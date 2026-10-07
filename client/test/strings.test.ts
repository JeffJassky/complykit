import fs from 'node:fs';
import path from 'node:path';
import { type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DIST, launchBrowser, startFixtureServer, type FixtureServer } from './harness';

// F2 fixture tests: the default words per regime (opt-in, opt-out-signal,
// opt-out), the California opt-out icon, the GPC notice, the privacy-policy
// link, config overrides, and the re-render when the regime arrives late.

const EXAMPLE = path.join(__dirname, '..', '..', 'test', 'fixtures', 'consent-config', 'example.json');
const DNSS = 'Do Not Sell or Share My Personal Information';
const config = (over: Record<string, unknown> = {}): any => {
  const c = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
  c.generatedFrom.site ??= 'example-shop.test';
  c.consent = { lifetimeDays: 365 };
  c.strings = {};
  for (const cat of c.categories) {
    cat.defaultByRegime['opt-out-signal'] ??= cat.id === 'necessary';
    delete cat.defaultByRegime.notice;
  }
  return { ...c, ...over };
};
const fixed = (regime: string, over: Record<string, unknown> = {}) => config({ regimeSource: { kind: 'fixed', regime }, ...over });

let browser: Browser;
let server: FixtureServer;

beforeAll(async () => {
  if (!fs.existsSync(path.join(DIST, 'complykit-consent-ui.js'))) throw new Error('dist missing: run `npm run build` first');
  server = await startFixtureServer();
  browser = await launchBrowser();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function load(cfg: unknown, opts: { gpc?: boolean; region?: { body: string; delayMs: number } } = {}): Promise<Page> {
  const ctx = await browser.newContext();
  if (opts.gpc) await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true }));
  const page = await ctx.newPage();
  await page.route('**/strings-page', (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Strings fixture</title>
<script type="application/json" id="complykit-config">${JSON.stringify(cfg)}</script>
<script src="/complykit-consent.js" data-complykit-reload="none"></script></head><body><main><a href="#x" id="page-first">x</a></main></body></html>`,
    }),
  );
  if (opts.region) {
    const { body, delayMs } = opts.region;
    await page.route('**/__region', async (route) => {
      await new Promise((r) => setTimeout(r, delayMs));
      await route.fulfill({ contentType: 'text/plain', body });
    });
  }
  await page.goto(`${server.origin}/strings-page`);
  await page.waitForSelector('#complykit-ui .ck-banner [data-ck-action=reject]', { state: 'attached' });
  return page;
}

const words = (p: Page) =>
  p.evaluate(() => {
    const q = (s: string) => document.querySelector(s)?.textContent ?? null;
    const choices = document.querySelector('.ck-choices')!;
    return {
      title: q('.ck-banner .ck-title'),
      body: q('.ck-banner .ck-body'),
      actions: Array.from(document.querySelectorAll('.ck-banner .ck-btn')).map((b) => b.textContent),
      choices: choices.textContent?.trim(),
      icon: choices.querySelector('svg.ck-icon')?.getAttribute('aria-label') ?? null,
      gpc: q('.ck-banner [data-ck-note=gpc]'),
      policy: (document.querySelector('.ck-banner a.ck-link') as HTMLAnchorElement | null)?.href ?? null,
      policyText: q('.ck-banner a.ck-link'),
    };
  });

const settingsWords = async (p: Page) => {
  await p.evaluate(() => (window as any).ComplyKit.open());
  return p.evaluate(() => ({
    title: document.querySelector('.ck-settings .ck-title')?.textContent,
    actions: Array.from(document.querySelectorAll('.ck-settings .ck-btn')).map((b) => b.textContent),
    gpc: document.querySelector('.ck-settings [data-ck-note=gpc]')?.textContent ?? null,
    policy: document.querySelector('.ck-settings a.ck-link')?.textContent ?? null,
  }));
};

describe('opt-in (EU/UK) defaults', () => {
  it('purpose-first copy, Reject all / Accept all / Manage choices, no icon, policy link last', async () => {
    const page = await load(fixed('opt-in'));
    const w = await words(page);
    expect(w.title).toBe('Cookies on this site');
    // {purposes} = the config's own non-necessary categories.
    expect(w.body).toContain('for analytics and advertising.');
    expect(w.body).toContain('They stay off unless you accept.');
    expect(w.body).not.toMatch(/value your privacy/i);
    expect(w.actions).toEqual(['Reject all', 'Accept all', 'Manage choices']);
    expect(w.icon).toBeNull();
    expect(w.gpc).toBeNull();
    expect(w.policy).toBe('https://example-shop.test/privacy');
    expect(w.policyText).toBe('Privacy policy');
    // Reject stays the first stop; the policy link comes after the actions.
    expect(await page.evaluate(() => document.querySelector('.ck-banner .ck-actions')!.nextElementSibling?.className)).toBe('ck-links');
    const s = await settingsWords(page);
    expect(s.title).toBe('Privacy settings');
    expect(s.actions).toEqual(['Reject all', 'Accept all', 'Save choices', 'Close']);
    expect(s.policy).toBe('Privacy policy');
    await page.context().close();
  });

  it('GPC under opt-in shows no opt-out notice (nothing is on anyway)', async () => {
    const page = await load(fixed('opt-in'), { gpc: true });
    expect((await words(page)).gpc).toBeNull();
    await page.context().close();
  });

  it('after accepting, the settings layer explains withdrawal and that sent data is not recalled', async () => {
    const page = await load(fixed('opt-in'));
    await page.click('.ck-banner [data-ck-action=accept]');
    await page.evaluate(() => (window as any).ComplyKit.open());
    expect(await page.locator('.ck-settings [data-ck-note=withdraw]').textContent()).toContain('data already sent cannot be recalled');
    await page.context().close();
  });
});

describe('opt-out-signal (California etc.) defaults', () => {
  it('"Your Privacy Choices" with the CPPA icon, "Do Not Sell or Share", opt-out confirmation', async () => {
    const page = await load(fixed('opt-out-signal'));
    const w = await words(page);
    expect(w.title).toBe('Your Privacy Choices');
    expect(w.body).toContain('"sale" or "sharing" of your personal information');
    expect(w.actions).toEqual([DNSS, 'Accept all', 'Manage choices']);
    const s = await settingsWords(page);
    expect(s.title).toBe('Your Privacy Choices');
    expect(s.actions).toEqual([DNSS, 'Accept all', 'Save choices', 'Close']);
    await page.keyboard.press('Escape');
    await page.click('.ck-banner [data-ck-action=reject]');
    expect(await page.locator('#complykit-ui [role=status]').textContent()).toBe('Opt-out request honored.');
    const after = await words(page);
    expect(after.choices).toBe('Your Privacy Choices');
    expect(after.icon).toBe('California Consumer Privacy Act (CCPA) Opt-Out Icon');
    // The official 30×14 design, colors unchanged.
    const icon = await page.evaluate(() => {
      const svg = document.querySelector('.ck-choices svg')!;
      return { box: svg.getAttribute('viewBox'), fills: Array.from(svg.querySelectorAll('path')).map((p) => p.getAttribute('fill')) };
    });
    expect(icon).toEqual({ box: '0 0 30 14', fills: ['#FFFFFF', '#0066FF', '#FFFFFF', '#0066FF'] });
    await page.context().close();
  });

  it('GPC: the banner and settings say the signal was honored', async () => {
    const page = await load(fixed('opt-out-signal'), { gpc: true });
    expect((await words(page)).gpc).toContain('Global Privacy Control');
    expect((await settingsWords(page)).gpc).toContain('opt out of the sale and sharing');
    expect(await page.evaluate(() => (window as any).ComplyKit.get().categories)).toMatchObject({ analytics: false, advertising: false });
    await page.context().close();
  });
});

describe('opt-out defaults', () => {
  it('"Your Privacy Choices", Reject all, no icon', async () => {
    const page = await load(fixed('opt-out'));
    const w = await words(page);
    expect(w.title).toBe('Your Privacy Choices');
    expect(w.body).toContain('opt out of targeted advertising');
    expect(w.actions).toEqual(['Reject all', 'Accept all', 'Manage choices']);
    await page.click('.ck-banner [data-ck-action=accept]');
    const after = await words(page);
    expect(after.choices).toBe('Your Privacy Choices');
    expect(after.icon).toBeNull();
    await page.context().close();
  });
});

describe('overrides and edge cases', () => {
  it('config byRegime beats the base table, which beats the built-in regime default', async () => {
    const strings = { en: { 'banner.title': 'Cookies at Example Shop', 'banner.reject': 'Decline all', byRegime: { 'opt-out-signal': { 'banner.title': 'Your California Privacy Choices' } } } };
    let page = await load(fixed('opt-out-signal', { strings }));
    let w = await words(page);
    expect(w.title).toBe('Your California Privacy Choices');
    expect(w.actions[0]).toBe('Decline all');
    await page.context().close();
    page = await load(fixed('opt-in', { strings }));
    w = await words(page);
    expect(w.title).toBe('Cookies at Example Shop');
    await page.context().close();
  });

  it('no privacyPolicyUrl: no link', async () => {
    const c = fixed('opt-in');
    delete c.privacyPolicyUrl;
    const page = await load(c);
    expect((await words(page)).policy).toBeNull();
    await page.context().close();
  });

  it('the regime arriving late re-renders the visible banner (GPC on: same grants, new words)', async () => {
    const c = config({ regimeSource: { kind: 'header', header: 'cf-ipcountry', endpoint: '/__region' } });
    const page = await load(c, { gpc: true, region: { body: 'US-CA', delayMs: 400 } });
    expect((await words(page)).title).toBe('Cookies on this site'); // unknown ⇒ opt-in
    await page.waitForFunction(() => document.querySelector('.ck-banner .ck-title')?.textContent === 'Your Privacy Choices');
    const w = await words(page);
    expect(w.actions[0]).toBe(DNSS);
    expect(w.gpc).toContain('Global Privacy Control');
    await page.context().close();
  });
});
