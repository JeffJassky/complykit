// Script gate (D4) fixture tests. Every page runs the built IIFE; the gate is
// driven by test/fixtures/test-store.js (the GateStore interface + set()).
import fs from 'node:fs';
import path from 'node:path';
import { type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DIST, launchBrowser, startFixtureServer, type FixtureServer } from './harness';

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

/** Open a fixture, load the IIFE, return the page. The gate is NOT created yet. */
async function open(fixture: string): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(`${server.origin}/${fixture}`);
  await page.addScriptTag({ url: `${server.origin}/complykit-consent.js` });
  return page;
}

/** Create the gate on TestStore/TestConfig, keeping a handle at window.__gate. */
const createGate = (page: Page) =>
  page.evaluate(() => {
    const w = window as any;
    w.__gate = w.ComplyKit.createScriptGate({ config: w.TestConfig, store: w.TestStore });
  });

const grant = (page: Page, id: string, on = true) => page.evaluate(([i, o]) => (window as any).TestStore.set(i, o), [id, on] as const);
const order = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).__order ?? []);
/** Requests since `start` (server.urls is shared by every test in this file). */
const urlsSince = (start: number, re = /./) => server.urls.slice(start).filter((u) => re.test(u));

describe('script gate: holding and releasing', () => {
  it('holds everything until the category is granted; releases inline and src scripts into fresh elements', async () => {
    const page = await open('gate-basic.html');
    const before = server.urls.length;
    await createGate(page);
    // Nothing granted: nothing runs, nothing fetched.
    expect(await page.evaluate(() => (window as any).__inlineRan)).toBeUndefined();
    expect(await page.evaluate(() => (window as any).__analyticsLoaded)).toBeUndefined();
    expect(server.urls.slice(before)).toEqual([]);

    await grant(page, 'analytics');
    await page.waitForFunction(() => (window as any).__analyticsLoaded === true && (window as any).__ran?.src === 1);
    expect(await page.evaluate(() => (window as any).__inlineRan)).toBe(1);
    expect(server.urls.slice(before)).toContain('/vendor/analytics.js');

    // The original is an inert marker; the twin sits right after it with the same
    // attributes — and owns the id (vendor loaders find themselves by id).
    const shape = await page.evaluate(() => {
      const twin = document.getElementById('ana') as HTMLScriptElement;
      const orig = twin.previousElementSibling as HTMLScriptElement;
      return {
        origType: orig.getAttribute('type'),
        origReleased: orig.hasAttribute('data-ck-released'),
        origHasId: orig.hasAttribute('id'),
        origDataSrc: orig.getAttribute('data-src'),
        twinTag: twin.tagName,
        twinType: twin.getAttribute('type'),
        twinSrc: twin.getAttribute('src'),
        twinHasDataSrc: twin.hasAttribute('data-src'),
        twinReleasedMarker: twin.hasAttribute('data-ck-released'),
        twinAsyncAttr: twin.hasAttribute('async'),
        attrs: ['id', 'class', 'crossorigin', 'referrerpolicy', 'data-vendor', 'data-category'].map((a) => twin.getAttribute(a)),
      };
    });
    expect(shape).toEqual({
      origType: 'text/plain',
      origReleased: true,
      origHasId: false,
      origDataSrc: '/vendor/analytics.js',
      twinTag: 'SCRIPT',
      twinType: null,
      twinSrc: '/vendor/analytics.js',
      twinHasDataSrc: false,
      twinReleasedMarker: false,
      twinAsyncAttr: false,
      attrs: ['ana', 'tag', 'anonymous', 'no-referrer', 'example', 'analytics'],
    });
    // The inline twin carries the body; the `data-ck-category` alias was honoured for the src one.
    expect(await page.evaluate(() => document.querySelectorAll('script[data-ck-released]').length)).toBe(3);
    await page.close();
  });

  it('never releases an ungranted category, an unlisted category, or a script that is not ours', async () => {
    const page = await open('gate-basic.html');
    const start = server.urls.length;
    await createGate(page);
    await grant(page, 'analytics');
    await grant(page, 'bogus'); // the store may say yes; the config does not list it
    await page.waitForFunction(() => (window as any).__analyticsLoaded === true);
    await page.waitForTimeout(100);
    const state = await page.evaluate(() => {
      const w = window as any;
      return {
        marketing: w.__marketingRan,
        bogus: w.__bogusRan,
        template: w.__templateRan,
        tplReleased: document.getElementById('tpl')!.hasAttribute('data-ck-released'),
        tplType: document.getElementById('tpl')!.getAttribute('type'),
      };
    });
    expect(state).toEqual({ marketing: undefined, bogus: undefined, template: undefined, tplReleased: false, tplType: 'text/plain' });
    expect(urlsSince(start, /n=mk/)).toEqual([]);
    expect(urlsSince(start, /^\/pixel\.gif$/)).toEqual([]);
    await page.close();
  });

  it('never releases twice: repeated notifications, repeated sweeps, a second gate instance', async () => {
    const page = await open('gate-basic.html');
    const start = server.urls.length;
    await createGate(page);
    await grant(page, 'analytics');
    await page.waitForFunction(() => (window as any).__analyticsLoaded === true);
    await page.evaluate(() => {
      const w = window as any;
      w.TestStore.notify();
      w.TestStore.notify();
      w.__gate.sweep();
      w.__gate.sweep();
      w.TestStore.set('analytics', true);
      // A second instance on the same document must refuse the marked originals.
      w.ComplyKit.createScriptGate({ config: w.TestConfig, store: w.TestStore });
    });
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => (window as any).__inlineRan)).toBe(1);
    expect(urlsSince(start, /^\/vendor\/analytics\.js$/).length).toBe(1);
    expect(urlsSince(start, /n=src/).length).toBe(1);
    // One twin only, and it alone carries the id (the marker gave it up on release).
    expect(await page.evaluate(() => document.querySelectorAll('script[id="ana"]').length)).toBe(1);
    expect(await page.evaluate(() => document.querySelectorAll('script[data-src="/vendor/analytics.js"]').length)).toBe(1);
    expect(await page.evaluate(() => document.querySelectorAll('script[src="/vendor/analytics.js"]').length)).toBe(1);
    await page.close();
  });

  it('applies config.gate rules (src regex, selector) to scripts without data-category', async () => {
    const page = await open('gate-basic.html');
    await page.evaluate(() => {
      (window as any).TestConfig.gate = [
        { category: 'analytics', src: 'n=rule-src' },
        { category: 'analytics', selector: 'script[data-ck-inline="example"]' },
        { category: 'marketing', src: '[' }, // malformed: gates nothing, breaks nothing
      ];
    });
    await createGate(page);
    await grant(page, 'analytics');
    await page.waitForFunction(() => (window as any).__ran?.['rule-src'] === 1);
    expect(await page.evaluate(() => (window as any).__ruleSelectorRan)).toBe(true);
    await page.close();
  });

  it('releases iframe/img with data-src + data-category by setting src, once, only when granted', async () => {
    const page = await open('gate-basic.html');
    const start = server.urls.length;
    await createGate(page);
    expect(await page.evaluate(() => document.querySelector('iframe')!.getAttribute('src'))).toBeNull();
    await grant(page, 'analytics');
    await page.waitForFunction(() => document.querySelector('iframe')!.getAttribute('src') === '/embed.html');
    await page.waitForTimeout(100);
    expect(urlsSince(start)).toContain('/embed.html');
    expect(urlsSince(start, /^\/pixel\.gif\?a=1$/).length).toBe(1);
    expect(urlsSince(start, /^\/pixel\.gif$/)).toEqual([]); // marketing pixel stays held
    await page.evaluate(() => (window as any).TestStore.notify());
    await page.waitForTimeout(50);
    expect(urlsSince(start, /^\/pixel\.gif\?a=1$/).length).toBe(1);
    await page.close();
  });

  // complykit#47: a "delay JS" optimizer serves inline snippets as
  // <script src="data:text/javascript;base64,…">; the change list rewrites them to
  // type="text/plain" data-category data-src="data:…". The twin gets that data:
  // URL as its src: it runs once, in category order, and only when granted.
  it('releases a data-src that is a data: URL (base64 and percent-encoded), in order, once, only when granted', async () => {
    const page = await open('gate-data-url.html');
    const start = server.urls.length;
    await createGate(page);
    expect(await page.evaluate(() => (window as any).__dataB64)).toBeUndefined();
    await grant(page, 'analytics');
    await page.waitForFunction(() => ((window as any).__order ?? []).length === 3);
    expect(await order(page)).toEqual(['b64', 'pct', 'inline']);
    expect(await page.evaluate(() => [(window as any).__dataB64, (window as any).__dataPct])).toEqual([1, 1]);
    const twin = await page.evaluate(() => {
      const t = document.getElementById('dataurl') as HTMLScriptElement;
      return { type: t.getAttribute('type'), src: t.getAttribute('src')?.slice(0, 29), dataSrc: t.hasAttribute('data-src') };
    });
    expect(twin).toEqual({ type: null, src: 'data:text/javascript;base64,d', dataSrc: false });
    await page.evaluate(() => (window as any).TestStore.notify());
    await page.waitForTimeout(50);
    expect(await page.evaluate(() => [(window as any).__dataB64, (window as any).__dataPct])).toEqual([1, 1]); // never twice; marketing copy stays held
    expect(urlsSince(start)).toEqual([]); // a data: URL is never a request
    await page.close();
  });
});

