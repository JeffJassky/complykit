import fs from 'node:fs';
import path from 'node:path';
import { type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DIST, ENGINE, TAB, launchBrowser, startFixtureServer, type FixtureServer } from './harness';

// F1 fixtures: theme tokens, appearance switches and the three layouts. Each
// layout gets a screenshot (test/__screenshots__, regenerated on every run: look
// at them in review) and computed-style assertions: Accept and Reject are
// identical in size and type, Reject keeps a full-contrast border, Accept is
// filled unless appearance.accept is 'outline'; tokens reach the banner; the
// mockup defaults when the theme gives none; reduced motion removes transitions.

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

// Size and type: identical. Colors: identical too when Accept is outlined.
const BOX_PROPS = ['font-family', 'font-size', 'font-weight', 'line-height', 'border-top-width', 'border-top-style', 'border-radius', 'padding-top', 'padding-left', 'min-height', 'height', 'opacity', 'text-decoration-line'];
const COLOR_PROPS = ['color', 'background-color', 'border-top-color'];

async function expectEqualWeight(p: Page, scope: string, filled = true): Promise<void> {
  const props = filled ? BOX_PROPS : [...BOX_PROPS, ...COLOR_PROPS];
  const reject = await style(p, `${scope} [data-ck-action=reject]`, [...props, 'border-top-color', 'color']);
  const accept = await style(p, `${scope} [data-ck-action=accept]`, [...props, 'border-top-color', 'color']);
  const pick = (o: Record<string, string>) => Object.fromEntries(props.map((k) => [k, o[k]]));
  expect(pick(accept)).toEqual(pick(reject));
  // Reject is never a bare link: a solid border in the text color (the equal-prominence rule's "bordered").
  expect(parseFloat(reject['border-top-width'])).toBeGreaterThanOrEqual(1);
  expect(reject['border-top-color']).toBe(reject.color);
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
        // the mockup card: 880px wide at most, 40px from the bottom-left corner
        expect(Math.round(box!.width)).toBe(Math.min(880, vp.width - 80));
        expect(Math.round(box!.x)).toBe(40);
        expect(Math.round(box!.y + box!.height)).toBe(vp.height - 40);
      } else {
        const cx = box!.x + box!.width / 2;
        const cy = box!.y + box!.height / 2;
        expect(Math.abs(cx - vp.width / 2)).toBeLessThan(2);
        expect(Math.abs(cy - vp.height / 2)).toBeLessThan(2);
      }
      await expectEqualWeight(p, '.ck-banner');
      // the cookie art sits beside the text; Manage is an underlined link on its own line under the buttons
      expect(await p.locator('.ck-banner > svg.ck-art').count()).toBe(1);
      expect(await p.locator('.ck-banner .ck-sub > [data-ck-action=manage]').count()).toBe(1);
      const manage = await style(p, '.ck-banner [data-ck-action=manage]', ['text-decoration-line', 'border-top-style']);
      expect(manage).toEqual({ 'text-decoration-line': 'underline', 'border-top-style': 'none' });
      await p.screenshot({ path: shot(`layout-${layout}`) });
      await p.context().close();
    });
  }

  it('settings panel: styled, equal-weight Accept/Reject, screenshot', async () => {
    const p = await load(baseConfig({ layout: 'bar', theme: THEME }));
    await p.click('.ck-banner [data-ck-action=manage]');
    await p.waitForSelector('.ck-settings[open]');
    await expectEqualWeight(p, '.ck-settings');
    const s = await style(p, '.ck-settings', ['background-color', 'color', 'border-top-color']);
    expect(s['background-color']).toBe('rgb(255, 253, 245)');
    expect(s.color).toBe('rgb(26, 26, 26)');
    const w = (await p.locator('.ck-settings').boundingBox())!.width;
    expect(w).toBeLessThanOrEqual(36 * 16 + 1);
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
    expect(b['border-top-color']).toBe('rgb(201, 195, 176)');
    // buttons take 9/16 of the card radius (16px card, 9px buttons in the mockup)
    const btn = await style(p, '[data-ck-action=accept]', ['border-top-left-radius', 'background-color']);
    expect(btn['border-top-left-radius']).toBe('5.625px');
    expect(btn['background-color']).toBe('rgb(37, 99, 235)');
    await p.context().close();
  });

  it('the newer tokens: muted body, accent text, steam color, heading font', async () => {
    const p = await load(baseConfig({ theme: { ...THEME, muted: '#555555', accentText: '#fefefe', icon: '#ff0000', headingFont: 'Courier New, monospace' } }));
    expect((await style(p, '.ck-banner .ck-body', ['color'])).color).toBe('rgb(85, 85, 85)');
    expect((await style(p, '[data-ck-action=accept]', ['color'])).color).toBe('rgb(254, 254, 254)');
    expect((await style(p, '.ck-art-steam', ['stroke'])).stroke).toBe('rgb(255, 0, 0)');
    expect((await style(p, '.ck-art-cookie', ['stroke'])).stroke).toBe('rgb(26, 26, 26)');
    expect((await style(p, '.ck-title', ['font-family']))['font-family']).toContain('Courier New');
    await p.context().close();
  });

  it('headingFont: balanced quotes pass; an open quote is dropped', async () => {
    const ok = await load(baseConfig({ theme: { headingFont: '"Helvetica Neue", Arial, sans-serif' } }));
    expect((await style(ok, '.ck-title', ['font-family']))['font-family']).toContain('Helvetica Neue');
    await ok.context().close();
    const bad = await load(baseConfig({ theme: { headingFont: '"Helvetica, sans-serif', accent: '#2563eb' } }));
    const root = await style(bad, '#complykit-ui', ['--ck-heading-font', '--ck-accent']);
    expect(root['--ck-heading-font']).toBe('');
    expect(root['--ck-accent']).toBe('#2563eb');
    await bad.context().close();
  });

  it('without headingFont the title keeps the page font', async () => {
    const p = await load(baseConfig({ theme: THEME }));
    const f = await p.evaluate(() => [getComputedStyle(document.body).fontFamily, getComputedStyle(document.querySelector('.ck-title')!).fontFamily]);
    expect(f[1]).toBe(f[0]);
    expect((await style(p, '.ck-title', ['font-weight']))['font-weight']).toBe('700');
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
    // dropped: the defaults stay
    expect(root['--ck-bg']).toBe('#fff');
    expect(root['--ck-fg']).toBe('#111');
    expect(root['--ck-accent']).toBe('#2563eb');
    await p.context().close();
  });
});

