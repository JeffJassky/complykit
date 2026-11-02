import fs from 'node:fs';
import path from 'node:path';
import { type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeRecord } from '../../service/src/server/consent-records';
import { DIST, launchBrowser, startFixtureServer, type FixtureServer } from './harness';

// Contract: proof of the visitor's choice in add-on (companion) mode, the same proof full mode keeps.
//
// The site's banner still decides; complykit's copy is proof only and is never read back as the answer.
//   - Before the banner reports an answer: the store follows the banner's effective grants (region defaults
//     included), status stays 'unset', and nothing is written: no `complykit_consent` cookie, no mirror, no
//     outbox, no POST.
//   - When the banner reports an answer: the same snapshot full mode writes (cookie + localStorage mirror,
//     v:1, id, at, configHash, regime, gpc, categories, kind, supersedes, gpcHonored, region) plus
//     `source` = config.companion.cmp; status 'chosen'; the record is queued to config.record.endpoint.
//   - Later pages: the banner's answer is compared with the stored snapshot. Same grants => same id, no new
//     record (a changed config hash with the same category set does not count as a change). Different grants
//     => a new snapshot whose `supersedes` is the stored id, kind 'withdrawal' when a non-necessary grant was
//     taken back.
//   - The banner going back to "no answer" (its own storage cleared) after a snapshot exists: status 'unset',
//     the snapshot is cleared and its id waits under `complykit_consent_prev`, so the next answer, even one
//     with the same grants, is a new decision that supersedes it.
//   - "Answered" comes from the banner where its API says so (Shopify: any of currentVisitorConsent's fields
//     'yes'/'no'; OneTrust: OneTrust.IsAlertBoxClosed(), else the OptanonAlertBoxClosed cookie; Cookiebot:
//     Cookiebot.hasResponse). A source that cannot tell (consent-mode, tcf, usercentrics, didomi, trustarc,
//     wordpress, and manual ComplyKit.sync) counts as answered on a live change after the page's first state,
//     or on a first state when a snapshot is already stored; a page's first state with nothing stored is
//     followed but not recorded.
//     Consent Mode: a `default` command is never an answer; an `update` (live, or a CMP restoring its
//     stored answer) is. Shopify: a GPC visitor's automatic sale_of_data 'no' with the other fields
//     undeclared is not an answer. Cookiebot: consent.method 'implied' is not an answer.
//   - A page's first state from a source that cannot tell, when it differs from the stored snapshot, is
//     followed but not written (a CMP restoring its answer a moment later must not leave a
//     withdrawal + choice pair per page); a later live change on the page is a decision.
//   - The proof waits for the visitor's location: a decision learned while the header lookup is pending
//     is written once it settles, with the settled regime and region (the gate follows the banner at once).
//   - A config category the banner's map cannot reach is recorded as false (the banner never asked); the
//     live state keeps its default. Its default never makes two answers differ.
//   - Another tab writing a snapshot never resets this tab to defaults (its own banner stays the answer).
//   - Full mode records carry no `source`.

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

interface Opened {
  page: Page;
  ctx: BrowserContext;
  /** Parsed POST bodies sent to the record endpoint, in order. */
  posts: any[];
  /** Swap the config (or banner) the next load serves. */
  holder: { config: any; banner: string; reload: string };
  load(): Promise<void>;
}

