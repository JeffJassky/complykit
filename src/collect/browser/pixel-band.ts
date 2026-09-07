import { PNG } from 'pngjs';
import type { ContrastCandidate } from './contrast.js';

// Pitfall #1 escalation (browser-analysis-design mitigation table, row 1). When
// the effective background is NOT a flat colour (image/gradient/overlap), we do
// not guess a ratio from styles. Instead we pixel-sample the element's region
// from the already-captured full-page screenshot: the min contrast over sampled
// background pixels vs the text colour gives a MEASURED range. A range that
// clearly passes or clearly fails resolves deterministically; only the ambiguous
// band escalates to C1 (M4) — which shrinks C1 volume a lot for ~free.

export type Band = 'pass' | 'fail' | 'ambiguous';

export interface PixelSample {
  x: number; // absolute screenshot pixel coords
  y: number;
}

export interface PixelBandResult {
  band: Band;
  minRatio: number;
  maxRatio: number;
  sampled: number;
  // Visualization payload (evidence): the background-classified pixels and the
  // colours behind the verdict, so a report can show exactly what was measured.
  samples: PixelSample[]; // bounded subset of background pixels, absolute coords
  fgColor: string; // rgb(...) — the text colour
  bgLoColor: string; // rgb(...) — darkest sampled background pixel
  bgHiColor: string; // rgb(...) — lightest sampled background pixel
  ratioLo: number; // contrast of text vs the darkest background pixel
  ratioHi: number; // contrast of text vs the lightest background pixel
}

