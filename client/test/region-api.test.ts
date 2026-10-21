import fs from 'node:fs';
import path from 'node:path';
import { type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveLocation, type LocationEnv } from '../src/location';
import type { ConsentToolConfig, RegimeSource } from '../src/config';
import { DIST, launchBrowser, startFixtureServer, type FixtureServer } from './harness';

// Contract (plans/regime-overrides.md "Region API"): the site tells the tool where
// the visitor is, with no request.
//   window.ComplyKitRegion = 'US-CA'   set before the tool's script: read synchronously,
//                                      beats the meta tag, the header endpoint (never
//                                      fetched) and the platform.
//   ComplyKit.setRegion('US-CA')       after load: replaces whatever was decided (a pending
//                                      lookup's late answer is then ignored). Moves the
//                                      defaults before a choice only; a stored choice stands.
//                                      Returns false (and changes nothing) for a value that
//                                      is not a location, or when the tool is not running.
// A `fixed` regimeSource keeps its regime; the region still sets the location (holds).

const EXAMPLE = path.join(__dirname, '..', '..', 'test', 'fixtures', 'consent-config', 'example.json');
const ON = '2026-10-21';

function cfg(regimeSource: RegimeSource): ConsentToolConfig {
  const c = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
  for (const cat of c.categories) if (cat.id !== 'necessary') cat.defaultByRegime = { 'opt-in': false, 'opt-out-signal': true, 'opt-out': true };
  delete c.gtm;
  c.regimeSource = regimeSource;
  c.locationDefaults = { 'US-CA': { analytics: false, advertising: false } };
  return c;
}
const HEADER: RegimeSource = { kind: 'header', header: 'complykit-geo', endpoint: 'https://ck.example-host.test/geo' };
const META: RegimeSource = { kind: 'meta', name: 'complykit-region' };

const metaDoc = (tags: Record<string, string>): LocationEnv['document'] => ({
  querySelector: ((sel: string) => {
    const m = /^meta\[name="(.+)"\]$/.exec(sel);
    const v = m ? tags[m[1]] : undefined;
    return v === undefined ? null : { getAttribute: () => v };
  }) as any,
});

describe('window.ComplyKitRegion (unit)', () => {
  const env = (region: unknown, calls: string[] = [], tags: Record<string, string> = {}): LocationEnv => ({
    document: metaDoc(tags),
    window: { ComplyKitRegion: region } as never,
    pageUrl: 'https://www.example-shop.test/',
    scriptUrl: 'https://ck.example-host.test/s/example-shop.test.js',
    fetch: async (url) => {
      calls.push(url);
      return { ok: true, text: async () => 'DE' };
    },
    onDate: ON,
  });

  it('decides synchronously, source "global", and the header endpoint is never fetched', async () => {
    const calls: string[] = [];
    const r = resolveLocation(cfg(HEADER), env('US-CA', calls));
    expect(r.initial).toMatchObject({ source: 'global', regime: 'opt-out-signal', pending: false, location: { country: 'US', region: 'CA' } });
    await r.ready;
    expect(calls).toEqual([]);
  });

  it('beats the meta tag', () => {
    expect(resolveLocation(cfg(META), env('DE', [], { 'complykit-region': 'US-TX' })).initial).toMatchObject({ source: 'global', regime: 'opt-in' });
  });

  it('a value that is not a location is ignored (the next source decides)', () => {
    for (const bad of ['', 'Europe', 'XX', 42, { country: 'US' }, null]) {
      expect(resolveLocation(cfg(META), env(bad, [], { 'complykit-region': 'US-TX' })).initial, JSON.stringify(bad)).toMatchObject({ source: 'meta' });
    }
  });

  it('owner regime overrides still apply to it', () => {
    const c = { ...cfg(META), overrides: { regimes: { CA: 'opt-out' as const } } };
    expect(resolveLocation(c, env('CA-ON')).initial).toMatchObject({ source: 'global', regime: 'opt-out', overridden: true });
  });

  it('under a fixed regime it sets the location only', () => {
    expect(resolveLocation(cfg({ kind: 'fixed', regime: 'opt-out' }), env('US-CA')).initial).toMatchObject({ source: 'fixed', regime: 'opt-out', location: { country: 'US', region: 'CA' } });
  });
});

// --- the built tool in a browser -------------------------------------------------

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

interface PageOpts {
  config: unknown;
  /** Set as window.ComplyKitRegion before the tool's script. */
  region?: string;
  meta?: string;
  /** Same-origin location endpoint that never answers until released (header source). */
  holdEndpoint?: string;
}

