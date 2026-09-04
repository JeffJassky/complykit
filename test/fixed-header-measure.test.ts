import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { GEOMETRY_INIT } from '../src/collect/browser/geometry-init.js';
import { captureScreenshot, type Obstructions } from '../src/collect/browser/screenshot.js';
import { asRunId } from '../src/index.js';

// A screenshot records what the camera saw, not what the document says. Content
// scrolled under a fixed header is covered by the header's pixels, so measuring
// it there reports the header's colour as the element's background.
//
// On the StoryFolder client this was a 136px header at rgba(13,10,23,.875).
// Banding by the raw viewport height parked white sections in those rows and a
// near-black heading on white "measured" as near-black on dark purple.

const PAGE_URL = pathToFileURL(
  fileURLToPath(new URL('./fixtures/pages/fixed-header.html', import.meta.url)),
).href;

let chromiumAvailable = false;
try {
  const { chromium } = await import('playwright');
  chromiumAvailable = fs.existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}
const suite = chromiumAvailable ? describe : describe.skip;

suite('measurement under fixed chrome', () => {
  let cwd: string;
  let browser: import('playwright').Browser;
  let page: import('playwright').Page;

  beforeAll(async () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'complykit-fixedhdr-'));
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 400, height: 600 } });
    await ctx.addInitScript(GEOMETRY_INIT);
    page = await ctx.newPage();
    await page.goto(PAGE_URL, { waitUntil: 'load' });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('reports the header as an obstruction and parks the subject clear of it', async () => {
    // Where the subject was sampled, and what the pixels there actually were.
    let sample: { r: number; g: number; b: number; y: number } | null = null;
    let sawHeader = false;

    await captureScreenshot(
      page,
      { property: 'test', routePattern: '/', instanceUrl: PAGE_URL, viewport: 'desktop', colorScheme: 'light' },
      {
        runId: asRunId('2026-09-04T00-00-00.000Z'),
        cwd,
        viewport: 'desktop',
        colorScheme: 'light',
        capturedAt: new Date().toISOString(),
        onBand: async (png: PNG, _offset: number, _i: number, obs: Obstructions) => {
          if (obs.topInset >= 100) sawHeader = true;
          const box = await page.evaluate(() => {
            const el = document.getElementById('subject');
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
          });
          if (!box) return;
          const onScreen = box.y + box.height > 0 && box.y < png.height;
          if (!onScreen || sample) return;
          // What the pixel-band pass would do: reject a box the chrome covers,
          // otherwise sample it.
          const covered = obs.rects.some(
            (o) =>
              box.x < o.x + o.width && box.x + box.width > o.x &&
              box.y < o.y + o.height && box.y + box.height > o.y,
          );
          if (covered) return;
          const px = Math.round(box.x + 4);
          const py = Math.round(box.y + 4);
          const idx = (png.width * py + px) << 2;
          sample = { r: png.data[idx], g: png.data[idx + 1], b: png.data[idx + 2], y: py };
        },
      } as Parameters<typeof captureScreenshot>[2],
    );

    expect(sawHeader).toBe(true);

    // Some band put the subject in the clear, and it read white there. Stepping
    // by the raw viewport height instead parks it at y = 0 under the header and
    // samples #0b0812.
    expect(sample).not.toBeNull();
    const s = sample as unknown as { r: number; g: number; b: number; y: number };
    expect(s.y).toBeGreaterThanOrEqual(100);
    expect(s.r).toBeGreaterThan(200);
    expect(s.g).toBeGreaterThan(200);
    expect(s.b).toBeGreaterThan(200);
  }, 60_000);
});
