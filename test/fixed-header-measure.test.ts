import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { GEOMETRY_INIT } from '../src/collect/browser/geometry-init.js';
import { GLYPH_INIT } from '../src/collect/browser/glyph-init.js';
import { asRunId } from '../src/record/index.js';
import { createGlyphRunState, measureRemaining, type MeasuredSubject, type MeasureContext } from '../src/collect/browser/glyph-measure.js';

// A screenshot records what the camera saw, not what the document says.
// Content scrolled under a fixed header is covered by the header's pixels, so
// measuring it there reports the header's colour as the element's background.
//
// On the StoryFolder client this was a 136px header at rgba(13,10,23,.875).
// Banding by the raw viewport height parked white sections in those rows and
// a near-black heading on white "measured" as near-black on dark purple.
//
// The glyph-mask walk avoids this the same way it avoids every other
// wrong-instant read: `measureBand`/`measureAtRest` only ever consider a
// subject "eligible" when its rects lie fully within the CLEAR strip
// (`topInset`..`vh - bottomInset`), and the rest pass parks a subject at
// `topInset + 8` before measuring it — so the header is never the thing
// behind the glyphs it hides.

const PAGE_URL = pathToFileURL(
  fileURLToPath(new URL('./fixtures/pages/fixed-header.html', import.meta.url)),
).href;

let chromiumAvailable = false;
try {
  const { chromium } = await import('playwright');
  chromiumAvailable = fs.existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}
const suite = chromiumAvailable ? describe : describe.skip;

interface Obstructions {
  rects: Array<{ x: number; y: number; width: number; height: number }>;
  topInset: number;
  bottomInset: number;
}

async function readObstructions(page: import('playwright').Page): Promise<Obstructions> {
  return page.evaluate(() => {
    const ck = (window as unknown as { __ck?: { obstructions?(): unknown } }).__ck;
    return (ck?.obstructions ? ck.obstructions() : { rects: [], topInset: 0, bottomInset: 0 }) as Obstructions;
  });
}

function parseRgb(s: string | undefined): { r: number; g: number; b: number } {
  const m = s?.match(/(\d+),\s*(\d+),\s*(\d+)/);
  return m ? { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) } : { r: -1, g: -1, b: -1 };
}

suite('glyph-mask measurement under fixed chrome', () => {
  let cwd: string;
  let browser: import('playwright').Browser;
  let page: import('playwright').Page;
  let done: MeasuredSubject[];
  let obstructions: Obstructions;

  beforeAll(async () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'complykit-fixedhdr-'));
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 400, height: 600 } });
    await ctx.addInitScript(GEOMETRY_INIT);
    await ctx.addInitScript(GLYPH_INIT);
    page = await ctx.newPage();
    await page.goto(PAGE_URL, { waitUntil: 'load' });

    obstructions = await readObstructions(page);
    const state = createGlyphRunState();
    const measureCtx: MeasureContext = { runId: asRunId('fixed-header-test'), cwd, obstructions };
    await measureRemaining(page, state, measureCtx);
    done = [...state.done.values()];
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('reports the header as a 100px+ top obstruction', () => {
    expect(obstructions.topInset).toBeGreaterThanOrEqual(100);
  });

  it('measures the subject one screen down against the white section, not the header colour', () => {
    const subject = done.find((m) => m.textSample.includes('Near-black body text on white, one screen down'));
    expect(subject?.status).toBe('measured');
    expect(subject?.verdict).toBe('pass');
    const bg = parseRgb(subject?.worstBgColor);
    expect(bg.r).toBeGreaterThan(200);
    expect(bg.g).toBeGreaterThan(200);
    expect(bg.b).toBeGreaterThan(200);
  });

  it("also measures the header's own text — it is painted ON TOP, not obstructed by itself", () => {
    const header = done.find((m) => m.textSample.includes('Fixed header, painted over everything'));
    expect(header?.status).toBe('measured');
    // Near-white text on the header's own near-black: unambiguously legible.
    expect(header?.verdict).toBe('pass');
  });
});
