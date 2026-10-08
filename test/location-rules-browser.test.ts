import fs from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Browser } from 'playwright';
import { renderConsentHtml } from '../src/report/consent-html.js';
import { buildConsentReportModel } from '../src/report/consent-model.js';
import { TrackingEvaluation } from '../src/record/index.js';

// PR C contract, browser half: the rules disclosure opens on hover, on click
// (pinned) and on keyboard focus; Escape closes it; a narrow screen does not
// scroll sideways; print shows every popover. Same optional-browser convention
// as test/report-browser.test.ts (COMPLYKIT_BROWSER_CHANNEL=chrome runs it
// without the Playwright Chromium build).

let available = false;
try {
  const { chromium } = await import('playwright');
  available = fs.existsSync(chromium.executablePath());
} catch { /* optional */ }
const channelFallback = available ? {} : { channel: process.env.COMPLYKIT_BROWSER_CHANNEL };
const suite = available || process.env.COMPLYKIT_BROWSER_CHANNEL ? describe : describe.skip;

const evaluation = TrackingEvaluation.parse({
  runId: 'r-loc-b', property: 'shop', site: { url: 'https://shop.example/', host: 'shop.example', registrableDomain: 'shop.example' },
  versions: { kb: '0', registry: '0', package: '0' }, startedAt: '2026-10-08T10:00:00Z', finishedAt: '2026-10-08T10:20:00Z',
  locations: [
    { spec: { id: 'de', label: 'Germany', country: 'DE', proxied: true }, verification: { verdict: 'verified', expected: { country: 'DE' }, observed: { country: 'DE' }, sources: [], jurisdictions: ['eu', 'eu-de'], checkedAt: 'x' }, scenarios: [{ scenario: 'do-nothing', status: 'tested' }] },
    { spec: { id: 'us-tx', label: 'Texas, US', country: 'US', region: 'TX', proxied: true }, verification: { verdict: 'verified', expected: { country: 'US', region: 'TX' }, observed: { country: 'US', region: 'TX' }, sources: [], jurisdictions: ['us', 'us-tx'], checkedAt: 'x' }, scenarios: [{ scenario: 'do-nothing', status: 'tested' }] },
  ],
  inventory: [], notTested: [], researchQueue: [], redacted: true,
});
const html = renderConsentHtml(buildConsentReportModel(evaluation, []));

suite('location rules disclosure in a browser', () => {
  let browser: Browser;
  beforeAll(async () => { const { chromium } = await import('playwright'); browser = await chromium.launch({ headless: true, ...channelFallback }); });
  afterAll(async () => { await browser?.close(); });

  it('is hidden until hovered, pins on click, closes on Escape and outside click', async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setContent(html);
    const btn = page.locator('[data-location="de"] .ck-rules-btn');
    const pop = page.locator('#rules-pop-de');
    expect(await pop.isVisible()).toBe(false);
    await btn.hover();
    expect(await pop.isVisible()).toBe(true);
    await page.mouse.move(5, 5);
    expect(await pop.isVisible()).toBe(false);
    await btn.click();
    expect(await pop.isVisible()).toBe(true);
    expect(await btn.getAttribute('aria-expanded')).toBe('true');
    expect(await pop.getAttribute('data-open')).toBe('true');
    await page.mouse.move(5, 5);
    expect(await pop.isVisible()).toBe(true); // pinned
    await page.keyboard.press('Escape');
    expect(await pop.isVisible()).toBe(false);
    expect(await btn.getAttribute('aria-expanded')).toBe('false');
    await btn.click();
    await page.mouse.click(5, 5);
    expect(await pop.isVisible()).toBe(false);
    expect(errors).toEqual([]);
  });

  it('opens on keyboard focus and its links are reachable', async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await page.setContent(html);
    await page.locator('[data-location="us-tx"] .ck-rules-btn').focus();
    const pop = page.locator('#rules-pop-us-tx');
    expect(await pop.isVisible()).toBe(true);
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => document.activeElement?.closest('#rules-pop-us-tx') !== null);
    expect(focused).toBe(true);
    expect(await pop.isVisible()).toBe(true);
  });

  it('stays open while the mouse crosses from the button into the popover (its links are reachable by mouse)', async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await page.setContent(html);
    const btnLoc = page.locator('[data-location="de"] .ck-rules-btn');
    await btnLoc.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, 200));
    const b = (await btnLoc.boundingBox())!;
    const x = b.x + 20;
    for (let y = b.y + b.height / 2; y < b.y + b.height + 30; y += 2) {
      await page.mouse.move(x, y);
      expect(await page.locator('#rules-pop-de').isVisible(), `y=${y}`).toBe(true);
    }
  });

  it('fits a phone and prints expanded', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(html);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('[data-location="de"] .ck-rules-btn').click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.emulateMedia({ media: 'print' });
    expect(await page.locator('#rules-pop-us-tx').isVisible()).toBe(true);
  });
});
