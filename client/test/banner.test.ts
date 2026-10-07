import fs from 'node:fs';
import path from 'node:path';
import { type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DIST, SHIFT_TAB, TAB, launchBrowser, startFixtureServer, type FixtureServer } from './harness';

// D9 fixture tests: the banner and settings layer, driven by the keyboard only
// (Tab / Shift+Tab / Enter / Space / Escape — no clicks), loaded from the built
// IIFE. The page and its inline config are served per test via route fulfilment.

const EXAMPLE = path.join(__dirname, '..', '..', 'test', 'fixtures', 'consent-config', 'example.json');
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

interface Opts {
  config?: unknown;
  scriptAttrs?: string;
  siteLink?: boolean;
}

async function load(opts: Opts = {}): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const config = opts.config ?? baseConfig();
  await page.route('**/banner-page', (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Banner fixture</title>
<script type="application/json" id="complykit-config">${JSON.stringify(config)}</script>
<script src="/complykit-consent.js" ${opts.scriptAttrs ?? ''}></script></head>
<body><main><h1>Shop</h1><p><a href="#a" id="page-first">First page link</a> <a href="#b">Second</a></p></main>
<footer>${opts.siteLink ? '<a href="#" id="site-link" data-complykit-open>Cookie settings</a>' : ''}</footer></body></html>`,
    }),
  );
  await page.route('**/consent-record', (route) => route.fulfill({ status: 204 }));
  await page.goto(`${server.origin}/banner-page`);
  await page.waitForSelector('#complykit-ui', { state: 'attached' });
  return page;
}

/** What has focus: an action hook, a category, a page id, or the element's tag. */
const focused = (p: Page) =>
  p.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    if (!a || a === document.body) return 'body';
    return a.getAttribute('data-ck-action') ?? (a.getAttribute('data-ck-category') ? `cat:${a.getAttribute('data-ck-category')}` : null) ?? (a.id ? `#${a.id}` : a.tagName.toLowerCase());
  });

/** Press Tab until `want` has focus (at most `max` presses); returns the stops visited. */
async function tabTo(p: Page, want: string, max = 12): Promise<string[]> {
  const seen: string[] = [];
  for (let i = 0; i < max; i++) {
    await p.keyboard.press(TAB);
    const f = await focused(p);
    seen.push(f);
    if (f === want) return seen;
  }
  throw new Error(`never reached ${want}; visited ${seen.join(' → ')}`);
}

const state = (p: Page) => p.evaluate(() => (window as any).ComplyKit.get());
const bannerVisible = (p: Page) => p.evaluate(() => {
  const b = document.querySelector('.ck-banner') as HTMLElement;
  return b instanceof HTMLDialogElement ? b.open : !b.hidden;
});
const settingsOpen = (p: Page) => p.evaluate(() => (document.querySelector('.ck-settings') as HTMLDialogElement).open);

