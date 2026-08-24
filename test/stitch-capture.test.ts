import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { GEOMETRY_INIT } from '../src/collect/browser/geometry-init.js';
import { captureScreenshot } from '../src/collect/browser/screenshot.js';
import { asRunId } from '../src/index.js';

// An app shell that pins the document and scrolls an inner container: the case
// that made `fullPage: true` capture one screen and left every below-fold
// element unmeasurable.

const PAGE_URL = pathToFileURL(fileURLToPath(new URL('./fixtures/pages/inner-scroller.html', import.meta.url))).href;

let chromiumAvailable = false;
try {
  const { chromium } = await import('playwright');
  chromiumAvailable = fs.existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}
const suite = chromiumAvailable ? describe : describe.skip;

suite('stitched capture of an inner scroll container', () => {
  let cwd: string;
  let browser: import('playwright').Browser;
  let page: import('playwright').Page;

  beforeAll(async () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'complykit-stitch-'));
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

  it('identifies the inner container as the page scroller', async () => {
    const info = await page.evaluate(() => (window as never as { __ck: { primaryScroller(): unknown } }).__ck.primaryScroller());
    expect(info).toMatchObject({ inner: true, top: 60 });
    expect((info as { scrollHeight: number }).scrollHeight).toBeGreaterThan(1900);
  });

  it('locates a below-fold element beyond the viewport, where window.scrollY cannot', async () => {
    const geo = await page.evaluate(() => {
      const el = document.getElementById('deep') as Element;
      const ck = (window as never as { __ck: { contentBox(e: Element): { y: number } } }).__ck;
      return { content: ck.contentBox(el).y, naive: el.getBoundingClientRect().y + window.scrollY };
    });
    expect(geo.naive).toBeGreaterThan(600); // off-screen, so the old box was un-samplable
    expect(geo.content).toBeCloseTo(geo.naive, 0); // unscrolled they agree...
    // ...and after scrolling, only contentBox stays put in capture space.
    await page.evaluate(() => (window as never as { __ck: { scrollPrimaryTo(o: number): number } }).__ck.scrollPrimaryTo(900));
    const after = await page.evaluate(() => {
      const el = document.getElementById('deep') as Element;
      const ck = (window as never as { __ck: { contentBox(e: Element): { y: number } } }).__ck;
      return { content: ck.contentBox(el).y, naive: el.getBoundingClientRect().y + window.scrollY };
    });
    expect(after.content).toBeCloseTo(geo.content, 0);
    expect(after.naive).toBeLessThan(geo.naive - 800);
    await page.evaluate(() => (window as never as { __ck: { scrollPrimaryTo(o: number): number } }).__ck.scrollPrimaryTo(0));
  });

  it('captures the full scroll extent and puts the element where contentBox says it is', async () => {
    const shot = await captureScreenshot(page, { property: 'test' }, {
      runId: asRunId('2026-01-01T00-00-00.000Z'), cwd, viewport: 'desktop', scheme: 'light', capturedAt: '',
    });
    expect(shot.stitched).toBe(true);
    expect(shot.bands).toBeGreaterThan(1);

    const png = PNG.sync.read(shot.buffer);
    const box = await page.evaluate(() => {
      const el = document.getElementById('deep') as Element;
      return (window as never as { __ck: { contentBox(e: Element): { x: number; y: number; width: number; height: number } } }).__ck.contentBox(el);
    });
    // The composite must actually extend past one screen and cover the element.
    expect(png.height).toBeGreaterThan(box.y + box.height);

    // And the pixels there must be the element's white background, not the dark
    // page chrome that a naive re-capture of band 0 would have left behind.
    const px = (x: number, y: number): [number, number, number] => {
      const i = (png.width * y + x) << 2;
      return [png.data[i], png.data[i + 1], png.data[i + 2]];
    };
    const [r, g, b] = px(Math.round(box.x + 2), Math.round(box.y + box.height / 2));
    expect(r).toBeGreaterThan(200);
    expect(g).toBeGreaterThan(200);
    expect(b).toBeGreaterThan(200);
  }, 60_000);
});
