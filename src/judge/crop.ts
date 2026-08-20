import { PNG } from 'pngjs';
import type { Box } from '../record/index.js';

// Crop an element region (+ context padding) from a full-page screenshot. The
// deterministic layer hands the region; C1 only ever judges the crop, never
// locates (vision-analysis-design: "LLM judges, never locates"). A small crop is
// ~60 tokens vs an illegible full page.

export interface CroppedImage {
  buffer: Buffer;
  width: number;
  height: number;
}

export function cropRegion(pngBuffer: Buffer, box: Box, padding = 24): CroppedImage {
  const src = PNG.sync.read(pngBuffer);
  const x0 = Math.max(0, Math.floor(box.x - padding));
  const y0 = Math.max(0, Math.floor(box.y - padding));
  const x1 = Math.min(src.width, Math.ceil(box.x + box.width + padding));
  const y1 = Math.min(src.height, Math.ceil(box.y + box.height + padding));
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);

  const dst = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sIdx = ((src.width * (y0 + y)) + (x0 + x)) << 2;
      const dIdx = ((w * y) + x) << 2;
      dst.data[dIdx] = src.data[sIdx];
      dst.data[dIdx + 1] = src.data[sIdx + 1];
      dst.data[dIdx + 2] = src.data[sIdx + 2];
      dst.data[dIdx + 3] = src.data[sIdx + 3];
    }
  }
  return { buffer: PNG.sync.write(dst), width: w, height: h };
}
