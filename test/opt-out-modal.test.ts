import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import type { Browser } from 'playwright';
import { walkOptOutLink } from '../src/collect/browser/evaluation/banner.js';

// Field run storyfolder.com, 2026-10-08: the footer "Do Not Sell or Share My
// Personal Information" link opens a preferences modal (vanilla-cookieconsent)
// whose Analytics and Advertising toggles start ON under US implied consent,
// with "Accept all", "Reject all" and "Save preferences". The walk clicked
// "Save preferences" — the first control its wording matched — without
// switching anything off, saved "everything on", and the report blamed the
// site for tracking after the opt-out. A real visitor clicking Reject all is
// opted out. The walk must choose the refusal, or switch the optional toggles
// off before it saves.

let chromiumAvailable = false;
try {
  const { chromium } = await import('playwright');
  chromiumAvailable = fs.existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}
const channel = process.env.COMPLYKIT_BROWSER_CHANNEL;
const suite = chromiumAvailable || channel ? describe : describe.skip;

const toggle = (id: string, on: boolean, locked = false) =>
  `<label><input type="checkbox" class="section__toggle" value="${id}"${on ? ' checked' : ''}${locked ? ' disabled' : ''}> ${id}</label>`;

// The modal records what was saved in window.__saved, as the consent tool's cookie would.
const MODAL = (buttons: string) => `<div id="cc-main"><div class="pm" role="dialog" aria-modal="true" hidden>
  <h2>Manage cookie preferences</h2>
  <section><h3>Your privacy choices</h3><p>Analytics and advertising cookies are on. Switch them off here to opt out.</p></section>
  ${toggle('necessary', true, true)}${toggle('functional', false)}${toggle('analytics', true)}${toggle('advertising', true)}
  <footer class="pm__footer">${buttons}</footer></div></div>
  <script>
    var pm = document.querySelector('.pm');
    function save(cats){ window.__saved = cats; pm.hidden = true; }
    function checked(){ return Array.from(document.querySelectorAll('.section__toggle')).filter(function(t){return t.checked;}).map(function(t){return t.value;}); }
    document.querySelectorAll('[data-open]').forEach(function(a){ a.addEventListener('click', function(e){ e.preventDefault(); pm.hidden = false; }); });
    document.querySelectorAll('.pm [data-act]').forEach(function(b){ b.addEventListener('click', function(){
      var act = b.getAttribute('data-act');
      save(act === 'all' ? ['necessary','functional','analytics','advertising'] : act === 'none' ? ['necessary'] : checked());
    }); });
  </script>`;

const FOOTER = `<footer><ul><li><a href="#" data-open>Cookie Preferences</a></li><li><a href="#" data-open>Do Not Sell or Share My Personal Information</a></li></ul></footer>`;
const BUTTONS_FULL = `<button type="button" data-act="all">Accept all</button><button type="button" data-act="none">Reject all</button><button type="button" data-act="save">Save preferences</button>`;
const BUTTONS_SAVE_ONLY = `<button type="button" data-act="save">Save preferences</button>`;

// vanilla-cookieconsent keeps its first-layer banner in the DOM under implied consent, drawn but
// visibility:hidden — full size, so a bounding-box check calls it visible. Its "Decline optional"
// comes first in the DOM and is a refusal: the field run picked it, the click timed out unseen, and
// the walk still said performed.
const HIDDEN_BANNER = `<div class="cm-wrapper"><div class="cm" style="visibility:hidden"><p>We value your privacy</p>
  <button type="button" onclick="window.__saved=['necessary']">Decline optional</button><button type="button">Got it</button></div></div>`;
// A refusal that is on screen but whose click lands on an overlay: nothing is saved.
const COVERED = `<div style="position:fixed;inset:0;z-index:9" id="veil"></div>`;

const pages: Record<string, string> = {
  '/': `<!doctype html><title>StoryFolder</title><main><h1>Storyboards</h1></main>${FOOTER}${MODAL(BUTTONS_FULL)}`,
  '/hidden-banner': `<!doctype html><title>StoryFolder</title><main><h1>Storyboards</h1></main>${FOOTER}${HIDDEN_BANNER}${MODAL(BUTTONS_FULL)}`,
  '/covered': `<!doctype html><title>Shop</title><main><h1>Shop</h1></main>${FOOTER}${MODAL(BUTTONS_FULL)}<script>document.querySelectorAll('[data-open]').forEach(function(a){ a.addEventListener('click', function(){ document.body.insertAdjacentHTML('beforeend', '${COVERED}'); }); });</script>`,
  '/save-only': `<!doctype html><title>Shop</title><main><h1>Shop</h1></main>${FOOTER}${MODAL(BUTTONS_SAVE_ONLY)}`,
};

suite('opt-out link walk: a preferences modal with toggles that start on', () => {
  let browser: Browser;
  beforeAll(async () => {
    const { chromium } = await import('playwright');
    browser = await chromium.launch(chromiumAvailable ? {} : { channel });
  });
  afterAll(async () => browser?.close());

  async function walk(path: string) {
    const context = await browser.newContext();
    await context.route('http://modal.test/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: pages[new URL(route.request().url()).pathname] ?? '<!doctype html><p>ok</p>' }),
    );
    const page = await context.newPage();
    await page.goto(`http://modal.test${path}`);
    const result = await walkOptOutLink(page, true);
    const saved = (await page.evaluate(() => (window as unknown as { __saved?: string[] }).__saved)) ?? null;
    await context.close();
    return { result, saved };
  }

  it('clicks Reject all — never Save with everything still on', async () => {
    const { result, saved } = await walk('/');
    expect(result.found).toBe(true);
    expect(result.linkText).toBe('Do Not Sell or Share My Personal Information');
    expect(result.performed).toBe(true);
    expect(saved).toEqual(['necessary']);
  });

  it('with only a Save button, switches the optional toggles off first (the locked necessary one stays)', async () => {
    const { result, saved } = await walk('/save-only');
    expect(result.performed).toBe(true);
    expect(saved).toEqual(['necessary']);
  });

  it('never picks a control hidden by visibility (a consent tool’s undrawn first layer): clicks Reject all in the open modal', async () => {
    const { result, saved } = await walk('/hidden-banner');
    expect(result.performed).toBe(true);
    expect(saved).toEqual(['necessary']);
  });

  it('a click that does not land is not performed', async () => {
    const { result, saved } = await walk('/covered');
    expect(saved).toBeNull();
    expect(result.performed).toBe(false);
  });
});
