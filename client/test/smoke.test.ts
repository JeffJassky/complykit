import fs from 'node:fs';
import path from 'node:path';
import { type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DIST, launchBrowser, startFixtureServer, type FixtureServer } from './harness';

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

describe('fixture harness smoke', () => {
  it('loads the IIFE as global ComplyKit and leaves gated scripts unexecuted', async () => {
    const page = await browser.newPage();
    await page.goto(`${server.origin}/gated-scripts.html`);
    await page.addScriptTag({ url: `${server.origin}/complykit-consent.js` });

    expect(await page.evaluate(() => typeof (window as any).ComplyKit)).toBe('object');
    expect(await page.evaluate(() => (window as any).ComplyKit.version)).toBe('0.0.0');

    // Fixture sanity: fake vendor + fake GTM are present, gated scripts are not run.
    expect(await page.evaluate(() => typeof (window as any).FakeConsentVendor?.setConsent)).toBe('function');
    expect(await page.evaluate(() => Array.isArray((window as any).dataLayer))).toBe(true);
    expect(await page.evaluate(() => (window as any).__analyticsLoaded)).toBeUndefined();
    expect(await page.evaluate(() => (window as any).__gatedInlineRan)).toBeUndefined();
    expect(server.requests).not.toContain('/vendor/analytics.js');
    await page.close();
  });
});