describe('banner (bar layout): markup', () => {
  it('is a labelled, described region, first in <body>, with reject and accept of equal weight', async () => {
    const page = await load();
    const m = await page.evaluate(() => {
      const root = document.body.firstElementChild!;
      const b = document.querySelector('.ck-banner')!;
      const btns = Array.from(b.querySelectorAll('button'));
      const r = b.querySelector('[data-ck-action=reject]')!;
      const a = b.querySelector('[data-ck-action=accept]')!;
      return {
        rootId: root.id,
        role: b.getAttribute('role'),
        label: document.getElementById(b.getAttribute('aria-labelledby')!)?.textContent,
        desc: !!document.getElementById(b.getAttribute('aria-describedby')!)?.textContent,
        tags: btns.map((x) => `${x.tagName}:${x.type}:${x.className}`),
        adjacent: r.nextElementSibling === a,
        actions: btns.map((x) => x.getAttribute('data-ck-action')),
        choicesHidden: (document.querySelector('.ck-choices') as HTMLElement).hidden,
        settingsOpen: (document.querySelector('.ck-settings') as HTMLDialogElement).open,
      };
    });
    expect(m.rootId).toBe('complykit-ui');
    expect(m.role).toBe('region');
    expect(m.label).toBe('Your privacy choices'); // config.strings override
    expect(m.desc).toBe(true);
    expect(m.actions).toEqual(['reject', 'accept', 'manage']);
    expect(new Set(m.tags).size).toBe(1); // same element, type and class
    expect(m.adjacent).toBe(true);
    expect(m.choicesHidden).toBe(true);
    expect(m.settingsOpen).toBe(false);
    // Non-modal: focus was not moved.
    expect(await focused(page)).toBe('body');
    await page.context().close();
  });

  it('does not trap focus: Tab moves past the banner into the page', async () => {
    const page = await load();
    const stops = await tabTo(page, '#page-first');
    // F2: the privacy-policy link (config.privacyPolicyUrl) follows the actions.
    expect(stops).toEqual(['reject', 'accept', 'manage', 'privacy-policy', '#page-first']);
    await page.context().close();
  });

  it('a refused config renders nothing', async () => {
    const page = await (async () => {
      const ctx = await browser.newContext();
      const p = await ctx.newPage();
      await p.route('**/banner-page', (r) =>
        r.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><title>x</title><script type="application/json" id="complykit-config">${JSON.stringify(baseConfig({ version: '9.0' }))}</script><script src="/complykit-consent.js"></script></head><body><main>x</main></body></html>` }),
      );
      await p.goto(`${server.origin}/banner-page`);
      return p;
    })();
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => document.getElementById('complykit-ui'))).toBeNull();
    await page.context().close();
  });
});

describe('two-file split: the core loads the UI file', () => {
  it('from the same folder as the core, and records it in diagnostics', async () => {
    const page = await load();
    expect(await page.evaluate(() => (window as any).ComplyKit.diagnostics.ui)).toEqual({ url: `${server.origin}/complykit-consent-ui.js`, state: 'loaded' });
    await page.context().close();
  });

  it('fails closed when the UI file does not load: warning, diagnostics, defaults stand', async () => {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    const warnings: string[] = [];
    p.on('console', (m) => m.type() === 'warning' && warnings.push(m.text()));
    await p.route('**/complykit-consent-ui.js', (r) => r.abort());
    await p.route('**/banner-page', (r) =>
      r.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><title>x</title><script type="application/json" id="complykit-config">${JSON.stringify(baseConfig())}</script><script src="/complykit-consent.js"></script></head><body><main>x</main></body></html>` }),
    );
    await p.goto(`${server.origin}/banner-page`);
    await p.waitForFunction(() => (window as any).ComplyKit.diagnostics.ui?.state === 'failed');
    expect(warnings.some((w) => w.includes('banner not loaded'))).toBe(true);
    expect(await state(p)).toMatchObject({ status: 'unset', categories: { necessary: true, analytics: false, advertising: false } });
    expect(await p.evaluate(() => document.getElementById('complykit-ui'))).toBeNull();
    await ctx.close();
  });

  it('data-complykit-ui overrides the URL', async () => {
    const page = await load({ scriptAttrs: 'data-complykit-ui="/complykit-consent-ui.js?v=2"' });
    expect(await page.evaluate(() => (window as any).ComplyKit.diagnostics.ui.url)).toBe(`${server.origin}/complykit-consent-ui.js?v=2`);
    await page.context().close();
  });
});

