import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import type { Browser, Page } from 'playwright';
import { findBanner, readoutConfirms, consentModeMismatch, findConfirmation, detectBlock, walkOptOutLink } from '../src/collect/browser/evaluation/banner.js';

// Regressions from the 2026-10-03 field run: a storefront with no banner was
// read as "banner showing" because a stray OK button matched, and a Shopify
// accept was failed because Google Consent Mode (wired separately) disagreed.

describe('consent readout confirmation', () => {
  const shopify = (marketing: string) => ({ shopify: { currentVisitorConsent: { marketing } } });
  it('the consent tool record decides; Google is a fallback and a reported mismatch', () => {
    expect(readoutConfirms('accept', { ...shopify('yes'), googleConsent: { ad_storage: { update: 'denied' } } })).toBe(true);
    expect(consentModeMismatch('accept', { googleConsent: { ad_storage: { update: 'denied' } } })).toMatch(/disagree/);
    expect(readoutConfirms('reject', shopify(''))).toBe(false); // no choice stored yet
    expect(readoutConfirms('reject', shopify('no'))).toBe(true);
    expect(readoutConfirms('accept', { googleConsent: { ad_storage: { update: 'granted' } } })).toBe(true);
    expect(readoutConfirms('accept', {})).toBeUndefined();
    expect(readoutConfirms('reject', { cookieyes: { isUserActionCompleted: true, categories: { advertisement: false } } })).toBe(true);
    expect(readoutConfirms('reject', { cookieyes: { isUserActionCompleted: false, categories: { advertisement: false } } })).toBe(false);
    // OneTrust with site-specific group ids (benchmark: accept was failed on a fixed C0004 check).
    expect(readoutConfirms('accept', { oneTrustActiveGroups: ',C0001,C0002,C0003,', oneTrustClosed: true })).toBe(true);
    expect(readoutConfirms('reject', { oneTrustActiveGroups: ',C0001,', oneTrustClosed: true })).toBe(true);
    expect(readoutConfirms('reject', { oneTrustActiveGroups: ',C0001,', oneTrustClosed: false })).toBe(false); // no choice stored yet
    expect(readoutConfirms('reject', { trustarc: { preferences: '0:' } })).toBe(true);
    expect(readoutConfirms('accept', { osano: { MARKETING: 'ACCEPT', ANALYTICS: 'ACCEPT' } })).toBe(true);
    expect(readoutConfirms('reject', { osano: { MARKETING: 'ACCEPT', OPT_OUT: 'ACCEPT' } })).toBe(true); // US opt-out mode
    expect(readoutConfirms('reject', { tcfData: { eventStatus: 'useractioncomplete', purpose1: false } })).toBe(true);
  });

  it('cookieconsent v3 bundled with no window global: its cc_cookie decides (storyfolder.com, 2026-10-08)', () => {
    const cc = (categories: string[]) => ({ cookieconsentCookie: { categories, revision: 1 } });
    expect(readoutConfirms('accept', cc(['necessary', 'functional', 'analytics', 'advertising']))).toBe(true);
    expect(readoutConfirms('reject', cc(['necessary']))).toBe(true);
    expect(readoutConfirms('accept', cc(['necessary']))).toBe(false);
    expect(readoutConfirms('reject', cc(['necessary', 'analytics']))).toBe(false);
    // The API reports opt-out defaults as accepted before a choice; the stored cookie wins.
    expect(readoutConfirms('reject', { ...cc(['necessary']), cookieconsent: { acceptedCategories: ['necessary', 'analytics', 'advertising'] } })).toBe(true);
    expect(readoutConfirms('accept', { cookieconsent: { acceptedCategories: ['necessary', 'analytics'] } })).toBe(true);
  });
});

let chromiumAvailable = false;
try {
  const { chromium } = await import('playwright');
  chromiumAvailable = fs.existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}
const suite = chromiumAvailable ? describe : describe.skip;

