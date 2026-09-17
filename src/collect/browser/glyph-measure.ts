import type { Page } from 'playwright';
import { PNG } from 'pngjs';
import {
  measureGlyphs,
  renderOverlay,
  cropPng,
  regionChanged,
  decideVerdict,
  RatioHistogram,
  composite,
  contrastRatio,
  parseCssColor,
  rgbString,
  floor2,
  type Rgb,
  type Rect,
  type GlyphResult,
} from './glyph-math.js';
import type { PageTextSubject, GlyphDescribeResult, SubjectKind } from './glyph-init.js';
import { putEvidence, type RunId } from '../../record/index.js';

// Playwright orchestration for the glyph-mask contrast method (plan
// plans/glyph-contrast-plan.md section 4.3). glyph-math.ts knows how to turn
// two screenshots into a verdict; glyph-init.ts knows how to make a subject's
// glyphs disappear on the page. This file is the thing that decides WHICH
// subjects to measure, WHEN it is safe to trust the pixels, and how to turn a
// GlyphResult into a durable MeasuredSubject with evidence on disk.

export interface MeasuredSubject {
  key: string;
  ref: number;
  kind: SubjectKind;
  cssPath: string;
  textSample: string;
  sourceFile: string | null;
  scopeId: string | null;
  fgVars?: string[];
  bgVars?: string[];
  bgImageVars?: string[];
  textColor: string;
  fontSizePx: number;
  bold: boolean;
  large: boolean;
  required: number;
  paintedByBackground?: boolean;
  flat: boolean;
  bgColor: string | null;
  cascadeRatio: number | null;
  box: Rect;
  status: 'measured' | 'unmeasured';
  unmeasuredReason?: 'never-stable' | 'occluded' | 'cap' | 'error';
  measuredAt?: 'band' | 'rest';
  verdict?: 'pass' | 'fail';
  ratio?: number;
  minRatio?: number;
  medianRatio?: number;
  maxRatio?: number;
  glyphPixels?: number;
  failingPixels?: number;
  fgSource?: 'css' | 'rendered';
  fgColor?: string;
  worstBgColor?: string;
  bestBgColor?: string;
  cropPath?: string;
  overlayPath?: string;
  cropWidth?: number;
  cropHeight?: number;
  /** Elements painted over the text when it was re-checked (see
   *  attributeOverlays). Set only for text that failed, or could not be seen,
   *  as rendered. */
  obscuredBy?: string[];
  /** The same text measured with `obscuredBy` hidden: its contrast against its
   *  own background. */
  unobscured?: UnobscuredMeasurement;
}

export interface UnobscuredMeasurement {
  verdict: 'pass' | 'fail';
  ratio: number;
  minRatio: number;
  medianRatio: number;
  glyphPixels: number;
  fgColor?: string;
  worstBgColor?: string;
  cropPath?: string;
  overlayPath?: string;
  cropWidth?: number;
  cropHeight?: number;
}

export interface GlyphRunState {
  done: Map<string, MeasuredSubject>;
  pending: Map<string, PageTextSubject>;
}

export function createGlyphRunState(): GlyphRunState {
  return { done: new Map(), pending: new Map() };
}

export interface MeasureContext {
  runId: RunId;
  cwd?: string;
  obstructions: { topInset: number; bottomInset: number };
  budgetMs?: number;
  maxRestSubjects?: number;
  trace?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// window.__ck.glyph / window.__ck.boxOf plumbing
// ---------------------------------------------------------------------------
// One thin, precisely-typed wrapper per page-side method rather than a single
// generic forwarder: a generic `K extends keyof GlyphPageApi` signature
// defeats TypeScript's per-method argument checking across the method union
// (every call site type-checks regardless of arg count), which is exactly the
// kind of mistake this file cannot afford — a wrong argument silently
// reaching `page.evaluate` fails at runtime, in the browser, far from the
// call site.
interface CkWindow {
  __ck?: {
    glyph?: {
      enumerate(opts: { viewportOnly?: boolean; refs?: number[] }): {
        subjects: PageTextSubject[];
        truncated: boolean;
        svgTextCount: number;
      };
      hide(keys: string[]): void;
      restore(): void;
      settled(keys: string[]): { running: number; moved: number };
      describe(refs: number[]): GlyphDescribeResult[];
      scrollSubjectTo(ref: number, viewportY: number): Rect | null;
      overlaysOver(key: string, hide: boolean): string[];
    };
    boxOf?(ref: number): Rect | null;
  };
}

async function pageEnumerate(
  page: Page,
  opts: { viewportOnly?: boolean; refs?: number[] },
): Promise<{ subjects: PageTextSubject[]; truncated: boolean; svgTextCount: number }> {
  return page.evaluate((o) => {
    const w = window as unknown as CkWindow;
    if (!w.__ck?.glyph) throw new Error('window.__ck.glyph not installed');
    return w.__ck.glyph.enumerate(o);
  }, opts);
}

async function pageHide(page: Page, keys: string[]): Promise<void> {
  await page.evaluate((k) => {
    (window as unknown as CkWindow).__ck?.glyph?.hide(k);
  }, keys);
}

async function pageOverlays(page: Page, key: string, hide: boolean): Promise<string[]> {
  return page.evaluate(
    ({ key, hide }) => (window as unknown as CkWindow).__ck?.glyph?.overlaysOver(key, hide) ?? [],
    { key, hide },
  );
}

async function pageRestore(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as CkWindow).__ck?.glyph?.restore();
  });
}

