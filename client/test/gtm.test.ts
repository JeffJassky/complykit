import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DIST, launchBrowser, startFixtureServer, type FixtureServer } from './harness';

// The example config: gtm.consentMode maps ad_* → advertising,
// analytics_storage → analytics, security_storage → necessary; the other two
// signals are unmapped.
const here = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'test', 'fixtures', 'consent-config', 'example.json'), 'utf8'));

const OPT_OUT = { ...structuredClone(CONFIG), regimeSource: { kind: 'fixed', regime: 'opt-out' } };

type Entry = { kind: 'command'; args: unknown[] } | { kind: 'data'; value: Record<string, unknown> };

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

async function open(file: string, regime: string, config: unknown = CONFIG): Promise<{ page: Page; warnings: string[] }> {
  const page = await browser.newPage();
  const warnings: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'warning') warnings.push(m.text());
  });
  await page.addInitScript(([config, r]) => {
    (window as any).__ckConfig = config;
    (window as any).__ckRegime = r;
  }, [config, regime] as const);
  await page.goto(`${server.origin}/${file}`);
  return { page, warnings };
}

/** The real store (auto-started from the inline config) with the location meta tag, above the fake GTM snippet. */
async function openRouted(config: unknown, region: string, gpc = false): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  if (gpc) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true }));
  const full = { ...(config as object), generatedFrom: { site: 'example-shop.test', ...(config as { generatedFrom?: object }).generatedFrom } };
  await page.route('**/gtm-routed', (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><head><meta charset="utf-8"><meta name="complykit-region" content="${region}">
<script type="application/json" id="complykit-config">${JSON.stringify(full)}</script>
<script src="/complykit-consent.js"></script>
<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s);j.async=true;j.src='/gtm-recording.js?id='+i;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','GTM-XXXX01');</script>
</head><body></body></html>`,
    }),
  );
  await page.goto(`${server.origin}/gtm-routed`);
  await containerLoaded(page);
  return page;
}

const containerLoaded = (page: Page) => page.waitForFunction(() => Array.isArray((window as any).__gtmQueueAtLoad));
const queueAtLoad = (page: Page) => page.evaluate(() => (window as any).__gtmQueueAtLoad as Entry[]);
const pushes = (page: Page) => page.evaluate(() => (window as any).__gtmPushes as Entry[]);
const isCmd = (e: Entry, kind: string) => e.kind === 'command' && e.args[0] === 'consent' && e.args[1] === kind;
const isEvent = (e: Entry, name: string) => e.kind === 'data' && e.value.event === name;

describe('GTM bridge: defaults before the container', () => {
  it('queues consent defaults (opt-in: denied) as a gtag command before gtm.js, and the first complykit_consent event', async () => {
    const { page, warnings } = await open('gtm-ordered.html', 'opt-in');
    await containerLoaded(page);
    const q = await queueAtLoad(page);

    const iDefault = q.findIndex((e) => isCmd(e, 'default'));
    const iGtm = q.findIndex((e) => isEvent(e, 'gtm.js'));
    expect(iDefault).toBeGreaterThanOrEqual(0);
    expect(iGtm).toBeGreaterThan(iDefault);

    expect((q[iDefault] as { args: unknown[] }).args[2]).toEqual({
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: 'denied',
      functionality_storage: 'denied', // unmapped
      personalization_storage: 'denied', // unmapped
      security_storage: 'granted', // mapped to necessary
      wait_for_update: 500,
    });
    // Nothing decided yet: no update to cut wait_for_update short.
    expect(q.some((e) => isCmd(e, 'update'))).toBe(false);

    const ev = q.find((e) => isEvent(e, 'complykit_consent'));
    expect(ev).toEqual({
      kind: 'data',
      value: { event: 'complykit_consent', complykit: { categories: { necessary: true, analytics: false, advertising: false }, regime: 'opt-in' } },
    });
    expect(q.findIndex((e) => isEvent(e, 'complykit_consent'))).toBeLessThan(iGtm);

    const diag = await page.evaluate(() => (window as any).ComplyKit.diagnostics.gtm);
    expect(diag).toMatchObject({ orderOk: true, regime: 'opt-in', containersLoadedBefore: [], gtmEventBefore: false, warnings: [] });
    expect(warnings.filter((w) => w.includes('[complykit]'))).toEqual([]);
    await page.close();
  });

  it('uses the regime defaults: opt-out grants what the config grants for opt-out', async () => {
    const page = await openRouted(OPT_OUT, 'US-TX');
    const q = await queueAtLoad(page);
    const def = q.find((e) => isCmd(e, 'default')) as { args: unknown[] };
    expect(def.args[2]).toMatchObject({
      ad_storage: 'granted',
      analytics_storage: 'granted',
      functionality_storage: 'denied',
      personalization_storage: 'denied',
    });
    await page.close();
  });

  it('never grants a tracking signal mapped to necessary (fail closed on a hand-edited config)', async () => {
    const bad = structuredClone(OPT_OUT);
    bad.gtm.consentMode.analytics_storage = 'necessary';
    const page = await openRouted(bad, 'US-TX');
    const def = (await queueAtLoad(page)).find((e) => isCmd(e, 'default')) as { args: unknown[] };
    expect(def.args[2]).toMatchObject({ analytics_storage: 'denied', security_storage: 'granted' });
    await page.close();
  });

  it('a wiretap-state visitor: the default command itself denies the held categories, and no update precedes gtm.js', async () => {
    const held = { ...structuredClone(CONFIG), locationDefaults: { 'US-CA': { analytics: false, advertising: false } } };
    const ca = await openRouted(held, 'US-CA');
    const q = await queueAtLoad(ca);
    const iDefault = q.findIndex((e) => isCmd(e, 'default'));
    expect(iDefault).toBeGreaterThanOrEqual(0);
    expect((q[iDefault] as { args: unknown[] }).args[2]).toMatchObject({ analytics_storage: 'denied', ad_storage: 'denied', ad_user_data: 'denied' });
    expect(q.findIndex((e) => isCmd(e, 'update'))).toBe(-1);
    expect(q.findIndex((e) => isEvent(e, 'gtm.js'))).toBeGreaterThan(iDefault);
    await ca.close();

    // The same config in Texas holds nothing.
    const tx = await openRouted(held, 'US-TX');
    const def = (await queueAtLoad(tx)).find((e) => isCmd(e, 'default')) as { args: unknown[] };
    expect(def.args[2]).toMatchObject({ analytics_storage: 'granted', ad_storage: 'denied' }); // opt-out-signal: advertising off by policy, analytics on
    await tx.close();
  });

  it('GPC denies the default command (opt-out state), and no update precedes gtm.js', async () => {
    const page = await openRouted(OPT_OUT, 'US-TX', true);
    const q = await queueAtLoad(page);
    const iDefault = q.findIndex((e) => isCmd(e, 'default'));
    expect((q[iDefault] as { args: unknown[] }).args[2]).toMatchObject({ analytics_storage: 'denied', ad_storage: 'denied', security_storage: 'granted' });
    expect(q.some((e) => isCmd(e, 'update'))).toBe(false);
    await page.close();
  });

  it('on each decision pushes gtag consent update, then the complykit_consent event', async () => {
    const { page } = await open('gtm-ordered.html', 'opt-in');
    await containerLoaded(page);

    await page.evaluate(() => (window as any).__store.set({ analytics: true }));
    let p = await pushes(page);
    expect(p).toHaveLength(2);
    expect(isCmd(p[0], 'update')).toBe(true);
    expect((p[0] as { args: unknown[] }).args[2]).toEqual({
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: 'granted',
      functionality_storage: 'denied',
      personalization_storage: 'denied',
      security_storage: 'granted',
    });
    expect(p[1]).toEqual({
      kind: 'data',
      value: { event: 'complykit_consent', complykit: { categories: { necessary: true, analytics: true, advertising: false }, regime: 'opt-in' } },
    });

    // Withdrawal goes through the same path.
    await page.evaluate(() => (window as any).__store.set({}));
    p = await pushes(page);
    expect(p).toHaveLength(4);
    expect((p[2] as { args: unknown[] }).args[2]).toMatchObject({ analytics_storage: 'denied' });
    expect((p[3] as { value: any }).value.complykit.categories).toEqual({ necessary: true, analytics: false, advertising: false });
    await page.close();
  });
});

describe('GTM bridge: started by the store', () => {
  it('installs itself when the tool starts on its config, before the GTM snippet runs', async () => {
    const page = await browser.newPage();
    // The full guard runs here; `generatedFrom.site` is new in the D2 contract
    // revision and may not be in the shared example yet.
    const config = { ...CONFIG, generatedFrom: { site: 'example-shop.test', ...CONFIG.generatedFrom } };
    await page.addInitScript((c) => {
      (window as any).ComplyKitConfig = c;
    }, config);
    await page.goto(`${server.origin}/gtm-auto.html`);
    await containerLoaded(page);
    const q = await queueAtLoad(page);
    const iDefault = q.findIndex((e) => isCmd(e, 'default'));
    expect(iDefault).toBeGreaterThanOrEqual(0);
    expect(q.findIndex((e) => isEvent(e, 'gtm.js'))).toBeGreaterThan(iDefault);
    // Unknown location ⇒ the fallback regime (opt-in): tracking signals denied.
    expect((q[iDefault] as { args: unknown[] }).args[2]).toMatchObject({ analytics_storage: 'denied', ad_storage: 'denied' });
    expect(q.find((e) => isEvent(e, 'complykit_consent'))).toMatchObject({ value: { complykit: { regime: 'opt-in' } } });
    expect(await page.evaluate(() => (window as any).ComplyKit.diagnostics.gtm.orderOk)).toBe(true);
    await page.close();
  });
});

describe('GTM bridge: misinstall detection', () => {
  it('flags the GTM snippet running above the consent tool', async () => {
    const { page, warnings } = await open('gtm-misordered.html', 'opt-in');
    await containerLoaded(page);
    const diag = await page.evaluate(() => (window as any).ComplyKit.diagnostics.gtm);
    expect(diag.orderOk).toBe(false);
    expect(diag.gtmEventBefore).toBe(true);
    expect(warnings.some((w) => w.startsWith('[complykit]') && w.includes('gtm.js'))).toBe(true);
    await page.close();
  });

  it('flags a container that already ran, and still sets the defaults (late beats never)', async () => {
    const { page, warnings } = await open('gtm-preloaded.html', 'opt-in');
    const diag = await page.evaluate(() => (window as any).ComplyKit.diagnostics.gtm);
    expect(diag.orderOk).toBe(false);
    expect(diag.containersLoadedBefore).toEqual(['GTM-XXXX01']);
    expect(diag.containerScriptsBefore).toHaveLength(1);
    expect(warnings.some((w) => w.includes('GTM-XXXX01'))).toBe(true);
    const hasDefault = await page.evaluate(() =>
      ((window as any).dataLayer as unknown[]).some(
        (e) => Object.prototype.toString.call(e) === '[object Arguments]' && (e as any)[0] === 'consent' && (e as any)[1] === 'default',
      ),
    );
    expect(hasDefault).toBe(true);
    await page.close();
  });
});
