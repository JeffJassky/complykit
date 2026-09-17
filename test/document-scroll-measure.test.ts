import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { GEOMETRY_INIT } from '../src/collect/browser/geometry-init.js';
import { GLYPH_INIT } from '../src/collect/browser/glyph-init.js';
import { asRunId } from '../src/record/index.js';
import { createGlyphRunState, measureRemaining, type MeasuredSubject, type MeasureContext } from '../src/collect/browser/glyph-measure.js';

// A plain document-scrolling page — the ordinary marketing-site case, and the
// one `fullPage: true` quietly got wrong.
//
// The old collector carried a VIEWPORT-relative box, and a measurement pass
// run afterwards against a finished full-page image agrees with that box only
// inside the first screen; below the fold, the same coordinates land on
// whatever occupies that image row instead. On a real site that produced a
// near-black heading on a white hero "measured" at 1.24:1.
//
// The glyph-mask walk instead measures each subject WHILE it is actually
// parked on screen (glyph-measure.ts's rest pass scrolls the subject to a
// known offset before hiding its glyphs), so a below-fold subject is always
// diffed against the pixels behind it at that instant — never against a
// decoy that merely happened to occupy the same VIEWPORT rect on the first
// screen.

const PAGE_URL = pathToFileURL(
  fileURLToPath(new URL('./fixtures/pages/long-document.html', import.meta.url)),
).href;

let chromiumAvailable = false;
try {
  const { chromium } = await import('playwright');
  chromiumAvailable = fs.existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}
const suite = chromiumAvailable ? describe : describe.skip;

function parseRgb(s: string | undefined): { r: number; g: number; b: number } {
  const m = s?.match(/(\d+),\s*(\d+),\s*(\d+)/);
  return m ? { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) } : { r: -1, g: -1, b: -1 };
}

suite('glyph-mask measurement on a document-scrolling page', () => {
  let cwd: string;
  let browser: import('playwright').Browser;
  let page: import('playwright').Page;
  let done: MeasuredSubject[];

  beforeAll(async () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'complykit-docscroll-'));
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 400, height: 600 } });
    await ctx.addInitScript(GEOMETRY_INIT);
    await ctx.addInitScript(GLYPH_INIT);
    page = await ctx.newPage();
    await page.goto(PAGE_URL, { waitUntil: 'load' });

    const state = createGlyphRunState();
    const measureCtx: MeasureContext = {
      runId: asRunId('doc-scroll-test'),
      cwd,
      obstructions: { topInset: 0, bottomInset: 0 },
    };
    await measureRemaining(page, state, measureCtx);
    done = [...state.done.values()];
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('measures the below-fold subject against its OWN white background, not the first-screen decoy', () => {
    const subject = done.find((m) => m.textSample.includes('Near-black body text on white, far below the fold'));
    expect(subject?.status).toBe('measured');
    expect(subject?.verdict).toBe('pass');
    const bg = parseRgb(subject?.worstBgColor);
    expect(bg.r).toBeGreaterThan(200);
    expect(bg.g).toBeGreaterThan(200);
    expect(bg.b).toBeGreaterThan(200);
  });

  it('measures the first-screen decoy against its own dark background', () => {
    const decoy = done.find((m) => m.textSample.includes('Bright text on a dark ground, first screen'));
    expect(decoy?.status).toBe('measured');
    // Near-white text on near-black: unambiguously legible.
    expect(decoy?.verdict).toBe('pass');
  });
});
