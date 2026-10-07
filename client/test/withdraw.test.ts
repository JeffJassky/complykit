import fs from 'node:fs';
import path from 'node:path';
import { type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DIST, launchBrowser, startFixtureServer, type FixtureServer } from './harness';

// F3 fixture tests: the withdrawal flow end to end on the built IIFE. Grant via
// the banner → the gated "Meta" script runs and sets its cookies → withdraw →
// GTM update and the adapter's revoke happen while the cookies still exist,
// then the cookies / storage go, the page reloads, and the script stays gated.
// The page writes its log to sessionStorage (synchronous, survives the reload).

const EXAMPLE = path.join(__dirname, '..', '..', 'test', 'fixtures', 'consent-config', 'example.json');
const config = (): any => {
  const c = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
  c.generatedFrom.site ??= 'example-shop.test';
  c.consent = { lifetimeDays: 365 };
  c.regimeSource = { kind: 'fixed', regime: 'opt-in' };
  for (const cat of c.categories) {
    cat.defaultByRegime['opt-out-signal'] ??= cat.id === 'necessary';
    delete cat.defaultByRegime.notice;
  }
  const meta = c.vendors.find((v: any) => v.id === 'meta.pixel');
  meta.stores.push({ name: '^_fbq_ls$', kind: 'local' }, { name: '^_fbq_ss$', kind: 'session' });
  return c;
};

const PAGE = (scriptAttrs: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Withdraw fixture</title>
<script>
  window.ckLog = function (e) { var l = JSON.parse(sessionStorage.getItem('testlog') || '[]'); l.push(e); sessionStorage.setItem('testlog', JSON.stringify(l)); };
  window.dataLayer = [];
  var push = dataLayer.push;
  dataLayer.push = function () {
    for (var i = 0; i < arguments.length; i++) {
      var a = arguments[i];
      if (a && a[0] === 'consent' && a[1] === 'update') ckLog(['gtm', a[2].ad_storage, document.cookie.indexOf('_fbp=') >= 0]);
    }
    return push.apply(this, arguments);
  };
  document.cookie = 'site_pref=dark; Path=/';
</script>
<script type="application/json" id="complykit-config">${JSON.stringify(config())}</script>
<script src="/complykit-consent.js" ${scriptAttrs}></script>
<script type="text/plain" data-ck-inline="meta">
  window.fbq = function () { ckLog(['fbq'].concat([].slice.call(arguments), document.cookie.indexOf('_fbp=') >= 0)); };
  document.cookie = '_fbp=fb.1.123; Path=/';
  document.cookie = '_fbc=fb.1.456; Path=' + location.pathname;
  localStorage.setItem('_fbq_ls', '1');
  sessionStorage.setItem('_fbq_ss', '1');
  ckLog(['meta-ran']);
</script>
</head><body><h1>Shop</h1></body></html>`;

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

async function load(scriptAttrs = ''): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.route('**/shop/withdraw-page', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE(scriptAttrs) }));
  await page.route('**/consent-record', (route) => route.fulfill({ status: 204 }));
  await page.goto(`${server.origin}/shop/withdraw-page`);
  return page;
}

const log = (p: Page) => p.evaluate(() => JSON.parse(sessionStorage.getItem('testlog') || '[]') as unknown[][]);
const cookieNames = async (p: Page) => (await p.context().cookies()).map((c) => c.name).sort();
const grant = async (p: Page) => {
  await p.click('.ck-banner [data-ck-action=accept]');
  await p.waitForFunction(() => typeof (window as any).fbq === 'function');
};

describe('withdrawal flow (F3)', () => {
  it('grant → script runs + cookies set → withdraw → revoke first, cookies gone, reload, script stays gated', async () => {
    const page = await load();
    expect(await log(page)).toEqual([]); // opt-in: held before a choice
    await grant(page);
    expect(await cookieNames(page)).toEqual(expect.arrayContaining(['_fbc', '_fbp', 'complykit_consent', 'site_pref']));
    expect((await log(page)).filter((e) => e[0] === 'meta-ran')).toHaveLength(1);
    const beforeWithdraw = (await log(page)).length;

    await Promise.all([page.waitForEvent('load'), page.evaluate(() => (window as any).ComplyKit.withdraw())]);

    // Reloaded: the gated script did not run again and the vendor was not re-granted.
    expect(await page.evaluate(() => typeof (window as any).fbq)).toBe('undefined');
    const after = (await log(page)).slice(beforeWithdraw);
    // The GTM update and the adapter's revoke both ran while the vendor cookie
    // still existed (true) — i.e. before cleanup — GTM first.
    expect(after).toEqual([
      ['gtm', 'denied', true],
      ['fbq', 'consent', 'revoke', true],
    ]);
    expect((await log(page)).filter((e) => e[0] === 'meta-ran')).toHaveLength(1);

    // Vendor stores gone; the consent cookie (now deny-all) and unrelated cookies kept.
    expect(await cookieNames(page)).toEqual(['complykit_consent', 'site_pref']);
    expect(await page.evaluate(() => [localStorage.getItem('_fbq_ls'), sessionStorage.getItem('_fbq_ss')])).toEqual([null, null]);
    const state = await page.evaluate(() => (window as any).ComplyKit.get());
    expect(state.status).toBe('chosen');
    expect(state.categories).toEqual({ necessary: true, analytics: false, advertising: false });
    await page.context().close();
  });

  it('data-complykit-reload="none": cleans up and revokes without reloading', async () => {
    const page = await load('data-complykit-reload="none"');
    await grant(page);
    await page.evaluate(() => ((window as any).__sameDocument = true));
    await page.evaluate(() => (window as any).ComplyKit.withdraw());
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => (window as any).__sameDocument)).toBe(true);
    expect((await log(page)).at(-1)).toEqual(['fbq', 'consent', 'revoke', true]);
    expect(await cookieNames(page)).toEqual(['complykit_consent', 'site_pref']);
    await page.context().close();
  });

  it('a withdrawal that revokes nothing does not reload', async () => {
    const page = await load();
    await page.evaluate(() => ((window as any).__sameDocument = true));
    await page.evaluate(() => (window as any).ComplyKit.withdraw());
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => (window as any).__sameDocument)).toBe(true);
    expect((await log(page)).filter((e) => e[0] === 'meta-ran')).toHaveLength(0);
    await page.context().close();
  });
});

describe('ComplyKit.init() twice (D4 review)', () => {
  it('a second init is refused and returns the running store, so the gate and adapters stay subscribed', async () => {
    const page = await load();
    const warned: string[] = [];
    page.on('console', (m) => m.type() === 'warning' && warned.push(m.text()));
    const same = await page.evaluate(() => {
      const w = window as any;
      const cfg = JSON.parse(document.getElementById('complykit-config')!.textContent!);
      const s = w.ComplyKit.init(cfg, 'opt-out');
      s.acceptAll();
      return s.state().regime === w.ComplyKit.get().regime && w.ComplyKit.get().regime === 'opt-in';
    });
    expect(same).toBe(true);
    expect(warned.some((t) => /already started/.test(t))).toBe(true);
    // The gate (subscribed to the first store) released the script; the adapter granted.
    await page.waitForFunction(() => typeof (window as any).fbq === 'function');
    await page.waitForFunction(() => sessionStorage.getItem('testlog')!.includes('"grant"'));
    await page.context().close();
  });
});