async function open(o: PageOpts): Promise<{ page: Page; requests: string[]; release: (body: string) => void }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  let release: (body: string) => void = () => {};
  if (o.holdEndpoint) {
    const answered = new Promise<string>((r) => (release = r));
    await page.route(`**${o.holdEndpoint}`, async (route) => route.fulfill({ contentType: 'text/plain', body: await answered }));
  }
  await page.route('**/region-page', (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><head>${o.meta ? `<meta name="complykit-region" content="${o.meta}">` : ''}
${o.region !== undefined ? `<script>window.ComplyKitRegion = ${JSON.stringify(o.region)}</script>` : ''}
<script type="application/json" id="complykit-config">${JSON.stringify(o.config)}</script>
<script src="/complykit-consent.js"></script>
<script type="text/plain" data-category="analytics">window.__ran = (window.__ran || []).concat('analytics')</script>
</head><body></body></html>`,
    }),
  );
  await page.goto(`${server.origin}/region-page`);
  return { page, requests, release };
}
const state = (page: Page) => page.evaluate(() => (window as any).ComplyKit.get());
const ran = (page: Page) => page.evaluate(() => ((window as any).__ran ?? []).slice());
const setRegion = (page: Page, v: unknown) => page.evaluate((x) => (window as any).ComplyKit.setRegion(x), v);

describe('region API in the browser', () => {
  it('ComplyKitRegion before the script: California holds analytics, with no location request', async () => {
    const { page, requests } = await open({ config: cfg({ kind: 'header', header: 'complykit-geo', endpoint: '/geo' }), region: 'US-CA' });
    expect(await state(page)).toMatchObject({ regime: 'opt-out-signal', location: { country: 'US', region: 'CA' }, categories: { analytics: false } });
    expect(await ran(page)).toEqual([]);
    expect(requests.some((u) => u.endsWith('/geo'))).toBe(false);
    await page.context().close();
  });

  it('setRegion after load moves the defaults before a choice and reports source "api"', async () => {
    const { page } = await open({ config: cfg(META) }); // no location: opt-in, nothing runs
    expect(await ran(page)).toEqual([]);
    expect(await setRegion(page, 'US-TX')).toBe(true);
    expect(await state(page)).toMatchObject({ regime: 'opt-out-signal', categories: { analytics: true } });
    await page.waitForFunction(() => ((window as any).__ran ?? []).includes('analytics'));
    expect(await page.evaluate(() => (window as any).ComplyKit.diagnostics.location)).toMatchObject({ source: 'api', regime: 'opt-out-signal', pending: false, location: { country: 'US', region: 'TX' } });
    await page.context().close();
  });

  it('setRegion during a pending lookup wins; the late answer is ignored', async () => {
    const { page, release } = await open({ config: cfg({ kind: 'header', header: 'complykit-geo', endpoint: '/held-geo' }), holdEndpoint: '/held-geo' });
    expect(await setRegion(page, 'US-CA')).toBe(true);
    release('US-TX');
    await page.waitForTimeout(300);
    expect(await state(page)).toMatchObject({ regime: 'opt-out-signal', location: { country: 'US', region: 'CA' }, categories: { analytics: false } });
    expect(await page.evaluate(() => (window as any).ComplyKit.diagnostics.location)).toMatchObject({ source: 'api', pending: false });
    await page.context().close();
  });

  it('a stored choice is never changed by setRegion', async () => {
    const { page } = await open({ config: cfg(META), region: 'US-TX' });
    // A recorded choice: everything denied. A withdrawal that revoked something reloads the page (withdraw.ts).
    await Promise.all([page.waitForEvent('load'), page.evaluate(() => (window as any).ComplyKit.withdraw())]);
    const before = await state(page);
    expect(before.status).toBe('chosen');
    expect(await setRegion(page, 'US-CA')).toBe(true);
    expect(await state(page)).toMatchObject({ status: 'chosen', categories: before.categories, regime: before.regime });
    await page.context().close();
  });

  it('a value that is not a location returns false and changes nothing', async () => {
    const { page } = await open({ config: cfg(META), region: 'US-TX' });
    const before = await state(page);
    for (const bad of ['Europe', '', 7, null]) expect(await setRegion(page, bad), JSON.stringify(bad)).toBe(false);
    expect(await state(page)).toEqual(before);
    await page.context().close();
  });
});