suite('strict banner detection', () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
    page = await browser.newPage();
  });
  afterAll(async () => browser?.close());

  it('an OK button outside any consent context is not a banner', async () => {
    await page.setContent('<main><h1>Shop</h1><div class="modal">Sign up for our newsletter <button>OK</button><button>Accept</button></div></main>');
    expect(await findBanner(page)).toBeNull();
  });

  it('a consent-worded container with choices is, and its controls are tagged', async () => {
    await page.setContent('<div style="position:fixed;bottom:0">We use cookies and similar technologies. <button>Manage preferences</button><button>Accept</button><button>Decline</button></div>');
    const b = await findBanner(page);
    expect(b?.via).toBe('heuristic');
    expect(b?.accept && b.reject && b.manage).toBeTruthy();
    expect(b?.close).toBeUndefined();
  });

  it('reads opt-out confirmations in the wordings sites actually use', async () => {
    for (const text of ['GPC request honored.', 'The GPC signal is honored', 'Opt-Out Request Honored']) {
      await page.setContent(`<p>${text}</p>`);
      expect(await findConfirmation(page), text).toBeTruthy();
    }
    await page.setContent('<p>We honor your privacy.</p>');
    expect(await findConfirmation(page)).toBeUndefined();
  });

  it('recognizes a bot-protection page but not a real page that mentions blocking', async () => {
    await page.setContent('<title>Access Denied</title><h1>Access Denied</h1><p>You don\'t have permission to access this server.</p>');
    expect(await detectBlock(page)).toMatch(/challenge/);
    await page.setContent(`<title>Shop</title><nav>${Array.from({ length: 30 }, (_, i) => `<a href="/p${i}">p${i}</a>`).join('')}</nav><p>Blocked drains? We sell plungers.</p>`);
    expect(await detectBlock(page)).toBeUndefined();
  });

  it('finds a banner rendered inside an open shadow root (Usercentrics, Termly)', async () => {
    await page.setContent('<div id="host"></div>');
    await page.evaluate(() => {
      const root = document.getElementById('host')!.attachShadow({ mode: 'open' });
      root.innerHTML = '<div style="position:fixed;bottom:0;left:0;right:0">We use cookies to improve your experience. <button>Accept all</button><button>Deny</button></div>';
    });
    const b = await findBanner(page);
    expect(b?.accept && b.reject).toBeTruthy();
  });

  it('an off-screen or hidden banner does not count', async () => {
    await page.setContent('<div style="display:none">We use cookies <button>Accept</button></div>');
    expect(await findBanner(page)).toBeNull();
  });
});

