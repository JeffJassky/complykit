import fs from 'node:fs';
import path from 'node:path';
import { type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveLocation, readGpc, sameOriginEndpoint, type LocationEnv } from '../src/location';
import type { ConsentToolConfig, RegimeSource } from '../src/config';
import { DIST, launchBrowser, startFixtureServer, type FixtureServer } from './harness';

// D7 fixture tests: one per location source, unknown → strictest, and GPC.
// Unit tests drive resolveLocation() with an injected environment; the browser
// tests load the built IIFE on a route-fulfilled page and read the store.

const EXAMPLE = path.join(__dirname, '..', '..', 'test', 'fixtures', 'consent-config', 'example.json');
const ON = '2026-10-06';

const baseConfig = (regimeSource: RegimeSource): any => {
  const c = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
  c.generatedFrom.site ??= 'example-shop.test';
  c.consent ??= { lifetimeDays: 365 };
  for (const cat of c.categories) {
    // Same defaults under both US regimes, so the regime and GPC effects are visible.
    cat.defaultByRegime['opt-out-signal'] = cat.defaultByRegime['opt-out'];
    delete cat.defaultByRegime.notice;
  }
  delete c.gtm; // the GTM bridge is not under test here
  c.regimeSource = regimeSource;
  return c;
};

const metaDoc = (tags: Record<string, string>): LocationEnv['document'] => ({
  querySelector: ((sel: string) => {
    const m = /^meta\[name="(.+)"\]$/.exec(sel);
    const v = m ? tags[m[1]] : undefined;
    return v === undefined ? null : { getAttribute: () => v };
  }) as any,
});
const noDoc = metaDoc({});

const okFetch = (body: string, calls: string[] = []): LocationEnv['fetch'] => async (url) => {
  calls.push(url);
  return { ok: true, text: async () => body };
};