describe('script gate: execution order', () => {
  const analyticsOnly = (o: string[]) => o.filter((n) => !['m1', 'm-inline', 'async'].includes(n));

  it('runs same-category sync scripts in document order (inline waits on the slow external); categories do not wait on each other', async () => {
    const page = await open('gate-order.html');
    await createGate(page);
    await page.evaluate(() => {
      const w = window as any;
      w.TestStore.granted.analytics = true;
      w.TestStore.granted.marketing = true;
      w.TestStore.notify();
    });
    await page.waitForFunction(() => ((window as any).__order ?? []).length === 8);
    const o = await order(page);
    expect(analyticsOnly(o)).toEqual(['a', 'inline-after-a', 'b', 'c', 'module']);
    expect(o.indexOf('m1')).toBeLessThan(o.indexOf('m-inline'));
    expect(o.indexOf('m-inline')).toBeLessThan(o.indexOf('a')); // marketing did not wait for the 400 ms analytics script
    expect(o).toContain('async');
    expect(await page.evaluate(() => Object.values((window as any).__ran as Record<string, number>).every((n) => n === 1))).toBe(true);
    await page.close();
  });

  it('keeps document order when the gate is installed in <head> and the scripts arrive through the parser (MutationObserver)', async () => {
    const page = await browser.newPage();
    await page.goto(`${server.origin}/gate-order-head.html`);
    await page.waitForFunction(() => ((window as any).__order ?? []).length === 6);
    const o = await order(page);
    expect(analyticsOnly(o)).toEqual(['a', 'inline-after-a', 'b', 'c', 'module']);
    expect(o.filter((n) => n === 'm1' || n === 'm-inline')).toEqual([]); // marketing not granted: held
    await grant(page, 'marketing');
    await page.waitForFunction(() => ((window as any).__order ?? []).length === 8);
    expect((await order(page)).slice(6)).toEqual(['m1', 'm-inline']);
    await page.close();
  });
});

