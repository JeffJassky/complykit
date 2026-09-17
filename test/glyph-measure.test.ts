import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { GEOMETRY_INIT } from '../src/collect/browser/geometry-init.js';
import { GLYPH_INIT } from '../src/collect/browser/glyph-init.js';
import { asRunId } from '../src/record/index.js';
import {
  measureBand,
  measureRemaining,
  createGlyphRunState,
  type MeasuredSubject,
  type MeasureContext,
} from '../src/collect/browser/glyph-measure.js';

// Proof that the ORCHESTRATION (glyph-measure.ts) gets the right verdict for
// every case in the ground-truth corpus, not just that the underlying math
// and page API are individually correct (glyph-math.test.ts / glyph-init.
// test.ts already cover those). Driving the real corpus through a real band
// walk exercises exactly the failure modes the plan (§1) was written to fix:
// wrong-instant reads of a JS-driven reveal, overlap exclusion, tall-subject
// slicing, and evidence written for real fails only.

// Duplicated from session.ts on purpose: that file is owned by a later wave
// and cannot be imported from (it is the only place Playwright itself is
// imported, per the dependency law) or modified by this one. Keeping the
// literal identical means the corpus is measured under the same frozen-
// animation conditions the real pipeline uses.
const FREEZE_CSS = `*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;scroll-behavior:auto!important;caret-color:transparent!important;}`;

const PAGE_URL = pathToFileURL(fileURLToPath(new URL('./fixtures/pages/contrast-truth.html', import.meta.url))).href;

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

interface InnerScroller {
  ref: number;
  top: number;
  clientHeight: number;
  scrollHeight: number;
}

interface GeometryWindow {
  __ck?: {
    obstructions?(): Obstructions;
    innerScrollers?(): InnerScroller[];
    scrollInnerTo?(ref: number, offset: number): number;
  };
}

async function readObstructions(page: import('playwright').Page): Promise<Obstructions> {
  return page.evaluate(() => {
    const ck = (window as unknown as GeometryWindow).__ck;
    return ck?.obstructions ? ck.obstructions() : { rects: [], topInset: 0, bottomInset: 0 };
  });
}

async function settle(page: import('playwright').Page, ms = 200): Promise<void> {
  await page.waitForTimeout(ms);
}

function pixelsEqual(a: PNG, b: PNG): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  return Buffer.compare(a.data, b.data) === 0;
}

// Mirrors screenshot.ts's walkInnerScrollers: a scroll container (the C38/C39
// overflow:auto box) never reveals its lower rows to a document-level scroll
// at all, so the walk has to step its OWN scrollTop too, calling measureBand
// again at each stop, or content below its fold is never even enumerable
// (paintedBoxLocal clips it) — not merely unmeasured, but invisible to the
// whole pass.
async function walkInnerScrollers(
  page: import('playwright').Page,
  state: ReturnType<typeof createGlyphRunState>,
  ctx: MeasureContext,
): Promise<void> {
  const scrollers = await page.evaluate(() => {
    const ck = (window as unknown as GeometryWindow).__ck;
    return ck?.innerScrollers ? ck.innerScrollers() : [];
  });
  for (const sc of scrollers) {
    const step = Math.max(1, sc.clientHeight);
    const steps = Math.ceil(sc.scrollHeight / step);
    for (let k = 0; k < steps; k++) {
      const got = await page.evaluate(
        ([ref, offset]) => {
          const ck = (window as unknown as GeometryWindow).__ck;
          return ck?.scrollInnerTo ? ck.scrollInnerTo(ref, offset) : 0;
        },
        [sc.ref, k * step] as [number, number],
      );
      if (k > 0 && got === 0) break;
      await settle(page, 150);
      ctx.obstructions = await readObstructions(page);
      await measureBand(page, state, ctx);
    }
    await page.evaluate((ref: number) => {
      const ck = (window as unknown as GeometryWindow).__ck;
      ck?.scrollInnerTo?.(ref, 0);
    }, sc.ref);
  }
}

interface CaseSpec {
  id: string;
  expect: string;
  ratio: number | null;
}

interface CaseRow {
  id: string;
  expect: string;
  expectedRatio: number | null;
  subject: MeasuredSubject | undefined;
  got: string;
  gotRatio: number | undefined;
}

function findSubject(done: MeasuredSubject[], token: string): MeasuredSubject | undefined {
  return done.find((m) => m.textSample.startsWith(`${token} `));
}

