import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DIST, launchBrowser, startFixtureServer, type FixtureServer } from './harness';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'test', 'fixtures', 'consent-config', 'example.json'), 'utf8'));

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

// example.json categories: necessary, analytics, advertising.
async function open(regime: string, platform = 'wordpress', mapping?: unknown): Promise<Page> {
  const c = structuredClone(EXAMPLE);
  c.platform = platform;
  const page = await browser.newPage();
  await page.addInitScript(([config, r, m]) => {
    (window as any).__ckConfig = config;
    (window as any).__ckRegime = r;
    if (m) (window as any).ComplyKitWordPressMapping = m;
  }, [c, regime, mapping] as const);
  await page.goto(`${server.origin}/wp-consent.html`);
  await page.waitForFunction(() => (window as any).__wpCalls.length > 0, undefined, { timeout: 3000 }).catch(() => undefined);
  return page;
}

const calls = (p: Page) => p.evaluate(() => (window as any).__wpCalls as [string, string][]);
const wpStore = (p: Page) => p.evaluate(() => (window as any).__wpStore as Record<string, string>);
const cats = (p: Page) => p.evaluate(() => (window as any).ComplyKit.get().categories as Record<string, boolean>);
const settle = (p: Page) => p.waitForTimeout(50);

describe('WordPress Consent API bridge', () => {
  it('opt-in: wp_consent_type optin; mapped categories denied once wp_set_consent appears', async () => {
    const page = await open('opt-in');
    expect(await page.evaluate(() => (window as any).wp_consent_type)).toBe('optin');
    expect(await wpStore(page)).toEqual({ functional: 'allow', statistics: 'deny', marketing: 'deny' });
    await page.close();
  });

  it('opt-out: wp_consent_type optout; categories the config grants are allowed', async () => {
    const page = await open('opt-out');
    expect(await page.evaluate(() => (window as any).wp_consent_type)).toBe('optout');
    expect(await wpStore(page)).toEqual({ functional: 'allow', statistics: 'allow', marketing: 'allow' });
    await page.close();
  });

  it('pushes every change of our store, idempotently', async () => {
    const page = await open('opt-in');
    await page.evaluate(() => (window as any).__store.set({ analytics: true }));
    await settle(page);
    expect(await wpStore(page)).toMatchObject({ statistics: 'allow', marketing: 'deny' });
    const n = (await calls(page)).length;
    await page.evaluate(() => (window as any).__store.set({ analytics: true })); // same grants
    await settle(page);
    expect((await calls(page)).length).toBe(n);
    await page.evaluate(() => (window as any).ComplyKit.withdraw());
    await settle(page);
    expect(await wpStore(page)).toMatchObject({ statistics: 'deny', marketing: 'deny' });
    await page.close();
  });

  it('a plugin deny reaches our store; a plugin allow never grants', async () => {
    const page = await open('opt-in');
    await page.evaluate(() => (window as any).__store.set({ analytics: true, advertising: true }));
    await settle(page);
    // another plugin's banner denies marketing
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('wp_listen_for_consent_change', { detail: { marketing: 'deny' } })));
    await settle(page);
    expect(await cats(page)).toEqual({ necessary: true, analytics: true, advertising: false });
    // another plugin tries to grant it back: ignored
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('wp_listen_for_consent_change', { detail: { marketing: 'allow' } })));
    await settle(page);
    expect((await cats(page)).advertising).toBe(false);
    expect(await wpStore(page)).toMatchObject({ statistics: 'allow', marketing: 'deny' });
    await page.close();
  });

  it('a plugin allow on a denied category changes nothing', async () => {
    const page = await open('opt-in');
    await page.evaluate(() => (window as any).wp_set_consent('statistics', 'allow')); // plugin grants itself
    await settle(page);
    expect((await cats(page)).analytics).toBe(false);
    await page.close();
  });

  it('the mapping is configurable', async () => {
    const page = await open('opt-in', 'wordpress', { analytics: 'statistics-anonymous' });
    await page.evaluate(() => (window as any).__store.set({ analytics: true }));
    await settle(page);
    expect(await wpStore(page)).toMatchObject({ 'statistics-anonymous': 'allow' });
    expect((await wpStore(page)).statistics).toBeUndefined();
    await page.close();
  });

  it('inactive when the platform is not wordpress and no wp_set_consent exists at start', async () => {
    const page = await open('opt-in', 'none');
    expect(await page.evaluate(() => (window as any).wp_consent_type)).toBeUndefined();
    await page.close();
  });
});