describe('script gate: late-added scripts and withdrawal', () => {
  it('releases gated scripts added after load when granted, holds them when not, and never un-runs on withdrawal', async () => {
    const page = await open('gate-basic.html');
    await createGate(page);
    await grant(page, 'analytics');
    await page.waitForFunction(() => (window as any).__analyticsLoaded === true);

    // Added directly, and inside a subtree.
    await page.evaluate(() => {
      const s = document.createElement('script');
      s.type = 'text/plain';
      s.dataset.category = 'analytics';
      s.textContent = 'window.__late1 = true;';
      document.body.appendChild(s);
      const div = document.createElement('div');
      div.innerHTML = '<p>x</p><script type="text/plain" data-category="analytics">window.__late2 = true;</script>';
      document.body.appendChild(div);
      const held = document.createElement('script');
      held.type = 'text/plain';
      held.dataset.category = 'marketing';
      held.id = 'late-marketing';
      held.textContent = 'window.__lateMarketing = true;';
      document.body.appendChild(held);
    });
    await page.waitForFunction(() => (window as any).__late1 === true && (window as any).__late2 === true);
    expect(await page.evaluate(() => (window as any).__lateMarketing)).toBeUndefined();

    // Grant marketing later: the held late script runs now.
    await grant(page, 'marketing');
    await page.waitForFunction(() => (window as any).__lateMarketing === true);
    expect(await page.evaluate(() => (window as any).__marketingRan)).toBe(true);

    // Withdraw analytics: nothing is undone, but nothing new in that category is released.
    await grant(page, 'analytics', false);
    await page.evaluate(() => {
      const s = document.createElement('script');
      s.type = 'text/plain';
      s.dataset.category = 'analytics';
      s.textContent = 'window.__afterWithdraw = true;';
      document.body.appendChild(s);
    });
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => (window as any).__afterWithdraw)).toBeUndefined();
    expect(await page.evaluate(() => (window as any).__inlineRan)).toBe(1); // still ran once; cannot be unloaded

    // Re-grant: the script added during withdrawal is released; the earlier ones are not released again.
    await grant(page, 'analytics', true);
    await page.waitForFunction(() => (window as any).__afterWithdraw === true);
    expect(await page.evaluate(() => (window as any).__inlineRan)).toBe(1);

    // Next load with nothing granted: everything held from the start.
    await page.reload();
    await page.addScriptTag({ url: `${server.origin}/complykit-consent.js` });
    await createGate(page);
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => (window as any).__inlineRan)).toBeUndefined();
    await page.close();
  });

  it('stop() ends releasing; already-released scripts are untouched', async () => {
    const page = await open('gate-basic.html');
    await createGate(page);
    await page.evaluate(() => (window as any).__gate.stop());
    await grant(page, 'analytics');
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => (window as any).__inlineRan)).toBeUndefined();
    await page.close();
  });
});

