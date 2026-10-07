import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import type { Browser } from 'playwright';
import { searchStep, resolveJourney, type SearchStep } from '../src/collect/browser/evaluation/journey.js';
import type { CaptureHandle } from '../src/collect/browser/evaluation/capture.js';
import { findMarkers } from '../src/rules/tracking/fields.js';

// B4: the journey's site-search step. Fixture pages with and without a search
// box (and with a POST-only one); an "analytics" endpoint on the same server
// records what the results page sends. Skips without Chromium.

let chromiumAvailable = false;
try {
  const { chromium } = await import('playwright');
  chromiumAvailable = fs.existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}
const suite = chromiumAvailable ? describe : describe.skip;

const TERM = 'ckmarkerabc123';
const head = '<!doctype html><meta charset="utf-8">';
const PAGES: Record<string, string> = {
  '/with-search': `${head}<title>Store</title><header><form role="search" action="/search" method="get"><input type="search" name="q" placeholder="Search"></form></header>`,
  '/named-q': `${head}<title>Store</title><form action="/find"><input type="text" name="q"></form>`,
  '/icon-search': `${head}<title>Store</title><a href="/search" aria-label="Search" style="display:block;width:20px;height:20px">s</a>`,
  '/search': `${head}<title>Store</title><form action="/search"><input type="text" name="q" placeholder="Search our store"></form>`,
  '/no-search': `${head}<title>Store</title><h1>Nothing to search</h1><form action="/subscribe"><input type="email" name="email" placeholder="Email"></form>`,
  '/post-search': `${head}<title>Store</title><form action="/search" method="post"><input type="search" name="q"></form>`,
};

suite('journey site search (B4)', () => {
  let server: http.Server;
  let base: string;
  let browser: Browser;
  const seen: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      seen.push(`${req.method} ${u.pathname}${u.search}`);
      if (u.pathname === '/ga') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (u.pathname === '/search' && u.searchParams.has('q')) {
        const q = u.searchParams.get('q')!;
        res.writeHead(200, { 'content-type': 'text/html' });
        // The results page leaks the term the way an analytics tag does.
        res.end(`${head}<title>Search: ${q}</title><h1>Results</h1><script>new Image().src='/ga?dl='+encodeURIComponent(location.href)+'&dt='+encodeURIComponent(document.title)</script>`);
        return;
      }
      const page = PAGES[u.pathname];
      if (!page) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(page);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
  }, 60000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  });

  const run = async (path: string): Promise<{ ok: boolean; notes: string[]; actions: string[]; url: string }> => {
    const page = await browser.newPage();
    try {
      await page.goto(base + path);
      const actions: string[] = [];
      const cap = { push: (e: { action?: string }) => actions.push(e.action ?? ''), now: () => 0, pageIndex: () => 0 } as unknown as CaptureHandle;
      const notes: string[] = [];
      const step: SearchStep = { term: TERM, note: (r) => notes.push(r) };
      const ok = await searchStep(page, cap, step, resolveJourney({ pageDwellMs: 300, scrollSteps: 1 }));
      return { ok, notes, actions, url: page.url() };
    } finally {
      await page.close();
    }
  };

  it('types the marker into a role=search box, submits and lands on the results page', async () => {
    seen.length = 0;
    const r = await run('/with-search');
    expect(r.ok).toBe(true);
    expect(r.notes).toEqual([]);
    expect(r.url).toContain(`/search?q=${TERM}`);
    expect(r.actions).toEqual(expect.arrayContaining(['type', 'key']));
    // The results page's analytics hit carries the term (URL and title) — the rules flag exactly this.
    const ga = seen.find((s) => s.includes('/ga?'));
    expect(ga).toBeTruthy();
    expect(findMarkers([ga], { email: 'x@example.com', text: TERM, clickIds: {} })).toHaveLength(1);
  }, 30000);

  it('finds a plain name=q input', async () => {
    const r = await run('/named-q');
    expect(r.ok).toBe(true);
    expect(r.url).toContain(`/find?q=${TERM}`);
  }, 30000);

  it('opens an icon-only search link and searches from there', async () => {
    const r = await run('/icon-search');
    expect(r.ok).toBe(true);
    expect(r.url).toContain(`/search?q=${TERM}`);
  }, 30000);

  it('records the step as not tested when the site has no search', async () => {
    const r = await run('/no-search');
    expect(r.ok).toBe(false);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatch(/^site search: no usable search input/);
    expect(r.url).toBe(`${base}/no-search`);
  }, 30000);

  it('never submits a POST search form', async () => {
    seen.length = 0;
    const r = await run('/post-search');
    expect(r.ok).toBe(false);
    expect(r.notes[0]).toMatch(/POST/);
    expect(seen.some((s) => s.startsWith('POST'))).toBe(false);
  }, 30000);

  it('runs at most once per scenario', async () => {
    const page = await browser.newPage();
    await page.goto(base + '/with-search');
    const cap = { push: () => {}, now: () => 0, pageIndex: () => 0 } as unknown as CaptureHandle;
    const step: SearchStep = { term: TERM, note: () => {} };
    const j = resolveJourney({ pageDwellMs: 100, scrollSteps: 1 });
    expect(await searchStep(page, cap, step, j)).toBe(true);
    expect(await searchStep(page, cap, step, j)).toBe(false);
    await page.close();
  }, 30000);
});