describe('resolveLocation (unit)', () => {
  it('fixed: the configured regime, synchronously, ignoring every other source', async () => {
    const r = resolveLocation(baseConfig({ kind: 'fixed', regime: 'opt-out' }), {
      document: metaDoc({ 'complykit-region': 'DE' }),
      onDate: ON,
    });
    expect(r.initial).toMatchObject({ regime: 'opt-out', source: 'fixed', pending: false });
    expect(await r.ready).toBe(r.initial);
  });

  it('meta: reads the default name and the configured one', () => {
    const def = resolveLocation(baseConfig({ kind: 'meta', name: 'complykit-region' }), { document: metaDoc({ 'complykit-region': 'US-CA' }), onDate: ON });
    expect(def.initial).toMatchObject({ regime: 'opt-out-signal', source: 'meta', location: { country: 'US', region: 'CA' } });
    const custom = resolveLocation(baseConfig({ kind: 'meta', name: 'x-geo' }), { document: metaDoc({ 'x-geo': 'DE' }), onDate: ON });
    expect(custom.initial).toMatchObject({ regime: 'opt-in', source: 'meta' });
    const ny = resolveLocation(baseConfig({ kind: 'meta', name: 'complykit-region' }), { document: metaDoc({ 'complykit-region': 'US-NY' }), onDate: ON });
    expect(ny.initial.regime).toBe('opt-out');
  });

  it('meta: an unreadable value is unknown → strictest', () => {
    for (const v of ['', 'XX', 'Germany']) {
      const r = resolveLocation(baseConfig({ kind: 'meta', name: 'complykit-region' }), { document: metaDoc({ 'complykit-region': v }), onDate: ON });
      expect(r.initial).toMatchObject({ regime: 'opt-in', source: 'unknown' });
    }
  });

  it('header: strict while pending, then the echoed location', async () => {
    const calls: string[] = [];
    const r = resolveLocation(baseConfig({ kind: 'header', header: 'cf-ipcountry', endpoint: '/.well-known/complykit-location' }), {
      document: noDoc,
      fetch: okFetch('US-CO\n', calls),
      pageUrl: 'https://example-shop.test/products/x',
      onDate: ON,
    });
    expect(r.initial).toMatchObject({ regime: 'opt-in', pending: true });
    expect(await r.ready).toMatchObject({ regime: 'opt-out-signal', source: 'header', pending: false });
    expect(calls).toEqual(['https://example-shop.test/.well-known/complykit-location']);
  });

  it('header: a server-written meta tag wins without a request', () => {
    const calls: string[] = [];
    const r = resolveLocation(baseConfig({ kind: 'header', header: 'cf-ipcountry', endpoint: '/geo' }), {
      document: metaDoc({ 'complykit-region': 'GB' }),
      fetch: okFetch('US', calls),
      pageUrl: 'https://example-shop.test/',
      onDate: ON,
    });
    expect(r.initial).toMatchObject({ regime: 'opt-in', source: 'meta', pending: false });
    expect(calls).toEqual([]);
  });

  it('header: a cross-origin endpoint is refused (never a third-party lookup)', () => {
    const calls: string[] = [];
    const r = resolveLocation(baseConfig({ kind: 'header', header: 'cf-ipcountry', endpoint: 'https://geo.example.test/json' }), {
      document: noDoc,
      fetch: okFetch('US-CA', calls),
      pageUrl: 'https://example-shop.test/',
      onDate: ON,
    });
    expect(r.initial).toMatchObject({ regime: 'opt-in', source: 'unknown', pending: false });
    expect(calls).toEqual([]);
    expect(sameOriginEndpoint('//geo.example.test/x', 'https://example-shop.test/')).toBeUndefined();
    expect(sameOriginEndpoint('/geo', 'https://example-shop.test/a/b')).toBe('https://example-shop.test/geo');
  });

  it('header: failure, an error status or a timeout stays strictest', async () => {
    const cfg = baseConfig({ kind: 'header', header: 'cf-ipcountry', endpoint: '/geo' });
    const env = { document: noDoc, pageUrl: 'https://example-shop.test/', onDate: ON };
    const failed = resolveLocation(cfg, { ...env, fetch: async () => { throw new Error('offline'); } });
    expect(await failed.ready).toMatchObject({ regime: 'opt-in', source: 'unknown' });
    const status = resolveLocation(cfg, { ...env, fetch: async () => ({ ok: false, text: async () => 'US-CA' }) });
    expect(await status.ready).toMatchObject({ regime: 'opt-in', source: 'unknown' });
    const slow = resolveLocation(cfg, { ...env, timeoutMs: 20, fetch: () => new Promise(() => {}) });
    expect(await slow.ready).toMatchObject({ regime: 'opt-in', source: 'unknown' });
  });

  it('platform: Shopify customerPrivacy region, read only when already loaded', () => {
    const cfg = baseConfig({ kind: 'platform' });
    const shop = (region: unknown): LocationEnv['window'] => ({ Shopify: { customerPrivacy: { getRegion: () => region } } });
    expect(resolveLocation(cfg, { document: noDoc, window: shop('USCA'), onDate: ON }).initial).toMatchObject({ regime: 'opt-out-signal', source: 'platform' });
    expect(resolveLocation(cfg, { document: noDoc, window: shop('FR'), onDate: ON }).initial).toMatchObject({ regime: 'opt-in', source: 'platform' });
    expect(resolveLocation(cfg, { document: noDoc, window: shop('USTX'), onDate: ON }).initial.regime).toBe('opt-out-signal');
    // Not loaded / throws / junk → unknown → strictest.
    expect(resolveLocation(cfg, { document: noDoc, window: {}, onDate: ON }).initial).toMatchObject({ regime: 'opt-in', source: 'unknown' });
    const throwing: LocationEnv['window'] = { Shopify: { customerPrivacy: { getRegion: () => { throw new Error('x'); } } } };
    expect(resolveLocation(cfg, { document: noDoc, window: throwing, onDate: ON }).initial.source).toBe('unknown');
  });

  it('GPC is read from navigator and reported with every decision', () => {
    expect(readGpc({ globalPrivacyControl: true })).toBe(true);
    expect(readGpc({ globalPrivacyControl: 'true' })).toBe(false);
    expect(readGpc({})).toBe(false);
    expect(readGpc(undefined)).toBe(false);
    const r = resolveLocation(baseConfig({ kind: 'fixed', regime: 'opt-out' }), { navigator: { globalPrivacyControl: true } });
    expect(r.initial.gpc).toBe(true);
  });
});

// --- in a real browser, through the built IIFE --------------------------------------

let browser: Browser;
let server: FixtureServer;

