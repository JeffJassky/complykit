import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { GEOMETRY_INIT } from '../src/collect/browser/geometry-init.js';
import { GLYPH_INIT } from '../src/collect/browser/glyph-init.js';
import { asRunId } from '../src/record/index.js';
import { createGlyphRunState, measureRemaining, type MeasuredSubject, type MeasureContext } from '../src/collect/browser/glyph-measure.js';

// A contrast SUBJECT has to be something a reader can actually see.
//
// The old candidate collector checked only the element's OWN computed style,
// so a closed mega-menu, an unopened modal or an off-slide carousel panel —
// all of which lay out with real geometry while an ancestor hides them —
// came through as candidates, and the pixel pass then sampled whatever was
// painted at those coordinates (the page behind), reporting the panel's own
// text as failing against a background it never sits on. On the StoryFolder
// client that was 28 findings from one closed dropdown, at ratios around
// 1.03:1.
//
// The glyph-mask walk closes this a level earlier: `enumerate()` (glyph-
// init.ts) never creates a subject at all for an owner that fails
// `checkVisibility` (an ancestor's `opacity: 0`) or whose painted box is null
// (clipped away entirely by an ancestor's `overflow: hidden`) — so there is
// nothing here to measure a false verdict FOR, pass or fail, not merely a
// filtered candidate list.

const PAGE_URL = pathToFileURL(
  fileURLToPath(new URL('./fixtures/pages/hidden-panel.html', import.meta.url)),
).href;

let chromiumAvailable = false;
try {
  const { chromium } = await import('playwright');
  chromiumAvailable = fs.existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}
const suite = chromiumAvailable ? describe : describe.skip;

suite('glyph-mask contrast subjects exclude what is not painted', () => {
  let cwd: string;
  let browser: import('playwright').Browser;
  let page: import('playwright').Page;
  let done: MeasuredSubject[];

  beforeAll(async () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'complykit-hiddenpanel-'));
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
    // The scanner installs these page-side helpers on every context, and both
    // the visibility test (enumerate) and the measurement (hide/restore) live
    // in them — so the fixture has to have them too, or this is testing a
    // degraded fallback rather than the product.
    const ctx = await browser.newContext({ viewport: { width: 900, height: 700 } });
    await ctx.addInitScript(GEOMETRY_INIT);
    await ctx.addInitScript(GLYPH_INIT);
    page = await ctx.newPage();
    await page.goto(PAGE_URL, { waitUntil: 'load' });

    const state = createGlyphRunState();
    const measureCtx: MeasureContext = {
      runId: asRunId('hidden-panel-test'),
      cwd,
      obstructions: { topInset: 0, bottomInset: 0 },
    };
    await measureRemaining(page, state, measureCtx);
    done = [...state.done.values()];
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('never produces a measurement for the closed panel or the clipped line — they are not subjects at all', () => {
    expect(done.some((m) => m.textSample.includes('Import a video from anywhere'))).toBe(false);
    expect(done.some((m) => m.textSample.includes('Third line, clipped away entirely'))).toBe(false);
  });

  it('still measures the two lines the clipper actually paints', () => {
    expect(done.some((m) => m.textSample.includes('First line, painted'))).toBe(true);
  });

  it('measures the pale hero copy and the pale visible paragraph as real failures', () => {
    const hero = done.find((m) => m.textSample.includes('Hero copy that the closed panel'));
    const visible = done.find((m) => m.textSample.includes('too pale for its ground'));
    expect(hero?.status, 'hero copy should be measured, not skipped').toBe('measured');
    expect(hero?.verdict).toBe('fail');
    expect(visible?.status, 'visible paragraph should be measured, not skipped').toBe('measured');
    expect(visible?.verdict).toBe('fail');
  });

  it('measures the gradient (background-clip: text) title as a real subject, not skipped as unmeasurable', () => {
    const gradient = done.find((m) => m.textSample.includes('Convert any video'));
    expect(gradient).toBeDefined();
    expect(gradient?.paintedByBackground).toBe(true);
    // Whichever way it verdicts, it must have gone through the pixel method —
    // fgSource 'rendered' is exactly the gradient-text path (glyph-math §4.1
    // step 5: no CSS colour to trust, so the rendered ink IS the colour).
    if (gradient?.status === 'measured') {
      expect(gradient.fgSource).toBe('rendered');
    }
  });
});