/** One browser context (cookies and localStorage survive load()); `banner` runs before complykit. */
async function open(config: unknown, banner: string, reload = 'none', ctx?: BrowserContext): Promise<Opened> {
  ctx ??= await browser.newContext();
  const page = await ctx.newPage();
  const posts: any[] = [];
  const holder = { config, banner, reload };
  await page.route('**/proof-page', (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Proof</title>
${holder.banner}
<script>window.ComplyKitConfig=${JSON.stringify(holder.config)};</script>
<script src="/complykit-consent.js"${holder.reload === 'default' ? '' : ` data-complykit-reload="${holder.reload}"`}></script>
</head><body><h1>Shop</h1></body></html>`,
    }),
  );
  await page.route('**/consent-record', (route) => {
    posts.push(JSON.parse(route.request().postData() ?? '{}'));
    return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
  });
  const load = async () => {
    await page.goto(`${server.origin}/proof-page`);
    await settle(page);
  };
  await load();
  return { page, ctx, posts, holder, load };
}

const settle = (p: Page, ms = 400) => p.waitForTimeout(ms);
const get = (p: Page) => p.evaluate(() => (window as any).ComplyKit.get());
const ls = (p: Page, k: string) => p.evaluate((key) => localStorage.getItem(key), k);
const ckCookie = async (ctx: BrowserContext) => {
  const c = (await ctx.cookies()).find((x) => x.name === 'complykit_consent');
  return c ? JSON.parse(decodeURIComponent(c.value)) : undefined;
};
const mirror = async (p: Page) => {
  const m = await ls(p, 'complykit_consent');
  return m ? JSON.parse(m) : undefined;
};
const outbox = async (p: Page) => JSON.parse((await ls(p, 'complykit_consent_outbox')) ?? '[]');

async function expectNothingWritten(o: Opened): Promise<void> {
  expect(await ckCookie(o.ctx)).toBeUndefined();
  expect(await mirror(o.page)).toBeUndefined();
  expect(await outbox(o.page)).toEqual([]);
  expect(o.posts).toEqual([]);
}

/** The stored snapshot (cookie and mirror agree) and the store state name the same decision. */
async function snapshot(o: Opened): Promise<any> {
  const c = await ckCookie(o.ctx);
  expect(c).toBeDefined();
  expect(await mirror(o.page)).toEqual(c);
  const s = await get(o.page);
  expect(s).toMatchObject({ status: 'chosen', id: c.id, at: c.at });
  return c;
}

const validRecord = (body: any) => normalizeRecord(body, 'example-shop.test');

// --- fake banners: each keeps its answer in localStorage so a reload sees the same answer ---------------------

/** Shopify Customer Privacy API. `allowWhenUndeclared` = the region default ('' fields allowed, e.g. Virginia). */
const SHOPIFY = (init: Record<string, string>, allowWhenUndeclared = false) => `<script>(function(){
var k='__fakeShop',s=null;try{s=JSON.parse(localStorage.getItem(k)||'null')}catch(e){}
window.__shop=s||${JSON.stringify(init)};
window.__setShop=function(o){window.__shop=Object.assign({},window.__shop,o);localStorage.setItem(k,JSON.stringify(window.__shop));document.dispatchEvent(new CustomEvent('visitorConsentCollected',{detail:{}}))};
var eff=function(f){return function(){var v=window.__shop[f];return v==='yes'||(v===''&&${allowWhenUndeclared})}};
window.Shopify={customerPrivacy:{currentVisitorConsent:function(){return window.__shop},analyticsProcessingAllowed:eff('analytics'),marketingAllowed:eff('marketing'),preferencesProcessingAllowed:eff('preferences'),saleOfDataAllowed:function(){return window.__shop.sale_of_data!=='no'}}};
})();</script>`;
const UNDECLARED = { analytics: '', marketing: '', preferences: '', sale_of_data: '' };
const ALL_YES = { analytics: 'yes', marketing: 'yes', preferences: 'yes', sale_of_data: 'yes' };

/** OneTrust: groups + IsAlertBoxClosed (or only the OptanonAlertBoxClosed cookie when `fn` is false). */
const ONETRUST = (groups: string, closed: boolean, fn = true) => `<script>
window.OnetrustActiveGroups=${JSON.stringify(groups)};
${fn ? `window.OneTrust={IsAlertBoxClosed:function(){return ${closed}}};` : `window.OneTrust={};${closed ? "document.cookie='OptanonAlertBoxClosed='+new Date().toISOString()+';path=/';" : ''}`}
</script>`;

const COOKIEBOT = (hasResponse: boolean, stats: boolean) =>
  `<script>window.Cookiebot={hasResponse:${hasResponse},consented:${hasResponse},declined:false,consent:{necessary:true,preferences:${stats},statistics:${stats},marketing:${stats}}};</script>`;

/** Consent Mode: the default denies; the visitor's answer arrives as an update (kept in localStorage). */
const CONSENT_MODE = `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}
gtag('consent','default',{analytics_storage:'denied',ad_storage:'denied'});
(function(){var u=localStorage.getItem('__fakeCm');if(u)gtag('consent','update',JSON.parse(u));})();
window.__cm=function(u){localStorage.setItem('__fakeCm',JSON.stringify(u));gtag('consent','update',u)};</script>`;

describe('add-on proof: Shopify', () => {
  it('before the banner is answered (region default allows): follows the grants, status unset, writes nothing', async () => {
    const o = await open(companionConfig('shopify'), SHOPIFY(UNDECLARED, true));
    expect(await get(o.page)).toMatchObject({ status: 'unset', categories: { analytics: true, advertising: true } });
    await expectNothingWritten(o);
    await o.ctx.close();
  });

  it('before the banner is answered (consent region): status unset, everything held, writes nothing', async () => {
    const o = await open(companionConfig('shopify'), SHOPIFY(UNDECLARED));
    expect(await get(o.page)).toMatchObject({ status: 'unset', categories: { analytics: false, advertising: false } });
    await expectNothingWritten(o);
    await o.ctx.close();
  });

  it('an answer on the page: the full snapshot with source, one valid record, confirmed outbox', async () => {
    const o = await open(companionConfig('shopify'), SHOPIFY(UNDECLARED));
    await o.page.evaluate(() => (window as any).__setShop({ analytics: 'yes', marketing: 'yes', preferences: 'yes', sale_of_data: 'yes' }));
    await settle(o.page);
    const c = await snapshot(o);
    expect(c).toMatchObject({ v: 1, kind: 'choice', source: 'shopify', regime: 'opt-in', gpc: false, gpcHonored: false, categories: { necessary: true, analytics: true, advertising: true } });
    expect(c.supersedes).toBeUndefined();
    expect(typeof c.configHash).toBe('string');
    expect(o.posts).toHaveLength(1);
    expect(o.posts[0]).toMatchObject({ id: c.id, at: c.at, kind: 'choice', source: 'shopify', categories: c.categories });
    expect(validRecord(o.posts[0])).toMatchObject({ source: 'shopify' });
    expect(await outbox(o.page)).toEqual([]);
    await o.ctx.close();
  });

  it('an answer already given before this page (nothing stored yet): recorded once on load', async () => {
    const o = await open(companionConfig('shopify'), SHOPIFY(ALL_YES));
    const c = await snapshot(o);
    expect(c).toMatchObject({ kind: 'choice', source: 'shopify', categories: { analytics: true, advertising: true } });
    expect(o.posts.map((p) => p.id)).toEqual([c.id]);
    await o.ctx.close();
  });

  it('the same answer on later pages keeps the id: no new decision, no new record', async () => {
    const o = await open(companionConfig('shopify'), SHOPIFY(ALL_YES));
    const first = await snapshot(o);
    await o.load();
    await o.load();
    const again = await snapshot(o);
    expect(again).toEqual(first);
    expect(o.posts).toHaveLength(1);
    await o.ctx.close();
  });

  it('a config re-render (new hash, same categories) is not a new decision', async () => {
    const cfg = companionConfig('shopify');
    const o = await open(cfg, SHOPIFY(ALL_YES));
    const first = await snapshot(o);
    o.holder.config = { ...cfg, hash: 'f'.repeat(64) };
    await o.load();
    expect((await snapshot(o)).id).toBe(first.id);
    expect(o.posts).toHaveLength(1);
    await o.ctx.close();
  });

  it('a revoke is a withdrawal that supersedes the grant; a later grant is a choice that supersedes the withdrawal', async () => {
    const o = await open(companionConfig('shopify'), SHOPIFY(ALL_YES));
    const grant = await snapshot(o);
    await o.page.evaluate(() => (window as any).__setShop({ analytics: 'no' }));
    await settle(o.page);
    const wd = await snapshot(o);
    expect(wd).toMatchObject({ kind: 'withdrawal', supersedes: grant.id, source: 'shopify', categories: { analytics: false, advertising: true } });
    expect(wd.id).not.toBe(grant.id);
    await o.load();
    expect((await snapshot(o)).id).toBe(wd.id);
    await o.page.evaluate(() => (window as any).__setShop({ analytics: 'yes' }));
    await settle(o.page);
    const back = await snapshot(o);
    expect(back).toMatchObject({ kind: 'choice', supersedes: wd.id, categories: { analytics: true } });
    expect(o.posts.map((p) => [p.kind, p.supersedes])).toEqual([
      ['choice', undefined],
      ['withdrawal', grant.id],
      ['choice', wd.id],
    ]);
    for (const p of o.posts) validRecord(p);
    await o.ctx.close();
  });

  it('the banner forgets its answer: status unset, snapshot cleared and its id kept; the next answer supersedes it even with the same grants', async () => {
    const o = await open(companionConfig('shopify'), SHOPIFY(ALL_YES));
    const old = await snapshot(o);
    await o.page.evaluate(() => localStorage.setItem('__fakeShop', JSON.stringify({ analytics: '', marketing: '', preferences: '', sale_of_data: '' })));
    await o.load();
    expect(await get(o.page)).toMatchObject({ status: 'unset' });
    expect(await ckCookie(o.ctx)).toBeUndefined();
    expect(await mirror(o.page)).toBeUndefined();
    expect(await ls(o.page, 'complykit_consent_prev')).toBe(old.id);
    expect(o.posts).toHaveLength(1);
    await o.page.evaluate(() => (window as any).__setShop({ analytics: 'yes', marketing: 'yes', preferences: 'yes', sale_of_data: 'yes' }));
    await settle(o.page);
    const next = await snapshot(o);
    expect(next).toMatchObject({ kind: 'choice', supersedes: old.id, categories: old.categories });
    expect(next.id).not.toBe(old.id);
    expect(await ls(o.page, 'complykit_consent_prev')).toBeNull();
    expect(o.posts).toHaveLength(2);
    await o.ctx.close();
  });

  it('a category added to the config: the next answer is a new decision superseding the old one', async () => {
    const cfg = companionConfig('shopify');
    const o = await open(cfg, SHOPIFY(ALL_YES));
    const old = await snapshot(o);
    const extra = { ...cfg.categories[1], id: 'personalization', label: 'Personalization' };
    o.holder.config = { ...cfg, categories: [...cfg.categories, extra], hash: 'e'.repeat(64) };
    await o.load();
    const next = await snapshot(o);
    expect(next.id).not.toBe(old.id);
    expect(next).toMatchObject({ supersedes: old.id, source: 'shopify' });
    expect('personalization' in next.categories).toBe(true);
    await o.ctx.close();
  });

  it('a revoke that reloads the page: the withdrawal reaches the endpoint and the reloaded page keeps its id', async () => {
    const o = await open(companionConfig('shopify'), SHOPIFY(ALL_YES), 'default');
    const grant = await snapshot(o);
    const loaded = o.page.waitForEvent('load');
    await o.page.evaluate(() => (window as any).__setShop({ analytics: 'no' }));
    await loaded;
    await settle(o.page, 800);
    const wd = await snapshot(o);
    expect(wd).toMatchObject({ kind: 'withdrawal', supersedes: grant.id });
    // Sent before the reload or resent from the outbox after it; the export de-duplicates a double send by id.
    expect([...new Set(o.posts.map((p) => p.id))]).toEqual([grant.id, wd.id]);
    expect(await outbox(o.page)).toEqual([]);
    await o.ctx.close();
  });

  it("another tab's decision never resets this tab to defaults", async () => {
    const a = await open(companionConfig('shopify'), SHOPIFY(ALL_YES));
    await snapshot(a);
    const b = await open(companionConfig('shopify'), SHOPIFY(ALL_YES), 'none', a.ctx);
    await b.page.evaluate(() => (window as any).__setShop({ analytics: 'no' }));
    await settle(a.page);
    // Tab A still follows its own banner (granted); it is not dropped to the opt-in defaults.
    expect(await get(a.page)).toMatchObject({ categories: { analytics: true, advertising: true } });
    await a.ctx.close();
  });
});

describe('add-on proof: banners that say whether the visitor answered', () => {
  it('OneTrust: IsAlertBoxClosed() false => followed, nothing written; true => recorded', async () => {
    const o = await open(companionConfig('onetrust'), ONETRUST(',C0001,C0002,C0004,', false));
    expect(await get(o.page)).toMatchObject({ status: 'unset', categories: { analytics: true, advertising: true } });
    await expectNothingWritten(o);
    o.holder.banner = ONETRUST(',C0001,C0002,C0004,', true);
    await o.load();
    expect(await snapshot(o)).toMatchObject({ kind: 'choice', source: 'onetrust', categories: { analytics: true, advertising: true } });
    expect(o.posts).toHaveLength(1);
    await o.ctx.close();
  });

  it('OneTrust without IsAlertBoxClosed: the OptanonAlertBoxClosed cookie says answered', async () => {
    const no = await open(companionConfig('onetrust'), ONETRUST(',C0001,C0002,', false, false));
    await expectNothingWritten(no);
    await no.ctx.close();
    const yes = await open(companionConfig('onetrust'), ONETRUST(',C0001,C0002,', true, false));
    expect(await snapshot(yes)).toMatchObject({ source: 'onetrust', categories: { analytics: true } });
    await yes.ctx.close();
  });

  it('Cookiebot: hasResponse false => nothing written; true => recorded', async () => {
    const o = await open(companionConfig('cookiebot'), COOKIEBOT(false, false));
    expect(await get(o.page)).toMatchObject({ status: 'unset' });
    await expectNothingWritten(o);
    o.holder.banner = COOKIEBOT(true, false);
    await o.load();
    expect(await snapshot(o)).toMatchObject({ kind: 'choice', source: 'cookiebot', categories: { analytics: false, advertising: false } });
    expect(o.posts).toHaveLength(1);
    await o.ctx.close();
  });
});

describe('add-on proof: banners that cannot say', () => {
  it("consent-mode: the page's first state is followed, not recorded; a live change is; later pages keep its id", async () => {
    const o = await open(companionConfig('consent-mode'), CONSENT_MODE);
    expect(await get(o.page)).toMatchObject({ status: 'unset' });
    await expectNothingWritten(o);
    await o.page.evaluate(() => (window as any).__cm({ analytics_storage: 'granted', ad_storage: 'granted' }));
    await settle(o.page);
    const c = await snapshot(o);
    expect(c).toMatchObject({ kind: 'choice', source: 'consent-mode', categories: { analytics: true, advertising: true } });
    expect(o.posts.map((p) => p.id)).toEqual([c.id]);
    await o.load();
    expect((await snapshot(o)).id).toBe(c.id);
    expect(o.posts).toHaveLength(1);
    await o.ctx.close();
  });

  it('manual: ComplyKit.sync is the answer', async () => {
    const o = await open(companionConfig('manual'), '');
    await expectNothingWritten(o);
    await o.page.evaluate(() => (window as any).ComplyKit.sync({ analytics: true, advertising: false }));
    await settle(o.page);
    expect(await snapshot(o)).toMatchObject({ kind: 'choice', source: 'manual', categories: { analytics: true, advertising: false } });
    expect(validRecord(o.posts[0])).toMatchObject({ source: 'manual' });
    await o.ctx.close();
  });
});

describe('add-on proof: review fixes', () => {
  // A CMP that restores its stored answer with an async `update` after complykit's first read (Google's
  // recommended setup: inline default in <head>, CMP script async).
  const CONSENT_MODE_ASYNC = `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}
gtag('consent','default',{analytics_storage:'denied',ad_storage:'denied'});
setTimeout(function(){var u=localStorage.getItem('__fakeCm');if(u)gtag('consent','update',JSON.parse(u));},150);
window.__cm=function(u){localStorage.setItem('__fakeCm',JSON.stringify(u));gtag('consent','update',u)};</script>`;

  it('consent-mode: a default before the restored update is no withdrawal; later pages keep the id', async () => {
    const o = await open(companionConfig('consent-mode'), CONSENT_MODE_ASYNC);
    await expectNothingWritten(o);
    await o.page.evaluate(() => (window as any).__cm({ analytics_storage: 'granted', ad_storage: 'granted' }));
    await settle(o.page);
    const c = await snapshot(o);
    await o.load();
    await settle(o.page, 400);
    await o.load();
    await settle(o.page, 400);
    expect((await snapshot(o)).id).toBe(c.id);
    expect(o.posts.map((p) => p.kind)).toEqual(['choice']);
    expect(await get(o.page)).toMatchObject({ categories: { analytics: true, advertising: true } });
    await o.ctx.close();
  });

  it('the proof waits for a pending location lookup and records the settled regime and region', async () => {
    const cfg = companionConfig('shopify', { regimeSource: { kind: 'header', header: 'cf-ipcountry', endpoint: '/geo-slow' } });
    const ctx = await browser.newContext();
    const page0 = await ctx.newPage();
    await page0.close();
    await ctx.route('**/geo-slow', async (route) => {
      await new Promise((r) => setTimeout(r, 600));
      await route.fulfill({ contentType: 'text/plain', body: 'US-TX', headers: { 'access-control-allow-origin': '*' } });
    });
    const o = await open(cfg, SHOPIFY(ALL_YES), 'none', ctx);
    await settle(o.page, 1000);
    const c = await snapshot(o);
    const s = await get(o.page);
    expect(s.location).toMatchObject({ country: 'US', region: 'TX' });
    expect(c).toMatchObject({ region: 'US-TX', regime: s.regime, source: 'shopify' });
    expect(o.posts).toHaveLength(1);
    expect(o.posts[0]).toMatchObject({ region: 'US-TX', regime: s.regime });
    await o.load();
    await settle(o.page, 1000);
    expect((await snapshot(o)).id).toBe(c.id);
    expect(o.posts).toHaveLength(1);
    await o.ctx.close();
  });

  it('a category the banner cannot reach is recorded as false; the live state keeps its default', async () => {
    const base = companionConfig('shopify', { regimeSource: { kind: 'fixed', regime: 'opt-out' } });
    const social = { ...base.categories.find((c: any) => c.id === 'analytics'), id: 'social', label: 'Social' };
    social.defaultByRegime = { 'opt-in': false, 'opt-out-signal': true, 'opt-out': true };
    const cfg = { ...base, categories: [...base.categories, social] };
    const o = await open(cfg, SHOPIFY(ALL_YES));
    expect(await get(o.page)).toMatchObject({ categories: { social: true } });
    const c = await snapshot(o);
    expect(c.categories).toMatchObject({ social: false, analytics: true, advertising: true });
    expect(o.posts[0].categories.social).toBe(false);
    await o.load();
    expect((await snapshot(o)).id).toBe(c.id);
    expect(o.posts).toHaveLength(1);
    await o.ctx.close();
  });

  it("shopify: a GPC visitor's automatic sale-of-data opt-out is not an answer", async () => {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true }));
    const o = await open(companionConfig('shopify'), SHOPIFY({ analytics: '', marketing: '', preferences: '', sale_of_data: 'no' }, true), 'none', ctx);
    expect(await get(o.page)).toMatchObject({ status: 'unset', categories: { analytics: true, advertising: false } });
    await expectNothingWritten(o);
    await o.ctx.close();
  });

  it('cookiebot: implied consent is not an answer', async () => {
    const o = await open(companionConfig('cookiebot'), `<script>window.Cookiebot={hasResponse:true,consented:true,declined:false,consent:{method:'implied',necessary:true,preferences:true,statistics:true,marketing:true}};</script>`);
    expect(await get(o.page)).toMatchObject({ status: 'unset', categories: { analytics: true } });
    await expectNothingWritten(o);
    await o.ctx.close();
  });
});

describe('add-on proof: re-review fixes', () => {
  it('a location that settles before the banner speaks moves the pre-answer defaults (and stays if the banner never comes)', async () => {
    const base = companionConfig('shopify', { regimeSource: { kind: 'header', header: 'cf-ipcountry', endpoint: '/geo-fast' } });
    const ctx = await browser.newContext();
    await ctx.route('**/geo-fast', (route) => route.fulfill({ contentType: 'text/plain', body: 'US-TX', headers: { 'access-control-allow-origin': '*' } }));
    // No Shopify API at all: the banner is never found.
    const o = await open(base, '', 'none', ctx);
    await settle(o.page, 800);
    const s = await get(o.page);
    expect(s).toMatchObject({ status: 'unset', location: { country: 'US', region: 'TX' } });
    const want = await o.page.evaluate(() => {
      const st = (window as any).ComplyKit.get();
      return st.regime;
    });
    expect(want).not.toBe('opt-in');
    // The settled regime's defaults (example.json: analytics is on by default outside opt-in), not the strict fallback's.
    const cfg = base.categories.find((c: any) => c.id === 'analytics');
    expect(s.categories.analytics).toBe(cfg.defaultByRegime[s.regime]);
    await expectNothingWritten(o);
    await o.ctx.close();
  });

  it('manual: a partial ComplyKit.sync keeps the earlier answer in the proof (no false withdrawal)', async () => {
    const o = await open(companionConfig('manual'), '');
    await o.page.evaluate(() => (window as any).ComplyKit.sync({ analytics: true }));
    await settle(o.page);
    await o.page.evaluate(() => (window as any).ComplyKit.sync({ advertising: true }));
    await settle(o.page);
    expect(await get(o.page)).toMatchObject({ categories: { analytics: true, advertising: true } });
    const c = await snapshot(o);
    expect(c).toMatchObject({ kind: 'choice', categories: { analytics: true, advertising: true } });
    expect(o.posts.map((p) => p.kind)).toEqual(['choice', 'choice']);
    await o.ctx.close();
  });

  it('a live answer after the location settled is written at once: sync returns the chosen state', async () => {
    const cfg = companionConfig('manual', { regimeSource: { kind: 'header', header: 'cf-ipcountry', endpoint: '/geo-fast' } });
    const ctx = await browser.newContext();
    await ctx.route('**/geo-fast', (route) => route.fulfill({ contentType: 'text/plain', body: 'US-TX', headers: { 'access-control-allow-origin': '*' } }));
    const o = await open(cfg, '', 'none', ctx);
    await settle(o.page, 600);
    const r = await o.page.evaluate(() => (window as any).ComplyKit.sync({ analytics: true, advertising: true }));
    expect(r).toMatchObject({ status: 'chosen', region: 'US-TX' });
    await o.ctx.close();
  });
});

describe('add-on proof: Shopify platform location', () => {
  // Walrus-like: location from Shopify's customerPrivacy.getRegion(), which exists only after Shopify.loadFeatures.
  const SHOPIFY_LAZY_REGION = `<script>window.__loads=0;window.Shopify={loadFeatures:function(f,cb){window.__loads++;setTimeout(function(){var s={analytics:'yes',marketing:'yes',preferences:'yes',sale_of_data:'yes'};window.Shopify.customerPrivacy={currentVisitorConsent:function(){return s},getRegion:function(){return 'USFL'}};cb();},80);}};</script>`;

  it('the record carries the region Shopify reports, and the regime for it', async () => {
    const o = await open(companionConfig('shopify', { regimeSource: { kind: 'platform' } }), SHOPIFY_LAZY_REGION);
    await settle(o.page, 800);
    const s = await get(o.page);
    expect(s).toMatchObject({ status: 'chosen', location: { country: 'US', region: 'FL' } });
    expect(await o.page.evaluate(() => (window as any).ComplyKit.diagnostics.location)).toMatchObject({ source: 'platform', pending: false });
    const c = await snapshot(o);
    expect(c).toMatchObject({ region: 'US-FL', regime: s.regime, source: 'shopify' });
    expect(o.posts).toHaveLength(1);
    expect(o.posts[0]).toMatchObject({ region: 'US-FL', regime: s.regime });
    await o.ctx.close();
  });
});

describe('add-on proof: full mode', () => {
  it('a full-mode record carries no source', async () => {
    const o = await open({ ...companionConfig('onetrust'), mode: undefined, companion: undefined }, '');
    await o.page.locator('#complykit-ui .ck-btn[data-ck-action=accept]:visible').first().click();
    await settle(o.page);
    const c = await snapshot(o);
    expect('source' in c).toBe(false);
    expect(o.posts).toHaveLength(1);
    expect('source' in o.posts[0]).toBe(false);
    await o.ctx.close();
  });
});