beforeAll(async () => {
  if (!fs.existsSync(path.join(DIST, 'complykit-consent.js'))) {
    throw new Error('dist/complykit-consent.js missing: run `npm run build` first');
  }
  server = await startFixtureServer();
  browser = await launchBrowser();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

interface PageOpts {
  config: unknown;
  meta?: string;
  gpc?: boolean;
  /** Body for the header endpoint; undefined = never answers (held). */
  endpoint?: { path: string; body?: string };
}

async function open(o: PageOpts): Promise<{ page: Page; requests: string[]; release: () => Promise<void> }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  if (o.gpc) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true }));
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  if (o.endpoint) {
    const ep = o.endpoint;
    await page.route(`**${ep.path}`, async (route) => {
      if (ep.body === undefined) await held;
      await route.fulfill({ contentType: 'text/plain', body: ep.body ?? 'US-CA' });
    });
  }
  await page.route('**/location-page', (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><head>${o.meta ? `<meta name="complykit-region" content="${o.meta}">` : ''}
<script type="application/json" id="complykit-config">${JSON.stringify(o.config)}</script>
<script src="/complykit-consent.js"></script></head><body></body></html>`,
    }),
  );
  await page.goto(`${server.origin}/location-page`);
  return {
    page,
    requests,
    release: async () => {
      release();
    },
  };
}

const state = (page: Page) => page.evaluate(() => (window as any).ComplyKit.get());
const diag = (page: Page) => page.evaluate(() => (window as any).ComplyKit.diagnostics.location);

describe('location in the browser', () => {
  it('meta: the regime is set before the store starts', async () => {
    const { page } = await open({ config: baseConfig({ kind: 'meta', name: 'complykit-region' }), meta: 'US-NY' });
    const s = await state(page);
    expect(s.regime).toBe('opt-out');
    expect(s.categories).toMatchObject({ necessary: true, analytics: true, advertising: true });
    expect(await diag(page)).toMatchObject({ source: 'meta', regime: 'opt-out', pending: false });
    await page.context().close();
  });

  it('meta: an EU visitor gets nothing but necessary', async () => {
    const { page } = await open({ config: baseConfig({ kind: 'meta', name: 'complykit-region' }), meta: 'DE' });
    const s = await state(page);
    expect(s.regime).toBe('opt-in');
    expect(s.categories).toEqual({ necessary: true, analytics: false, advertising: false });
    await page.context().close();
  });

  it('header: strictest until the same-origin endpoint answers, then moves', async () => {
    const cfg = baseConfig({ kind: 'header', header: 'cf-ipcountry', endpoint: '/.well-known/complykit-location' });
    const { page, requests, release } = await open({ config: cfg, endpoint: { path: '/.well-known/complykit-location' } });
    const before = await state(page);
    expect(before.regime).toBe('opt-in');
    expect(before.categories).toEqual({ necessary: true, analytics: false, advertising: false });
    expect(await diag(page)).toMatchObject({ source: 'header', pending: true });
    await release();
    await page.waitForFunction(() => (window as any).ComplyKit.diagnostics.location?.pending === false);
    const after = await state(page);
    expect(after.regime).toBe('opt-out-signal');
    expect(after.categories).toMatchObject({ analytics: true, advertising: true });
    expect(requests.every((u) => u.startsWith(server.origin))).toBe(true);
    await page.context().close();
  });

  it('unknown: no meta, no platform → strictest', async () => {
    const { page } = await open({ config: baseConfig({ kind: 'platform' }) });
    const s = await state(page);
    expect(s.regime).toBe('opt-in');
    expect(s.categories).toEqual({ necessary: true, analytics: false, advertising: false });
    expect(await diag(page)).toMatchObject({ source: 'unknown', regime: 'opt-in' });
    await page.context().close();
  });

  it('GPC: a US visitor in an opt-out state gets every non-necessary default denied, and gpc is recorded', async () => {
    const { page } = await open({ config: baseConfig({ kind: 'meta', name: 'complykit-region' }), meta: 'US-CA', gpc: true });
    const s = await state(page);
    expect(s.regime).toBe('opt-out-signal');
    expect(s.gpc).toBe(true);
    expect(s.categories).toEqual({ necessary: true, analytics: false, advertising: false });
    expect(await diag(page)).toMatchObject({ gpc: true });
    // Without GPC, the same visitor gets the configured opt-out defaults.
    const plain = await open({ config: baseConfig({ kind: 'meta', name: 'complykit-region' }), meta: 'US-CA' });
    expect((await state(plain.page)).categories).toMatchObject({ advertising: true });
    await page.context().close();
    await plain.page.context().close();
  });
});
