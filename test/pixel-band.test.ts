import { describe, it, expect } from 'vitest';
import { PNG } from 'pngjs';
import { pixelBand } from '../src/collect/browser/pixel-band.js';
import type { ContrastCandidate } from '../src/collect/browser/contrast.js';

function gray(png: PNG, x: number, y: number, v: number): void {
  const i = (png.width * y + x) << 2;
  png.data[i] = png.data[i + 1] = png.data[i + 2] = v;
  png.data[i + 3] = 255;
}

function candidate(over: Partial<ContrastCandidate> = {}): ContrastCandidate {
  return {
    cssPath: 'x', sourceFile: null, scopeId: null, textSample: 'x', fontSizePx: 16, bold: false, large: false,
    textColor: 'rgb(0,0,0)', bgColor: null, flat: false, ratio: null, required: 4.5,
    box: { x: 0, y: 0, width: 100, height: 40 },
    ...over,
  };
}

describe('pixelBand background recovery', () => {
  it('recovers a flat white background as a near-exact ratio despite antialiased glyphs', () => {
    // White bg, black ink columns, plus a graduated anti-aliasing halo around
    // each column — exactly what dragged the old measurement to a ~1.05 floor.
    const png = new PNG({ width: 100, height: 40 });
    for (let y = 0; y < 40; y++) for (let x = 0; x < 100; x++) gray(png, x, y, 255);
    for (let gx = 10; gx < 90; gx += 12) {
      for (let y = 8; y < 32; y++) {
        gray(png, gx, y, 0); gray(png, gx + 1, y, 0);       // ink
        gray(png, gx - 1, y, 90); gray(png, gx + 2, y, 90); // dark halo
        gray(png, gx - 2, y, 180); gray(png, gx + 3, y, 180); // light halo
      }
    }
    const res = pixelBand(png, candidate())!;
    expect(res).not.toBeNull();
    // True answer is black-on-white ≈ 21:1. The band must sit tightly there and
    // must NOT collapse toward the text colour (the old ~1.x floor bug).
    expect(res.minRatio).toBeGreaterThan(18);
    expect(res.band).toBe('pass');
    // Visualization payload: real sampled pixels + colour swatches.
    expect(res.samples.length).toBeGreaterThan(0);
    expect(res.fgColor).toBe('rgb(0, 0, 0)');
    expect(res.bgHiColor).toBe('rgb(255, 255, 255)');
    expect(res.ratioHi).toBeGreaterThan(18);
  });

  it('reports a real gradient background as a bounded range, not the full 1..21 span', () => {
    // Vertical gradient background (light→mid), dark text with halo.
    const png = new PNG({ width: 100, height: 40 });
    for (let y = 0; y < 40; y++) {
      const v = 230 - Math.round((y / 39) * 70); // 230 → 160
      for (let x = 0; x < 100; x++) gray(png, x, y, v);
    }
    for (let gx = 10; gx < 90; gx += 12) {
      for (let y = 8; y < 32; y++) {
        gray(png, gx, y, 0);                 // ink
        // Graduated anti-aliasing edge (ink → background), as real rendering does.
        gray(png, gx - 1, y, 60); gray(png, gx + 1, y, 60);
        gray(png, gx - 2, y, 130); gray(png, gx + 2, y, 130);
      }
    }
    const res = pixelBand(png, candidate())!;
    expect(res).not.toBeNull();
    // Band reflects the gradient (two distinct ends) but stays well above the
    // text colour — no bogus ~1.x floor from halo pixels.
    expect(res.minRatio).toBeGreaterThan(6);
    expect(res.maxRatio).toBeGreaterThan(res.minRatio);
  });

  it('ignores a minority icon/border colour inside the box', () => {
    // White bg with a small dark square (icon) occupying a corner + text halo.
    const png = new PNG({ width: 100, height: 40 });
    for (let y = 0; y < 40; y++) for (let x = 0; x < 100; x++) gray(png, x, y, 255);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) gray(png, x, y, 40); // icon
    for (let gx = 30; gx < 80; gx += 12) {
      for (let y = 8; y < 32; y++) { gray(png, gx, y, 0); gray(png, gx - 1, y, 120); }
    }
    const res = pixelBand(png, candidate())!;
    // Dominant cluster is the white bg; the icon is a minority cluster excluded.
    expect(res.minRatio).toBeGreaterThan(18);
  });
});