// Field run 2026-10-07: a Shopify opt-out page reported the footer newsletter
// form (contact[email]) and the login form (customer[email]) as the opt-out's
// required fields, and so never performed it. Only the control's own form (or
// section) counts. Runs on an installed browser via COMPLYKIT_BROWSER_CHANNEL
// when the Playwright Chromium build is absent.
const walkChannel = process.env.COMPLYKIT_BROWSER_CHANNEL;
const walkSuite = chromiumAvailable || walkChannel ? describe : describe.skip;
walkSuite('opt-out link walk: required fields belong to the opt-out control', () => {
  let browser: Browser;
  const CHROME = `<header><form action="/account/login" method="post"><input type="email" name="customer[email]" required><input type="password" name="customer[password]" required><button type="submit">Sign in</button></form></header>`;
  const FOOTER = `<footer><form action="/contact" method="post"><input type="email" name="contact[email]" required><button type="submit" aria-label="Subscribe">→</button></form><a href="/pages/data-sharing-opt-out">Your Privacy Choices</a></footer>`;
  const pages: Record<string, string> = {
    '/': `<!doctype html><title>Shop</title>${CHROME}<main><h1>Shop</h1></main>${FOOTER}`,
    '/pages/data-sharing-opt-out': `<!doctype html><title>Opt out</title>${CHROME}<main><section><h1>Data sharing opt-out</h1>
      <label><input type="checkbox" role="switch" aria-label="Opt out of data sharing" onchange="document.getElementById('s').textContent='Your preferences have been saved.'"> Opt out of data sharing</label>
      <p id="s"></p></section></main>${FOOTER}`,
    '/email-form': `<!doctype html><title>Shop</title>${CHROME}<main><h1>Shop</h1></main><footer><a href="/pages/request">Do Not Sell or Share My Personal Information</a></footer>`,
    // georgesmusic.com: a newsletter SECTION (not the footer) with a required email,
    // and Shopify's "Opt out" button drawn by script after load, in its own form.
    '/late': `<!doctype html><title>Shop</title><main><h1>Shop</h1></main><footer><a href="/pages/late-opt-out">Your Privacy Choices</a></footer>`,
    '/pages/late-opt-out': `<!doctype html><title>Your Privacy Choices</title><main><h1>Your Privacy Choices</h1><div id="slot"></div></main>
      <section class="newsletter"><form id="NewsletterForm" action="/contact" method="post"><input type="email" name="contact[email]" required><button type="submit">Subscribe</button></form></section>
      <script>setTimeout(function(){document.getElementById('slot').innerHTML='<form action="/dns_opt_out" method="post" onsubmit="event.preventDefault();document.getElementById(\\'slot\\').insertAdjacentHTML(\\'beforeend\\',\\'<p>You have opted out.</p>\\')"><button type="submit" name="pc--commit">Opt out</button></form>';},2500)</script>`,
    '/nocontrol': `<!doctype html><title>Shop</title><main><h1>Shop</h1></main><footer><a href="/pages/info-only">Your Privacy Choices</a></footer>`,
    '/pages/info-only': `<!doctype html><title>Privacy</title><main><h1>Privacy</h1><p>Email us to opt out.</p></main>
      <section><form action="/contact" method="post"><input type="email" name="contact[email]" required><button type="submit">Join</button></form></section>`,
    '/pages/request': `<!doctype html><title>Request</title><main><form action="/submit-request" method="post"><label>Email <input type="email" name="email" required></label><button type="submit">Submit request</button></form></main>`,
  };
  const posted: string[] = [];
  async function open() {
    const context = await browser.newContext();
    await context.route('http://shop.test/**', (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() === 'POST') posted.push(url.pathname);
      return route.fulfill({ contentType: 'text/html', body: pages[url.pathname] ?? '<!doctype html><p>ok</p>' });
    });
    return { context, page: await context.newPage() };
  }
  beforeAll(async () => {
    const { chromium } = await import('playwright');
    browser = await chromium.launch(chromiumAvailable ? {} : { channel: walkChannel });
  });
  afterAll(async () => browser?.close());

  it('a toggle opt-out is performed despite the footer newsletter and header login forms', async () => {
    const { context, page } = await open();
    await page.goto('http://shop.test/');
    const walk = await walkOptOutLink(page, true);
    expect(walk.found).toBe(true);
    expect(walk.linkText).toBe('Your Privacy Choices');
    expect(walk.requiredFields).toEqual([]);
    expect(walk.performed).toBe(true);
    expect(walk.confirmation).toMatch(/preferences have been saved/);
    expect(posted).toEqual([]);
    await context.close();
  });

  it('waits for an opt-out button drawn after load, and ignores a newsletter section on the page', async () => {
    const { context, page } = await open();
    await page.goto('http://shop.test/late');
    const walk = await walkOptOutLink(page, true);
    expect(walk.requiredFields).toEqual([]);
    expect(walk.performed).toBe(true);
    expect(walk.confirmation).toMatch(/opted out/);
    await context.close();
  });

  it('a page with no opt-out control reports no fields (a newsletter email is not the opt-out)', async () => {
    const { context, page } = await open();
    await page.goto('http://shop.test/nocontrol');
    const walk = await walkOptOutLink(page, true);
    expect(walk.found).toBe(true);
    expect(walk.requiredFields).toEqual([]);
    expect(walk.performed).toBe(false);
    await context.close();
  });

  it('an opt-out form that itself requires an email is not submitted, and the field is reported', async () => {
    const { context, page } = await open();
    await page.goto('http://shop.test/email-form');
    const walk = await walkOptOutLink(page, true);
    expect(walk.found).toBe(true);
    expect(walk.requiredFields).toEqual(['email']);
    expect(walk.performed).toBe(false);
    expect(posted).toEqual([]);
    await context.close();
  });
});
