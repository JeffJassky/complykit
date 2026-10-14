import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import type { Browser } from 'playwright';
import { partialConsent } from '../src/collect/browser/evaluation/banner.js';

// Field run storyfolder.com, 2026-10-08: the "analytics only" visit could not run against
// vanilla-cookieconsent v3. Its category toggles are input.section__toggle with the category key as
// value and the title in a sibling button, so the generic label match found nothing. And the
// banner's own "Cookie settings" button (data-cc="show-preferencesModal" in the banner footer) did
// nothing: the library wires data-cc buttons only where they exist when it starts. A visitor could
// not choose per category, and the scan must say that, not "no recognizable control".

let chromiumAvailable = false;
try {
  const { chromium } = await import('playwright');
  chromiumAvailable = fs.existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}
const channel = process.env.COMPLYKIT_BROWSER_CHANNEL;
const suite = chromiumAvailable || channel ? describe : describe.skip;

const section = (id: string, title: string, locked = false) =>
  `<div class="pm__section--toggle pm__section"><div class="pm__section-title-wrapper"><button type="button" class="pm__section-title">${title}</button>` +
  `<label class="section__toggle-wrapper"><input type="checkbox" class="section__toggle" value="${id}"${locked ? ' checked disabled' : ''}><span class="toggle__icon"></span></label></div></div>`;

// The v3 markup, reduced: first-layer banner, preferences modal, show--* classes on <html>.
const CC = (wired: boolean) => `<div id="cc-main">
  <div class="cm"><p>We value your privacy</p><button type="button" class="cm__btn" data-role="all">Got it</button><button type="button" class="cm__btn" data-role="necessary">Decline optional</button>
    <div class="cm__footer"><button type="button" class="cc-settings-link" data-cc="show-preferencesModal">Cookie settings</button></div></div>
  <div class="pm" style="display:none">${section('necessary', 'Strictly necessary', true)}${section('functional', 'Functional — live chat')}${section('analytics', 'Analytics')}${section('advertising', 'Advertising')}
    <button type="button" class="pm__btn" data-role="all">Accept all</button><button type="button" class="pm__btn" data-role="necessary">Reject all</button><button type="button" class="pm__btn" data-role="save">Save preferences</button></div></div>
  <script>
    document.documentElement.classList.add('show--consent');
    var pm = document.querySelector('.pm');
    ${wired ? `document.querySelector('[data-cc="show-preferencesModal"]').addEventListener('click', function(){ pm.style.display = ''; document.documentElement.classList.add('show--preferences'); });` : ''}
    document.querySelector('.pm [data-role="save"]').addEventListener('click', function(){
      window.__saved = Array.from(document.querySelectorAll('.section__toggle')).filter(function(t){ return t.checked; }).map(function(t){ return t.value; });
    });
  </script>`;

const pages: Record<string, string> = {
  '/wired': `<!doctype html><title>StoryFolder</title><main><h1>Storyboards</h1></main>${CC(true)}`,
  '/dead-settings': `<!doctype html><title>StoryFolder</title><main><h1>Storyboards</h1></main>${CC(false)}`,
};

suite('analytics-only visit: vanilla-cookieconsent v3', () => {
  let browser: Browser;
  beforeAll(async () => {
    const { chromium } = await import('playwright');
    browser = await chromium.launch(chromiumAvailable ? {} : { channel });
  });
  afterAll(async () => browser?.close());

  async function run(path: string) {
    const context = await browser.newContext();
    await context.route('http://cc.test/**', (route) => route.fulfill({ contentType: 'text/html', body: pages[new URL(route.request().url()).pathname] ?? '<!doctype html><p>ok</p>' }));
    const page = await context.newPage();
    await page.goto(`http://cc.test${path}`);
    const result = await partialConsent(page);
    const saved = (await page.evaluate(() => (window as unknown as { __saved?: string[] }).__saved)) ?? null;
    await context.close();
    return { result, saved };
  }

  it('opens the settings through the banner, switches on analytics alone, and saves', async () => {
    const { result, saved } = await run('/wired');
    expect(result).toMatchObject({ ok: true, method: 'cookieconsent3:analytics' });
    expect(saved).toEqual(['necessary', 'analytics']);
  });

  it('a settings button that opens nothing is reported as the reason — a visitor cannot choose per category either', async () => {
    const { result, saved } = await run('/dead-settings');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/“Cookie settings” control did not open the cookie settings/);
    expect(saved).toBeNull();
  });
});
