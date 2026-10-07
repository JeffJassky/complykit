import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { watchMarkup } from '../src/collect/browser/evaluation/markup.js';

// A1 collection half: the served HTML is read from the navigation response
// through the scenario's own context; a page whose body was not captured is
// re-fetched through that context. Local server only (no network). Skips
// without Chromium.

const HTML = fs.readFileSync(new URL('./fixtures/pages/markup-trackers.html', import.meta.url), 'utf8');

let chromiumAvailable = false;
try {
  const { chromium } = await import('playwright');
  chromiumAvailable = fs.existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}
const suite = chromiumAvailable ? describe : describe.skip;

suite('watchMarkup', () => {
  let server: http.Server;
  let base: string;
  const hits: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      if (req.url === '/' || req.url === '/other') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(req.url === '/' ? HTML : '<!doctype html><title>x</title><script src="https://connect.facebook.net/en_US/fbevents.js"></script>');
      } else if (req.url === '/redirect') {
        res.writeHead(302, { location: '/' });
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('inspects the navigation body, follows redirects, and re-fetches what it did not see', async () => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      // Third-party subresources never leave the machine.
      await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
      const w = watchMarkup(context);
      const page = await context.newPage();
      await page.goto(`${base}/redirect`);
      const pages = await w.finish([{ url: `${base}/#top` }, { url: `${base}/` }, { url: `${base}/other` }]);
      expect(pages.map((p) => [p.url, p.status, p.via])).toEqual([
        [`${base}/`, 'inspected', 'navigation'],
        [`${base}/other`, 'inspected', 'refetch'],
      ]);
      const meta = pages[0].elements.find((e) => e.kind === 'img' && e.context === 'noscript' && e.url?.includes('facebook.com/tr'));
      expect(meta?.line).toBe(HTML.slice(0, HTML.indexOf('<noscript><img')).split('\n').length);
      expect(pages[1].elements[0]).toMatchObject({ kind: 'script', loads: 'executes' });
      await context.close();
    } finally {
      await browser.close();
    }
  }, 60000);
});
