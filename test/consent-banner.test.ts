import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import type { Browser, Page } from 'playwright';
import { findBanner, readoutConfirms, consentModeMismatch, findConfirmation, detectBlock } from '../src/collect/browser/evaluation/banner.js';

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
    expect(readoutConfirms('reject', { tcfData: { eventStatus: 'useractioncomplete', purpose1: false } })).toBe(true);
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

  it('an off-screen or hidden banner does not count', async () => {
    await page.setContent('<div style="display:none">We use cookies <button>Accept</button></div>');
    expect(await findBanner(page)).toBeNull();
  });
});