describe('keyboard-only runs', () => {
  it('accept: Tab, Tab, Enter → all granted, banner gone, focus on Privacy choices', async () => {
    const page = await load();
    await tabTo(page, 'accept');
    await page.keyboard.press('Enter');
    expect(await state(page)).toMatchObject({ status: 'chosen', categories: { necessary: true, analytics: true, advertising: true } });
    expect(await bannerVisible(page)).toBe(false);
    expect(await focused(page)).toBe('privacy-choices');
    expect(await page.locator('.ck-choices').textContent()).toBe('Privacy choices');
    await page.context().close();
  });

  it('reject: Tab, Enter → only necessary, banner gone; the choice survives a reload', async () => {
    const page = await load();
    await tabTo(page, 'reject');
    await page.keyboard.press('Enter');
    expect(await state(page)).toMatchObject({ status: 'chosen', categories: { necessary: true, analytics: false, advertising: false } });
    expect(await bannerVisible(page)).toBe(false);
    expect(await focused(page)).toBe('privacy-choices');
    await page.reload();
    await page.waitForSelector('#complykit-ui', { state: 'attached' });
    expect(await bannerVisible(page)).toBe(false);
    expect(await page.locator('.ck-choices').isVisible()).toBe(true);
    await page.context().close();
  });

  it('settings: Manage → modal layer, toggles with Space, Save → exactly that choice', async () => {
    const page = await load();
    await tabTo(page, 'manage');
    await page.keyboard.press('Enter');
    expect(await settingsOpen(page)).toBe(true);
    const layer = await page.evaluate(() => {
      const d = document.querySelector('.ck-settings')!;
      const rows = Array.from(d.querySelectorAll('.ck-category')).map((r) => {
        const box = r.querySelector('input')!;
        return {
          id: r.getAttribute('data-ck-category'),
          checked: box.checked,
          disabled: box.disabled,
          label: (r.querySelector('label') as HTMLLabelElement).control === box ? r.querySelector('label')!.textContent : null,
          vendors: Array.from(r.querySelectorAll('.ck-vendor')).map((v) => v.textContent),
        };
      });
      return { focusInside: d.contains(document.activeElement), label: document.getElementById(d.getAttribute('aria-labelledby')!)?.textContent, rows };
    });
    expect(layer.focusInside).toBe(true);
    expect(layer.label).toBe('Privacy settings');
    expect(layer.rows).toEqual([
      { id: 'necessary', checked: true, disabled: true, label: 'Necessary', vendors: [] },
      { id: 'analytics', checked: false, disabled: false, label: 'Analytics', vendors: ['Google Analytics 4', 'Example widget'] },
      { id: 'advertising', checked: false, disabled: false, label: 'Advertising', vendors: ['Meta Pixel', 'Example pixel (noscript img)'] },
    ]);
    // The locked necessary box is not a tab stop; analytics is the first.
    await tabTo(page, 'cat:analytics', 1);
    await page.keyboard.press('Space');
    const stops = await tabTo(page, 'save');
    expect(stops).toEqual(['cat:advertising', 'reject', 'accept', 'save']);
    await page.keyboard.press('Enter');
    expect(await state(page)).toMatchObject({ status: 'chosen', categories: { necessary: true, analytics: true, advertising: false } });
    expect(await settingsOpen(page)).toBe(false);
    expect(await bannerVisible(page)).toBe(false);
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-ck-action') === 'privacy-choices');
    await page.context().close();
  });

  it('settings traps focus while open (Tab and Shift+Tab stay inside)', async () => {
    const page = await load();
    await tabTo(page, 'manage');
    await page.keyboard.press('Enter');
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press(i % 3 === 2 ? SHIFT_TAB : TAB);
      const inside = await page.evaluate(() => document.querySelector('.ck-settings')!.contains(document.activeElement));
      // Chromium may park focus on the browser UI for one stop at the end of the
      // cycle; it must never land on page content behind the dialog.
      const f = await focused(page);
      expect(inside || f === 'body').toBe(true);
    }
    await page.context().close();
  });

  it('Escape closes the settings layer without a choice; focus returns to Manage', async () => {
    const page = await load();
    await tabTo(page, 'manage');
    await page.keyboard.press('Enter');
    await tabTo(page, 'cat:analytics', 2);
    await page.keyboard.press('Space');
    await page.keyboard.press('Escape');
    expect(await settingsOpen(page)).toBe(false);
    expect(await state(page)).toMatchObject({ status: 'unset', categories: { analytics: false } });
    expect(await bannerVisible(page)).toBe(true);
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-ck-action') === 'manage');
    expect(await page.evaluate(() => document.cookie)).not.toContain('complykit_consent');
    await page.context().close();
  });

  it('withdraw: accept, then Privacy choices → Reject all withdraws (event, state, announcement)', async () => {
    // F3 reloads after a withdrawal by default; keep this page to inspect it.
    const page = await load({ scriptAttrs: 'data-complykit-reload="none"' });
    await page.evaluate(() => {
      (window as any).__withdrawn = 0;
      (window as any).ComplyKit.on('withdraw', () => (window as any).__withdrawn++);
    });
    await tabTo(page, 'accept');
    await page.keyboard.press('Enter');
    expect(await focused(page)).toBe('privacy-choices');
    await page.keyboard.press('Enter');
    expect(await settingsOpen(page)).toBe(true);
    // The layer shows what was granted.
    expect(await page.evaluate(() => Array.from(document.querySelectorAll<HTMLInputElement>('.ck-settings input')).map((i) => i.checked))).toEqual([true, true, true]);
    await tabTo(page, 'reject');
    await page.keyboard.press('Enter');
    expect(await state(page)).toMatchObject({ status: 'chosen', categories: { necessary: true, analytics: false, advertising: false } });
    expect(await page.evaluate(() => (window as any).__withdrawn)).toBe(1);
    expect(await page.locator('#complykit-ui [role=status]').textContent()).toBe('Your consent has been withdrawn.');
    expect(await bannerVisible(page)).toBe(false);
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-ck-action') === 'privacy-choices');
    await page.context().close();
  });
});

