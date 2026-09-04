import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { GEOMETRY_INIT } from '../src/collect/browser/geometry-init.js';
import { captureScreenshot } from '../src/collect/browser/screenshot.js';
import { asRunId } from '../src/index.js';

// A plain document-scrolling page — the ordinary marketing-site case, and the
// one `fullPage: true` quietly got wrong.
//
// The visitor used to be handed the full-page image once, at offset 0, while
// candidates carry viewport-relative boxes. Those agree only inside the first
// screen, so anything below the fold was measured against whatever happened to
// occupy those rows. On a real site that produced a near-black heading on a
// white hero "measured" at 1.24:1.

const PAGE_URL = pathToFileURL(
  fileURLToPath(new URL('./fixtures/pages/long-document.html', import.meta.url)),
).href;

let chromiumAvailable = false;
try {
  const { chromium } = await import('playwright');
  chromiumAvailable = fs.existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}
const suite = chromiumAvailable ? describe : describe.skip;

suite('measurement bands on a document-scrolling page', () => {
  let cwd: string;
  let browser: import('playwright').Browser;
  let page: import('playwright').Page;

  beforeAll(async () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'complykit-docscroll-'));
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

  it('hands the visitor each band at a known offset, so below-fold pixels are the right ones', async () => {
    const seen: Array<{ offset: number; height: number }> = [];

    // What the pixel-band pass does: read the element's viewport box in the
    // band it is on screen in, and sample the image there.
    let subjectSample: { r: number; g: number; b: number } | null = null;

    await captureScreenshot(
      page,
      { property: 'test', routePattern: '/', instanceUrl: PAGE_URL, viewport: 'desktop', colorScheme: 'light' },
      {
        runId: asRunId('2026-09-04T00-00-00.000Z'),
        cwd,
        viewport: 'desktop',
        colorScheme: 'light',
        capturedAt: new Date().toISOString(),
        onBand: async (png: PNG, offset: number) => {
          seen.push({ offset, height: png.height });
          const box = await page.evaluate(() => {
            const el = document.getElementById('subject');
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
          });
          if (!box) return;
          const onScreen = box.y + box.height > 0 && box.y < png.height;
          if (!onScreen || subjectSample) return;
          // Sample a pixel a little inside the subject block.
          const px = Math.round(box.x + 4);
          const py = Math.round(box.y + 4);
          const idx = (png.width * py + px) << 2;
          subjectSample = { r: png.data[idx], g: png.data[idx + 1], b: png.data[idx + 2] };
        },
      } as Parameters<typeof captureScreenshot>[2],
    );

    // More than one band, and every band is a viewport-sized image.
    expect(seen.length).toBeGreaterThan(1);
    for (const band of seen) expect(band.height).toBe(600);

    // Offsets advance, starting at the top.
    expect(seen[0].offset).toBe(0);
    expect(seen[seen.length - 1].offset).toBeGreaterThan(0);

    // The subject block is white (#ffffff). Under the old behaviour its box was
    // read against the full-page image and landed on the dark decoy instead.
    expect(subjectSample).not.toBeNull();
    const s = subjectSample as unknown as { r: number; g: number; b: number };
    expect(s.r).toBeGreaterThan(200);
    expect(s.g).toBeGreaterThan(200);
    expect(s.b).toBeGreaterThan(200);
  }, 60_000);
});
