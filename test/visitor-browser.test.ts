import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { VISITOR_LAUNCH_ARGS, contextOptionsFor, visitorUserAgent } from '../src/collect/browser/evaluation/location.js';

let chromiumAvailable = false;
try {
  const { chromium } = await import('playwright');
  chromiumAvailable = fs.existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}
const suite = chromiumAvailable || process.env.COMPLYKIT_BROWSER_CHANNEL ? describe : describe.skip;

describe('visitor user agent', () => {
  it('is desktop Chrome of the same major version, never HeadlessChrome', () => {
    const ua = visitorUserAgent('131.0.6778.33');
    expect(ua).toContain('Chrome/131.0.0.0');
    expect(ua).not.toMatch(/Headless/);
    expect(contextOptionsFor({ id: 'local', label: 'This machine' }, '131.0.6778.33').userAgent).toBe(ua);
    expect(contextOptionsFor({ id: 'local', label: 'This machine' }).userAgent).toBeUndefined();
  });
});

// Consent tools that hide from bots (CookieConsent v3: hideFromBots, default on, checks
// navigator.webdriver and a bot-like user agent) must still show the scan their banner.
suite('the scan browser looks like a visitor', () => {
  it('navigator.webdriver is false and the user agent is not headless', async () => {
    const { chromium } = await import('playwright');
    const channel = process.env.COMPLYKIT_BROWSER_CHANNEL || undefined;
    const browser = await chromium.launch({ headless: true, args: VISITOR_LAUNCH_ARGS, ...(channel ? { channel } : {}) });
    try {
      const context = await browser.newContext(contextOptionsFor({ id: 'local', label: 'This machine' }, browser.version()));
      const page = await context.newPage();
      await page.setContent('<p>hi</p>');
      const seen = await page.evaluate(() => ({ webdriver: navigator.webdriver, ua: navigator.userAgent }));
      expect(seen.webdriver).toBe(false);
      expect(seen.ua).not.toMatch(/Headless|bot|crawl|spider/i);
    } finally {
      await browser.close();
    }
  });
});