async function pageSettled(page: Page, keys: string[]): Promise<{ running: number; moved: number }> {
  return page.evaluate((k) => {
    const glyph = (window as unknown as CkWindow).__ck?.glyph;
    return glyph ? glyph.settled(k) : { running: 0, moved: 0 };
  }, keys);
}

async function pageDescribe(page: Page, refs: number[]): Promise<GlyphDescribeResult[]> {
  return page.evaluate((r) => {
    const glyph = (window as unknown as CkWindow).__ck?.glyph;
    return glyph ? glyph.describe(r) : [];
  }, refs);
}

async function pageScrollSubjectTo(page: Page, ref: number, viewportY: number): Promise<Rect | null> {
  return page.evaluate(
    ({ ref, viewportY }) => {
      const glyph = (window as unknown as CkWindow).__ck?.glyph;
      return glyph ? glyph.scrollSubjectTo(ref, viewportY) : null;
    },
    { ref, viewportY },
  );
}

async function pageBoxOf(page: Page, ref: number): Promise<Rect | null> {
  return page.evaluate((ref) => {
    const ck = (window as unknown as CkWindow).__ck;
    return ck?.boxOf ? ck.boxOf(ref) : null;
  }, ref);
}

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------
// Same tolerance as screenshot.ts safeShot: one stuck webfont or a detached
// page must not throw the whole band/rest pass away. A failed shot means
// "not measured this time" — the subject simply stays pending for the next
// band, or is retried by the rest pass.
const SHOT_TIMEOUT_MS = 8000;

async function shootOrNull(page: Page): Promise<PNG | null> {
  try {
    const buf = await page.screenshot({ type: 'png', timeout: SHOT_TIMEOUT_MS });
    return PNG.sync.read(buf);
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Poll settled() until two CONSECUTIVE polls report nothing running and
// nothing moved. One quiet poll is not enough: a rAF loop can land between
// frames and read as momentarily calm while still very much in progress —
// two in a row is the cheapest test that rejects that false negative.
async function pollSettled(page: Page, keys: string[], capMs: number): Promise<boolean> {
  if (keys.length === 0) return true;
  const start = Date.now();
  let streak = 0;
  while (Date.now() - start < capMs) {
    const r = await pageSettled(page, keys);
    if (r.running === 0 && r.moved === 0) {
      streak++;
      if (streak >= 2) return true;
    } else {
      streak = 0;
    }
    await sleep(100);
  }
  return false;
}

// regionChanged(A, A2) alone can miss a JS-driven reveal that happens to be
// mid-transition across the ENTIRE span of our own A/hide/B/restore/A2
// round trip: observed empirically on the corpus's IntersectionObserver ->
// rAF opacity ramp (C32/C33) during a long band walk — every pixel in A and
// A2 read back byte-identical, yet the element was genuinely still fading in
// (a later, unrelated read of the same subject showed further progress).
// Screenshots alone cannot prove the page was quiescent for that whole span,
// only that it happened not to move BETWEEN two particular samples. A short
// real delay with no CDP traffic in flight, followed by one more settled()
// read against the SAME lastState baseline pollSettled left behind, gives the
// animation a clear window to tick forward if it is still running — turning
// a coincidental quiet instant into a genuine "still moving" signal.
const CONFIRM_DELAY_MS = 150;
const CONFIRM_ROUNDS = 2; // two independent quiet windows, not just one

async function confirmNotMoving(page: Page, keys: string[]): Promise<boolean> {
  for (let i = 0; i < CONFIRM_ROUNDS; i++) {
    await sleep(CONFIRM_DELAY_MS);
    const post = await pageSettled(page, keys);
    if (post.running !== 0 || post.moved !== 0) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Small pixel/rect helpers not exported by glyph-math.ts (it exposes exactly
// the plan's §4.1 surface; the rest is orchestration-only plumbing that lives
// here instead of duplicating internals across modules).
// ---------------------------------------------------------------------------

function rectBounds(rects: Rect[], imgWidth: number, imgHeight: number): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) {
    const rx0 = Math.max(0, Math.floor(r.x));
    const ry0 = Math.max(0, Math.floor(r.y));
    const rx1 = Math.min(imgWidth, Math.ceil(r.x + r.width));
    const ry1 = Math.min(imgHeight, Math.ceil(r.y + r.height));
    if (rx1 <= rx0 || ry1 <= ry0) continue;
    if (rx0 < x0) x0 = rx0;
    if (ry0 < y0) y0 = ry0;
    if (rx1 > x1) x1 = rx1;
    if (ry1 > y1) y1 = ry1;
  }
  if (x1 <= x0 || y1 <= y0) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function collectRectPixels(png: PNG, rects: Rect[]): Rgb[] {
  const seen = new Set<number>();
  const out: Rgb[] = [];
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor(r.x));
    const y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(png.width, Math.ceil(r.x + r.width));
    const y1 = Math.min(png.height, Math.ceil(r.y + r.height));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const key = y * png.width + x;
        if (seen.has(key)) continue;
        seen.add(key);
        const idx = (png.width * y + x) << 2;
        out.push({ r: png.data[idx], g: png.data[idx + 1], b: png.data[idx + 2] });
      }
    }
  }
  return out;
}

