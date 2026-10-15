import fs from 'node:fs';
import path from 'node:path';
import { type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DIST, launchBrowser, startFixtureServer, type FixtureServer } from './harness';

// T2 contract (plans/hosted-script.md "Event beacon", P4/P5/P8): the banner
// beacon. Counters-only input: one text/plain POST per flush (pagehide /
// visibilitychange hidden) with the events not yet sent, and nothing that could
// identify the visitor or the page. Off unless config.analytics.endpoint is set.

const EXAMPLE = path.join(__dirname, '..', '..', 'test', 'fixtures', 'consent-config', 'example.json');
const baseConfig = (over: Record<string, unknown> = {}): any => {
  const c = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
  c.generatedFrom.site ??= 'example-shop.test';
  c.consent = { lifetimeDays: 365 };
  c.regimeSource = { kind: 'fixed', regime: 'opt-in' };
  for (const cat of c.categories) {
    cat.defaultByRegime['opt-out-signal'] ??= cat.id === 'necessary';
    delete cat.defaultByRegime.notice;
  }
  delete c.gtm;
  return { ...c, ...over };
};

let browser: Browser;
let server: FixtureServer;

beforeAll(async () => {
  if (!fs.existsSync(path.join(DIST, 'complykit-consent.js'))) throw new Error('dist/complykit-consent.js missing: run `npm run build` first');
  server = await startFixtureServer();
  browser = await launchBrowser();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

interface Beacon {
  contentType: string;
  body: string;
  json: any;
}

async function open(config: unknown, opts: { ctx?: BrowserContext; scriptAttrs?: string } = {}): Promise<{ page: Page; ctx: BrowserContext; beacons: Beacon[] }> {
  const ctx = opts.ctx ?? (await browser.newContext());
  const page = await ctx.newPage();
  const beacons: Beacon[] = [];
  await page.route('**/events-page', (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Events fixture</title>
<script>window.ComplyKitConfig=${JSON.stringify(config)};</script>
<script src="/complykit-consent.js" ${opts.scriptAttrs ?? ''}></script></head><body><main><h1>Shop</h1><input id="q" value="secret search"></main></body></html>`,
    }),
  );
  await page.route('**/e', async (route) => {
    const req = route.request();
    const body = req.postData() ?? '';
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      json = undefined;
    }
    beacons.push({ contentType: (await req.allHeaders())['content-type'] ?? '', body, json });
    await route.fulfill({ status: 204 });
  });
  await page.route('**/consent-record', (route) => route.fulfill({ status: 204 }));
  await page.goto(`${server.origin}/events-page?utm_source=ad&email=a%40b.test`);
  return { page, ctx, beacons };
}

const withAnalytics = () => baseConfig({ analytics: { endpoint: `${server.origin}/e` } });
const flush = (p: Page) => p.evaluate(() => window.dispatchEvent(new Event('pagehide')));
const settle = (p: Page) => p.waitForTimeout(150);
const click = async (p: Page, sel: string) => {
  await p.waitForSelector(sel, { state: 'visible' });
  await p.click(sel);
};
const BANNER = '#complykit-ui .ck-banner';
const btn = (scope: 'banner' | 'settings', action: string) => (scope === 'banner' ? `${BANNER} .ck-btn[data-ck-action="${action}"]` : `#complykit-ui .ck-settings[open] .ck-btn[data-ck-action="${action}"]`);

const TOP_KEYS = ['ev', 'h', 'r', 'tv', 'v'];
const EVENT_KEYS: Record<string, string[]> = { load: ['d', 'gpc', 't'], shown: ['t'], open: ['t', 'via'], decide: ['a', 'cats', 'ms', 't', 'via'] };

function assertShape(b: Beacon, config: any): void {
  expect(b.contentType).toMatch(/^text\/plain/);
  expect(Object.keys(b.json).sort()).toEqual(TOP_KEYS);
  expect(b.json.v).toBe(1);
  expect(b.json.h).toBe(config.hash);
  expect(b.json.r).toBe('opt-in');
  for (const e of b.json.ev) {
    expect(EVENT_KEYS[e.t], `event type ${e.t}`).toBeDefined();
    for (const k of Object.keys(e)) expect(EVENT_KEYS[e.t], `${e.t}.${k}`).toContain(k);
  }
  // P4/P5: nothing about the page or the visitor.
  for (const bad of [server.origin, '127.0.0.1', 'events-page', 'utm_source', 'a%40b', 'secret search', 'Mozilla', 'Events fixture']) expect(b.body).not.toContain(bad);
}

describe('banner beacon', () => {
  it('sends nothing at all without config.analytics', async () => {
    const { page, ctx, beacons } = await open(baseConfig());
    await click(page, btn('banner', 'accept'));
    await flush(page);
    await settle(page);
    expect(beacons).toEqual([]);
    await ctx.close();
  });

  it('load + shown + decide(accept, banner, ms) in one beacon on pagehide, with only allow-listed keys', async () => {
    const config = withAnalytics();
    const { page, ctx, beacons } = await open(config);
    await page.waitForSelector(BANNER, { state: 'visible' });
    await page.waitForTimeout(120);
    await click(page, btn('banner', 'accept'));
    await settle(page);
    expect(beacons).toEqual([]); // nothing before the flush (P8)
    await flush(page);
    await settle(page);
    expect(beacons).toHaveLength(1);
    const b = beacons[0];
    assertShape(b, config);
    expect(b.json.ev).toEqual([
      { t: 'load', d: 0, gpc: 0 },
      { t: 'shown' },
      { t: 'decide', a: 'accept', via: 'banner', ms: expect.any(Number) },
    ]);
    expect(b.json.ev[2].ms).toBeGreaterThanOrEqual(100);
    await ctx.close();
  });

  it('a second flush sends only new events, and nothing when there are none', async () => {
    const { page, ctx, beacons } = await open(withAnalytics());
    await page.waitForSelector(BANNER, { state: 'visible' });
    await flush(page);
    await settle(page);
    await flush(page);
    await settle(page);
    expect(beacons).toHaveLength(1);
    await click(page, btn('banner', 'reject'));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))).catch(() => {});
    await flush(page);
    await settle(page);
    expect(beacons).toHaveLength(2);
    expect(beacons[1].json.ev).toEqual([{ t: 'decide', a: 'reject', via: 'banner', ms: expect.any(Number) }]);
    await ctx.close();
  });

  it('settings: open via banner, then a custom save carries the categories', async () => {
    const config = withAnalytics();
    const { page, ctx, beacons } = await open(config);
    await click(page, btn('banner', 'manage'));
    await click(page, '#complykit-ui .ck-settings[open] .ck-toggle[data-ck-category="analytics"]');
    await click(page, btn('settings', 'save'));
    await flush(page);
    await settle(page);
    const ev = beacons.flatMap((b) => b.json.ev);
    expect(ev).toContainEqual({ t: 'open', via: 'banner' });
    expect(ev).toContainEqual({ t: 'decide', a: 'custom', via: 'settings', ms: expect.any(Number), cats: { analytics: true, advertising: false } });
    for (const b of beacons) assertShape(b, config);
    await ctx.close();
  });

  it('a returning visitor: load with d=1 and no shown', async () => {
    const config = withAnalytics();
    const first = await open(config);
    await click(first.page, btn('banner', 'accept'));
    await first.page.close();
    const again = await open(config, { ctx: first.ctx });
    await flush(again.page);
    await settle(again.page);
    expect(again.beacons).toHaveLength(1);
    expect(again.beacons[0].json.ev).toEqual([{ t: 'load', d: 1, gpc: 0 }]);
    await first.ctx.close();
  });
});

describe('UI file version pinning', () => {
  it('the derived UI URL carries ?v=<version>; an explicit data-complykit-ui is left alone', async () => {
    const a = await open(baseConfig());
    await a.page.waitForSelector(BANNER, { state: 'visible' });
    const url = await a.page.evaluate(() => (window as any).ComplyKit.diagnostics.ui.url as string);
    const version = await a.page.evaluate(() => (window as any).ComplyKit.version as string);
    expect(url).toBe(`${server.origin}/complykit-consent-ui.js?v=${encodeURIComponent(version)}`);
    await a.ctx.close();

    const b = await open(baseConfig(), { scriptAttrs: 'data-complykit-ui="/complykit-consent-ui.js"' });
    await b.page.waitForSelector(BANNER, { state: 'visible' });
    expect(await b.page.evaluate(() => (window as any).ComplyKit.diagnostics.ui.url)).toBe(`${server.origin}/complykit-consent-ui.js`);
    await b.ctx.close();
  });
});