describe('script gate: CSP nonce', () => {
  it('carries the nonce to the released element under a header-delivered CSP; a twin without a nonce is blocked', async () => {
    const page = await browser.newPage();
    // The violation event, not console text: each engine words (and levels) its
    // CSP console message differently (Firefox: "Content-Security-Policy: ...").
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => ((window as any).__cspViolations ??= []).push(e.violatedDirective));
    });
    await page.goto(`${server.origin}/csp.html`);
    expect(await page.evaluate(() => typeof (window as any).ComplyKit)).toBe('object'); // the nonced tool loaded
    await createGate(page);
    await grant(page, 'analytics');
    await page.waitForFunction(() => (window as any).__ran?.nonced === 1 && (window as any).__noncedInlineRan === true);
    const twin = await page.evaluate(() => {
      // The id moves to the released twin; the held original sits right before it.
      const t = document.getElementById('nonced-inline') as HTMLScriptElement;
      return { nonce: t.nonce, origAttr: (t.previousElementSibling as HTMLScriptElement).getAttribute('nonce') };
    });
    expect(twin.nonce).toBe('ck-test-nonce');
    expect(twin.origAttr).toBe(''); // the browser hides the content attribute: reading it would have lost the nonce
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => (window as any).__unnoncedRan)).toBeUndefined();
    expect(await page.evaluate(() => document.getElementById('unnonced')!.previousElementSibling!.hasAttribute('data-ck-released'))).toBe(true);
    expect(await page.evaluate(() => ((window as any).__cspViolations ?? []).length)).toBeGreaterThan(0); // the CSP was enforced on the unnonced twin
    await page.close();
  });
});

describe('script gate: documentation — why a fresh element', () => {
  it('changing only `type` on an existing text/plain script does NOT execute it', async () => {
    const page = await open('gate-basic.html');
    const before = server.urls.length;
    await page.evaluate(() => {
      for (const s of Array.from(document.querySelectorAll('script[type="text/plain"]'))) {
        s.setAttribute('type', 'text/javascript');
      }
    });
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => (window as any).__inlineRan)).toBeUndefined();
    expect(await page.evaluate(() => (window as any).__marketingRan)).toBeUndefined();
    expect(server.urls.slice(before)).toEqual([]);
    await page.close();
  });

  it('…but a type change followed by setting `src` DOES run it, since the element never "started": the gate must not touch originals', async () => {
    const page = await open('gate-basic.html');
    await page.evaluate(() => {
      const s = document.getElementById('ana') as HTMLScriptElement;
      s.setAttribute('type', 'text/javascript');
      s.src = s.getAttribute('data-src')!;
    });
    await page.waitForFunction(() => (window as any).__analyticsLoaded === true);
    await page.close();
  });
});

