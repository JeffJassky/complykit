import { describe, it, expect } from 'vitest';
import { PNG } from 'pngjs';
import { sliceTiles, buildSidecars, sweep, SWEEP_PASSES, type Sweeper, type MarkElement } from '../src/judge/index.js';

function solid(w: number, h: number): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 200;
    png.data[i + 1] = 200;
    png.data[i + 2] = 200;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

describe('mode-2 tiler', () => {
  it('slices a tall page into overlapping tiles under the size limit', () => {
    const tiles = sliceTiles(solid(1400, 2600), { tileWidth: 1280, tileHeight: 1100, overlap: 0.15 });
    expect(tiles.length).toBeGreaterThan(1);
    expect(tiles.every((t) => t.width <= 1280 && t.height <= 1100)).toBe(true);
    expect(tiles[0].index).toBe(0);
  });

  it('a page smaller than one tile yields a single tile', () => {
    const tiles = sliceTiles(solid(600, 400));
    expect(tiles).toHaveLength(1);
  });
});

describe('Set-of-Marks sidecar + sweep funnel', () => {
  const elements: MarkElement[] = [
    { fingerprint: 'fp-hero', role: 'img', name: 'hero', bbox: { x: 100, y: 50, width: 200, height: 100 } },
    { fingerprint: 'fp-cta', role: 'button', name: 'Buy', bbox: { x: 100, y: 1500, width: 120, height: 40 } },
  ];

  it('assigns each element to the tile its centre falls in, with a mark number', () => {
    const tiles = sliceTiles(solid(1400, 2600), { tileWidth: 1280, tileHeight: 1100, overlap: 0 });
    const sidecars = buildSidecars(tiles, elements);
    const marked = sidecars.flatMap((s) => s.marks.map((m) => m.fingerprint));
    expect(marked).toContain('fp-hero');
    expect(marked).toContain('fp-cta');
  });

  it('resolves a sweep lead back to a fingerprint via its mark', async () => {
    const tiles = sliceTiles(solid(1400, 2600), { tileWidth: 1280, tileHeight: 1100, overlap: 0 });
    const sidecars = buildSidecars(tiles, elements);
    // Stub sweeper: on the perception pass, flag mark 1 of any non-empty tile.
    const stub: Sweeper = async ({ sidecar, pass }) =>
      pass === 'perception' && sidecar.marks.length ? [{ mark: 1, suspicion: 'possible image of text' }] : [];
    const leads = await sweep(tiles, sidecars, stub, SWEEP_PASSES);
    expect(leads.length).toBeGreaterThan(0);
    expect(leads.every((l) => typeof l.fingerprint === 'string' && l.fingerprint.length > 0)).toBe(true);
    // A lead citing a mark not present is dropped (localization safety).
    const badStub: Sweeper = async () => [{ mark: 999, suspicion: 'nope' }];
    expect(await sweep(tiles, sidecars, badStub, ['perception'])).toHaveLength(0);
  });
});
