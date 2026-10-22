import fs from 'node:fs';
import path from 'node:path';
import { type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_MAPS } from '../src/companion/maps';
import { DIST, launchBrowser, startFixtureServer, type FixtureServer } from './harness';

// T6 add-on mode, the sources companion.test.ts does not cover: usercentrics, didomi, trustarc, wordpress,
// plus the banner-never-appears give-up. Same shape as companion.test.ts; the fake banners mimic the
// documented surface cited in each source's header (client/src/companion/sources/).

const EXAMPLE = path.join(__dirname, '..', '..', 'test', 'fixtures', 'consent-config', 'example.json');
const companionConfig = (cmp: string, over: Record<string, unknown> = {}): any => {
  const c = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
  c.generatedFrom.site ??= 'example-shop.test';
  c.consent = { lifetimeDays: 365 };
  c.regimeSource = { kind: 'fixed', regime: 'opt-in' };
  for (const cat of c.categories) {
    cat.defaultByRegime['opt-out-signal'] ??= cat.id === 'necessary';
    delete cat.defaultByRegime.notice;
  }
  delete c.gtm;
  return { ...c, record: { endpoint: '/consent-record' }, mode: 'companion', companion: { cmp }, ...over };
};

let browser: Browser;
let server: FixtureServer;

beforeAll(async () => {
  if (!fs.existsSync(path.join(DIST, 'complykit-consent-companion.js'))) throw new Error('dist/complykit-consent-companion.js missing: run `npm run build` first');
  server = await startFixtureServer();
  browser = await launchBrowser();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const SEED_COOKIES = `<script>document.cookie='_ga=GA1.1.1;path=/';document.cookie='_fbp=fb.1.1;path=/';document.cookie='site_pref=1;path=/';window.__marker=1;</script>`;

interface Opened {
  page: Page;
  ctx: BrowserContext;
  posts: string[];
}

async function open(config: unknown, banner: { before?: string; after?: string } = {}): Promise<Opened> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const posts: string[] = [];
  await page.route('**/more-page', (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Companion</title>
${SEED_COOKIES}
${banner.before ?? ''}
<script>window.ComplyKitConfig=${JSON.stringify(config)};</script>
<script src="/complykit-consent.js" data-complykit-reload="none"></script>
${banner.after ?? ''}
</head><body><h1>Shop</h1></body></html>`,
    }),
  );
  await page.route('**/consent-record', (route) => {
    posts.push(route.request().postData() ?? '');
    return route.fulfill({ status: 204 });
  });
  await page.goto(`${server.origin}/more-page`);
  return { page, ctx, posts };
}

const cookies = (p: Page) => p.evaluate(() => document.cookie.split(/;\s*/).map((c) => c.split('=')[0]).filter(Boolean).sort());
const state = (p: Page) => p.evaluate(() => (window as any).ComplyKit.get()?.categories as Record<string, boolean> | undefined);
const settle = (p: Page, ms = 300) => p.waitForTimeout(ms);

async function expectFollowsAndCleans(o: Opened, revoke: string): Promise<void> {
  await settle(o.page);
  expect(await state(o.page)).toMatchObject({ analytics: true, advertising: true });
  expect(await cookies(o.page)).toEqual(['_fbp', '_ga', 'site_pref']);
  await o.page.evaluate(revoke);
  await settle(o.page);
  expect(await state(o.page)).toMatchObject({ analytics: false, advertising: true });
  expect(await cookies(o.page)).toEqual(['_fbp', 'site_pref']);
  expect(await o.page.evaluate(() => (window as any).__marker)).toBe(1);
  expect(await o.page.$('#complykit-ui')).toBeNull();
  expect(server.requests).not.toContain('/complykit-consent-ui.js');
  expect(o.posts).toEqual([]);
}

// Usercentrics CMP v2: UC_UI.getServicesBaseInfo() with consent.status per service and a categorySlug;
// UC_UI_CMP_EVENT on a choice. The built-in map ties analytics to marketing (fail closed) as well as to a
// statistics slug, so the independent revoke below uses a site map; the default map has its own test.
const UC_SERVICES = (stats: boolean) =>
  `[{id:'a',categorySlug:'essential',consent:{status:true}},{id:'b',categorySlug:'statistics',consent:{status:${stats}}},{id:'c',categorySlug:'statistics',consent:{status:${stats}}},{id:'d',categorySlug:'marketing',consent:{status:true}}]`;
const USERCENTRICS = `<script>window.__ucServices=${UC_SERVICES(true)};window.UC_UI={isInitialized:function(){return true},getServicesBaseInfo:function(){return window.__ucServices}};</script>`;
const USERCENTRICS_REVOKE = `window.__ucServices[1].consent.status=false;window.__ucServices[2].consent.status=false;window.dispatchEvent(new CustomEvent('UC_UI_CMP_EVENT',{detail:{type:'SAVE'}}));`;

// Didomi: Didomi.getCurrentUserStatus().purposes[id].enabled; didomiEventListeners 'consent.changed'.
const DIDOMI = `<script>window.__dd={cookies:{enabled:true},measure_content_performance:{enabled:true},select_personalized_ads:{enabled:true}};window.didomiEventListeners=window.didomiEventListeners||[];window.Didomi={getCurrentUserStatus:function(){return{purposes:window.__dd}}};</script>`;
const DIDOMI_REVOKE = `window.__dd.measure_content_performance.enabled=false;window.didomiEventListeners.forEach(function(l){l.event==='consent.changed'&&l.listener({action:'click'})});`;

// TrustArc: truste.cma.callApi('getConsentDecision', domain) -> highest level (1 required, 2 functional, 3 advertising);
// the banner posts a message carrying "PrivacyManagerAPI" when the choice changes.
const TRUSTARC = `<script>window.__lvl=3;window.truste={cma:{callApi:function(a){return a==='getConsentDecision'?window.__lvl:undefined}}};</script>`;
const TRUSTARC_REVOKE = `window.__lvl=2;window.postMessage(JSON.stringify({PrivacyManagerAPI:{action:'getConsentDecision',timestamp:1,self:location.host}}),'*');`;

// WordPress Consent API: wp_has_consent(category); document event wp_listen_for_consent_change.
const WORDPRESS = `<script>window.__wp={statistics:true,marketing:true,preferences:true,functional:true};window.wp_has_consent=function(c){return !!window.__wp[c]};</script>`;
const WORDPRESS_REVOKE = `window.__wp.statistics=false;var d=[];d.statistics='deny';document.dispatchEvent(new CustomEvent('wp_listen_for_consent_change',{detail:d}));`;

describe('add-on mode: the remaining sources', () => {
  const cases: Array<[string, string, string]> = [
    ['usercentrics', USERCENTRICS, USERCENTRICS_REVOKE],
    ['didomi', DIDOMI, DIDOMI_REVOKE],
    ['wordpress', WORDPRESS, WORDPRESS_REVOKE],
  ];
  for (const [cmp, fake, revoke] of cases) {
    it(`${cmp}: banner loaded first`, async () => {
      const over = cmp === 'usercentrics' ? { companion: { cmp, map: { statistics: ['analytics'], marketing: ['advertising'] } } } : {};
      const o = await open(companionConfig(cmp, over), { before: fake });
      await expectFollowsAndCleans(o, revoke);
      await o.ctx.close();
    });
  }

  it('wordpress: the banner loads after complykit: it waits, then follows', async () => {
    const o = await open(companionConfig('wordpress'), { after: `<script>setTimeout(function(){${WORDPRESS.replace(/<\/?script>/g, '')}document.dispatchEvent(new Event('wp_consent_type_defined'));},600)</script>` });
    expect(await o.page.evaluate(() => (window as any).ComplyKit.diagnostics.companion)).toMatchObject({ cmp: 'wordpress', state: 'waiting' });
    await settle(o.page, 1200);
    expect(await o.page.evaluate(() => (window as any).ComplyKit.diagnostics.companion)).toMatchObject({ state: 'ready' });
    await expectFollowsAndCleans(o, WORDPRESS_REVOKE);
    await o.ctx.close();
  });

  it('usercentrics: the built-in map ties analytics and advertising to marketing', async () => {
    const o = await open(companionConfig('usercentrics'), { before: USERCENTRICS });
    await settle(o.page);
    expect(await state(o.page)).toMatchObject({ analytics: true, advertising: true });
    await o.page.evaluate(`window.__ucServices[3].consent.status=false;window.dispatchEvent(new CustomEvent('UC_UI_CMP_EVENT',{detail:{type:'SAVE'}}))`);
    await settle(o.page);
    // statistics is still granted, so analytics stays; advertising only came from marketing.
    expect(await state(o.page)).toMatchObject({ analytics: true, advertising: false });
    expect(await cookies(o.page)).toEqual(['_ga', 'site_pref']);
    await o.ctx.close();
  });

  it('trustarc: levels are cumulative: dropping from 3 to 2 revokes advertising and analytics together', async () => {
    const o = await open(companionConfig('trustarc'), { before: TRUSTARC });
    await settle(o.page);
    expect(await state(o.page)).toMatchObject({ analytics: true, advertising: true });
    expect(await cookies(o.page)).toEqual(['_fbp', '_ga', 'site_pref']);
    await o.page.evaluate(TRUSTARC_REVOKE);
    await settle(o.page);
    expect(await state(o.page)).toMatchObject({ analytics: false, advertising: false });
    expect(await cookies(o.page)).toEqual(['site_pref']);
    expect(o.posts).toEqual([]);
    expect(await o.page.$('#complykit-ui')).toBeNull();
    await o.ctx.close();
  });

  it('trustarc: a level of 0 (no preference) denies everything and sweeps', async () => {
    const o = await open(companionConfig('trustarc'), { before: `<script>window.truste={cma:{callApi:function(){return 0}}};</script>` });
    await settle(o.page);
    expect(await state(o.page)).toMatchObject({ analytics: false, advertising: false });
    expect(await cookies(o.page)).toEqual(['site_pref']);
    await o.ctx.close();
  });

  it('no banner ever appears: gives up after about 10 s, cleans nothing, shows nothing', async () => {
    const o = await open(companionConfig('didomi'));
    expect(await o.page.evaluate(() => (window as any).ComplyKit.diagnostics.companion)).toMatchObject({ cmp: 'didomi', state: 'waiting' });
    await settle(o.page, 10_800);
    expect(await o.page.evaluate(() => (window as any).ComplyKit.diagnostics.companion)).toMatchObject({ cmp: 'didomi', state: 'not-found' });
    expect(await cookies(o.page)).toEqual(['_fbp', '_ga', 'site_pref']);
    expect(await o.page.$('#complykit-ui')).toBeNull();
    await o.ctx.close();
  }, 20_000);

  it('ComplyKit.sync does nothing outside add-on mode', async () => {
    const o = await open({ ...companionConfig('onetrust'), mode: undefined, companion: undefined });
    expect(await o.page.evaluate(() => (window as any).ComplyKit.sync({ analytics: true }))).toBeNull();
    await o.ctx.close();
  });
});

// The generated configs have `performance` (and `functional`) categories; follow-mode must neither revoke nor
// sweep one the map cannot reach, and the default maps must carry performance with analytics.
const withPerf = (config: any, on = true): any => {
  config.categories.push({ id: 'performance', label: 'Performance', description: 'Speed and errors.', defaultByRegime: { 'opt-in': false, 'opt-out-signal': on, 'opt-out': on } });
  config.vendors.push({ id: 'perf.tool', label: 'Perf tool', category: 'performance', control: 'none', stores: [{ name: '^_perf$', kind: 'cookie' }] });
  return config;
};

describe('add-on mode: categories the map does not cover', () => {
  it('a config category absent from the map is never revoked or swept', async () => {
    const cfg = withPerf(companionConfig('onetrust', { regimeSource: { kind: 'fixed', regime: 'opt-out' }, companion: { cmp: 'onetrust', map: { C0002: ['analytics'], C0004: ['advertising'] } } })); // opt-out: performance starts granted and no map entry can reach it
    const o = await open(cfg, { before: `<script>document.cookie='_perf=1;path=/';</script><script>window.OnetrustActiveGroups=',C0001,C0002,C0004,';window.OneTrust={};</script>` });
    await settle(o.page);
    expect(await state(o.page)).toMatchObject({ analytics: true, advertising: true, performance: true });
    await o.page.evaluate(`window.OnetrustActiveGroups=',C0001,C0004,';window.dispatchEvent(new CustomEvent('OneTrustGroupsUpdated',{detail:['C0001','C0004']}));`);
    await settle(o.page);
    expect(await state(o.page)).toMatchObject({ analytics: false, advertising: true, performance: true });
    expect(await cookies(o.page)).toEqual(['_fbp', '_perf', 'site_pref']);
    await o.ctx.close();
  });

  for (const [cmp, fake, revoke] of [
    ['didomi', DIDOMI, DIDOMI_REVOKE],
    ['wordpress', WORDPRESS, WORDPRESS_REVOKE],
  ] as const) {
    it(`${cmp}: the default map carries performance with analytics`, async () => {
      const o = await open(withPerf(companionConfig(cmp)), { before: `<script>document.cookie='_perf=1;path=/';</script>${fake}` });
      await settle(o.page);
      expect(await state(o.page)).toMatchObject({ analytics: true, performance: true });
      await o.page.evaluate(revoke);
      await settle(o.page);
      expect(await state(o.page)).toMatchObject({ analytics: false, performance: false, advertising: true });
      expect(await cookies(o.page)).toEqual(['_fbp', 'site_pref']);
      await o.ctx.close();
    });
  }

  it('every default map that reaches analytics reaches performance by the same banner ids', () => {
    for (const [cmp, map] of Object.entries(DEFAULT_MAPS)) {
      for (const [id, cats] of Object.entries(map)) {
        if (!cats.includes('analytics')) continue;
        // usercentrics/trustarc: analytics also hangs on marketing / level 3 (fail closed); performance follows too.
        expect(cats, `${cmp} ${id}`).toContain('performance');
      }
    }
    expect(DEFAULT_MAPS['consent-mode'].functionality_storage).toEqual(['functional']);
    expect(DEFAULT_MAPS['consent-mode'].personalization_storage).toEqual(['functional']);
  });
});
