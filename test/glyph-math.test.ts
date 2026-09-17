import { describe, it, expect } from 'vitest';
import { PNG } from 'pngjs';
import {
  relLuminance,
  contrastRatio,
  composite,
  parseCssColor,
  rgbString,
  floor2,
  RatioHistogram,
  TRIM_FRACTION,
  MIN_RANK,
  decideVerdict,
  measureGlyphs,
  renderOverlay,
  cropPng,
  regionChanged,
  DIFF_FLOOR,
  type Rgb,
  type Rect,
  type GlyphInput,
} from '../src/collect/browser/glyph-math.js';

const BLACK: Rgb = { r: 0, g: 0, b: 0 };
const WHITE: Rgb = { r: 255, g: 255, b: 255 };

function makePng(width: number, height: number, fill: Rgb = WHITE): PNG {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    const idx = i << 2;
    png.data[idx] = fill.r;
    png.data[idx + 1] = fill.g;
    png.data[idx + 2] = fill.b;
    png.data[idx + 3] = 255;
  }
  return png;
}

function fillRect(png: PNG, rect: Rect, rgb: Rgb): void {
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      if (x < 0 || y < 0 || x >= png.width || y >= png.height) continue;
      const idx = (png.width * y + x) << 2;
      png.data[idx] = rgb.r;
      png.data[idx + 1] = rgb.g;
      png.data[idx + 2] = rgb.b;
      png.data[idx + 3] = 255;
    }
  }
}

function setPixel(png: PNG, x: number, y: number, rgb: Rgb): void {
  const idx = (png.width * y + x) << 2;
  png.data[idx] = rgb.r;
  png.data[idx + 1] = rgb.g;
  png.data[idx + 2] = rgb.b;
  png.data[idx + 3] = 255;
}

function readPixel(png: PNG, x: number, y: number): { r: number; g: number; b: number; a: number } {
  const idx = (png.width * y + x) << 2;
  return { r: png.data[idx], g: png.data[idx + 1], b: png.data[idx + 2], a: png.data[idx + 3] };
}

describe('relLuminance / contrastRatio', () => {
  it('black vs white is exactly 21', () => {
    expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21, 5);
  });

  it('#767676 vs white passes at ~4.54', () => {
    const ratio = contrastRatio({ r: 0x76, g: 0x76, b: 0x76 }, WHITE);
    expect(ratio).toBeCloseTo(4.54, 1);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('#777777 vs white fails at ~4.48', () => {
    const ratio = contrastRatio({ r: 0x77, g: 0x77, b: 0x77 }, WHITE);
    expect(ratio).toBeCloseTo(4.48, 1);
    expect(ratio).toBeLessThan(4.5);
  });

  it('argument order is symmetric', () => {
    const a = { r: 20, g: 40, b: 200 };
    const b = { r: 210, g: 90, b: 30 };
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10);
  });

  it('composite blends fg over bg by alpha, unrounded', () => {
    const c = composite({ r: 0, g: 0, b: 0 }, 0.5, { r: 255, g: 255, b: 255 });
    expect(c.r).toBeCloseTo(127.5, 10);
    expect(c.g).toBeCloseTo(127.5, 10);
    expect(c.b).toBeCloseTo(127.5, 10);
  });
});