function srgbToLin(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
function luminance(r: number, g: number, b: number): number {
  return 0.2126 * srgbToLin(r) + 0.7152 * srgbToLin(g) + 0.0722 * srgbToLin(b);
}
function contrast(l1: number, l2: number): number {
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}
function parseRgb(s: string): [number, number, number] | null {
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const [r, g, b] = m[1].split(',').map((p) => parseFloat(p.trim()));
  return [r, g, b];
}

const HIST_BINS = 64;

/**
 * Recover the element's background luminance band from the screenshot, EXCLUDING
 * the text glyphs and — critically — their anti-aliasing halo.
 *
 * The naive approach (sample the box, drop pixels near the text colour) fails on
 * every antialiased glyph: rendering blends text→background across a 1–2px edge,
 * a continuum no fixed luminance threshold can cleanly cut, so halo pixels survive
 * and drag the measured "background" toward the text colour — the bogus ~1.05
 * contrast floor seen on almost every element.
 *
 * Instead we treat it as clustering. Background occupies the large MAJORITY of a
 * text element's area; ink is a minority and its anti-aliasing is a minority
 * spread thinly across the transition. So we histogram the region's luminances
 * and take the dominant cluster — the mode and the contiguous populated bins
 * around it — as the background. Anti-aliasing bins sit in the sparse valley
 * between the background peak and the (smaller) ink peak, below the population
 * threshold, so they are excluded by construction; a distinct icon/border is a
 * separate minority cluster and excluded too. A flat background collapses to a
 * near-exact value; a real gradient keeps a true (tight) range.
 */
export function pixelBand(png: PNG, candidate: ContrastCandidate, boxOverride?: ContrastCandidate['box']): PixelBandResult | null {
  // Gradient text has no single ink colour: `background-clip: text` paints the
  // glyphs with the element's own gradient and the CSS colour is transparent.
  // It is still measurable — the glyphs are the pixels that are NOT the
  // ground. Same histogram, but the ink is read from the image too: every
  // populated luminance run other than the background's, with the sparse
  // anti-aliasing valley excluded by the same floor. The verdict is the worst
  // glyph pixel against the worst ground pixel, which is what the reader gets.
  const inkFromPixels = candidate.paintedByBackground === true;
  const fg = inkFromPixels ? null : parseRgb(candidate.textColor);
  if (!fg && !inkFromPixels) return null;
  const fgLum = fg ? luminance(fg[0], fg[1], fg[2]) : 0;

  // Which coordinates address this element IN THIS IMAGE: a band capture is
  // viewport-relative, a full-page/composite capture is capture-space.
  const box = boxOverride ?? candidate.box;
  // A very small element is almost all ink. The clustering below assumes the
  // background is the majority of the region — true for a word, false for a
  // one-letter word: `<span class="word">I</span>` is about four pixels wide,
  // its glyph fills most of them, and the "background" cluster it finds is the
  // ink. That is why 64 single-letter spans in a transcript demo came back
  // unmeasured while every multi-letter sibling measured cleanly.
  //
  // Padding a few pixels outward fixes it without changing what is measured:
  // the pixels immediately around a word belong to the same surface it sits on
  // (inter-word space, line leading), so they are the ground, not a neighbour's.
  const PAD = 3;
  const tight = box.width < 24 || box.height < 24;
  const x0 = Math.max(0, Math.floor(box.x) - (tight ? PAD : 0));
  const y0 = Math.max(0, Math.floor(box.y) - (tight ? PAD : 0));
  const x1 = Math.min(png.width, Math.ceil(box.x + box.width) + (tight ? PAD : 0));
  const y1 = Math.min(png.height, Math.ceil(box.y + box.height) + (tight ? PAD : 0));
  if (x1 <= x0 || y1 <= y0) return null;

  // Histogram luminance over a bounded grid. Track per-bin min/max of the actual
  // pixel luminances so the reported band uses measured values, not bin edges.
  const counts = new Int32Array(HIST_BINS);
  const binMin = new Float64Array(HIST_BINS).fill(Infinity);
  const binMax = new Float64Array(HIST_BINS).fill(-Infinity);
  // Retain each sampled pixel so, once the background band is known, we can point
  // back at the exact pixels behind the verdict (evidence overlay).
  const px: number[] = [];
  const py: number[] = [];
  const pl: number[] = [];
  const pr: number[] = [];
  const pg: number[] = [];
  const pb: number[] = [];
  const stepX = Math.max(1, Math.floor((x1 - x0) / 60));
  const stepY = Math.max(1, Math.floor((y1 - y0) / 60));
  for (let y = y0; y < y1; y += stepY) {
    for (let x = x0; x < x1; x += stepX) {
      const idx = (png.width * y + x) << 2;
      const r = png.data[idx], g = png.data[idx + 1], b = png.data[idx + 2];
      const l = luminance(r, g, b);
      const bin = Math.min(HIST_BINS - 1, Math.max(0, Math.floor(l * HIST_BINS)));
      counts[bin]++;
      if (l < binMin[bin]) binMin[bin] = l;
      if (l > binMax[bin]) binMax[bin] = l;
      px.push(x); py.push(y); pl.push(l); pr.push(r); pg.push(g); pb.push(b);
    }
  }
  if (px.length === 0) return null;

  // Background = the largest cluster by TOTAL AREA, not the tallest single bin.
  // A gradient background spreads its pixels across many short bins whose sum
  // still dwarfs any concentrated ink/halo/icon spike; splitting the histogram
  // into contiguous runs of populated bins and picking the run with the most
  // pixels isolates it. The sparse anti-aliasing valley (few pixels per
  // intermediate blend value) drops below the populated floor and separates the
  // background run from the ink run, so halo pixels never join the background.
  let maxCount = 0;
  for (let i = 0; i < HIST_BINS; i++) if (counts[i] > maxCount) maxCount = counts[i];
  const floor = Math.max(2, maxCount * 0.05);

  let bestArea = -1;
  let bgMinLum = Infinity;
  let bgMaxLum = -Infinity;
  let bgPixels = 0;
  let i = 0;
  while (i < HIST_BINS) {
    if (counts[i] < floor) { i++; continue; }
    let area = 0;
    let runMin = Infinity;
    let runMax = -Infinity;
    while (i < HIST_BINS && counts[i] >= floor) {
      area += counts[i];
      if (binMin[i] < runMin) runMin = binMin[i];
      if (binMax[i] > runMax) runMax = binMax[i];
      i++;
    }
    if (area > bestArea) {
      bestArea = area;
      bgMinLum = runMin;
      bgMaxLum = runMax;
      bgPixels = area;
    }
  }
  if (bgPixels === 0 || bgMinLum === Infinity) return null;

  let minRatio: number;
  let maxRatio: number;
  let inkLo = -1;
  let inkHi = -1;
  if (inkFromPixels) {
    // Ink = every populated run that is not the background run. Track the ink
    // pixels nearest the background in luminance (worst case) and farthest
    // (best case).
    let worst = Infinity;
    let best = -Infinity;
    for (let k = 0; k < pl.length; k++) {
      const l = pl[k];
      if (l >= bgMinLum - 1e-9 && l <= bgMaxLum + 1e-9) continue; // background
      const bin = Math.min(HIST_BINS - 1, Math.max(0, Math.floor(l * HIST_BINS)));
      if (counts[bin] < floor) continue; // anti-aliasing valley
      const r = Math.min(contrast(l, bgMinLum), contrast(l, bgMaxLum));
      const R = Math.max(contrast(l, bgMinLum), contrast(l, bgMaxLum));
      if (r < worst) { worst = r; inkLo = k; }
      if (R > best) { best = R; inkHi = k; }
    }
    if (inkLo < 0) return null; // no ink cluster distinct from the ground
    minRatio = worst;
    maxRatio = best;
  } else {
    // Worst case: the background pixel whose contrast with the text is LOWEST.
    const ratioAtMin = contrast(fgLum, bgMinLum);
    const ratioAtMax = contrast(fgLum, bgMaxLum);
    minRatio = Math.min(ratioAtMin, ratioAtMax);
    maxRatio = Math.max(ratioAtMin, ratioAtMax);
  }
  const req = candidate.required;

  let band: Band;
  if (minRatio >= req) band = 'pass';
  else if (maxRatio < req) band = 'fail';
  else band = 'ambiguous';

  // Collect the background-classified pixels (luminance within the chosen band)
  // for the evidence overlay, plus the exact colours at the band extremes.
  const rgbStr = (r: number, g: number, b: number): string => `rgb(${r}, ${g}, ${b})`;
  const EPS = 1e-9;
  let loIdx = -1, hiIdx = -1;
  const bgIdx: number[] = [];
  for (let k = 0; k < pl.length; k++) {
    if (pl[k] >= bgMinLum - EPS && pl[k] <= bgMaxLum + EPS) {
      bgIdx.push(k);
      if (loIdx < 0 || pl[k] < pl[loIdx]) loIdx = k;
      if (hiIdx < 0 || pl[k] > pl[hiIdx]) hiIdx = k;
    }
  }
  // Evenly thin the background pixels to a bounded set of overlay markers.
  const MAX_MARKERS = 24;
  const samples: PixelSample[] = [];
  const stride = Math.max(1, Math.floor(bgIdx.length / MAX_MARKERS));
  for (let k = 0; k < bgIdx.length && samples.length < MAX_MARKERS; k += stride) {
    const idx = bgIdx[k];
    samples.push({ x: px[idx], y: py[idx] });
  }
  const lo = loIdx >= 0 ? loIdx : 0;
  const hi = hiIdx >= 0 ? hiIdx : 0;

  const fgOut: [number, number, number] = fg
    ? [fg[0], fg[1], fg[2]]
    : [pr[inkLo], pg[inkLo], pb[inkLo]]; // the worst glyph pixel, for the swatch
  return {
    band,
    minRatio: Math.round(minRatio * 100) / 100,
    maxRatio: Math.round(maxRatio * 100) / 100,
    sampled: bgPixels,
    samples,
    fgColor: rgbStr(fgOut[0], fgOut[1], fgOut[2]),
    bgLoColor: rgbStr(pr[lo], pg[lo], pb[lo]),
    bgHiColor: rgbStr(pr[hi], pg[hi], pb[hi]),
    ratioLo: Math.round((fg ? contrast(fgLum, pl[lo]) : minRatio) * 100) / 100,
    ratioHi: Math.round((fg ? contrast(fgLum, pl[hi]) : maxRatio) * 100) / 100,
  };
}

/** Decode a PNG buffer once; callers sample many candidates against it. */
export function decodePng(buffer: Buffer): PNG {
  return PNG.sync.read(buffer);
}
