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
  /** What the record endpoint answers from now on: an HTTP status, or 'abort' (network failure). Default 204. */
  setRecordAnswer(a: number | 'abort'): void;
  load(): Promise<void>;
}

async function harness(config: unknown): Promise<Harness> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const records: Harness['records'] = [];
  let current = config;
  let answer: number | 'abort' = 204;
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
    if (answer === 'abort') await route.abort('failed');
    else await route.fulfill({ status: answer, headers: { 'access-control-allow-origin': '*' } });
  });
  return {
    ctx,
    page,
    records,
    setConfig: (c) => {
      current = c;
    },
    setRecordAnswer: (a) => {
      answer = a;
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
    // A first decision: no `supersedes`, no `region` (no location reported on this fixture).
    expect(Object.keys(body).sort()).toEqual(['at', 'categories', 'configHash', 'gpc', 'gpcHonored', 'id', 'kind', 'regime', 'toolVersion']);
    expect(body).toEqual({ id: s.id, at: s.at, kind: 'choice', categories: { necessary: true, analytics: true, advertising: false }, configHash: baseConfig().hash, toolVersion: '0.0.0', regime: 'opt-in', gpc: false, gpcHonored: false });
    expect(s).toMatchObject({ kind: 'choice' });
    expect(s.supersedes).toBeUndefined();
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
    // It took back a grant: a withdrawal, chained to the decision it replaces.
    expect(wb).toMatchObject({ kind: 'withdrawal', supersedes: body.id });
    expect(w.state).toMatchObject({ kind: 'withdrawal', supersedes: body.id });
    expect(() => normalizeRecord(wb, 'example.test')).not.toThrow();
    expect(normalizeRecord(wb, 'example.test')).toMatchObject({ kind: 'withdrawal', supersedes: body.id });
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
    expect(JSON.parse(h.records[0].body)).toMatchObject({ regime: 'opt-out', gpc: true, gpcHonored: true, categories: { analytics: true, advertising: false } });
    await h.ctx.close();
  });

  it('records gpcHonored false when the owner turned GPC honoring off', async () => {
    const cfg = baseConfig();
    cfg.regimeSource = { kind: 'fixed', regime: 'opt-out' };
    cfg.overrides = { honorGpc: false };
    const h = await harness(cfg);
    await h.ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true }));
    await h.load();
    await h.page.evaluate(() => (window as any).ComplyKit.init(JSON.parse(document.getElementById('complykit-config')!.textContent!)).rejectAll());
    await waitFor(() => h.records.length >= 1);
    expect(JSON.parse(h.records[0].body)).toMatchObject({ gpc: true, gpcHonored: false });
    expect(JSON.parse(decodeURIComponent((await cookie(h.ctx))!.value))).toMatchObject({ gpc: true, gpcHonored: false });
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

  it('the cookie is a complete snapshot of the current decision: kind, supersedes, gpcHonored, region', async () => {
    const h = await harness(baseConfig());
    await h.load();
    const first = await h.page.evaluate(() => {
      const ck = (window as any).ComplyKit;
      const store = ck.init(JSON.parse(document.getElementById('complykit-config')!.textContent!));
      ck.setRegion('US-CA');
      store.rejectAll();
      return ck.get();
    });
    // Rejecting with nothing granted before is a choice, not a withdrawal.
    expect(first).toMatchObject({ status: 'chosen', kind: 'choice', region: 'US-CA' });
    expect(first.supersedes).toBeUndefined();
    const c1 = JSON.parse(decodeURIComponent((await cookie(h.ctx))!.value));
    expect(c1).toMatchObject({ v: 1, id: first.id, kind: 'choice', gpcHonored: false, region: 'US-CA' });
    expect('supersedes' in c1).toBe(false);

    // A later grant replaces it: a choice, chained to the first.
    const second = await h.page.evaluate(() => {
      const ck = (window as any).ComplyKit;
      ck.init(JSON.parse(document.getElementById('complykit-config')!.textContent!)).set({ analytics: true });
      return ck.get();
    });
    expect(second).toMatchObject({ kind: 'choice', supersedes: first.id, region: 'US-CA' });
    const c2 = JSON.parse(decodeURIComponent((await cookie(h.ctx))!.value));
    expect(c2).toMatchObject({ id: second.id, kind: 'choice', supersedes: first.id, region: 'US-CA' });
    // The mirror holds the same JSON.
    expect(JSON.parse((await h.page.evaluate(() => localStorage.getItem('complykit_consent')))!)).toEqual(c2);

    // After a reload the state still reports them.
    await h.load();
    expect(await get(h.page)).toMatchObject({ status: 'chosen', id: second.id, kind: 'choice', supersedes: first.id, region: 'US-CA' });

    // Taking back analytics in the settings layer (not withdraw()) is also a withdrawal.
    const third = await h.page.evaluate(() => {
      const ck = (window as any).ComplyKit;
      ck.init(JSON.parse(document.getElementById('complykit-config')!.textContent!)).set({ advertising: true });
      return ck.get();
    });
    expect(third).toMatchObject({ kind: 'withdrawal', supersedes: second.id });
    await h.ctx.close();
  });

  it('keeps a stored value written before these fields existed (no re-prompt)', async () => {
    const h = await harness(baseConfig());
    await h.load();
    const old = { v: 1, id: 'a'.repeat(32), at: new Date().toISOString(), configHash: baseConfig().hash, regime: 'opt-in', gpc: false, categories: { necessary: true, analytics: true, advertising: false } };
    await h.page.evaluate((j) => localStorage.setItem('complykit_consent', j), JSON.stringify(old));
    await h.load();
    const s = await get(h.page);
    expect(s).toMatchObject({ status: 'chosen', id: old.id, categories: { analytics: true } });
    expect(s.kind).toBeUndefined();
    expect(s.supersedes).toBeUndefined();
    await h.ctx.close();
  });

  it('a record the endpoint did not confirm is kept and resent on the next page, then dropped', async () => {
    const h = await harness(baseConfig());
    h.setRecordAnswer('abort');
    await h.load();
    const s = await h.page.evaluate(() => {
      const ck = (window as any).ComplyKit;
      ck.init(JSON.parse(document.getElementById('complykit-config')!.textContent!)).set({ analytics: true });
      return ck.get();
    });
    await waitFor(() => h.records.length >= 1);
    const outbox = async () => JSON.parse((await h.page.evaluate(() => localStorage.getItem('complykit_consent_outbox'))) ?? '[]');
    await waitFor(() => false, 300);
    expect((await outbox()).map((r: any) => r.id)).toEqual([s.id]);

    // A server error is not a confirmation either.
    h.setRecordAnswer(503);
    await h.load();
    await waitFor(() => h.records.length >= 2);
    await waitFor(() => false, 300);
    expect((await outbox()).map((r: any) => r.id)).toEqual([s.id]);

    // Delivered: the same record (same id: the service de-duplicates), then the outbox is empty.
    h.setRecordAnswer(204);
    await h.load();
    await waitFor(() => h.records.length >= 3);
    expect(JSON.parse(h.records[2].body)).toEqual(JSON.parse(h.records[0].body));
    await waitFor(() => false, 300);
    expect(await outbox()).toEqual([]);

    // Nothing left: the next page sends nothing.
    await h.load();
    await waitFor(() => false, 300);
    expect(h.records).toHaveLength(3);
    await h.ctx.close();
  });

  it('a confirmed record leaves nothing behind; a 4xx refusal (other than 429) is dropped, not retried', async () => {
    const h = await harness(baseConfig());
    await h.load();
    await h.page.evaluate(() => (window as any).ComplyKit.init(JSON.parse(document.getElementById('complykit-config')!.textContent!)).acceptAll());
    await waitFor(() => h.records.length >= 1);
    await waitFor(() => false, 300);
    expect(await h.page.evaluate(() => localStorage.getItem('complykit_consent_outbox') ?? '[]')).toBe('[]');

    h.setRecordAnswer(400);
    await h.page.evaluate(() => (window as any).ComplyKit.init(JSON.parse(document.getElementById('complykit-config')!.textContent!)).rejectAll());
    await waitFor(() => h.records.length >= 2);
    await waitFor(() => false, 300);
    expect(await h.page.evaluate(() => localStorage.getItem('complykit_consent_outbox') ?? '[]')).toBe('[]');
    await h.load();
    await waitFor(() => false, 300);
    expect(h.records).toHaveLength(2);
    await h.ctx.close();
  });

  it('drops an undelivered record older than 30 days, and keeps at most 5', async () => {
    const h = await harness(baseConfig());
    await h.load();
    const body = (id: string, at: string) => ({ id, at, kind: 'choice', categories: { necessary: true, analytics: false, advertising: false }, configHash: baseConfig().hash, toolVersion: '0.0.0', regime: 'opt-in', gpc: false, gpcHonored: false });
    const stale = body('b'.repeat(32), new Date(Date.now() - 31 * 86_400_000).toISOString());
    const fresh = body('c'.repeat(32), new Date().toISOString());
    await h.page.evaluate((j) => localStorage.setItem('complykit_consent_outbox', j), JSON.stringify([stale, fresh]));
    await h.load();
    await waitFor(() => h.records.length >= 1);
    await waitFor(() => false, 300);
    expect(h.records.map((r) => JSON.parse(r.body).id)).toEqual([fresh.id]);

    h.setRecordAnswer('abort');
    for (let i = 0; i < 7; i++) {
      await h.page.evaluate(() => (window as any).ComplyKit.init(JSON.parse(document.getElementById('complykit-config')!.textContent!)).rejectAll());
    }
    await waitFor(() => false, 500);
    const ob = JSON.parse((await h.page.evaluate(() => localStorage.getItem('complykit_consent_outbox')))!);
    expect(ob).toHaveLength(5);
    await h.ctx.close();
  });

  it('add-on (companion) mode keeps no outbox', async () => {
    const cfg = baseConfig();
    cfg.mode = 'companion';
    cfg.companion = { cmp: 'onetrust' };
    const h = await harness(cfg);
    await h.load();
    await h.page.evaluate(() => (window as any).ComplyKit.init(JSON.parse(document.getElementById('complykit-config')!.textContent!)).acceptAll());
    await waitFor(() => false, 300);
    expect(h.records).toHaveLength(0);
    expect(await h.page.evaluate(() => localStorage.getItem('complykit_consent_outbox'))).toBeNull();
    await h.ctx.close();
  });
});