function medianRgb(pixels: Rgb[]): Rgb | null {
  if (pixels.length === 0) return null;
  const rs = pixels.map((p) => p.r).sort((a, b) => a - b);
  const gs = pixels.map((p) => p.g).sort((a, b) => a - b);
  const bs = pixels.map((p) => p.b).sort((a, b) => a - b);
  const mid = Math.floor(pixels.length / 2);
  return { r: rs[mid], g: gs[mid], b: bs[mid] };
}

function fillRectMask(rects: Rect[], maskRect: Rect, imgWidth: number, imgHeight: number, value: number): Uint8Array {
  const mask = new Uint8Array(Math.max(0, maskRect.width) * Math.max(0, maskRect.height));
  if (maskRect.width === 0 || maskRect.height === 0) return mask;
  for (const r of rects) {
    const rx0 = Math.max(0, Math.floor(r.x));
    const ry0 = Math.max(0, Math.floor(r.y));
    const rx1 = Math.min(imgWidth, Math.ceil(r.x + r.width));
    const ry1 = Math.min(imgHeight, Math.ceil(r.y + r.height));
    for (let y = Math.max(ry0, maskRect.y); y < Math.min(ry1, maskRect.y + maskRect.height); y++) {
      for (let x = Math.max(rx0, maskRect.x); x < Math.min(rx1, maskRect.x + maskRect.width); x++) {
        mask[(y - maskRect.y) * maskRect.width + (x - maskRect.x)] = value;
      }
    }
  }
  return mask;
}

function boundsOfRects(rects: Rect[]): { minY: number; height: number } {
  let minY = Infinity, maxY = -Infinity;
  for (const r of rects) {
    if (r.y < minY) minY = r.y;
    if (r.y + r.height > maxY) maxY = r.y + r.height;
  }
  if (!Number.isFinite(minY)) return { minY: 0, height: 0 };
  return { minY, height: maxY - minY };
}

function clipRectToWindow(r: Rect, top: number, bottom: number): Rect | null {
  const y0 = Math.max(r.y, top);
  const y1 = Math.min(r.y + r.height, bottom);
  if (y1 <= y0) return null;
  return { x: r.x, y: y0, width: r.width, height: y1 - y0 };
}