describe('defaults and appearance switches', () => {
  it('no theme: the mockup colors, the same in dark mode', async () => {
    for (const colorScheme of ['light', 'dark'] as const) {
      const p = await load(baseConfig({ theme: {} }), { colorScheme });
      const b = await style(p, '.ck-banner', ['background-color', 'color', 'border-top-left-radius']);
      expect(b).toEqual({ 'background-color': 'rgb(255, 255, 255)', color: 'rgb(17, 17, 17)', 'border-top-left-radius': '0px' });
      const a = await style(p, '[data-ck-action=accept]', ['background-color', 'color', 'border-top-left-radius']);
      expect(a).toEqual({ 'background-color': 'rgb(17, 17, 17)', color: 'rgb(255, 255, 255)', 'border-top-left-radius': '9px' });
      expect((await style(p, '.ck-banner .ck-body', ['color'])).color).toBe('rgb(58, 58, 56)');
      if (colorScheme === 'dark') await p.screenshot({ path: shot('defaults-dark-scheme') });
      await p.context().close();
    }
  });

  it("accept: 'outline' — Accept and Reject identical, colors included", async () => {
    const p = await load(baseConfig({ theme: THEME, appearance: { accept: 'outline' } }));
    await expectEqualWeight(p, '.ck-banner', false);
    await p.click('.ck-banner [data-ck-action=manage]');
    await p.waitForSelector('.ck-settings[open]');
    await expectEqualWeight(p, '.ck-settings', false);
    await p.context().close();
  });

  it("manage: 'button' — a third button in the row, same height; icon: 'none' — no art", async () => {
    const p = await load(baseConfig({ theme: THEME, layout: 'box', appearance: { manage: 'button', icon: 'none' } }));
    expect(await p.locator('.ck-banner .ck-actions > [data-ck-action=manage]').count()).toBe(1);
    expect(await p.locator('.ck-banner .ck-sub').count()).toBe(0);
    expect(await p.locator('.ck-banner svg.ck-art').count()).toBe(0);
    const heights = await p.$$eval('.ck-banner .ck-btn', (bs) => bs.map((b) => Math.round(b.getBoundingClientRect().height)));
    expect(new Set(heights).size).toBe(1);
    await p.screenshot({ path: shot('appearance-manage-button') });
    await p.context().close();
  });

  it("position: 'right' — the box sits bottom-right", async () => {
    const p = await load(baseConfig({ theme: THEME, layout: 'box', appearance: { position: 'right' } }));
    const box = (await p.locator('.ck-banner').boundingBox())!;
    expect(Math.round(box.x + box.width)).toBe(p.viewportSize()!.width - 40);
    await p.context().close();
  });

  it('narrow screen: 16px gutter, art on top, buttons stacked full width with Accept first, Manage centred', async () => {
    const p = await load(baseConfig({ theme: THEME, layout: 'box' }), { viewport: { width: 390, height: 844 } });
    const box = (await p.locator('.ck-banner').boundingBox())!;
    expect(Math.round(box.x)).toBe(16);
    expect(Math.round(box.width)).toBe(390 - 32);
    const art = (await p.locator('.ck-art').boundingBox())!;
    const title = (await p.locator('.ck-banner .ck-title').boundingBox())!;
    expect(art.y + art.height).toBeLessThanOrEqual(title.y);
    const a = (await p.locator('.ck-banner [data-ck-action=accept]').boundingBox())!;
    const r = (await p.locator('.ck-banner [data-ck-action=reject]').boundingBox())!;
    expect(a.y).toBeLessThan(r.y);
    expect(Math.round(a.width)).toBe(Math.round(r.width));
    expect(Math.round(a.x)).toBe(Math.round(r.x));
    expect((await style(p, '.ck-banner .ck-sub', ['text-align']))['text-align']).toBe('center');
    await p.screenshot({ path: shot('layout-box-narrow') });
    await p.context().close();
  });

  it('short screen: the art is hidden and Reject stays on screen', async () => {
    const p = await load(baseConfig({ theme: THEME, layout: 'box' }), { viewport: { width: 320, height: 568 } });
    expect(await p.locator('.ck-art').isVisible()).toBe(false);
    const r = (await p.locator('.ck-banner [data-ck-action=reject]').boundingBox())!;
    expect(r.y + r.height).toBeLessThanOrEqual(568);
    await p.screenshot({ path: shot('layout-box-short') });
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
    expect(o.action).toBe('accept');
    expect(o.style).toBe('solid');
    expect(o.width).toBe('2px');
    expect(o.color).toBe('rgb(26, 26, 26)');
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