describe('parseCssColor', () => {
  it('parses comma rgb()', () => {
    expect(parseCssColor('rgb(1, 2, 3)')).toEqual({ rgb: { r: 1, g: 2, b: 3 }, alpha: 1 });
  });

  it('parses comma rgba() with decimal alpha', () => {
    expect(parseCssColor('rgba(1,2,3,0.5)')).toEqual({ rgb: { r: 1, g: 2, b: 3 }, alpha: 0.5 });
  });

  it('parses space syntax with percentage alpha', () => {
    expect(parseCssColor('rgb(1 2 3 / 50%)')).toEqual({ rgb: { r: 1, g: 2, b: 3 }, alpha: 0.5 });
  });

  it('parses space syntax with fractional alpha', () => {
    expect(parseCssColor('rgb(1 2 3 / .25)')).toEqual({ rgb: { r: 1, g: 2, b: 3 }, alpha: 0.25 });
  });

  it('parses a fully transparent colour', () => {
    expect(parseCssColor('rgba(0, 0, 0, 0)')).toEqual({ rgb: { r: 0, g: 0, b: 0 }, alpha: 0 });
  });

  it('returns null for unparseable input', () => {
    expect(parseCssColor('not-a-color')).toBeNull();
    expect(parseCssColor('#767676')).toBeNull();
    expect(parseCssColor('currentColor')).toBeNull();
  });
});

describe('rgbString / floor2', () => {
  it('rounds channels', () => {
    expect(rgbString({ r: 1.4, g: 2.6, b: 3.5 })).toBe('rgb(1, 3, 4)');
  });

  it('floors to 2 decimals without rounding up', () => {
    expect(floor2(4.5699)).toBe(4.56);
    expect(floor2(4.5)).toBe(4.5);
  });
});

describe('RatioHistogram', () => {
  it('floor-bins: 4.4999 lands at 4.49, 4.5 lands at 4.50', () => {
    const h1 = new RatioHistogram();
    h1.add(4.4999);
    expect(h1.valueAtRank(0)).toBeCloseTo(4.49, 10);

    const h2 = new RatioHistogram();
    h2.add(4.5);
    expect(h2.valueAtRank(0)).toBeCloseTo(4.5, 10);
  });

  it('clamps ratios above 21 into the top bin', () => {
    const h = new RatioHistogram();
    h.add(25);
    expect(h.valueAtRank(0)).toBeCloseTo(21, 10);
  });

  it('merges two histograms', () => {
    const h1 = new RatioHistogram();
    h1.add(2, 3);
    const h2 = new RatioHistogram();
    h2.add(10, 2);
    h1.merge(h2);
    expect(h1.total).toBe(5);
    expect(h1.min()).toBeCloseTo(2, 10);
    expect(h1.max()).toBeCloseTo(10, 10);
  });

  it('valueAtRank returns the bin of the pixel at that ascending rank', () => {
    const h = new RatioHistogram();
    h.add(2, 2); // ranks 0,1
    h.add(5, 1); // rank 2
    h.add(10, 1); // rank 3
    expect(h.valueAtRank(0)).toBeCloseTo(2, 10);
    expect(h.valueAtRank(1)).toBeCloseTo(2, 10);
    expect(h.valueAtRank(2)).toBeCloseTo(5, 10);
    expect(h.valueAtRank(3)).toBeCloseTo(10, 10);
  });

  it('min/median/max', () => {
    const h = new RatioHistogram();
    h.add(1, 1);
    h.add(5, 1);
    h.add(21, 1);
    expect(h.min()).toBeCloseTo(1, 10);
    expect(h.median()).toBeCloseTo(5, 10);
    expect(h.max()).toBeCloseTo(21, 10);
  });

  it('clamps rank into range', () => {
    const h = new RatioHistogram();
    h.add(3, 1);
    expect(h.valueAtRank(-5)).toBeCloseTo(3, 10);
    expect(h.valueAtRank(500)).toBeCloseTo(3, 10);
  });

  it('is NaN when empty', () => {
    const h = new RatioHistogram();
    expect(h.valueAtRank(0)).toBeNaN();
    expect(h.min()).toBeNaN();
    expect(h.max()).toBeNaN();
    expect(h.median()).toBeNaN();
  });
});

