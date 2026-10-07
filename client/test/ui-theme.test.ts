import fs from 'node:fs';
import path from 'node:path';
import { type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DIST, ENGINE, TAB, launchBrowser, startFixtureServer, type FixtureServer } from './harness';

// F1 fixtures: theme tokens and the three layouts. Each layout gets a
// screenshot (test/__screenshots__, regenerated on every run: look at them in
// review) and computed-style assertions: Accept and Reject are identical in
// size, type and colors; tokens reach the banner; system colors / dark scheme
// when the theme gives none; reduced motion removes transitions.

const EXAMPLE = path.join(__dirname, '..', '..', 'test', 'fixtures', 'consent-config', 'example.json');
const SHOTS = path.join(__dirname, '__screenshots__');
/** One file per engine (F5): layout-bar.chromium.png, layout-bar.webkit.png, ... */
const shot = (name: string): string => path.join(SHOTS, `${name}.${ENGINE}.png`);

const baseConfig = (over: Record<string, unknown> = {}): any => {
  const c = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
  c.generatedFrom.site ??= 'example-shop.test';
  c.consent = { lifetimeDays: 365 };
  c.regimeSource = { kind: 'fixed', regime: 'opt-in' };
  for (const cat of c.categories) {
    cat.defaultByRegime['opt-out-signal'] ??= cat.id === 'necessary';
    delete cat.defaultByRegime.notice;
  }
  return { ...c, ...over };
};

let browser: Browser;
let server: FixtureServer;