describe('script gate: wired to the real store', () => {
  it('installs on the store ComplyKit.init() starts and releases on acceptAll(); a category the config does not list stays held', async () => {
    const example = JSON.parse(fs.readFileSync(path.join(DIST, '..', '..', 'test', 'fixtures', 'consent-config', 'example.json'), 'utf8'));
    const page = await open('gated-scripts.html');
    await page.evaluate((cfg) => {
      const w = window as any;
      w.__store = w.ComplyKit.init(cfg, 'opt-in');
      if (!w.__store) throw new Error('config refused');
      if (w.__store.isGranted('analytics')) throw new Error('opt-in must deny analytics by default');
    }, example);
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => (window as any).__analyticsLoaded)).toBeUndefined();
    await page.evaluate(() => (window as any).__store.acceptAll());
    await page.waitForFunction(() => (window as any).__analyticsLoaded === true);
    await page.waitForTimeout(50);
    // gated-scripts.html gates its inline under "marketing", which example.json does not list.
    expect(await page.evaluate(() => (window as any).__gatedInlineRan)).toBeUndefined();
    await page.close();
  });
});

describe('script gate: chain liveness (review fixes)', () => {
  it('a queued script whose subtree was detached does not stall its category; re-attached, it is released then', async () => {
    const page = await open('gate-basic.html');
    await createGate(page);
    await page.evaluate(() => {
      const w = window as any;
      document.getElementById('host')!.remove(); // only this test's scripts on the marketing chain
      const box = document.createElement('div');
      box.id = 'spa-box';
      box.innerHTML =
        '<script type="text/plain" data-category="marketing" data-src="/slow/order.js?n=d1&ms=150"></script>' +
        '<script type="text/plain" data-category="marketing" data-src="/slow/order.js?n=d2&ms=5"></script>';
      document.body.appendChild(box);
      w.__box = box;
    });
    await page.waitForTimeout(50); // observer saw the held scripts
    await page.evaluate(() => {
      const w = window as any;
      w.TestStore.set('marketing', true); // d1 twin inserted (fetching), d2 queued behind it
      w.__box.remove(); // SPA navigation: the queued d2 is now in a detached subtree
    });
    await page.waitForFunction(() => (window as any).__ran?.d1 === 1);
    // A later marketing script must still be released: the chain is not stuck on d2.
    await page.evaluate(() => {
      const s = document.createElement('script');
      s.type = 'text/plain';
      s.dataset.category = 'marketing';
      s.textContent = 'window.__afterDetach = true;';
      document.body.appendChild(s);
    });
    await page.waitForFunction(() => (window as any).__afterDetach === true, undefined, { timeout: 2000 });
    expect(await page.evaluate(() => (window as any).__ran?.d2)).toBeUndefined();
    // Back on the page: d2 is held-and-granted again, so it runs, once.
    await page.evaluate(() => document.body.appendChild((window as any).__box));
    await page.waitForFunction(() => (window as any).__ran?.d2 === 1);
    await page.close();
  });

  it('a nomodule classic script (no load/error ever fires) does not stall its category', async () => {
    const page = await open('gate-basic.html');
    await page.evaluate(() => {
      document.body.insertAdjacentHTML(
        'beforeend',
        '<script type="text/plain" data-category="marketing" nomodule data-src="/slow/order.js?n=nm&ms=5"></script>' +
          '<script type="text/plain" data-category="marketing">window.__afterNomodule = true;</script>',
      );
    });
    await createGate(page);
    await grant(page, 'marketing');
    await page.waitForFunction(() => (window as any).__afterNomodule === true, undefined, { timeout: 2000 });
    expect(await page.evaluate(() => (window as any).__ran?.nm)).toBeUndefined(); // modern browser: nomodule skipped
    await page.close();
  });
});

describe('script gate: defer (review fix)', () => {
  it('a gated `defer` script released while the document is still parsing waits for DOMContentLoaded, as native defer would', async () => {
    const page = await browser.newPage();
    await page.goto(`${server.origin}/gate-defer.html`);
    await page.waitForFunction(() => (window as any).__deferSawTail !== undefined);
    expect(await page.evaluate(() => (window as any).__deferSawTail)).toBe(true);
    await page.close();
  });
});
