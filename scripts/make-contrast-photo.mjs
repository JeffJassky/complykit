#!/usr/bin/env node
// Deterministic "photo-like" texture for the contrast ground-truth corpus
// (C42/C43 in test/fixtures/pages/contrast-truth.html): a light, noisy
// background a real hero photo might have, plus a scatter of isolated
// near-black specks (dust/vignette/JPEG artifacts) at very low density.
// Deterministic and seeded so the fixture — and the accuracy it is scored
// against — never drifts between runs. No Math.random anywhere.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const WIDTH = 900;
const HEIGHT = 300;
const SEED = 0xc0ffee;

// mulberry32: small, fast, deterministic PRNG from an integer seed.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(SEED);

// A handful of fixed-frequency sine terms with seeded phases give smooth,
// large-scale luminance variation (cloudy highlights / soft shadow) without
// any per-pixel randomness driving the low frequencies.
const terms = Array.from({ length: 4 }, () => ({
  fx: (rand() * 2 + 0.5) / WIDTH,
  fy: (rand() * 2 + 0.5) / HEIGHT,
  phase: rand() * Math.PI * 2,
  amp: 8 + rand() * 10,
}));

function baseLuminance(x, y) {
  // Centered around the midpoint of #d8 (216) and #ff (255).
  let v = 236;
  for (const t of terms) {
    v += t.amp * Math.sin(x * t.fx * Math.PI * 2 + y * t.fy * Math.PI * 2 + t.phase);
  }
  return v;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

const png = new PNG({ width: WIDTH, height: HEIGHT });

for (let y = 0; y < HEIGHT; y++) {
  for (let x = 0; x < WIDTH; x++) {
    const base = baseLuminance(x, y);
    // Fine per-pixel grain, the kind JPEG sensor noise leaves behind.
    const grain = (rand() - 0.5) * 10;
    const v = Math.round(clamp(base + grain, 208, 255));
    const idx = (WIDTH * y + x) << 2;
    png.data[idx] = v;
    png.data[idx + 1] = v;
    png.data[idx + 2] = v;
    png.data[idx + 3] = 255;
  }
}

// Isolated dark specks: a coarse grid (one candidate slot per cell) keeps
// them spaced apart instead of letting chance cluster them into a patch that
// would itself read as a contiguous low-luminance region. Probability per
// cell is tuned so the specks stay well under 0.5% of all pixels.
const CELL = 6;
const SPECK_PROB = 0.1; // -> ~0.1/36 ≈ 0.28% of pixels
const SPECK = { r: 0x20, g: 0x20, b: 0x20 };

for (let cy = 0; cy < HEIGHT; cy += CELL) {
  for (let cx = 0; cx < WIDTH; cx += CELL) {
    if (rand() >= SPECK_PROB) continue;
    const w = Math.min(CELL, WIDTH - cx);
    const h = Math.min(CELL, HEIGHT - cy);
    const x = cx + Math.floor(rand() * w);
    const y = cy + Math.floor(rand() * h);
    const idx = (WIDTH * y + x) << 2;
    png.data[idx] = SPECK.r;
    png.data[idx + 1] = SPECK.g;
    png.data[idx + 2] = SPECK.b;
    png.data[idx + 3] = 255;
  }
}

const outPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'fixtures',
  'pages',
  'contrast-truth-photo.png',
);
fs.writeFileSync(outPath, PNG.sync.write(png));

let speckCount = 0;
for (let i = 0; i < png.data.length; i += 4) {
  if (png.data[i] <= 0x25) speckCount++;
}
process.stdout.write(
  `wrote ${outPath} (${WIDTH}x${HEIGHT}, ${speckCount} dark speck(s), ${((speckCount / (WIDTH * HEIGHT)) * 100).toFixed(3)}% density)\n`,
);