describe('decideVerdict', () => {
  it('trims outliers: 1000 pixels at 21 + 3 at 1.5 passes (rank 10)', () => {
    const h = new RatioHistogram();
    h.add(21, 1000);
    h.add(1.5, 3);
    const total = h.total; // 1003
    expect(Math.max(MIN_RANK, Math.floor(TRIM_FRACTION * total))).toBe(10);
    const v = decideVerdict(h, 4.5);
    expect(v.verdict).toBe('pass');
    expect(v.ratio).toBeCloseTo(21, 10);
    expect(v.glyphPixels).toBe(1003);
    expect(v.failingPixels).toBe(3);
  });

  it('enough outliers to reach the trimmed rank fails', () => {
    const h = new RatioHistogram();
    h.add(21, 1000);
    h.add(1.5, 3);
    h.add(1.5, 50); // 53 total at 1.5, occupying ranks 0..52
    const v = decideVerdict(h, 4.5);
    expect(v.verdict).toBe('fail');
    expect(v.ratio).toBeCloseTo(1.5, 10);
  });

  it('clamps rank to total-1 on tiny populations', () => {
    const h = new RatioHistogram();
    h.add(2, 1);
    h.add(5, 1);
    h.add(10, 1);
    // total=3, rank = min(2, max(4, floor(0.01*3))) = min(2, 4) = 2 -> highest value
    const v = decideVerdict(h, 4.5);
    expect(v.ratio).toBeCloseTo(10, 10);
    expect(v.glyphPixels).toBe(3);
  });

  it('ratio exactly equal to required passes (fail iff strictly less)', () => {
    const h = new RatioHistogram();
    h.add(4.5, 10);
    const v = decideVerdict(h, 4.5);
    expect(v.verdict).toBe('pass');
  });
});

describe('measureGlyphs: flat black-on-white with anti-aliased fringe', () => {
  it('measures every glyph pixel at 21:1, fgSource css, mask covers block+fringe', () => {
    const width = 40, height = 40;
    const b = makePng(width, height, WHITE);
    const a = makePng(width, height, WHITE);
    const block: Rect = { x: 14, y: 14, width: 10, height: 10 };
    fillRect(a, block, BLACK);
    // 1px anti-aliased fringe (#808080) around the block.
    const fringe: Rgb = { r: 128, g: 128, b: 128 };
    for (let x = block.x - 1; x <= block.x + block.width; x++) {
      setPixel(a, x, block.y - 1, fringe);
      setPixel(a, x, block.y + block.height, fringe);
    }
    for (let y = block.y - 1; y <= block.y + block.height; y++) {
      setPixel(a, block.x - 1, y, fringe);
      setPixel(a, block.x + block.width, y, fringe);
    }
    const rects: Rect[] = [{ x: block.x - 1, y: block.y - 1, width: block.width + 2, height: block.height + 2 }];
    const input: GlyphInput = { a, b, rects, fg: { rgb: BLACK, alpha: 1 }, opacity: 1, required: 4.5 };
    const result = measureGlyphs(input);

    expect(result.status).toBe('measured');
    expect(result.fgSource).toBe('css');
    // maxDiff from the pure-black interior pixels vs white background.
    expect(result.maxDiff).toBeCloseTo(765, 5);
    // Every glyph-mask ratio should be exactly 21 (black composited over white bg).
    for (let i = 0; i < result.mask.length; i++) {
      // mask value 0 means "not glyph"; skip those.
      if (result.mask[i] === 0) continue;
      expect(result.mask[i]).toBe(1); // passing (21 >= 4.5)
    }
    expect(result.hist.total).toBeGreaterThan(0);
    expect(result.hist.min()).toBeCloseTo(21, 5);
    const v = decideVerdict(result.hist, 4.5);
    expect(v.verdict).toBe('pass');
    // Fringe diff (381) is >= 0.25*maxDiff (191.25), so fringe pixels are glyph.
    const fringeDiff = Math.abs(128 - 255) * 3;
    expect(fringeDiff).toBeGreaterThanOrEqual(0.25 * result.maxDiff);
    expect(result.hist.total).toBeGreaterThan(block.width * block.height); // fringe counted too
  });
});

