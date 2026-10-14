import fs from 'node:fs';
import path from 'node:path';
import { type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DIST, ENGINE, launchBrowser, startFixtureServer, type FixtureServer } from './harness';
import { deletionStrings } from '../src/withdraw';

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

async function load(scriptAttrs = '', origin = server.origin): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.route('**/shop/withdraw-page', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE(scriptAttrs) }));
  await page.route('**/consent-record', (route) => route.fulfill({ status: 204 }));
  if (origin !== server.origin) {
    // A named host (the fixture server is 127.0.0.1, which has no parent domain): serve the IIFE for it too.
    for (const f of ['complykit-consent.js', 'complykit-consent-ui.js']) {
      await page.route(`${origin}/${f}`, (route) => route.fulfill({ contentType: 'text/javascript', path: path.join(DIST, f) }));
    }
  }
  await page.goto(`${origin}/shop/withdraw-page`);
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

describe('cleanup reach and report (diagnostics.withdrawal)', () => {
  const report = (p: Page) => p.waitForFunction(() => (window as any).ComplyKit.diagnostics.withdrawal).then((h) => h.jsonValue()) as Promise<any>;

  it('a cookie on a parent Domain is gone after withdraw; the report lists what was cleared and no leftover', async () => {
    const page = await load('data-complykit-reload="none"', 'http://shop.example-shop.test');
    await grant(page);
    await page.evaluate(() => {
      document.cookie = '_fbc=on-parent; Domain=example-shop.test; Path=/';
      document.cookie = '_fbq_x=1; Path=/'; // not a vendor store: untouched
    });
    expect((await page.context().cookies()).filter((c) => c.name === '_fbc').map((c) => c.domain)).toContain('.example-shop.test');
    await page.evaluate(() => (window as any).ComplyKit.withdraw());
    const w = await report(page);
    expect([...w.categories].sort()).toEqual(['advertising', 'analytics']);
    expect([...w.cleared].sort()).toEqual(['cookie:_fbc', 'cookie:_fbp', 'local:_fbq_ls', 'session:_fbq_ss']);
    expect(w.leftover).toEqual([]);
    expect(typeof w.at).toBe('number');
    expect(await cookieNames(page)).toEqual(['_fbq_x', 'complykit_consent', 'site_pref']);
    await page.context().close();
  });

  it('a cookie set with a shallower Path than the page is gone too', async () => {
    const page = await load('data-complykit-reload="none"');
    await grant(page);
    await page.evaluate(() => (document.cookie = '_fbp=p; Path=/shop'));
    expect((await page.context().cookies()).some((c) => c.name === '_fbp' && c.path.startsWith('/shop'))).toBe(true);
    await page.evaluate(() => (window as any).ComplyKit.withdraw());
    expect((await report(page)).leftover).toEqual([]);
    expect((await page.context().cookies()).filter((c) => c.name === '_fbp')).toEqual([]);
    await page.context().close();
  });

  // cookieStore.getAll() only reports cookies sent to the current URL, so a Path the page is not under is
  // invisible to it (and to document.cookie) — unreachable from this page by design. What it adds: the
  // cookie's real Domain / Path / partitioned flag. Block every document.cookie deletion write to prove it.
  it.runIf(ENGINE === 'chromium')('cookieStore deletes precisely when the document.cookie brute force cannot', async () => {
    const page = await load('data-complykit-reload="none"');
    await grant(page);
    await page.evaluate(() => {
      document.cookie = '_fbp=deep; Path=/shop/'; // (cookieStore.delete appends a trailing "/" to a path)
      const d = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!;
      Object.defineProperty(document, 'cookie', { get: () => d.get!.call(document), set: (v: string) => void (/^_fbp=;/.test(v) || d.set!.call(document, v)) });
    });
    expect((await page.context().cookies()).some((c) => c.name === '_fbp' && c.path.startsWith('/shop'))).toBe(true);
    await page.evaluate(() => (window as any).ComplyKit.withdraw());
    const w = await report(page);
    expect(w.leftover).toEqual([]);
    expect(w.cleared).toContain('cookie:_fbp');
    expect((await page.context().cookies()).filter((c) => c.name === '_fbp')).toEqual([]);
    await page.context().close();
  });

  it('a matching cookie that cannot be deleted is listed in leftover and warned about once', async () => {
    const page = await load('data-complykit-reload="none"');
    const warned: string[] = [];
    page.on('console', (m) => m.type() === 'warning' && warned.push(m.text()));
    await grant(page);
    await page.evaluate(() => {
      Object.defineProperty(window, 'cookieStore', { value: undefined }); // no precise delete either
      const d = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!;
      Object.defineProperty(document, 'cookie', {
        get: () => d.get!.call(document),
        set: (v: string) => void (/^_fbc=;/.test(v) || d.set!.call(document, v)), // the page "refuses" to let _fbc go
      });
    });
    await page.evaluate(() => (window as any).ComplyKit.withdraw());
    const w = await report(page);
    expect(w.leftover).toEqual(['cookie:_fbc']);
    expect([...w.cleared].sort()).toEqual(['cookie:_fbp', 'local:_fbq_ls', 'session:_fbq_ss']);
    expect(warned.filter((t) => /withdrawal left cookie:_fbc/.test(t))).toHaveLength(1);
    await page.context().close();
  });

  it('deletion strings: http plain; https adds Secure and Secure+Partitioned for every Domain / Path pair', () => {
    const http = deletionStrings('a.shop.example.com', '/x/y', false, '_c');
    expect(http.some((c) => /Secure|Partitioned/.test(c))).toBe(false);
    const https = deletionStrings('a.shop.example.com', '/x/y', true, '_c');
    // 4 host forms (host-only + 3 Domain=, never the bare TLD) x 5 paths (/, /x, /x/, /x/y, /x/y/) x 2 variants
    expect(https).toHaveLength(4 * 5 * 2);
    expect(https.filter((c) => c.endsWith('; Secure; Partitioned'))).toHaveLength(4 * 5);
    expect(https).toContain('_c=; Max-Age=0; Path=/; Secure; Partitioned');
    expect(https).toContain('_c=; Max-Age=0; Path=/x/; Domain=example.com; Secure; Partitioned');
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
