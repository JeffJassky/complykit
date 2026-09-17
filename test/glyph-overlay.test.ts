import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { GEOMETRY_INIT } from '../src/collect/browser/geometry-init.js';
import { GLYPH_INIT } from '../src/collect/browser/glyph-init.js';
import { asRunId } from '../src/record/index.js';
import type { Artifact } from '../src/record/index.js';
import { contrastText } from '../src/rules/contrast/contrast.js';
import {
  measureBand,
  measureRemaining,
  createGlyphRunState,
  type MeasuredSubject,
  type MeasureContext,
} from '../src/collect/browser/glyph-measure.js';

// Overlay attribution (glyph-measure attributeOverlays) against a small
// corpus: text that fails as rendered is re-measured with whatever is painted
// over it hidden, and only that second measurement decides the outcome.

const FREEZE_CSS = `*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;scroll-behavior:auto!important;caret-color:transparent!important;}`;
const PAGE_URL = pathToFileURL(fileURLToPath(new URL('./fixtures/pages/overlay-truth.html', import.meta.url))).href;

let chromiumAvailable = false;
try {
  const { chromium } = await import('playwright');
  chromiumAvailable = fs.existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}
const suite = chromiumAvailable ? describe : describe.skip;

type Obstructions = { topInset: number; bottomInset: number };

async function readObstructions(page: import('playwright').Page): Promise<Obstructions> {
  return page.evaluate(() => {
    const ck = (window as unknown as { __ck?: { obstructions?(): Obstructions } }).__ck;
    return ck?.obstructions ? ck.obstructions() : { topInset: 0, bottomInset: 0 };
  });
}

suite('overlay attribution against the overlay-truth corpus', () => {
  let browser: import('playwright').Browser;
  let tmpCwd: string;
  let done: MeasuredSubject[];
  let expects: Record<string, string>;

  const find = (id: string): MeasuredSubject | undefined => done.find((m) => m.textSample.startsWith(`${id} `));
  const findingsFor = (id: string) => {
    const probe = {
      kind: 'style-probe',
      check: 'contrast',
      subject: { property: 'p', routePattern: '/', instanceUrl: PAGE_URL, viewport: 'desktop', colorScheme: 'light' },
      capturedAt: '2026-09-16T00:00:00.000Z',
      results: done.filter((m) => m.textSample.startsWith(`${id} `)),
    } as unknown as Extract<Artifact, { kind: 'style-probe' }>;
    return contrastText.evaluate({ 'style-probe': [probe] }, { property: 'p' });
  };

  beforeAll(async () => {
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    await context.addInitScript(GEOMETRY_INIT);
    await context.addInitScript(GLYPH_INIT);
    const page = await context.newPage();
    await page.goto(PAGE_URL, { waitUntil: 'load' });
    await page.addStyleTag({ content: FREEZE_CSS });
    await page.waitForTimeout(100);
    expects = await page.evaluate(() =>
      Object.fromEntries(Array.from(document.querySelectorAll('[data-case]')).map((el) => [el.getAttribute('data-case'), el.getAttribute('data-expect')])),
    );

    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-glyph-overlay-'));
    const state = createGlyphRunState();
    const ctx: MeasureContext = { runId: asRunId('glyph-overlay-test'), cwd: tmpCwd, obstructions: await readObstructions(page) };

    // Band walk; the consent banner appears partway through, as on a real site.
    let offset = 0;
    for (let guard = 0; guard < 50; guard++) {
      await page.evaluate((y) => window.scrollTo(0, y), offset);
      await page.waitForTimeout(200);
      ctx.obstructions = await readObstructions(page);
      await measureBand(page, state, ctx);
      const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      if (offset + 800 >= scrollHeight) break;
      offset += 600;
    }
    await measureRemaining(page, state, ctx);
    done = Array.from(state.done.values());
    for (const m of done) {
      console.log(`${m.textSample.slice(0, 3)} ${m.status} ${m.verdict ?? m.unmeasuredReason} ${m.ratio ?? ''} over=${m.obscuredBy?.join('|') ?? '-'} own=${m.unobscured?.verdict ?? '-'} ${m.unobscured?.ratio ?? ''}`);
    }
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    if (tmpCwd) fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  it('classifies every case as authored', () => {
    const problems: string[] = [];
    for (const [id, want] of Object.entries(expects)) {
      const findings = findingsFor(id);
      const got = findings.length === 0 ? 'pass' : findings[0].confidence === 'violation' ? 'fail' : find(id)?.status === 'unmeasured' ? 'covered' : 'obscured';
      if (got !== want) problems.push(`${id}: expected ${want}, got ${got} (${findings.map((f) => f.message).join(' / ')})`);
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('names the overlay and measures the text on its own background', () => {
    const o1 = find('O1');
    expect(o1?.obscuredBy).toEqual(['div#o1-scrim']);
    expect(o1?.unobscured?.verdict).toBe('pass');
    expect(o1?.unobscured?.ratio).toBeGreaterThan(10);
    expect(find('O5')?.obscuredBy).toEqual(['div#o5-banner']);
    expect(find('O4')?.obscuredBy).toEqual(['div#o4-cover']);
  });

  it('attaches evidence for both the rendered and the overlay-hidden measurement', () => {
    const [f] = findingsFor('O1');
    const shots = f.evidence.filter((e) => e.kind === 'screenshot');
    expect(shots).toHaveLength(2);
    expect(f.message).toContain('div#o1-scrim');
  });

  it('leaves no coverage gap behind for covered text it could re-check', () => {
    expect(find('O4')?.unobscured).toBeDefined();
  });
});