describe('measureGlyphs: grey text on white', () => {
  it('#777777 fails at ~4.48', () => {
    const width = 20, height = 20;
    const b = makePng(width, height, WHITE);
    const a = makePng(width, height, WHITE);
    const rect: Rect = { x: 2, y: 2, width: 16, height: 16 };
    const grey = { r: 0x77, g: 0x77, b: 0x77 };
    fillRect(a, rect, grey);
    const input: GlyphInput = { a, b, rects: [rect], fg: { rgb: grey, alpha: 1 }, opacity: 1, required: 4.5 };
    const result = measureGlyphs(input);
    expect(result.status).toBe('measured');
    expect(result.fgSource).toBe('css');
    const v = decideVerdict(result.hist, 4.5);
    expect(v.ratio).toBeCloseTo(4.48, 1);
    expect(v.verdict).toBe('fail');
  });

  it('#767676 passes at ~4.54', () => {
    const width = 20, height = 20;
    const b = makePng(width, height, WHITE);
    const a = makePng(width, height, WHITE);
    const rect: Rect = { x: 2, y: 2, width: 16, height: 16 };
    const grey = { r: 0x76, g: 0x76, b: 0x76 };
    fillRect(a, rect, grey);
    const input: GlyphInput = { a, b, rects: [rect], fg: { rgb: grey, alpha: 1 }, opacity: 1, required: 4.5 };
    const result = measureGlyphs(input);
    const v = decideVerdict(result.hist, 4.5);
    expect(v.ratio).toBeCloseTo(4.54, 1);
    expect(v.verdict).toBe('pass');
  });
});

describe('measureGlyphs: gradient background', () => {
  it('some ratios fail near the dark end; worst.bg is the dark end; verdict fails', () => {
    const width = 100, height = 10;
    const b = makePng(width, height, WHITE);
    // Horizontal gradient white(255) -> #444(68) left to right.
    for (let x = 0; x < width; x++) {
      const t = x / (width - 1);
      const v = Math.round(255 + t * (68 - 255));
      for (let y = 0; y < height; y++) setPixel(b, x, y, { r: v, g: v, b: v });
    }
    const a = makePng(width, height, WHITE);
    // Copy background into A first (so non-glyph pixels have zero diff), then
    // stamp black "glyph" columns spread across the width, including near the
    // dark end where black-on-black-ish gives low contrast.
    for (let x = 0; x < width; x++) for (let y = 0; y < height; y++) setPixel(a, x, y, readPixel(b, x, y));
    const rects: Rect[] = [];
    for (let x = 5; x < width; x += 10) {
      const rect: Rect = { x, y: 2, width: 1, height: 6 };
      fillRect(a, rect, BLACK);
      rects.push(rect);
    }
    const input: GlyphInput = { a, b, rects, fg: { rgb: BLACK, alpha: 1 }, opacity: 1, required: 4.5 };
    const result = measureGlyphs(input);
    expect(result.status).toBe('measured');
    expect(result.fgSource).toBe('css');
    expect(result.worst).not.toBeNull();
    // The worst pixel's background should be near the dark end (#444), i.e. low value.
    expect(result.worst!.bg.r).toBeLessThan(150);
    const v = decideVerdict(result.hist, 4.5);
    expect(v.verdict).toBe('fail');
    expect(v.min).toBeLessThan(4.5);
  });
});

