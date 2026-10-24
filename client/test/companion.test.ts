import fs from 'node:fs';
import path from 'node:path';
import { type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DIST, launchBrowser, startFixtureServer, type FixtureServer } from './harness';

// T6 contract (plans/hosted-script.md "Add-on mode"): the site keeps its own
// banner; complykit follows that banner's choice and deletes the cookies of
// what the visitor revokes. No UI, no records. It reloads only when the banner takes a grant back after the
// page's first answer (a running script cannot be unloaded); the follow-and-clean tests pin
// data-complykit-reload="none" to look at the page before that reload. Fake banners below
// mimic each vendor's documented surface; the implementer checks those surfaces
// against the vendors' current docs (and may extend these fakes, never weaken
// the assertions).

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
  if (!fs.existsSync(path.join(DIST, 'complykit-consent.js'))) throw new Error('dist/complykit-consent.js missing: run `npm run build` first');
  server = await startFixtureServer();
  browser = await launchBrowser();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

// Vendor cookies from the example config: _ga (analytics), _fbp (advertising).
const SEED_COOKIES = `<script>document.cookie='_ga=GA1.1.1;path=/';document.cookie='_fbp=fb.1.1;path=/';document.cookie='site_pref=1;path=/';window.__marker=1;</script>`;

interface Opened {
  page: Page;
  ctx: BrowserContext;
  posts: string[];
  beacons: any[];
}