suite('glyph-measure orchestration against the contrast-truth corpus', () => {
  let browser: import('playwright').Browser;
  let page: import('playwright').Page;
  let tmpCwd: string;
  let ctx: MeasureContext;
  let state: ReturnType<typeof createGlyphRunState>;
  let cases: CaseSpec[];
  let rows: CaseRow[];
  let beforeShot: PNG;
  let afterShot: PNG;

  beforeAll(async () => {
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
    });
    await context.addInitScript(GEOMETRY_INIT);
    await context.addInitScript(GLYPH_INIT);
    page = await context.newPage();
    await page.goto(PAGE_URL, { waitUntil: 'load' });
    await page.addStyleTag({ content: FREEZE_CSS });
    await settle(page, 100);

    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-glyph-measure-'));
    const runId = asRunId('glyph-measure-corpus-test');

    // Baseline for the restore-integrity check at the end: at scroll(0,0) the
    // JS-revealed sections (C32/C33) are far below the fold regardless of
    // their own reveal state, so this frame depends only on things this test
    // itself is responsible for putting back — the header's hide/restore.
    beforeShot = PNG.sync.read(await page.screenshot({ type: 'png' }));

    cases = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-case]')).map((el) => ({
        id: el.getAttribute('data-case') as string,
        expect: el.getAttribute('data-expect') as string,
        ratio: el.hasAttribute('data-ratio') ? parseFloat(el.getAttribute('data-ratio') as string) : null,
      })),
    );

    state = createGlyphRunState();
    ctx = {
      runId,
      cwd: tmpCwd,
      obstructions: await readObstructions(page),
      trace: (line) => console.log(line),
    };

    // Walk the document a band at a time, exactly as index.ts's scanOnce will
    // (screenshot.ts measureInBands): step by 75% of the unobstructed clear
    // height so nothing lands entirely under the fixed header's strip.
    let offset = 0;
    for (let guard = 0; guard < 200; guard++) {
      await page.evaluate((y) => window.scrollTo(0, y), offset);
      await settle(page);
      ctx.obstructions = await readObstructions(page);
      await measureBand(page, state, ctx);
      await walkInnerScrollers(page, state, ctx);

      const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      const clear = Math.max(1, 800 - ctx.obstructions.topInset - ctx.obstructions.bottomInset);
      const step = Math.max(1, Math.round(clear * 0.75));
      if (offset + 800 >= scrollHeight) break;
      offset += step;
    }

    await measureRemaining(page, state, ctx);

    await page.evaluate(() => window.scrollTo(0, 0));
    await settle(page);
    afterShot = PNG.sync.read(await page.screenshot({ type: 'png' }));

    const done = Array.from(state.done.values());
    rows = cases.map((c) => {
      const subject = findSubject(done, c.id);
      const got = !subject ? 'missing' : subject.status === 'unmeasured' ? `unmeasured:${subject.unmeasuredReason}` : (subject.verdict as string);
      return { id: c.id, expect: c.expect, expectedRatio: c.ratio, subject, got, gotRatio: subject?.ratio };
    });

    console.log('\ncontrast-truth corpus — glyph-measure results');
    console.log('id     expect   got                ratio(want)   ratio(got)');
    for (const r of rows) {
      console.log(
        `${r.id.padEnd(6)} ${r.expect.padEnd(8)} ${r.got.padEnd(18)} ${String(r.expectedRatio ?? '-').padEnd(13)} ${r.gotRatio ?? '-'}`,
      );
    }
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    if (tmpCwd) fs.rmSync(tmpCwd, { recursive: true, force: true });
  });


  it('measures every pass/fail case to the expected verdict, within 0.05 ratio where authored', () => {
    const failures: string[] = [];
    for (const r of rows) {
      if (r.expect !== 'pass' && r.expect !== 'fail') continue;
      if (!r.subject) {
        failures.push(`case ${r.id}: no measured subject found (textSample search)`);
        continue;
      }
      if (r.subject.status !== 'measured') {
        failures.push(`case ${r.id}: expected measured, got ${r.got}`);
        continue;
      }
      if (r.subject.verdict !== r.expect) {
        failures.push(`case ${r.id}: expected ${r.expect}, got ${r.subject.verdict} (ratio ${r.subject.ratio})`);
        continue;
      }
      if (r.expectedRatio !== null) {
        const diff = Math.abs((r.subject.ratio as number) - r.expectedRatio);
        if (diff > 0.05) failures.push(`case ${r.id}: ratio ${r.subject.ratio} vs expected ${r.expectedRatio} (diff ${diff.toFixed(3)})`);
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('never reports a violation for a "none" case (invisible to readers)', () => {
    const done = Array.from(state.done.values());
    for (const r of rows) {
      if (r.expect !== 'none') continue;
      const fail = done.find((m) => m.textSample.startsWith(`${r.id} `) && m.status === 'measured' && m.verdict === 'fail');
      expect(fail, `case ${r.id} ("none"): unexpected measured fail`).toBeUndefined();
    }
  });

  it('C28 (gap-ok, fully occluded low-contrast text) is not reported as a fail', () => {
    const done = Array.from(state.done.values());
    const fail = done.find((m) => m.textSample.startsWith('C28 ') && m.status === 'measured' && m.verdict === 'fail');
    expect(fail).toBeUndefined();
  });

  it('C26 (text-shadow legibility) is a documented limitation — printed, not asserted', () => {
    const row = rows.find((r) => r.id === 'C26');
    console.log(`C26 (limitation, not scored): got=${row?.got} ratio=${row?.gotRatio}`);
    expect(row).toBeDefined();
  });

  it('writes crop and overlay evidence for a failing subject, same dimensions, on disk under the run dir', () => {
    const done = Array.from(state.done.values());
    const failing = done.find((m) => m.status === 'measured' && m.verdict === 'fail' && m.cropPath);
    expect(failing, 'expected at least one measured failing subject with evidence').toBeDefined();
    const runDir = path.join(tmpCwd, '.comply', 'runs', 'glyph-measure-corpus-test');
    const cropAbs = path.join(runDir, failing!.cropPath as string);
    const overlayAbs = path.join(runDir, failing!.overlayPath as string);
    expect(fs.existsSync(cropAbs)).toBe(true);
    expect(fs.existsSync(overlayAbs)).toBe(true);
    const crop = PNG.sync.read(fs.readFileSync(cropAbs));
    const overlay = PNG.sync.read(fs.readFileSync(overlayAbs));
    expect(crop.width).toBe(overlay.width);
    expect(crop.height).toBe(overlay.height);
    expect(crop.width).toBe(failing!.cropWidth);
    expect(crop.height).toBe(failing!.cropHeight);
  });

  it('restore() leaves the page pixel-identical at scroll(0,0) after the whole walk', () => {
    expect(pixelsEqual(beforeShot, afterShot)).toBe(true);
  });
});