describe('measureGlyphs: alpha and opacity', () => {
  it('fg rgba(0,0,0,0.4), opacity 1: A composited over white, css match', () => {
    const width = 20, height = 20;
    const b = makePng(width, height, WHITE);
    const a = makePng(width, height, WHITE);
    const rect: Rect = { x: 2, y: 2, width: 16, height: 16 };
    const predicted = composite(BLACK, 0.4, WHITE);
    fillRect(a, rect, { r: Math.round(predicted.r), g: Math.round(predicted.g), b: Math.round(predicted.b) });
    const input: GlyphInput = { a, b, rects: [rect], fg: { rgb: BLACK, alpha: 0.4 }, opacity: 1, required: 4.5 };
    const result = measureGlyphs(input);
    expect(result.status).toBe('measured');
    expect(result.fgSource).toBe('css');
  });

  it('fg black alpha 1 with owner opacity 0.5, A = #808080: css match, ratio ~3.95', () => {
    const width = 20, height = 20;
    const b = makePng(width, height, WHITE);
    const a = makePng(width, height, WHITE);
    const rect: Rect = { x: 2, y: 2, width: 16, height: 16 };
    fillRect(a, rect, { r: 128, g: 128, b: 128 });
    const input: GlyphInput = { a, b, rects: [rect], fg: { rgb: BLACK, alpha: 1 }, opacity: 0.5, required: 4.5 };
    const result = measureGlyphs(input);
    expect(result.fgSource).toBe('css');
    const v = decideVerdict(result.hist, 4.5);
    expect(v.ratio).toBeCloseTo(3.95, 1);
  });
});

describe('measureGlyphs: rendered fallback', () => {
  it('declared black fg but rendered ink is #b3b3b3: rendered fallback, only core pixels in hist', () => {
    const width = 20, height = 20;
    const b = makePng(width, height, WHITE);
    const a = makePng(width, height, WHITE);
    const core: Rect = { x: 5, y: 5, width: 10, height: 10 };
    const rendered = { r: 0xb3, g: 0xb3, b: 0xb3 }; // (179,179,179)
    fillRect(a, core, rendered);
    // A lighter fringe: diff to white is glyph-threshold-eligible but below
    // the core threshold, so it must be excluded from the histogram in
    // rendered mode (mask 0) even though it's part of the glyph mask logic.
    const fringeColor = { r: 220, g: 220, b: 220 };
    for (let x = core.x - 1; x <= core.x + core.width; x++) {
      setPixel(a, x, core.y - 1, fringeColor);
      setPixel(a, x, core.y + core.height, fringeColor);
    }
    for (let y = core.y - 1; y <= core.y + core.height; y++) {
      setPixel(a, core.x - 1, y, fringeColor);
      setPixel(a, core.x + core.width, y, fringeColor);
    }
    const rects: Rect[] = [{ x: core.x - 1, y: core.y - 1, width: core.width + 2, height: core.height + 2 }];
    const input: GlyphInput = { a, b, rects, fg: { rgb: BLACK, alpha: 1 }, opacity: 1, required: 4.5 };
    const result = measureGlyphs(input);
    expect(result.fgSource).toBe('rendered');
    const v = decideVerdict(result.hist, 4.5);
    expect(v.ratio).toBeCloseTo(2.1, 1);
    // Only the solid core block's pixels should be in the histogram.
    expect(result.hist.total).toBe(core.width * core.height);
    // A fringe pixel's mask value must be 0 (excluded in rendered mode).
    const maskRect = result.maskRect;
    const fringeMaskIdx = (core.y - 1 - maskRect.y) * maskRect.width + (core.x - maskRect.x);
    expect(result.mask[fringeMaskIdx]).toBe(0);
  });
});

describe('measureGlyphs: fg null (gradient text)', () => {
  it('always uses rendered fgSource', () => {
    const width = 20, height = 20;
    const b = makePng(width, height, WHITE);
    const a = makePng(width, height, WHITE);
    const rect: Rect = { x: 2, y: 2, width: 16, height: 16 };
    fillRect(a, rect, BLACK);
    const input: GlyphInput = { a, b, rects: [rect], fg: null, opacity: 1, required: 4.5 };
    const result = measureGlyphs(input);
    expect(result.fgSource).toBe('rendered');
  });
});

