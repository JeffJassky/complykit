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

export interface PixelBandResult {
  band: Band;
  minRatio: number;
  maxRatio: number;
  sampled: number;
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

/**
 * Sample the candidate's background band from the screenshot. We approximate the
 * background by the lightest and darkest pixels in the region (text sits between
 * them); the WORST-case contrast over that band is what we report, so we never
 * over-claim a pass.
 */
export function pixelBand(png: PNG, candidate: ContrastCandidate): PixelBandResult | null {
  const fg = parseRgb(candidate.textColor);
  if (!fg) return null;
  const fgLum = luminance(fg[0], fg[1], fg[2]);

  const x0 = Math.max(0, Math.floor(candidate.box.x));
  const y0 = Math.max(0, Math.floor(candidate.box.y));
  const x1 = Math.min(png.width, Math.ceil(candidate.box.x + candidate.box.width));
  const y1 = Math.min(png.height, Math.ceil(candidate.box.y + candidate.box.height));
  if (x1 <= x0 || y1 <= y0) return null;

  // Sample a bounded grid of pixels in the region; collect background luminance
  // extremes (pixels far in luminance from the text colour are likely bg).
  let minLum = Infinity;
  let maxLum = -Infinity;
  let sampled = 0;
  const stepX = Math.max(1, Math.floor((x1 - x0) / 40));
  const stepY = Math.max(1, Math.floor((y1 - y0) / 40));
  for (let y = y0; y < y1; y += stepY) {
    for (let x = x0; x < x1; x += stepX) {
      const idx = (png.width * y + x) << 2;
      const r = png.data[idx];
      const g = png.data[idx + 1];
      const b = png.data[idx + 2];
      const l = luminance(r, g, b);
      // Skip pixels within the text colour's luminance (likely the glyphs).
      if (Math.abs(l - fgLum) < 0.02) continue;
      if (l < minLum) minLum = l;
      if (l > maxLum) maxLum = l;
      sampled++;
    }
  }
  if (sampled === 0 || minLum === Infinity) return null;

  // Worst case: the background pixel whose contrast with the text is LOWEST.
  const ratioAtMin = contrast(fgLum, minLum);
  const ratioAtMax = contrast(fgLum, maxLum);
  const minRatio = Math.min(ratioAtMin, ratioAtMax);
  const maxRatio = Math.max(ratioAtMin, ratioAtMax);
  const req = candidate.required;

  let band: Band;
  if (minRatio >= req) band = 'pass';
  else if (maxRatio < req) band = 'fail';
  else band = 'ambiguous';

  return {
    band,
    minRatio: Math.round(minRatio * 100) / 100,
    maxRatio: Math.round(maxRatio * 100) / 100,
    sampled,
  };
}

/** Decode a PNG buffer once; callers sample many candidates against it. */
export function decodePng(buffer: Buffer): PNG {
  return PNG.sync.read(buffer);
}
