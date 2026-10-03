import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import type { Browser, Page } from 'playwright';
import { findBanner, readoutConfirms, consentModeMismatch } from '../src/collect/browser/evaluation/banner.js';

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

  it('an off-screen or hidden banner does not count', async () => {
    await page.setContent('<div style="display:none">We use cookies <button>Accept</button></div>');
    expect(await findBanner(page)).toBeNull();
  });
});
