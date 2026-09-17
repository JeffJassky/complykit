import { PNG } from 'pngjs';

// Pure pixel/colour math for glyph-mask contrast measurement (plan §4.1). No
// DOM, no Playwright: everything here operates on decoded PNGs and plain
// numbers so it can be unit-tested without a browser and reused by both the
// per-band and rest-pass orchestration in glyph-measure.ts.

export interface Rgb { r: number; g: number; b: number }
export interface Rect { x: number; y: number; width: number; height: number }

function srgbToLin(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

// WCAG 2.x relative luminance, sRGB 0.03928 knee (same formula as pixel-band.ts;
// duplicated here rather than imported because this module must stay
// dependency-free — pixel-band.ts is being deleted by Wave 3 D).
export function relLuminance(c: Rgb): number {
  return 0.2126 * srgbToLin(c.r) + 0.7152 * srgbToLin(c.g) + 0.0722 * srgbToLin(c.b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export function composite(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return {
    r: fg.r * alpha + bg.r * (1 - alpha),
    g: fg.g * alpha + bg.g * (1 - alpha),
    b: fg.b * alpha + bg.b * (1 - alpha),
  };
}

// rgb()/rgba(), comma or space syntax, optional "/ a" alpha (percentage or
// fraction). Anything else — named colours, hex, currentColor, gradients —
// returns null: the caller (glyph-init describe / glyph-measure) is
// responsible for resolving those to rgb() via getComputedStyle before this
// module ever sees them.
export function parseCssColor(s: string): { rgb: Rgb; alpha: number } | null {
  const m = s.trim().match(/^rgba?\(\s*([^)]+)\s*\)$/i);
  if (!m) return null;
  // Split on the slash first (alpha), then tokenize the colour part on comma
  // OR whitespace so both `rgb(1, 2, 3)` and the modern `rgb(1 2 3 / 50%)`
  // syntax parse with one code path.
  const [colorPart, alphaPart] = m[1].split('/').map((p) => p.trim());
  const tokens = colorPart.split(/[\s,]+/).filter((t) => t.length > 0);
  if (tokens.length < 3) return null;
  const chan = (t: string): number | null => {
    if (t.endsWith('%')) {
      const v = parseFloat(t);
      return Number.isNaN(v) ? null : (v / 100) * 255;
    }
    const v = parseFloat(t);
    return Number.isNaN(v) ? null : v;
  };
  const r = chan(tokens[0]);
  const g = chan(tokens[1]);
  const b = chan(tokens[2]);
  if (r === null || g === null || b === null) return null;
  let alpha = 1;
  // rgba(r,g,b,a) puts alpha as a 4th comma token instead of after a slash.
  const alphaToken = alphaPart ?? tokens[3];
  if (alphaToken !== undefined) {
    if (alphaToken.endsWith('%')) {
      const v = parseFloat(alphaToken);
      if (Number.isNaN(v)) return null;
      alpha = v / 100;
    } else {
      const v = parseFloat(alphaToken);
      if (Number.isNaN(v)) return null;
      alpha = v;
    }
  }
  return { rgb: { r, g, b }, alpha };
}

export function rgbString(c: Rgb): string {
  return `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;
}

export function floor2(n: number): number {
  return Math.floor(n * 100) / 100;
}

const HIST_BINS = 2001; // index = clamp(floor((ratio - 1) * 100), 0, 2000)

function ratioBinIndex(ratio: number): number {
  return Math.min(HIST_BINS - 1, Math.max(0, Math.floor((ratio - 1) * 100)));
}

function binValue(index: number): number {
  return 1 + index / 100;
}

// A 2001-bin fixed histogram over contrast ratio [1, 21+]. Fixed bins (rather
// than a sorted array of every glyph pixel) keep a 100k+ pixel band cheap:
// O(1) per pixel with no allocation, and rank queries are a single linear
// scan over 2001 buckets instead of a sort of the whole pixel population.
export class RatioHistogram {
  readonly counts: Uint32Array;
  total: number;

  constructor() {
    this.counts = new Uint32Array(HIST_BINS);
    this.total = 0;
  }

  add(ratio: number, n = 1): void {
    if (n <= 0) return;
    this.counts[ratioBinIndex(ratio)] += n;
    this.total += n;
  }

  merge(other: RatioHistogram): void {
    for (let i = 0; i < HIST_BINS; i++) this.counts[i] += other.counts[i];
    this.total += other.total;
  }

  valueAtRank(rank: number): number {
    if (this.total === 0) return NaN;
    const r = Math.min(this.total - 1, Math.max(0, rank));
    let cum = 0;
    for (let i = 0; i < HIST_BINS; i++) {
      cum += this.counts[i];
      if (cum > r) return binValue(i);
    }
    // Unreachable if total is accurate, but keep a safe fallback rather than
    // NaN-poisoning a downstream verdict.
    return binValue(HIST_BINS - 1);
  }

  min(): number {
    return this.valueAtRank(0);
  }

  max(): number {
    return this.valueAtRank(this.total - 1);
  }

  median(): number {
    return this.valueAtRank(Math.floor((this.total - 1) / 2));
  }
}

export const TRIM_FRACTION = 0.01;
export const MIN_RANK = 4; // the verdict is never worse than the 5th-worst pixel

export interface Verdict {
  verdict: 'pass' | 'fail';
  ratio: number;
  min: number;
  median: number;
  max: number;
  glyphPixels: number;
  failingPixels: number;
}

// Verdict ratio = the 1st-percentile pixel, but never worse than the 5th
// worst pixel (MIN_RANK): on a small glyph population (a few hundred
// pixels), a literal 1% trim is 1-2 pixels and one stray anti-aliasing
// speck can flip the verdict; MIN_RANK bounds how much a single outlier
// pixel can move the reported ratio on small subjects, while TRIM_FRACTION
// dominates once there are enough pixels for percentile trimming to be
// statistically meaningful.
export function decideVerdict(hist: RatioHistogram, required: number): Verdict {
  const total = hist.total;
  const rank = total > 0 ? Math.min(total - 1, Math.max(MIN_RANK, Math.floor(TRIM_FRACTION * total))) : 0;
  const ratio = hist.valueAtRank(rank);
  let failingPixels = 0;
  for (let i = 0; i < HIST_BINS; i++) {
    if (binValue(i) < required) failingPixels += hist.counts[i];
  }
  return {
    verdict: total > 0 && ratio < required ? 'fail' : 'pass',
    ratio,
    min: hist.min(),
    median: hist.median(),
    max: hist.max(),
    glyphPixels: total,
    failingPixels,
  };
}

export const DIFF_FLOOR = 6; // |ΔR|+|ΔG|+|ΔB| at or below this = no change
export const MASK_FRACTION = 0.25; // glyph pixel: d >= max(DIFF_FLOOR, MASK_FRACTION*maxDiff)
export const CORE_FRACTION = 0.6; // core pixel: d >= max(DIFF_FLOOR, CORE_FRACTION*maxDiff)
export const INK_TOLERANCE = 36; // |pred−A| channel sum for an ink match
export const INK_MIN_MATCHES = 3;

export interface GlyphInput {
  a: PNG;
  b: PNG;
  rects: Rect[];
  fg: { rgb: Rgb; alpha: number } | null;
  opacity: number;
  required: number;
}

export interface GlyphResult {
  status: 'measured' | 'no-diff';
  maxDiff: number;
  hist: RatioHistogram;
  fgSource: 'css' | 'rendered';
  worst: { fg: Rgb; bg: Rgb; ratio: number } | null;
  best: { fg: Rgb; bg: Rgb; ratio: number } | null;
  maskRect: Rect;
  mask: Uint8Array;
}

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

// Visits every integer pixel that is inside at least one rect (clipped to the
// image), each pixel exactly once even where rects overlap. `inside` is
// reused across calls (no per-pixel Set/array allocation) — needed because
// bands can carry 100k+ pixels across dozens of rects.
function forEachRectPixel(
  rects: Rect[],
  maskRect: Rect,
  imgWidth: number,
  imgHeight: number,
  visit: (x: number, y: number, maskIdx: number) => void,
): void {
  if (maskRect.width === 0 || maskRect.height === 0) return;
  // Row-major "already visited this row's span" tracking via a per-row visited
  // buffer, reset per row, so overlapping rects don't double count.
  const rowVisited = new Uint8Array(maskRect.width);
  for (let y = maskRect.y; y < maskRect.y + maskRect.height; y++) {
    rowVisited.fill(0);
    for (const r of rects) {
      const rx0 = Math.max(0, Math.floor(r.x));
      const ry0 = Math.max(0, Math.floor(r.y));
      const rx1 = Math.min(imgWidth, Math.ceil(r.x + r.width));
      const ry1 = Math.min(imgHeight, Math.ceil(r.y + r.height));
      if (y < ry0 || y >= ry1) continue;
      for (let x = rx0; x < rx1; x++) {
        const col = x - maskRect.x;
        if (rowVisited[col]) continue;
        rowVisited[col] = 1;
        const maskIdx = (y - maskRect.y) * maskRect.width + col;
        visit(x, y, maskIdx);
      }
    }
  }
}

function pixelAt(png: PNG, x: number, y: number): Rgb {
  const idx = (png.width * y + x) << 2;
  return { r: png.data[idx], g: png.data[idx + 1], b: png.data[idx + 2] };
}

function channelSum(a: Rgb, b: Rgb): number {
  return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
}

export function measureGlyphs(input: GlyphInput): GlyphResult {
  const { a, b, rects, fg, opacity, required } = input;
  const maskRect = rectBounds(rects, a.width, a.height);
  const hist = new RatioHistogram();

  if (maskRect.width === 0 || maskRect.height === 0) {
    return {
      status: 'no-diff',
      maxDiff: 0,
      hist,
      fgSource: 'css',
      worst: null,
      best: null,
      maskRect,
      mask: new Uint8Array(0),
    };
  }

  const mask = new Uint8Array(maskRect.width * maskRect.height);

  // Hiding glyphs can only take ink AWAY. A rendered glyph pixel is the text
  // colour blended over its background, A = α·fg + (1−α)·B, so A is never
  // farther from the text colour than B is. A pixel that moves TOWARD the text
  // colour in B gained paint instead — something the hide step switched on,
  // not a glyph. That happened in the field: a style write matched a page's
  // `[style*=border-top-color]` rule and drew a black border in B, and every
  // pixel of it measured the text against itself at 1:1. Such pixels are never
  // glyphs, whatever caused them.
  const addedPaint = (pa: Rgb, pb: Rgb): boolean => fg !== null && channelSum(pb, fg.rgb) < channelSum(pa, fg.rgb) - DIFF_FLOOR;

  // Step 1: maxDiff over every rect pixel.
  let maxDiff = 0;
  forEachRectPixel(rects, maskRect, a.width, a.height, (x, y) => {
    const pa = pixelAt(a, x, y);
    const pb = pixelAt(b, x, y);
    if (addedPaint(pa, pb)) return;
    const d = channelSum(pa, pb);
    if (d > maxDiff) maxDiff = d;
  });

  if (maxDiff <= DIFF_FLOOR) {
    return {
      status: 'no-diff',
      maxDiff,
      hist,
      fgSource: 'css',
      worst: null,
      best: null,
      maskRect,
      mask,
    };
  }

  const glyphThreshold = Math.max(DIFF_FLOOR, MASK_FRACTION * maxDiff);
  const coreThreshold = Math.max(DIFF_FLOOR, CORE_FRACTION * maxDiff);

  // Step 3/4: classify glyph vs core, and — if fg is known — test whether the
  // CSS-predicted ink colour actually matches what Chromium rendered at core
  // pixels. Two passes over the same pixel set (classify, then verify ink)
  // rather than one, because INK_MIN_MATCHES needs the total core count first.
  let coreCount = 0;
  let inkMatches = 0;
  let ea = 0;
  if (fg !== null) {
    ea = fg.alpha * opacity;
    forEachRectPixel(rects, maskRect, a.width, a.height, (x, y) => {
      const pa = pixelAt(a, x, y);
      const pb = pixelAt(b, x, y);
      if (addedPaint(pa, pb)) return;
      const d = channelSum(pa, pb);
      if (d < coreThreshold) return;
      coreCount++;
      const pred = composite(fg.rgb, ea, pb);
      if (channelSum(pred, pa) <= INK_TOLERANCE) inkMatches++;
    });
  }

  const useCss = fg !== null && inkMatches >= Math.min(INK_MIN_MATCHES, coreCount);
  const fgSource: 'css' | 'rendered' = useCss ? 'css' : 'rendered';

  let worst: { fg: Rgb; bg: Rgb; ratio: number } | null = null;
  let best: { fg: Rgb; bg: Rgb; ratio: number } | null = null;

  forEachRectPixel(rects, maskRect, a.width, a.height, (x, y, maskIdx) => {
    const pa = pixelAt(a, x, y);
    const pb = pixelAt(b, x, y);
    if (addedPaint(pa, pb)) return;
    const d = channelSum(pa, pb);
    const isGlyph = d >= glyphThreshold;
    const isCore = d >= coreThreshold;
    if (!isGlyph) return;

    let contributes = false;
    let pixelFg: Rgb = pa;
    if (useCss) {
      // fg is non-null whenever useCss is true.
      pixelFg = composite((fg as { rgb: Rgb; alpha: number }).rgb, ea, pb);
      contributes = true;
    } else if (isCore) {
      pixelFg = pa;
      contributes = true;
    }
    if (!contributes) {
      mask[maskIdx] = 0;
      return;
    }

    const ratio = contrastRatio(pixelFg, pb);
    hist.add(ratio);
    mask[maskIdx] = ratio < required ? 2 : 1;

    if (worst === null || ratio < worst.ratio) worst = { fg: pixelFg, bg: pb, ratio };
    if (best === null || ratio > best.ratio) best = { fg: pixelFg, bg: pb, ratio };
  });

  return { status: 'measured', maxDiff, hist, fgSource, worst, best, maskRect, mask };
}

// 2 → rgba(255,0,200,235) magenta (failing), 1 → rgba(0,229,255,150) cyan
// (passing), 0 → transparent. Matches plan §4.1 / the HTML report legend.
export function renderOverlay(result: GlyphResult): Buffer {
  const { width, height } = result.maskRect;
  const png = new PNG({ width: Math.max(1, width), height: Math.max(1, height) });
  png.data.fill(0);
  for (let i = 0; i < result.mask.length; i++) {
    const v = result.mask[i];
    const idx = i << 2;
    if (v === 2) {
      png.data[idx] = 255; png.data[idx + 1] = 0; png.data[idx + 2] = 200; png.data[idx + 3] = 235;
    } else if (v === 1) {
      png.data[idx] = 0; png.data[idx + 1] = 229; png.data[idx + 2] = 255; png.data[idx + 3] = 150;
    } else {
      png.data[idx] = 0; png.data[idx + 1] = 0; png.data[idx + 2] = 0; png.data[idx + 3] = 0;
    }
  }
  return PNG.sync.write(png);
}

export function cropPng(png: PNG, rect: Rect): Buffer {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(png.width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(png.height, Math.ceil(rect.y + rect.height));
  const w = Math.max(0, x1 - x0);
  const h = Math.max(0, y1 - y0);
  const out = new PNG({ width: Math.max(1, w), height: Math.max(1, h) });
  out.data.fill(0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = (png.width * (y0 + y) + (x0 + x)) << 2;
      const dst = (out.width * y + x) << 2;
      out.data[dst] = png.data[src];
      out.data[dst + 1] = png.data[src + 1];
      out.data[dst + 2] = png.data[src + 2];
      out.data[dst + 3] = png.data[src + 3];
    }
  }
  return PNG.sync.write(out);
}

// True when A and A2 differ (d > DIFF_FLOOR) at any pixel inside rects — the
// page moved between the two "normal" screenshots (JS-driven animation,
// layout shift), so whatever B captured in between is untrustworthy and the
// caller must retry rather than trust this measurement.
export function regionChanged(a: PNG, a2: PNG, rects: Rect[]): boolean {
  const maskRect = rectBounds(rects, a.width, a.height);
  if (maskRect.width === 0 || maskRect.height === 0) return false;
  let changed = false;
  forEachRectPixel(rects, maskRect, a.width, a.height, (x, y) => {
    if (changed) return;
    const pa = pixelAt(a, x, y);
    const pa2 = pixelAt(a2, x, y);
    if (channelSum(pa, pa2) > DIFF_FLOOR) changed = true;
  });
  return changed;
}