describe('measureGlyphs: no-diff', () => {
  it('A equal to B yields status no-diff, empty hist, null worst/best', () => {
    const width = 20, height = 20;
    const b = makePng(width, height, WHITE);
    const a = makePng(width, height, WHITE);
    const rect: Rect = { x: 2, y: 2, width: 16, height: 16 };
    const input: GlyphInput = { a, b, rects: [rect], fg: { rgb: BLACK, alpha: 1 }, opacity: 1, required: 4.5 };
    const result = measureGlyphs(input);
    expect(result.status).toBe('no-diff');
    expect(result.hist.total).toBe(0);
    expect(result.worst).toBeNull();
    expect(result.best).toBeNull();
    expect(result.maxDiff).toBeLessThanOrEqual(DIFF_FLOOR);
  });
});

describe('measureGlyphs: rects', () => {
  it('counts overlapping rect pixels once', () => {
    const width = 20, height = 20;
    const b = makePng(width, height, WHITE);
    const a = makePng(width, height, WHITE);
    const rect: Rect = { x: 2, y: 2, width: 10, height: 10 };
    fillRect(a, rect, BLACK);
    const overlapping: Rect[] = [rect, { x: 5, y: 5, width: 10, height: 10 }];
    fillRect(a, overlapping[1], BLACK);
    const input: GlyphInput = { a, b, rects: overlapping, fg: { rgb: BLACK, alpha: 1 }, opacity: 1, required: 4.5 };
    const result = measureGlyphs(input);
    // Union area of two 10x10 squares offset by (3,3): 100 + 100 - 49 = 151.
    expect(result.hist.total).toBe(151);
  });

  it('clips rects partly outside the image', () => {
    const width = 20, height = 20;
    const b = makePng(width, height, WHITE);
    const a = makePng(width, height, WHITE);
    const rect: Rect = { x: 15, y: 15, width: 10, height: 10 }; // extends to (25,25), image is 20x20
    fillRect(a, { x: 15, y: 15, width: 5, height: 5 }, BLACK); // only the in-bounds part
    const input: GlyphInput = { a, b, rects: [rect], fg: { rgb: BLACK, alpha: 1 }, opacity: 1, required: 4.5 };
    const result = measureGlyphs(input);
    expect(result.hist.total).toBe(25);
  });

  it('maskRect is the integer bounding box of rects clipped to the image', () => {
    const width = 20, height = 20;
    const b = makePng(width, height, WHITE);
    const a = makePng(width, height, WHITE);
    const rects: Rect[] = [{ x: 2.4, y: 3.6, width: 4, height: 4 }, { x: 15, y: 15, width: 10, height: 10 }];
    fillRect(a, { x: 2, y: 4, width: 4, height: 4 }, BLACK);
    const input: GlyphInput = { a, b, rects, fg: { rgb: BLACK, alpha: 1 }, opacity: 1, required: 4.5 };
    const result = measureGlyphs(input);
    expect(result.maskRect).toEqual({ x: 2, y: 3, width: 20 - 2, height: 20 - 3 });
  });
});

describe('measureGlyphs: mask values', () => {
  it('marks passing pixels 1 and failing pixels 2 against the required ratio', () => {
    // Same (known) black foreground throughout, two different backgrounds:
    // white (21:1, passes) and dark grey #505050 (~2.6:1, fails at 4.5).
    const width = 20, height = 10;
    const b = makePng(width, height, WHITE);
    const passRect: Rect = { x: 0, y: 0, width: 10, height: 10 };
    const failRect: Rect = { x: 10, y: 0, width: 10, height: 10 };
    fillRect(b, failRect, { r: 0x50, g: 0x50, b: 0x50 });
    const a = makePng(width, height, WHITE);
    fillRect(a, passRect, BLACK);
    fillRect(a, failRect, BLACK);
    const input: GlyphInput = {
      a, b, rects: [passRect, failRect], fg: { rgb: BLACK, alpha: 1 }, opacity: 1, required: 4.5,
    };
    const result = measureGlyphs(input);
    expect(result.fgSource).toBe('css');
    const passIdx = 5 - result.maskRect.x + (5 - result.maskRect.y) * result.maskRect.width;
    const failIdx = 15 - result.maskRect.x + (5 - result.maskRect.y) * result.maskRect.width;
    expect(result.mask[passIdx]).toBe(1);
    expect(result.mask[failIdx]).toBe(2);
  });
});

