import fs from 'node:fs';
import path from 'node:path';
import { type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeRecord } from '../../service/src/server/consent-records';
import { DIST, launchBrowser, startFixtureServer, type FixtureServer } from './harness';

// D3 fixture tests: the consent state store in a real browser, loaded from the
// built IIFE. Pages are served by the fixture server's origin (so cookies and
// localStorage are first-party) with the inline config injected per test via
// route fulfilment; the record endpoint is a route that captures the POST.

const EXAMPLE = path.join(__dirname, '..', '..', 'test', 'fixtures', 'consent-config', 'example.json');
// The shared example sets consent.cookieDomain to `.example-shop.test`, which the
// browser rejects on the fixture's 127.0.0.1 origin: these tests therefore also
// cover the host-only fallback. `lifetimeDays` drives the cookie's Max-Age.
const baseConfig = (): any => JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
const DAYS = (): number => baseConfig().consent.lifetimeDays;

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

interface Harness {
  ctx: BrowserContext;
  page: Page;
  records: Array<{ body: string; contentType: string | undefined }>;
  /** Serve this config on the next load. */
  setConfig(c: unknown): void;
  load(): Promise<void>;
}

async function harness(config: unknown): Promise<Harness> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const records: Harness['records'] = [];
  let current = config;
  await page.route('**/store-page', (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><head><meta charset="utf-8">
<script type="application/json" id="complykit-config">${JSON.stringify(current)}</script>
<script src="/complykit-consent.js"></script></head><body>store fixture</body></html>`,
    }),
  );
  await page.route('**/consent-record', async (route) => {
    const req = route.request();
    records.push({ body: req.postData() ?? '', contentType: req.headers()['content-type'] });
    await route.fulfill({ status: 204 });
  });
  return {
    ctx,
    page,
    records,
    setConfig: (c) => {
      current = c;
    },
    load: async () => {
      await page.goto(`${server.origin}/store-page`);
    },
  };
}

const get = (p: Page) => p.evaluate(() => (window as any).ComplyKit.get());
const cookie = async (ctx: BrowserContext) => (await ctx.cookies()).find((c) => c.name === 'complykit_consent');
const waitFor = async (cond: () => boolean, ms = 3000) => {
  const t = Date.now();
  while (!cond() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 25));
};

describe('consent state store', () => {
  it('starts unset with fail-closed opt-in defaults, writes nothing before a choice', async () => {
    const h = await harness(baseConfig());
    await h.load();
    const s = await get(h.page);
    expect(s).toMatchObject({ status: 'unset', reason: 'none', regime: 'opt-in', categories: { necessary: true, analytics: false, advertising: false } });
    expect(await cookie(h.ctx)).toBeUndefined();
    expect(await h.page.evaluate(() => localStorage.getItem('complykit_consent'))).toBeNull();
    expect(h.records).toHaveLength(0);
    await h.ctx.close();
  });

  it('persists a choice across reloads (cookie + localStorage mirror), and restores a dropped cookie', async () => {
    const h = await harness(baseConfig());
    await h.load();
    // The banner's call: the store is internal, so go through init()'s return value.
    const chosen = await h.page.evaluate(() => {
      const ck = (window as any).ComplyKit;
      const seen: any[] = [];
      ck.on('change', (s: any) => seen.push(s));
      const store = ck.init(JSON.parse(document.getElementById('complykit-config')!.textContent!));
      store.set({ analytics: true });
      return { state: ck.get(), seen: seen.length };
    });
    expect(chosen.seen).toBe(1);
    expect(chosen.state).toMatchObject({ status: 'chosen', categories: { necessary: true, analytics: true, advertising: false } });
    expect(chosen.state.id).toMatch(/^[0-9a-f]{32}$/);

    const c = await cookie(h.ctx);
    expect(c).toBeDefined();
    expect(c!.path).toBe('/');
    expect(c!.sameSite).toBe('Lax');
    // config.consent.lifetimeDays
    expect(c!.expires - Date.now() / 1000).toBeGreaterThan((DAYS() - 1) * 86400);
    expect(c!.expires - Date.now() / 1000).toBeLessThan((DAYS() + 1) * 86400);
    const stored = JSON.parse(decodeURIComponent(c!.value));
    expect(stored).toMatchObject({ v: 1, id: chosen.state.id, regime: 'opt-in', gpc: false, configHash: baseConfig().hash, categories: { necessary: true, analytics: true, advertising: false } });

    await h.load();
    expect(await get(h.page)).toMatchObject({ status: 'chosen', id: chosen.state.id, categories: { analytics: true, advertising: false } });

    // Cookie dropped (ITP / cleaner): the mirror restores it.
    await h.ctx.clearCookies();
    await h.load();
    expect(await get(h.page)).toMatchObject({ status: 'chosen', id: chosen.state.id });
    expect(JSON.parse(decodeURIComponent((await cookie(h.ctx))!.value)).id).toBe(chosen.state.id);
    await h.ctx.close();
  });

  it('keeps the choice when only the config hash changes, re-asks when the category set changes', async () => {
    const h = await harness(baseConfig());
    await h.load();
    await h.page.evaluate(() => {
      const ck = (window as any).ComplyKit;
      ck.init(JSON.parse(document.getElementById('complykit-config')!.textContent!)).acceptAll();
    });
    const first = await get(h.page);

    const themed = baseConfig();
    themed.theme.accent = '#000000';
    themed.hash = 'f'.repeat(64);
    h.setConfig(themed);
    await h.load();
    expect(await get(h.page)).toMatchObject({ status: 'chosen', id: first.id, configHash: baseConfig().hash });

    const added = baseConfig();
    added.categories.push({ id: 'preferences', label: 'Preferences', description: 'x', defaultByRegime: { ...added.categories[1].defaultByRegime } });
    added.hash = 'e'.repeat(64);
    h.setConfig(added);
    await h.load();
    expect(await get(h.page)).toMatchObject({ status: 'unset', reason: 'categories-changed', categories: { necessary: true, analytics: false, advertising: false, preferences: false } });
    expect(await cookie(h.ctx)).toBeUndefined();
    expect(await h.page.evaluate(() => localStorage.getItem('complykit_consent'))).toBeNull();
    await h.ctx.close();
  });

  it('expires a choice after its lifetime (365 days unless config.consent.lifetimeDays says otherwise)', async () => {
    const year = baseConfig();
    year.consent = { lifetimeDays: 365 };
    const h = await harness(year);
    const old = { v: 1, id: 'a'.repeat(32), at: new Date(Date.now() - 366 * 86_400_000).toISOString(), configHash: baseConfig().hash, regime: 'opt-in', gpc: false, categories: { necessary: true, analytics: true, advertising: true } };
    await h.ctx.addCookies([{ name: 'complykit_consent', value: encodeURIComponent(JSON.stringify(old)), url: server.origin }]);
    await h.load();
    expect(await get(h.page)).toMatchObject({ status: 'unset', reason: 'expired', categories: { analytics: false, advertising: false } });
    expect(await cookie(h.ctx)).toBeUndefined();

    // config.consent.lifetimeDays shortens it.
    const short = baseConfig();
    short.consent = { lifetimeDays: 30 };
    h.setConfig(short);
    const month = { ...old, at: new Date(Date.now() - 31 * 86_400_000).toISOString() };
    await h.ctx.addCookies([{ name: 'complykit_consent', value: encodeURIComponent(JSON.stringify(month)), url: server.origin }]);
    await h.load();
    expect(await get(h.page)).toMatchObject({ status: 'unset', reason: 'expired' });
    await h.ctx.close();
  });

  it('records the choice: POST body passes the service validator; withdraw records and emits', async () => {
    const h = await harness(baseConfig());
    await h.load();
    const s = await h.page.evaluate(() => {
      const ck = (window as any).ComplyKit;
      ck.init(JSON.parse(document.getElementById('complykit-config')!.textContent!)).set({ analytics: true, bogus: true });
      return ck.get();
    });
    await waitFor(() => h.records.length >= 1);
    expect(h.records).toHaveLength(1);
    expect(h.records[0].contentType).toMatch(/^text\/plain/);
    const body = JSON.parse(h.records[0].body);
    expect(Object.keys(body).sort()).toEqual(['at', 'categories', 'configHash', 'gpc', 'id', 'regime', 'toolVersion']);
    expect(body).toEqual({ id: s.id, at: s.at, categories: { necessary: true, analytics: true, advertising: false }, configHash: baseConfig().hash, toolVersion: '0.0.0', regime: 'opt-in', gpc: false });
    // Exactly what the F4 endpoint accepts.
    expect(() => normalizeRecord(body, 'example.test')).not.toThrow();

    const w = await h.page.evaluate(() => {
      const ck = (window as any).ComplyKit;
      const events: string[] = [];
      ck.on('withdraw', () => events.push('withdraw'));
      ck.on('change', () => events.push('change'));
      ck.on('open', () => events.push('open'));
      const state = ck.withdraw();
      ck.open();
      return { state, events };
    });
    expect(w.events).toEqual(['change', 'withdraw', 'open']);
    expect(w.state).toMatchObject({ status: 'chosen', categories: { necessary: true, analytics: false, advertising: false } });
    await waitFor(() => h.records.length >= 2);
    const wb = JSON.parse(h.records[1].body);
    expect(wb.id).not.toBe(body.id); // one id per decision: the service de-dups on it
    expect(wb.categories).toEqual({ necessary: true, analytics: false, advertising: false });
    expect(() => normalizeRecord(wb, 'example.test')).not.toThrow();
    await h.ctx.close();
  });

  it('GPC denies non-necessary defaults and is stored with the choice', async () => {
    const cfg = baseConfig();
    cfg.regimeSource = { kind: 'fixed', regime: 'opt-out' };
    const h = await harness(cfg);
    await h.load();
    expect(await get(h.page)).toMatchObject({ status: 'unset', regime: 'opt-out', gpc: false, categories: { analytics: true, advertising: true } });
    await h.ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true }));
    await h.load();
    expect(await get(h.page)).toMatchObject({ status: 'unset', regime: 'opt-out', gpc: true, categories: { necessary: true, analytics: false, advertising: false } });
    await h.page.evaluate(() => {
      const ck = (window as any).ComplyKit;
      ck.init(JSON.parse(document.getElementById('complykit-config')!.textContent!)).set({ analytics: true });
    });
    await waitFor(() => h.records.length >= 1);
    expect(JSON.parse(h.records[0].body)).toMatchObject({ regime: 'opt-out', gpc: true, categories: { analytics: true, advertising: false } });
    await h.ctx.close();
  });

  it('refuses a config with another major version: nothing starts', async () => {
    const cfg = baseConfig();
    cfg.version = '2.0';
    const h = await harness(cfg);
    await h.load();
    expect(await get(h.page)).toBeNull();
    await h.ctx.close();
  });
});
