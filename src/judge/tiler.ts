import { PNG } from 'pngjs';

// Mode-2 tiling (vision-analysis-design): slice a full-page capture into tiles
// that each stay under the vision resolution limit, so text stays legible — a
// squashed full page arrives illegible and the model hallucinates off blurry
// pixels. ~15% overlap so nothing is cut across a tile boundary.

export interface Tile {
  index: number;
  buffer: Buffer;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TileOptions {
  tileWidth?: number;
  tileHeight?: number;
  overlap?: number; // fraction, 0..0.5
}

export function sliceTiles(pngBuffer: Buffer, opts: TileOptions = {}): Tile[] {
  const tileW = opts.tileWidth ?? 1280;
  const tileH = opts.tileHeight ?? 1100;
  const overlap = Math.min(0.5, Math.max(0, opts.overlap ?? 0.15));
  const src = PNG.sync.read(pngBuffer);
  const stepY = Math.max(1, Math.floor(tileH * (1 - overlap)));
  const stepX = Math.max(1, Math.floor(tileW * (1 - overlap)));

  const tiles: Tile[] = [];
  let index = 0;
  for (let y = 0; y < src.height; y += stepY) {
    for (let x = 0; x < src.width; x += stepX) {
      const w = Math.min(tileW, src.width - x);
      const h = Math.min(tileH, src.height - y);
      if (w < 8 || h < 8) continue;
      const dst = new PNG({ width: w, height: h });
      for (let ty = 0; ty < h; ty++)
        for (let tx = 0; tx < w; tx++) {
          const s = ((src.width * (y + ty)) + (x + tx)) << 2;
          const d = ((w * ty) + tx) << 2;
          dst.data[d] = src.data[s];
          dst.data[d + 1] = src.data[s + 1];
          dst.data[d + 2] = src.data[s + 2];
          dst.data[d + 3] = src.data[s + 3];
        }
      tiles.push({ index: index++, buffer: PNG.sync.write(dst), x, y, width: w, height: h });
      if (x + tileW >= src.width) break;
    }
    if (y + tileH >= src.height) break;
  }
  return tiles;
}