describe('renderOverlay', () => {
  it('decodes to maskRect size with the specified RGBA per mask value', () => {
    const width = 20, height = 10;
    const b = makePng(width, height, WHITE);
    const passRect: Rect = { x: 0, y: 0, width: 10, height: 10 };
    const failRect: Rect = { x: 10, y: 0, width: 10, height: 10 };
    fillRect(b, failRect, { r: 0x50, g: 0x50, b: 0x50 });
    const a = makePng(width, height, WHITE);
    fillRect(a, passRect, BLACK);
    fillRect(a, failRect, BLACK);
    const input: GlyphInput = { a, b, rects: [passRect, failRect], fg: { rgb: BLACK, alpha: 1 }, opacity: 1, required: 4.5 };
    const result = measureGlyphs(input);
    const overlayBuf = renderOverlay(result);
    const overlay = PNG.sync.read(overlayBuf);
    expect(overlay.width).toBe(result.maskRect.width);
    expect(overlay.height).toBe(result.maskRect.height);

    const passPixel = readPixel(overlay, 5 - result.maskRect.x, 5 - result.maskRect.y);
    expect(passPixel).toEqual({ r: 0, g: 229, b: 255, a: 150 });
    const failPixel = readPixel(overlay, 15 - result.maskRect.x, 5 - result.maskRect.y);
    expect(failPixel).toEqual({ r: 255, g: 0, b: 200, a: 235 });
    // A pixel that is not glyph at all (outside any painted rect logic but
    // still inside maskRect) is transparent.
    if (result.maskRect.width * result.maskRect.height > 200) {
      const emptyPixel = readPixel(overlay, 0, result.maskRect.height - 1);
      expect(emptyPixel.a).toBe(0);
    }
  });
});

describe('cropPng', () => {
  it('clips to image bounds', () => {
    const width = 10, height = 10;
    const png = makePng(width, height, WHITE);
    fillRect(png, { x: 8, y: 8, width: 2, height: 2 }, BLACK);
    const buf = cropPng(png, { x: 8, y: 8, width: 10, height: 10 }); // extends past the image
    const cropped = PNG.sync.read(buf);
    expect(cropped.width).toBe(2);
    expect(cropped.height).toBe(2);
    const p = readPixel(cropped, 0, 0);
    expect(p).toEqual({ r: 0, g: 0, b: 0, a: 255 });
  });
});

describe('regionChanged', () => {
  it('is true when a pixel inside a rect changes by more than DIFF_FLOOR', () => {
    const width = 10, height = 10;
    const a = makePng(width, height, WHITE);
    const a2 = makePng(width, height, WHITE);
    setPixel(a2, 5, 5, BLACK);
    expect(regionChanged(a, a2, [{ x: 0, y: 0, width: 10, height: 10 }])).toBe(true);
  });

  it('is false when the change is outside the rects', () => {
    const width = 10, height = 10;
    const a = makePng(width, height, WHITE);
    const a2 = makePng(width, height, WHITE);
    setPixel(a2, 5, 5, BLACK); // outside the rect below
    expect(regionChanged(a, a2, [{ x: 0, y: 0, width: 3, height: 3 }])).toBe(false);
  });

  it('is false when the change is at or below DIFF_FLOOR', () => {
    const width = 10, height = 10;
    const a = makePng(width, height, WHITE);
    const a2 = makePng(width, height, WHITE);
    setPixel(a2, 5, 5, { r: 253, g: 253, b: 253 }); // diff = 2*3 = 6 = DIFF_FLOOR
    expect(regionChanged(a, a2, [{ x: 0, y: 0, width: 10, height: 10 }])).toBe(false);
  });
});
