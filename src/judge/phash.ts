import { PNG } from 'pngjs';
import { createHash } from 'node:crypto';

// Perceptual hash for instance dedupe (vision-analysis-design economics #1):
// headers/footers/nav/repeated cards appear on every page — pHash groups
// identical regions so they are judged ONCE. A difference hash (dHash) over an
// 8x9 greyscale downscale: robust to tiny rendering noise, cheap, dependency-
// free beyond pngjs.

function grayscaleDownscale(png: PNG, w: number, h: number): number[] {
  const out: number[] = [];
  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      // Nearest-neighbour sample from the source.
      const sx = Math.min(png.width - 1, Math.floor((tx / w) * png.width));
      const sy = Math.min(png.height - 1, Math.floor((ty / h) * png.height));
      const i = ((png.width * sy) + sx) << 2;
      out.push(0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2]);
    }
  }
  return out;
}

/** 64-bit dHash as 16 hex chars. Identical/near-identical crops share it. */
export function perceptualHash(pngBuffer: Buffer): string {
  const png = PNG.sync.read(pngBuffer);
  const W = 9;
  const H = 8;
  const gray = grayscaleDownscale(png, W, H);
  let bits = '';
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W - 1; x++) {
      const left = gray[y * W + x];
      const right = gray[y * W + x + 1];
      bits += left < right ? '1' : '0';
    }
  }
  // Pack 64 bits into 16 hex chars.
  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

/** Exact content hash of the crop bytes — the cache key's crop component. */
export function contentHash(pngBuffer: Buffer): string {
  return createHash('sha256').update(pngBuffer).digest('hex').slice(0, 16);
}