function inflateClip(rect: Rect, n: number, imgWidth: number, imgHeight: number): Rect {
  const x0 = Math.max(0, Math.floor(rect.x) - n);
  const y0 = Math.max(0, Math.floor(rect.y) - n);
  const x1 = Math.min(imgWidth, Math.ceil(rect.x + rect.width) + n);
  const y1 = Math.min(imgHeight, Math.ceil(rect.y + rect.height) + n);
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

// Re-base a GlyphResult's mask into a larger (or shifted) rect so a crop and
// its overlay are pixel-for-pixel the same rectangle of the source image —
// required by the plan (§4.3) so the HTML report can stack them exactly.
function rebaseMask(result: GlyphResult, target: Rect): Uint8Array {
  const w = Math.max(1, target.width);
  const h = Math.max(1, target.height);
  const out = new Uint8Array(w * h);
  const dx = result.maskRect.x - target.x;
  const dy = result.maskRect.y - target.y;
  for (let y = 0; y < result.maskRect.height; y++) {
    const ty = y + dy;
    if (ty < 0 || ty >= h) continue;
    for (let x = 0; x < result.maskRect.width; x++) {
      const tx = x + dx;
      if (tx < 0 || tx >= w) continue;
      out[ty * w + tx] = result.mask[y * result.maskRect.width + x];
    }
  }
  return out;
}

function subjectFg(subject: PageTextSubject): { rgb: Rgb; alpha: number } | null {
  if (subject.paintedByBackground) return null; // gradient text: fg is not a solid colour
  return parseCssColor(subject.color);
}

// Invisible-text rule (plan §4.3): hiding the glyphs produced no pixel diff
// (status 'no-diff'), yet the CSS colour is not literally transparent — e.g.
// white text on a white page (C27). That is a real 1.4.3 failure the diff
// method alone cannot see (there is nothing to diff), so it is scored
// directly from the declared colour vs. the surrounding (post-hide) pixels.
function tryInvisibleText(subject: PageTextSubject, b: PNG, rects: Rect[]): GlyphResult | null {
  const fg = subjectFg(subject);
  if (!fg || fg.alpha <= 0) return null;
  const pixels = collectRectPixels(b, rects);
  const bgMedian = medianRgb(pixels);
  if (!bgMedian) return null;
  const ea = fg.alpha * subject.opacity;
  const composited = composite(fg.rgb, ea, bgMedian);
  const ratio = contrastRatio(composited, bgMedian);
  if (ratio >= 1.1) return null;

  const hist = new RatioHistogram();
  hist.add(ratio, pixels.length);
  const maskRect = rectBounds(rects, b.width, b.height);
  const mask = fillRectMask(rects, maskRect, b.width, b.height, 2); // always below any real required ratio
  return {
    status: 'measured',
    maxDiff: 0,
    hist,
    fgSource: 'css',
    worst: { fg: composited, bg: bgMedian, ratio },
    best: { fg: composited, bg: bgMedian, ratio },
    maskRect,
    mask,
  };
}

// ---------------------------------------------------------------------------
// MeasuredSubject construction
// ---------------------------------------------------------------------------

function baseFields(subject: PageTextSubject): Pick<
  MeasuredSubject,
  | 'key'
  | 'ref'
  | 'kind'
  | 'cssPath'
  | 'textSample'
  | 'textColor'
  | 'fontSizePx'
  | 'bold'
  | 'large'
  | 'required'
  | 'paintedByBackground'
  | 'box'
> {
  return {
    key: subject.key,
    ref: subject.ref,
    kind: subject.kind,
    cssPath: subject.cssPath,
    textSample: subject.textSample,
    textColor: subject.color,
    fontSizePx: subject.fontSizePx,
    bold: subject.bold,
    large: subject.large,
    required: subject.required,
    paintedByBackground: subject.paintedByBackground,
    box: subject.box,
  };
}

function unmeasuredSubject(subject: PageTextSubject, reason: NonNullable<MeasuredSubject['unmeasuredReason']>): MeasuredSubject {
  return {
    ...baseFields(subject),
    sourceFile: null,
    scopeId: null,
    flat: false,
    bgColor: null,
    cascadeRatio: null,
    status: 'unmeasured',
    unmeasuredReason: reason,
  };
}

function buildEvidence(
  a: PNG,
  result: GlyphResult,
  ctx: MeasureContext,
): { cropPath: string; overlayPath: string; cropWidth: number; cropHeight: number } {
  const inflated = inflateClip(result.maskRect, 12, a.width, a.height);
  const target: Rect = { x: inflated.x, y: inflated.y, width: Math.max(1, inflated.width), height: Math.max(1, inflated.height) };
  const rebased = rebaseMask(result, target);
  const overlayBuf = renderOverlay({ ...result, maskRect: target, mask: rebased });
  const cropBuf = cropPng(a, target);
  const cropPath = putEvidence(ctx.runId, cropBuf, 'png', ctx.cwd);
  const overlayPath = putEvidence(ctx.runId, overlayBuf, 'png', ctx.cwd);
  return { cropPath, overlayPath, cropWidth: target.width, cropHeight: target.height };
}

function finalizeMeasured(
  subject: PageTextSubject,
  result: GlyphResult,
  measuredAt: 'band' | 'rest',
  a: PNG,
  ctx: MeasureContext,
  evidence: 'fail' | 'always' = 'fail',
): MeasuredSubject {
  const verdict = decideVerdict(result.hist, subject.required);
  const out: MeasuredSubject = {
    ...baseFields(subject),
    sourceFile: null,
    scopeId: null,
    flat: false,
    bgColor: null,
    cascadeRatio: null,
    box: subject.box,
    status: 'measured',
    measuredAt,
    verdict: verdict.verdict,
    ratio: floor2(verdict.ratio),
    minRatio: floor2(verdict.min),
    medianRatio: floor2(verdict.median),
    maxRatio: floor2(verdict.max),
    glyphPixels: verdict.glyphPixels,
    failingPixels: verdict.failingPixels,
    fgSource: result.fgSource,
    fgColor: result.worst ? rgbString(result.worst.fg) : undefined,
    worstBgColor: result.worst ? rgbString(result.worst.bg) : undefined,
    bestBgColor: result.best ? rgbString(result.best.bg) : undefined,
  };
  if (verdict.verdict === 'fail' || evidence === 'always') {
    const ev = buildEvidence(a, result, ctx);
    out.cropPath = ev.cropPath;
    out.overlayPath = ev.overlayPath;
    out.cropWidth = ev.cropWidth;
    out.cropHeight = ev.cropHeight;
  }
  return out;
}

// ---------------------------------------------------------------------------
// measureBand
// ---------------------------------------------------------------------------

export async function measureBand(page: Page, state: GlyphRunState, ctx: MeasureContext): Promise<void> {
  const viewport = page.viewportSize();
  if (!viewport) return; // nothing we can honestly measure without a known viewport
  const { width: vw, height: vh } = viewport;
  const { topInset, bottomInset } = ctx.obstructions;

  const { subjects } = await pageEnumerate(page, { viewportOnly: true });
  for (const s of subjects) {
    if (!state.done.has(s.key)) state.pending.set(s.key, s);
  }

  const fullyWithin = (rects: Rect[]): boolean =>
    rects.every((r) => r.x >= 0 && r.x + r.width <= vw && r.y >= topInset && r.y + r.height <= vh - bottomInset);

  let eligible = subjects.filter((s) => !state.done.has(s.key) && fullyWithin(s.rects));

  // Two subjects whose text rects overlap cannot be hidden in the same A/B
  // pass: hiding both would erase the OTHER one's ink from B too, so its
  // pixels would read as "background" when they are really a second glyph.
  // Measured individually later (rest pass) instead.
  const inflate1 = (r: Rect): Rect => ({ x: r.x - 1, y: r.y - 1, width: r.width + 2, height: r.height + 2 });
  const intersects = (a: Rect, b: Rect): boolean => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  const overlapsAnother = (s: PageTextSubject): boolean =>
    subjects.some((other) => other.key !== s.key && s.rects.some((ra) => other.rects.some((rb) => intersects(inflate1(ra), rb))));
  eligible = eligible.filter((s) => !overlapsAnother(s));

  if (eligible.length === 0) return;

  const keys = eligible.map((s) => s.key);
  const stable = await pollSettled(page, keys, 2000);
  if (!stable) return; // still moving; try again next band or in the rest pass

  const a = await shootOrNull(page);
  if (!a) return;

  let b: PNG | null = null;
  try {
    await pageHide(page, keys);
    b = await shootOrNull(page);
  } finally {
    // MUST run even if the B shot throws, or every subsequent band inherits
    // this batch's hidden glyphs.
    await pageRestore(page);
  }
  if (!b) return;

  const a2 = await shootOrNull(page);
  if (!a2) return;
  if (!(await confirmNotMoving(page, keys))) return; // see confirmNotMoving: closes a real gap regionChanged alone missed

  for (const subject of eligible) {
    if (regionChanged(a, a2, subject.rects)) continue; // page moved mid-measurement; stays pending

    const fg = subjectFg(subject);
    const result = measureGlyphs({ a, b, rects: subject.rects, fg, opacity: subject.opacity, required: subject.required });

    if (result.status === 'no-diff') {
      const invisible = tryInvisibleText(subject, b, subject.rects);
      if (invisible) {
        state.done.set(subject.key, finalizeMeasured(subject, invisible, 'band', a, ctx));
        state.pending.delete(subject.key);
      }
      continue; // otherwise stays pending — nothing conclusive happened this instant
    }

    state.done.set(subject.key, finalizeMeasured(subject, result, 'band', a, ctx));
    state.pending.delete(subject.key);
  }
}

// ---------------------------------------------------------------------------
// measureRemaining
// ---------------------------------------------------------------------------

type SingleOutcome =
  | { kind: 'measured'; result: GlyphResult; a: PNG }
  | { kind: 'never-stable' }
  | { kind: 'occluded' }
  | { kind: 'error' };

// Shared by the plain single-subject path and each slice of a tall subject:
// settle, then attempt A/hide/B/restore/A2 up to 3 times while the page keeps
// moving under us (regionChanged), then classify the result.
// With `withoutOverlays`, whatever is painted over the subject is made
// transparent for every shot (A, B and A2 alike), so the measurement is of the
// text against its own background.
async function measureRectsOnce(page: Page, subject: PageTextSubject, rects: Rect[], withoutOverlays = false): Promise<SingleOutcome> {
  try {
    await pollSettled(page, [subject.key], 5000);

    const shoot = async (hideGlyphs: boolean): Promise<[PNG | null, PNG | null]> => {
      try {
        if (withoutOverlays) await pageOverlays(page, subject.key, true);
        const first = await shootOrNull(page);
        if (!first || !hideGlyphs) return [first, null];
        await pageHide(page, [subject.key]);
        return [first, await shootOrNull(page)];
      } finally {
        await pageRestore(page);
      }
    };

    let a: PNG | null = null;
    let b: PNG | null = null;
    let a2: PNG | null = null;
    let changed = true;
    for (let attempt = 0; attempt < 3 && changed; attempt++) {
      [a, b] = await shoot(true);
      if (!a || !b) return { kind: 'error' };
      [a2] = await shoot(false);
      if (!a2) return { kind: 'error' };
      changed = regionChanged(a, a2, rects) || !(await confirmNotMoving(page, [subject.key]));
    }
    if (changed) return { kind: 'never-stable' };

    const fg = subjectFg(subject);
    // a/b are non-null here: the loop only exits with changed === false after
    // a successful iteration that assigned both.
    const result = measureGlyphs({ a: a as PNG, b: b as PNG, rects, fg, opacity: subject.opacity, required: subject.required });
    if (result.status === 'no-diff') {
      const invisible = tryInvisibleText(subject, b as PNG, rects);
      if (invisible) return { kind: 'measured', result: invisible, a: a as PNG };
      return { kind: 'occluded' };
    }
    return { kind: 'measured', result, a: a as PNG };
  } catch {
    return { kind: 'error' };
  }
}

async function measureSingleSubject(page: Page, subject: PageTextSubject, ctx: MeasureContext): Promise<MeasuredSubject> {
  const outcome = await measureRectsOnce(page, subject, subject.rects);
  switch (outcome.kind) {
    case 'measured':
      return finalizeMeasured(subject, outcome.result, 'rest', outcome.a, ctx);
    case 'never-stable':
    case 'occluded':
    case 'error':
      return unmeasuredSubject(subject, outcome.kind);
  }
}

// A subject taller than the unobstructed viewport strip cannot be hidden and
// shot in one pass — most of it is off-screen. Walk it a "clear window" at a
// time, clip the rects to what is actually visible at each stop, and merge
// the per-slice histograms into one verdict (plan §4.3).
async function measureTallSubject(page: Page, subject: PageTextSubject, ctx: MeasureContext, vh: number, clear: number): Promise<MeasuredSubject> {
  const windowTop = ctx.obstructions.topInset;
  const windowBottom = vh - ctx.obstructions.bottomInset;
  const merged = new RatioHistogram();
  let worst: { ratio: number; result: GlyphResult; a: PNG } | null = null;
  let sawNeverStable = false;
  let sawOccluded = false;
  let sawError = false;

  const MAX_SLICES = 60; // a bound on pathological pages; ordinary tall text needs a handful
  for (let i = 0; i < MAX_SLICES; i++) {
    const offset = i * clear;
    const landed = await pageScrollSubjectTo(page, subject.ref, windowTop + 8 - offset);
    if (landed === null) break; // the subject is gone

    const fresh = await pageEnumerate(page, { refs: [subject.ref] });
    const freshSubject = fresh.subjects.find((s) => s.key === subject.key);
    if (!freshSubject) break; // no longer enumerable at this scroll position

    const sliceRects = freshSubject.rects.map((r) => clipRectToWindow(r, windowTop, windowBottom)).filter((r): r is Rect => r !== null);
    if (sliceRects.length === 0) break; // scrolled past the whole subject

    const outcome = await measureRectsOnce(page, freshSubject, sliceRects);
    if (outcome.kind === 'measured') {
      merged.merge(outcome.result.hist);
      if (outcome.result.worst && (!worst || outcome.result.worst.ratio < worst.ratio)) {
        worst = { ratio: outcome.result.worst.ratio, result: outcome.result, a: outcome.a };
      }
    } else if (outcome.kind === 'never-stable') sawNeverStable = true;
    else if (outcome.kind === 'occluded') sawOccluded = true;
    else sawError = true;
  }

  if (merged.total === 0 || !worst) {
    const reason = sawNeverStable ? 'never-stable' : sawOccluded ? 'occluded' : sawError ? 'error' : 'occluded';
    return unmeasuredSubject(subject, reason);
  }

  // Evidence and worst/best pixel come from the slice that held the single
  // lowest-ratio pixel; min/median/max/verdict come from the MERGED
  // histogram across every slice (plan §4.3).
  const combined: GlyphResult = {
    status: 'measured',
    maxDiff: worst.result.maxDiff,
    hist: merged,
    fgSource: worst.result.fgSource,
    worst: worst.result.worst,
    best: worst.result.best,
    maskRect: worst.result.maskRect,
    mask: worst.result.mask,
  };
  return finalizeMeasured(subject, combined, 'rest', worst.a, ctx);
}

async function measureAtRest(page: Page, subject: PageTextSubject, ctx: MeasureContext, vh: number): Promise<MeasuredSubject> {
  const clear = Math.max(1, vh - ctx.obstructions.topInset - ctx.obstructions.bottomInset);
  const { height } = boundsOfRects(subject.rects);
  if (height <= clear) return measureSingleSubject(page, subject, ctx);
  return measureTallSubject(page, subject, ctx, vh, clear);
}

// ---------------------------------------------------------------------------
// attributeOverlays
// ---------------------------------------------------------------------------
// Text that failed as rendered, or that could not be seen at all (hiding it
// changed no pixels), is re-checked once at rest with anything painted over it
// hidden: a cookie banner, a scrim, a sticky bar. An overlay alone decides
// nothing (it may be fully transparent); only the second measurement does.
//
//   still fails without the overlay  -> the text itself fails (kept as is)
//   passes without the overlay       -> obscuredBy + unobscured: the rule
//                                       reports needs-review, naming the overlay
//   nothing over it, passes now      -> the earlier fail was read while
//                                       something transient covered it at that
//                                       scroll position; the at-rest pass stands
const MAX_OVERLAY_CHECKS = 150;

async function attributeOverlays(
  page: Page,
  state: GlyphRunState,
  ctx: MeasureContext,
  vh: number,
): Promise<{ obscured: number; cleared: number }> {
  const counts = { obscured: 0, cleared: 0 };
  const clear = Math.max(1, vh - ctx.obstructions.topInset - ctx.obstructions.bottomInset);
  const candidates = Array.from(state.done.values()).filter(
    (m) => (m.status === 'measured' && m.verdict === 'fail') || (m.status === 'unmeasured' && m.unmeasuredReason === 'occluded'),
  );
  for (const m of candidates.slice(0, MAX_OVERLAY_CHECKS)) {
    try {
      if ((await pageScrollSubjectTo(page, m.ref, ctx.obstructions.topInset + 8)) === null) continue;
      const fresh = (await pageEnumerate(page, { refs: [m.ref] })).subjects.find((s) => s.key === m.key);
      if (!fresh || boundsOfRects(fresh.rects).height > clear) continue;
      const overlays = await pageOverlays(page, fresh.key, false);

      const outcome = await measureRectsOnce(page, fresh, fresh.rects, overlays.length > 0);
      if (outcome.kind !== 'measured') continue;
      const again = finalizeMeasured(fresh, outcome.result, 'rest', outcome.a, ctx, overlays.length ? 'always' : 'fail');

      if (overlays.length === 0) {
        if (again.verdict === 'pass' && m.status === 'measured') {
          state.done.set(m.key, again);
          counts.cleared++;
        }
        continue;
      }
      if (again.verdict === 'fail' && m.status === 'measured') continue; // the text fails on its own
      m.obscuredBy = overlays;
      m.unobscured = {
        verdict: again.verdict as 'pass' | 'fail',
        ratio: again.ratio as number,
        minRatio: again.minRatio as number,
        medianRatio: again.medianRatio as number,
        glyphPixels: again.glyphPixels as number,
        fgColor: again.fgColor,
        worstBgColor: again.worstBgColor,
        cropPath: again.cropPath,
        overlayPath: again.overlayPath,
        cropWidth: again.cropWidth,
        cropHeight: again.cropHeight,
      };
      counts.obscured++;
    } catch {
      /* best-effort: the original result stands */
    }
  }
  return counts;
}

export async function measureRemaining(page: Page, state: GlyphRunState, ctx: MeasureContext): Promise<void> {
  const startedAt = Date.now();
  const budgetMs = ctx.budgetMs ?? 120_000;
  const maxRestSubjects = ctx.maxRestSubjects ?? 400;
  const viewport = page.viewportSize();
  const vh = viewport ? viewport.height : 0;

  const { subjects } = await pageEnumerate(page, {});
  for (const s of subjects) {
    if (!state.done.has(s.key)) state.pending.set(s.key, s);
  }

  let iterations = 0;
  const reasonCounts: Record<'never-stable' | 'occluded' | 'cap' | 'error', number> = {
    'never-stable': 0,
    occluded: 0,
    cap: 0,
    error: 0,
  };

  while (state.pending.size > 0) {
    if (Date.now() - startedAt > budgetMs) break;
    if (iterations >= maxRestSubjects) break;
    iterations++;

    let target: PageTextSubject | null = null;
    for (const s of state.pending.values()) {
      if (!target || s.box.y < target.box.y) target = s;
    }
    if (!target) break;
    const targetKey = target.key;

    try {
      const rect = await pageScrollSubjectTo(page, target.ref, ctx.obstructions.topInset + 8);
      if (rect === null) {
        state.pending.delete(targetKey);
        state.done.set(targetKey, unmeasuredSubject(target, 'error'));
        reasonCounts.error++;
        continue;
      }

      // measureBand measures everything eligible at this scroll position, not
      // just the target — a whole screen's worth of progress per iteration.
      await measureBand(page, state, ctx);
      if (state.done.has(targetKey)) continue;

      const fresh = state.pending.get(targetKey) ?? target; // measureBand refreshes rects/box on re-enumerate
      const measured = await measureAtRest(page, fresh, ctx, vh);
      state.pending.delete(targetKey);
      state.done.set(targetKey, measured);
      if (measured.status === 'unmeasured' && measured.unmeasuredReason) reasonCounts[measured.unmeasuredReason]++;
    } catch {
      state.pending.delete(targetKey);
      state.done.set(targetKey, unmeasuredSubject(target, 'error'));
      reasonCounts.error++;
    }
  }

  // Anything left when the budget/iteration cap ran out is unmeasured, not
  // silently dropped — a coverage gap is reported for it (plan §4.4).
  for (const [key, s] of state.pending) {
    state.done.set(key, unmeasuredSubject(s, 'cap'));
    reasonCounts.cap++;
  }
  state.pending.clear();

  const attributed = await attributeOverlays(page, state, ctx, vh);

  // Every subject in `done` — measured in an earlier band, measured here, or
  // unmeasured — gets its cascade diagnostics and an at-rest box re-read, so
  // callers emit exactly one list with no second describe() pass needed.
  const doneList = Array.from(state.done.values());
  const refs = Array.from(new Set(doneList.map((d) => d.ref)));
  const described = await pageDescribe(page, refs);
  const byRef = new Map(described.map((d) => [d.ref, d]));
  for (const m of doneList) {
    const d = byRef.get(m.ref);
    if (d) {
      m.sourceFile = d.sourceFile;
      m.scopeId = d.scopeId;
      m.fgVars = d.fgVars;
      m.bgVars = d.bgVars;
      m.bgImageVars = d.bgImageVars;
      m.flat = d.flat;
      m.bgColor = d.bgColor;
      m.cascadeRatio = d.cascadeRatio;
    }
    const box = await pageBoxOf(page, m.ref);
    if (box) m.box = box;
  }

  if (ctx.trace) {
    let measured = 0, pass = 0, fail = 0, unmeasured = 0;
    for (const m of doneList) {
      if (m.status === 'measured') {
        measured++;
        if (m.verdict === 'pass') pass++;
        else fail++;
      } else {
        unmeasured++;
      }
    }
    ctx.trace(
      `glyph-measure: rest pass measured ${measured} text element(s) (${pass} pass, ${fail} fail), ` +
        `${unmeasured} unmeasured [never-stable ${reasonCounts['never-stable']}, occluded ${reasonCounts.occluded}, ` +
        `cap ${reasonCounts.cap}, error ${reasonCounts.error}], ${iterations} rest iteration(s), ` +
        `${attributed.obscured} obscured by an overlay, ${attributed.cleared} cleared on re-check, ${Date.now() - startedAt}ms`,
    );
  }
}