describe('withdraw with the default reload', () => {
  it('the page reloads into the withdrawn state: no banner, Privacy choices present', async () => {
    const page = await load();
    await tabTo(page, 'accept');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter'); // Privacy choices (focused after the choice)
    await tabTo(page, 'reject');
    await Promise.all([page.waitForEvent('load'), page.keyboard.press('Enter')]);
    await page.waitForSelector('#complykit-ui', { state: 'attached' });
    expect(await state(page)).toMatchObject({ status: 'chosen', categories: { analytics: false, advertising: false } });
    expect(await bannerVisible(page)).toBe(false);
    expect(await page.locator('.ck-choices').isVisible()).toBe(true);
    await page.context().close();
  });
});

describe('modal layout', () => {
  it('moves focus into the dialog, keeps it there, ignores Escape, and completes by keyboard', async () => {
    const page = await load({ config: baseConfig({ layout: 'modal' }) });
    const m = await page.evaluate(() => {
      const d = document.querySelector('.ck-banner') as HTMLDialogElement;
      return { tag: d.tagName, open: d.open, focusIn: d === document.activeElement || d.contains(document.activeElement) };
    });
    expect(m).toEqual({ tag: 'DIALOG', open: true, focusIn: true });
    // Escape twice (Chromium lets the second through without user activation): still shown.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(50);
    expect(await bannerVisible(page)).toBe(true);
    const stops: string[] = [];
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press(TAB);
      stops.push(await focused(page));
    }
    expect(stops).not.toContain('#page-first');
    await tabTo(page, 'reject');
    await page.keyboard.press('Enter');
    expect(await state(page)).toMatchObject({ status: 'chosen', categories: { analytics: false, advertising: false } });
    expect(await bannerVisible(page)).toBe(false);
    expect(await focused(page)).toBe('privacy-choices');
    await page.context().close();
  });
});

describe('site-rendered link and placement', () => {
  it('a [data-complykit-open] link opens the settings layer; the floating control is then not rendered', async () => {
    const page = await load({ siteLink: true });
    await tabTo(page, 'reject');
    await page.keyboard.press('Enter');
    expect(await page.locator('.ck-choices').isVisible()).toBe(false);
    await tabTo(page, '#site-link');
    await page.keyboard.press('Enter');
    expect(await settingsOpen(page)).toBe(true);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.id === 'site-link');
    expect(new URL(page.url()).hash).toBe('');
    await page.context().close();
  });

  it('data-complykit-choices sets the position hook; ComplyKit.open() opens the layer', async () => {
    const page = await load({ scriptAttrs: 'data-complykit-choices="bottom-right"' });
    expect(await page.locator('.ck-choices').getAttribute('data-ck-position')).toBe('bottom-right');
    await page.evaluate(() => (window as any).ComplyKit.open());
    expect(await settingsOpen(page)).toBe(true);
    await page.context().close();
  });
});