beforeAll(async () => {
  if (!fs.existsSync(path.join(DIST, 'complykit-consent-ui.js'))) throw new Error('dist missing: run `npm run build` first');
  fs.mkdirSync(SHOTS, { recursive: true });
  server = await startFixtureServer();
  browser = await launchBrowser();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function load(config: unknown, ctxOpts: Parameters<Browser['newContext']>[0] = {}, extraCss = '', gpc = false): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 700 }, ...ctxOpts })).newPage();
  if (gpc) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true }));
  await page.route('**/theme-page', (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Theme fixture</title>
<style>body{font:17px/1.4 Georgia,serif;margin:0}${extraCss}</style>
<script type="application/json" id="complykit-config">${JSON.stringify(config)}</script>
<script src="/complykit-consent.js"></script></head>
<body><main style="padding:2rem"><h1>Example shop</h1><p>Page content behind the banner.</p></main></body></html>`,
    }),
  );
  await page.goto(`${server.origin}/theme-page`);
  await page.waitForSelector('.ck-banner [data-ck-action=accept]');
  return page;
}

const style = (p: Page, sel: string, props: string[]) =>
  p.evaluate(
    ([s, ps]) => {
      const cs = getComputedStyle(document.querySelector(s as string)!);
      return Object.fromEntries((ps as string[]).map((k) => [k, cs.getPropertyValue(k)]));
    },
    [sel, props] as const,
  );

const BTN_PROPS = ['font-family', 'font-size', 'font-weight', 'line-height', 'color', 'background-color', 'border-top-color', 'border-top-width', 'border-top-style', 'border-radius', 'padding-top', 'padding-left', 'min-height', 'height', 'width', 'opacity', 'text-decoration-line'];

async function expectEqualWeight(p: Page, scope: string): Promise<void> {
  const reject = await style(p, `${scope} [data-ck-action=reject]`, BTN_PROPS);
  const accept = await style(p, `${scope} [data-ck-action=accept]`, BTN_PROPS);
  // grid tracks can differ by a hair of a pixel; everything else must match exactly
  const round = (o: Record<string, string>) => ({ ...o, width: String(Math.round(parseFloat(o.width))) });
  expect(round(accept)).toEqual(round(reject));
  const classes = await p.evaluate((s) => ['reject', 'accept'].map((a) => document.querySelector(`${s} [data-ck-action=${a}]`)!.className), scope);
  expect(classes[0]).toBe(classes[1]);
}

const THEME = { bg: '#fffdf5', fg: '#1a1a1a', accent: '#2563eb', border: '#c9c3b0', radius: '10px' };

describe('layouts', () => {
  for (const layout of ['bar', 'box', 'modal'] as const) {
    it(`${layout}: placement, equal-weight buttons, screenshot`, async () => {
      const p = await load(baseConfig({ layout, theme: THEME }));
      const box = await p.locator('.ck-banner').boundingBox();
      const vp = p.viewportSize()!;
      expect(box).toBeTruthy();
      if (layout === 'bar') {
        expect(box!.x).toBe(0);
        expect(Math.round(box!.width)).toBe(vp.width);
        expect(Math.round(box!.y + box!.height)).toBe(vp.height);
      } else if (layout === 'box') {
        expect(box!.width).toBeLessThanOrEqual(28 * 17);
        expect(Math.round(box!.x + box!.width)).toBe(vp.width - 16);
        expect(Math.round(box!.y + box!.height)).toBe(vp.height - 16);
      } else {
        const cx = box!.x + box!.width / 2;
        const cy = box!.y + box!.height / 2;
        expect(Math.abs(cx - vp.width / 2)).toBeLessThan(2);
        expect(Math.abs(cy - vp.height / 2)).toBeLessThan(2);
      }
      await expectEqualWeight(p, '.ck-banner');
      // manage sits in the same row, same height (not a de-emphasised link)
      const heights = await p.$$eval('.ck-banner .ck-btn', (bs) => bs.map((b) => Math.round(b.getBoundingClientRect().height)));
      expect(new Set(heights).size).toBe(1);
      await p.screenshot({ path: shot(`layout-${layout}`) });
      await p.context().close();
    });
  }

  it('settings panel: styled, equal-weight Reject/Accept, screenshot', async () => {
    const p = await load(baseConfig({ layout: 'bar', theme: THEME }));
    await p.click('.ck-banner [data-ck-action=manage]');
    await p.waitForSelector('.ck-settings[open]');
    await expectEqualWeight(p, '.ck-settings');
    const s = await style(p, '.ck-settings', ['background-color', 'color', 'border-top-color']);
    expect(s['background-color']).toBe('rgb(255, 253, 245)');
    expect(s.color).toBe('rgb(26, 26, 26)');
    const w = (await p.locator('.ck-settings').boundingBox())!.width;
    expect(w).toBeLessThanOrEqual(34 * 17 + 1);
    await p.screenshot({ path: shot('settings') });
    await p.context().close();
  });

  it('F2 pieces: GPC note, privacy-policy link, opt-out icon, withdrawal note — styled, screenshots', async () => {
    const p = await load(baseConfig({ layout: 'box', theme: THEME, regimeSource: { kind: 'fixed', regime: 'opt-out-signal' } }), {}, '', true);
    const note = await style(p, '.ck-banner [data-ck-note=gpc]', ['font-size', 'border-left-style', 'margin-bottom']);
    expect(parseFloat(note['font-size'])).toBeLessThan(17);
    expect(note['border-left-style']).toBe('solid');
    // The link takes the layer's text color (never the UA link blue) and stays underlined.
    const link = await style(p, '.ck-banner a.ck-link', ['color', 'text-decoration-line']);
    expect(link.color).toBe('rgb(26, 26, 26)');
    expect(link['text-decoration-line']).toBe('underline');
    await p.screenshot({ path: shot('f2-banner-gpc') });
    await p.click('.ck-banner [data-ck-action=accept]');
    await p.waitForSelector('.ck-choices svg.ck-icon');
    expect((await style(p, '.ck-choices svg.ck-icon', ['vertical-align']))['vertical-align']).toBe('middle');
    await p.click('.ck-choices');
    await p.waitForSelector('.ck-settings[open] [data-ck-note=withdraw]');
    await p.screenshot({ path: shot('f2-settings-withdraw') });
    await p.context().close();
  });

  it('layout bar renders the bar hook', async () => {
    const p = await load(baseConfig({ layout: 'bar' }));
    expect(await p.getAttribute('.ck-banner', 'data-ck-layout')).toBe('bar');
    await p.context().close();
  });
});

describe('theme tokens', () => {
  it('config.theme becomes --ck-* on the root and reaches banner and buttons', async () => {
    const p = await load(baseConfig({ theme: THEME }));
    const root = await style(p, '#complykit-ui', ['--ck-bg', '--ck-fg', '--ck-accent', '--ck-border', '--ck-radius']);
    expect(root).toEqual({ '--ck-bg': '#fffdf5', '--ck-fg': '#1a1a1a', '--ck-accent': '#2563eb', '--ck-border': '#c9c3b0', '--ck-radius': '10px' });
    const b = await style(p, '.ck-banner', ['background-color', 'color', 'border-top-color']);
    expect(b['background-color']).toBe('rgb(255, 253, 245)');
    expect(b.color).toBe('rgb(26, 26, 26)');
    expect(b['border-top-color']).toBe('rgb(37, 99, 235)');
    const btn = await style(p, '[data-ck-action=accept]', ['border-top-left-radius', 'color']);
    expect(btn['border-top-left-radius']).toBe('10px');
    await p.context().close();
  });

  it('accent is not applied to Accept only: Reject and Accept share colors', async () => {
    const p = await load(baseConfig({ theme: THEME }));
    const a = await style(p, '[data-ck-action=accept]', ['background-color', 'color', 'border-top-color']);
    expect(a['background-color']).not.toBe('rgb(37, 99, 235)');
    await expectEqualWeight(p, '.ck-banner');
    await p.context().close();
  });

  it('font: inherit — the banner uses the page font', async () => {
    const p = await load(baseConfig({ theme: THEME }));
    const f = await p.evaluate(() => ({
      body: getComputedStyle(document.body).fontFamily,
      banner: getComputedStyle(document.querySelector('.ck-banner')!).fontFamily,
      btn: getComputedStyle(document.querySelector('.ck-btn')!).fontFamily,
    }));
    expect(f.banner).toBe(f.body);
    expect(f.btn).toBe(f.body);
    await p.context().close();
  });

  it('the site can override a token or any rule with its own CSS', async () => {
    const p = await load(baseConfig({ theme: THEME }), {}, '#complykit-ui{--ck-bg:rgb(1,2,3)} .ck-title{font-size:30px}');
    expect((await style(p, '.ck-banner', ['background-color']))['background-color']).toBe('rgb(1, 2, 3)');
    expect((await style(p, '.ck-title', ['font-size']))['font-size']).toBe('30px');
    await p.context().close();
  });

  it('hostile theme values are dropped (no url(), no breaking out of the rule)', async () => {
    const p = await load(baseConfig({ theme: { bg: 'red;} body{display:none', fg: 'url(https://evil.test/x)', accent: '#2563eb' } }));
    expect(await p.evaluate(() => getComputedStyle(document.body).display)).not.toBe('none');
    const root = await style(p, '#complykit-ui', ['--ck-bg', '--ck-fg', '--ck-accent']);
    expect(root['--ck-bg']).toBe('');
    expect(root['--ck-fg']).toBe('');
    expect(root['--ck-accent']).toBe('#2563eb');
    await p.context().close();
  });
});

describe('system colors and dark scheme', () => {
  const bg = (p: Page) => style(p, '.ck-banner', ['background-color', 'color']);
  it('no theme colors: light and dark both readable, following the scheme', async () => {
    const cfg = baseConfig({ theme: {} });
    const light = await load(cfg, { colorScheme: 'light' });
    const dark = await load(cfg, { colorScheme: 'dark' });
    const l = await bg(light);
    const d = await bg(dark);
    expect(l['background-color']).not.toBe(d['background-color']);
    expect(l['background-color']).not.toBe('rgba(0, 0, 0, 0)');
    expect(l.color).not.toBe(l['background-color']);
    expect(d.color).not.toBe(d['background-color']);
    await dark.screenshot({ path: shot('dark-fallback') });
    await light.context().close();
    await dark.context().close();
  });

  it('themed colors stay as configured in dark mode', async () => {
    const p = await load(baseConfig({ theme: THEME }), { colorScheme: 'dark' });
    expect((await bg(p))['background-color']).toBe('rgb(255, 253, 245)');
    await p.context().close();
  });
});

describe('focus and motion', () => {
  it('keyboard focus shows an outline on buttons', async () => {
    const p = await load(baseConfig({ theme: THEME }));
    await p.keyboard.press(TAB);
    const o = await p.evaluate(() => {
      const a = document.activeElement!;
      const cs = getComputedStyle(a);
      return { action: a.getAttribute('data-ck-action'), style: cs.outlineStyle, width: cs.outlineWidth, color: cs.outlineColor };
    });
    expect(o.action).toBe('reject');
    expect(o.style).toBe('solid');
    expect(o.width).toBe('2px');
    expect(o.color).toBe('rgb(37, 99, 235)');
    await p.context().close();
  });

  it('reduced motion: no transitions; otherwise a short one', async () => {
    const reduce = await load(baseConfig({ theme: THEME }), { reducedMotion: 'reduce' });
    expect((await style(reduce, '.ck-btn', ['transition-duration']))['transition-duration']).toBe('0s');
    const normal = await load(baseConfig({ theme: THEME }), { reducedMotion: 'no-preference' });
    expect((await style(normal, '.ck-btn', ['transition-duration']))['transition-duration']).not.toBe('0s');
    await reduce.context().close();
    await normal.context().close();
  });

  it('no external fonts or resources are requested by the UI', async () => {
    const p = await load(baseConfig({ theme: THEME }));
    const res = await p.evaluate(() => performance.getEntriesByType('resource').map((r) => new URL(r.name).host));
    expect(new Set(res).size).toBeLessThanOrEqual(1);
    await p.context().close();
  });
});