/** `before` runs before complykit (the banner already there); `after` after it (the banner loads late). */
async function open(config: unknown, banner: { before?: string; after?: string; reload?: string } = {}): Promise<Opened> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const posts: string[] = [];
  const beacons: any[] = [];
  await page.route('**/companion-page', (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Companion</title>
${SEED_COOKIES}
${banner.before ?? ''}
<script>window.ComplyKitConfig=${JSON.stringify(config)};</script>
<script src="/complykit-consent.js"${banner.reload === 'default' ? '' : ` data-complykit-reload="${banner.reload ?? 'none'}"`}></script>
${banner.after ?? ''}
</head><body><h1>Shop</h1></body></html>`,
    }),
  );
  await page.route('**/consent-record', (route) => {
    posts.push(route.request().postData() ?? '');
    return route.fulfill({ status: 204 });
  });
  await page.route('**/e', (route) => {
    beacons.push(JSON.parse(route.request().postData() ?? '{}'));
    return route.fulfill({ status: 204 });
  });
  await page.goto(`${server.origin}/companion-page`);
  return { page, ctx, posts, beacons };
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
  // The analytics cookie is gone; the still-granted advertising cookie and the site's own cookie stay.
  expect(await cookies(o.page)).toEqual(['_fbp', 'site_pref']);
  // No reload (pinned off here), no UI, no consent record.
  expect(await o.page.evaluate(() => (window as any).__marker)).toBe(1);
  expect(await o.page.$('#complykit-ui')).toBeNull();
  expect(server.requests).not.toContain('/complykit-consent-ui.js');
  expect(o.posts).toEqual([]);
}

const ONETRUST = `<script>window.OnetrustActiveGroups=',C0001,C0002,C0004,';window.OneTrust={GetDomainData:function(){return{}}};</script>`;
const ONETRUST_REVOKE = `window.OnetrustActiveGroups=',C0001,C0004,';window.dispatchEvent(new CustomEvent('OneTrustGroupsUpdated',{detail:['C0001','C0004']}));`;

const COOKIEBOT = `<script>window.Cookiebot={consented:true,declined:false,hasResponse:true,consent:{necessary:true,preferences:true,statistics:true,marketing:true}};</script>`;
const COOKIEBOT_REVOKE = `Object.assign(window.Cookiebot.consent,{statistics:false});window.dispatchEvent(new Event('CookiebotOnConsentReady'));window.dispatchEvent(new Event('CookiebotOnAccept'));`;

const CONSENT_MODE = `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('consent','default',{analytics_storage:'denied',ad_storage:'denied'});gtag('consent','update',{analytics_storage:'granted',ad_storage:'granted'});</script>`;
const CONSENT_MODE_REVOKE = `gtag('consent','update',{analytics_storage:'denied'});`;

const TCF = `<script>(function(){var ls=[];var all={1:true,2:true,3:true,4:true,7:true,8:true,9:true};window.__tcfState={eventStatus:'tcloaded',gdprApplies:true,listenerId:1,purpose:{consents:all}};window.__tcfapi=function(cmd,v,cb){if(cmd==='addEventListener'){ls.push(cb);cb(window.__tcfState,true);}else if(cmd==='removeEventListener'){cb(true);}};window.__tcfFire=function(){ls.forEach(function(f){f(window.__tcfState,true)})};})();</script>`;
const TCF_REVOKE = `window.__tcfState={eventStatus:'useractioncomplete',gdprApplies:true,listenerId:1,purpose:{consents:{1:true,2:true,3:true,4:true,7:false,8:false,9:false}}};window.__tcfFire();`;

const SHOPIFY = `<script>window.__shop={analytics:'yes',marketing:'yes',preferences:'yes',sale_of_data:'yes'};window.Shopify={customerPrivacy:{currentVisitorConsent:function(){return window.__shop}}};</script>`;
const SHOPIFY_REVOKE = `window.__shop=Object.assign({},window.__shop,{analytics:'no'});document.dispatchEvent(new CustomEvent('visitorConsentCollected',{detail:{analyticsAllowed:false,marketingAllowed:true,preferencesAllowed:true,saleOfDataAllowed:true}}));`;

// Shopify's sale-of-data opt-out (US opt-out page / GPC) leaves marketing allowed but stops the
// store's SALE_OF_DATA pixels: for the add-on it is an advertising refusal. Effective functions, then the fallback.
const SHOPIFY_FN = `<script>window.__shop={analytics:'yes',marketing:'yes',preferences:'yes',sale_of_data:'yes'};window.Shopify={customerPrivacy:{currentVisitorConsent:function(){return window.__shop},analyticsProcessingAllowed:function(){return window.__shop.analytics==='yes'},marketingAllowed:function(){return window.__shop.marketing==='yes'},preferencesProcessingAllowed:function(){return window.__shop.preferences==='yes'},saleOfDataAllowed:function(){return window.__shop.sale_of_data!=='no'}}};</script>`;
const SHOPIFY_SALE_OPT_OUT = `window.__shop=Object.assign({},window.__shop,{sale_of_data:'no'});document.dispatchEvent(new CustomEvent('visitorConsentCollected',{detail:{analyticsAllowed:true,marketingAllowed:true,preferencesAllowed:true,saleOfDataAllowed:false}}));`;

// Shopify's banner on its own: customerPrivacy exists only after Shopify.loadFeatures (async), never on the page before.
const SHOPIFY_LAZY = `<script>window.__loads=0;window.__shop={analytics:'yes',marketing:'yes',preferences:'yes',sale_of_data:'yes'};window.Shopify={loadFeatures:function(f,cb){window.__loads++;setTimeout(function(){window.Shopify.customerPrivacy={currentVisitorConsent:function(){return window.__shop}};cb();},50);}};</script>`;

describe('add-on mode: reload when the banner takes a grant back', () => {
  const countLoads = (p: Page) => {
    const n = { loads: 0 };
    p.on('load', () => void n.loads++);
    return n;
  };
  it('cleans up, then reloads once; the reloaded page (the banner answering again) does not reload again', async () => {
    const o = await open(companionConfig('shopify'), { before: SHOPIFY, reload: 'default' });
    await settle(o.page);
    expect(await state(o.page)).toMatchObject({ analytics: true, advertising: true });
    const n = countLoads(o.page);
    const loaded = o.page.waitForEvent('load');
    await o.page.evaluate(SHOPIFY_REVOKE);
    await loaded;
    await settle(o.page, 800);
    expect(n.loads).toBe(1);
    await o.ctx.close();
  });
  it('a page whose banner already denies (a stored refusal) does not reload', async () => {
    const DENIED = `<script>window.__shop={analytics:'no',marketing:'no',preferences:'no',sale_of_data:'no'};window.Shopify={customerPrivacy:{currentVisitorConsent:function(){return window.__shop}}};</script>`;
    const o = await open(companionConfig('shopify'), { before: DENIED, reload: 'default' });
    const n = countLoads(o.page);
    await settle(o.page, 800);
    expect(await state(o.page)).toMatchObject({ analytics: false, advertising: false });
    expect(n.loads).toBe(0);
    expect(await cookies(o.page)).toEqual(['site_pref']);
    await o.ctx.close();
  });
});

describe('add-on mode: Shopify API loaded on demand', () => {
  it('asks Shopify.loadFeatures for the consent API once and follows it', async () => {
    const o = await open(companionConfig('shopify'), { before: SHOPIFY_LAZY });
    await settle(o.page);
    expect(await state(o.page)).toMatchObject({ analytics: true, advertising: true });
    expect(await o.page.evaluate(() => (window as any).__loads)).toBe(1);
    expect(await o.page.evaluate(() => (window as any).ComplyKit.diagnostics.companion.state)).toBe('ready');
    await o.page.evaluate(SHOPIFY_REVOKE);
    await settle(o.page);
    expect(await state(o.page)).toMatchObject({ analytics: false, advertising: true });
    await o.ctx.close();
  });
});

describe('add-on mode: Shopify sale-of-data opt-out is an advertising refusal', () => {
  for (const [name, fake] of [['effective functions', SHOPIFY_FN], ['currentVisitorConsent fallback', SHOPIFY]] as const) {
    it(`${name}: marketing allowed + sale opted out denies advertising and cleans its cookies`, async () => {
      const o = await open(companionConfig('shopify'), { before: fake });
      await settle(o.page);
      expect(await state(o.page)).toMatchObject({ analytics: true, advertising: true });
      await o.page.evaluate(SHOPIFY_SALE_OPT_OUT);
      await settle(o.page);
      expect(await state(o.page)).toMatchObject({ analytics: true, advertising: false });
      // The advertising cookie goes; analytics and the site's own cookie stay.
      expect(await cookies(o.page)).toEqual(['_ga', 'site_pref']);
      await o.ctx.close();
    });
  }
});

describe('add-on mode: follow the banner, clean up what it revokes', () => {
  const cases: Array<[string, string, string]> = [
    ['onetrust', ONETRUST, ONETRUST_REVOKE],
    ['cookiebot', COOKIEBOT, COOKIEBOT_REVOKE],
    ['consent-mode', CONSENT_MODE, CONSENT_MODE_REVOKE],
    ['tcf', TCF, TCF_REVOKE],
    ['shopify', SHOPIFY, SHOPIFY_REVOKE],
  ];
  for (const [cmp, fake, revoke] of cases) {
    it(`${cmp}: banner loaded first`, async () => {
      const o = await open(companionConfig(cmp), { before: fake });
      await expectFollowsAndCleans(o, revoke);
      await o.ctx.close();
    });
  }

  it('the banner loads after complykit: it waits for it, then follows', async () => {
    const o = await open(companionConfig('onetrust'), { after: `<script>setTimeout(function(){document.head.insertAdjacentHTML('beforeend','');window.OnetrustActiveGroups=',C0001,C0002,C0004,';window.OneTrust={};window.dispatchEvent(new CustomEvent('OneTrustGroupsUpdated',{detail:['C0001','C0002','C0004']}));},600)</script>` });
    expect(await o.page.evaluate(() => (window as any).ComplyKit.diagnostics.companion)).toMatchObject({ cmp: 'onetrust', state: 'waiting' });
    await settle(o.page, 1200);
    expect(await o.page.evaluate(() => (window as any).ComplyKit.diagnostics.companion)).toMatchObject({ cmp: 'onetrust', state: 'ready' });
    await expectFollowsAndCleans(o, ONETRUST_REVOKE);
    await o.ctx.close();
  });

  it('sweep on load: what the banner already denies is cleaned at start', async () => {
    const o = await open(companionConfig('onetrust'), { before: `<script>window.OnetrustActiveGroups=',C0001,C0004,';window.OneTrust={};</script>` });
    await settle(o.page);
    expect(await state(o.page)).toMatchObject({ analytics: false, advertising: true });
    expect(await cookies(o.page)).toEqual(['_fbp', 'site_pref']);
    await o.ctx.close();
  });

  it('manual: ComplyKit.sync drives it', async () => {
    const o = await open(companionConfig('manual'));
    await o.page.evaluate(() => (window as any).ComplyKit.sync({ analytics: true, advertising: true }));
    await expectFollowsAndCleans(o, `ComplyKit.sync({analytics:false,advertising:true})`);
    await o.ctx.close();
  });

  it('a site map overrides the built-in one', async () => {
    const o = await open(companionConfig('onetrust', { companion: { cmp: 'onetrust', map: { C0009: ['analytics'], C0004: ['advertising'] } } }), { before: `<script>window.OnetrustActiveGroups=',C0001,C0009,C0004,';window.OneTrust={};</script>` });
    await expectFollowsAndCleans(o, `window.OnetrustActiveGroups=',C0001,C0004,';window.dispatchEvent(new CustomEvent('OneTrustGroupsUpdated',{detail:['C0001','C0004']}));`);
    await o.ctx.close();
  });

  it('analytics: load and decide via cmp, no shown, no ms', async () => {
    const o = await open(companionConfig('onetrust', { analytics: { endpoint: `${server.origin}/e` } }), { before: ONETRUST });
    await settle(o.page);
    await o.page.evaluate(ONETRUST_REVOKE);
    await settle(o.page);
    await o.page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await settle(o.page);
    const ev = o.beacons.flatMap((b) => b.ev);
    expect(ev.find((e: any) => e.t === 'load')).toBeDefined();
    expect(ev.find((e: any) => e.t === 'shown')).toBeUndefined();
    expect(ev).toContainEqual({ t: 'decide', a: 'custom', via: 'cmp', cats: { analytics: false, advertising: true } });
    await o.ctx.close();
  });

  it('analytics: the first state learned on a page is not a decision; only a later change is, once', async () => {
    const o = await open(companionConfig('onetrust', { analytics: { endpoint: `${server.origin}/e` } }), { before: ONETRUST });
    await settle(o.page);
    await o.page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await settle(o.page);
    const first = o.beacons.flatMap((b) => b.ev);
    expect(first.find((e: any) => e.t === 'load')).toBeDefined();
    expect(first.find((e: any) => e.t === 'decide')).toBeUndefined();
    await o.page.evaluate(ONETRUST_REVOKE);
    await settle(o.page);
    await o.page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await settle(o.page);
    expect(o.beacons.flatMap((b) => b.ev).filter((e: any) => e.t === 'decide')).toHaveLength(1);
    await o.ctx.close();
  });

  it('full mode is untouched: the banner shows', async () => {
    const o = await open({ ...companionConfig('onetrust'), mode: undefined, companion: undefined });
    await o.page.waitForSelector('#complykit-ui .ck-banner', { state: 'visible' });
    await o.ctx.close();
  });
});

describe('add-on mode: Shopify decline guard', () => {
  it('a click on the banner refusal removes the custom-pixel frames and revokes Meta before any bubble listener sees it', async () => {
    const o = await open(companionConfig('shopify'), { before: SHOPIFY });
    await settle(o.page);
    await o.page.evaluate(() => {
      const w = window as any;
      w.__fbq = [];
      w.fbq = (...a: unknown[]) => w.__fbq.push(a.join(':'));
      // Meta's automatic events listen in the bubble phase: record what Meta had been told when it saw the click.
      document.addEventListener('click', () => w.__fbq.push('meta-saw-click'));
      for (const id of ['web-pixel-sandbox-CUSTOM-1-LAX-x', 'web-pixel-sandbox-CUSTOM-2-LAX-x']) {
        const f = document.createElement('iframe');
        f.id = id;
        f.setAttribute('sandbox', 'allow-scripts');
        document.body.appendChild(f);
      }
      const other = document.createElement('iframe');
      other.id = 'video';
      document.body.appendChild(other);
      const b = document.createElement('button');
      b.id = 'shopify-pc__prefs__header-decline';
      b.innerHTML = '<span>Decline all</span>';
      document.body.appendChild(b);
    });
    await o.page.click('#shopify-pc__prefs__header-decline span');
    expect(await o.page.evaluate(() => [...document.querySelectorAll('iframe')].map((f) => f.id))).toEqual(['video']);
    expect(await o.page.evaluate(() => (window as any).__fbq)).toEqual(['consent:revoke', 'meta-saw-click']);
    expect(await o.page.evaluate(() => (window as any).__complykitDeclineGuard)).toEqual({ fired: 1, framesRemoved: 2 });
    // Any other click leaves the frames alone.
    await o.page.evaluate(() => document.body.appendChild(Object.assign(document.createElement('iframe'), { id: 'web-pixel-sandbox-CUSTOM-3-LAX-x' })));
    await o.page.click('body');
    expect(await o.page.evaluate(() => document.querySelectorAll('iframe').length)).toBe(2);
    await o.ctx.close();
  });
});
