import fs from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Browser } from 'playwright';
import { renderHtmlReport } from '../src/report/html.js';
import { renderConsentHtml } from '../src/report/consent-html.js';
import { buildConsentReportModel } from '../src/report/consent-model.js';
import { asRunId, asRuleId, asRequirementId, fingerprint, TrackingEvaluation, type Finding, type Run } from '../src/record/index.js';

let available = false;
try {
  const { chromium } = await import('playwright');
  available = fs.existsSync(chromium.executablePath());
} catch { /* Same optional browser convention as the collector tests. */ }
const suite = available ? describe : describe.skip;

const run: Run = { schemaVersion: 1, id: asRunId('report-browser'), property: 'Example site', startedAt: '2026-10-05T10:00:00Z', versions: { package: '0', registry: '0', engines: {} }, accessLevels: ['public'], matrix: [], gaps: [], rulesExecuted: [] };
const subject = { property: 'Example site', routePattern: '/', locator: { role: 'text', name: '.hero > p:nth-child(2)', cssPath: '.hero > p:nth-child(2)', ordinal: 0 } };
const finding: Finding = { schemaVersion: 1, runId: run.id, ruleId: asRuleId('axe-core:color-contrast'), requirementId: asRequirementId('wcag22.1.4.3'), subject, confidence: 'violation', severity: 'serious', message: 'Contrast ratio is 2.8:1.', evidence: [{ kind: 'computed-style', properties: { ratio: '2.8', required: '4.5' } }], fingerprint: fingerprint({ detects: 'presence', ruleId: asRuleId('axe-core:color-contrast'), subject }), producer: { type: 'engine', name: 'axe-core', version: '4' } };

const evaluation = TrackingEvaluation.parse({ runId: 'r', property: 'Example site', site: { url: 'https://example.com/', host: 'example.com', registrableDomain: 'example.com' }, startedAt: '2026-10-05T10:00:00Z', finishedAt: '2026-10-05T10:01:00Z', versions: { kb: '0', registry: '0', package: '0' }, redacted: true,
  locations: [{ spec: { id: 'de', label: 'Germany', country: 'DE', proxied: false }, verification: { verdict: 'verified', expected: { country: 'DE' }, observed: { country: 'DE' }, sources: [], jurisdictions: ['eu'], checkedAt: 'now' }, scenarios: [{ scenario: 'reject', status: 'tested', choice: { kind: 'reject', ok: false, method: 'test' } }] }],
  inventory: [{ partyId: 'x', label: 'Example analytics', domain: 'analytics.example', hosts: ['analytics.example'], recognized: true, kbStatus: 'proposed', categories: ['analytics'], behavesLikeTracker: true, trackerSignals: [], sends: ['page-address'], stores: [{ name: '_visitor', kind: 'cookie', lifetimeDays: 30 }], sources: ['injected'], loadedBy: [], seenIn: [] }], notTested: [{ scope: 'frame', id: 'embedded-widget', reason: 'Storage in https://example.com/a/very/long/unbroken/frame-url?with=long_parameters_cannot_be_measured' }], researchQueue: [] });
const consentFinding: Finding = { ...finding, ruleId: asRuleId('tracking.prior-consent'), requirementId: asRequirementId('eprivacy.art5.3'), details: { party: { id: 'x', label: 'Example analytics', domain: 'analytics.example' }, occurrences: [{ location: 'de', scenario: 'reject', phases: ['before-choice'], firstMs: 20, requests: 1, sent: ['page-address'], stored: [], decoded: [], markers: [] }] } };

suite('human reports in a browser', () => {
  let browser: Browser;
  beforeAll(async () => { const { chromium } = await import('playwright'); browser = await chromium.launch({ headless: true }); });
  afterAll(async () => { await browser?.close(); });

  it('shows the work brief, hides technical details, and works on a narrow screen', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setContent(renderHtmlReport(run, [finding]));
    expect(errors).toEqual([]);
    expect(await page.locator('#groups .grp[open]').count()).toBe(1);
    expect(await page.locator('summary button').count()).toBe(0);
    expect(await page.locator('.work-brief').isVisible()).toBe(true);
    expect(await page.locator('.finding .fmeta').isVisible()).toBe(false);
    expect((await page.locator('.finding > p').allTextContents()).join(' ')).not.toContain('.hero > p:nth-child');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('.finding > .human-details > summary').click();
    expect(await page.locator('.finding .fmeta').isVisible()).toBe(true);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('filters actions, restores linked actions, and copies a readable brief with real newlines', async () => {
    const page = await browser.newPage();
    await page.setContent(renderHtmlReport(run, [finding]));
    await page.locator('#actions > details > summary').click();
    await page.locator('#q').fill('nothing-matches');
    expect(await page.locator('#groups .finding').count()).toBe(0);
    await page.locator('.human-next a').click();
    await expect.poll(() => page.locator('#groups .finding').count()).toBe(1);
    expect(await page.locator('#q').inputValue()).toBe('');
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { document.body.dataset.copied = text; } } }));
    await page.locator('#copyBtn').click();
    const copied = await page.evaluate(() => document.body.dataset.copied!);
    expect(copied).toContain('What to do:');
    expect(copied).toContain('How to check the fix:');
    expect(copied.split('\n').length).toBeGreaterThan(5);
    expect(copied).not.toContain('\\n');
    await page.close();
  });

  it('shows overlapping classification and problem views and reveals filtered linked actions', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setContent(renderConsentHtml(buildConsentReportModel(evaluation, [consentFinding])));
    expect(await page.locator('.human-details[open]').count()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.selectOption('#tool-filter', 'problem');
    expect(await page.locator('#tool-1').isVisible()).toBe(true);
    await page.selectOption('#tool-filter', 'classify');
    expect(await page.locator('#tool-1').isVisible()).toBe(true);
    await page.selectOption('#action-filter', 'exposure');
    expect(await page.locator('#action-1').isVisible()).toBe(false);
    await page.locator('.human-next a').click();
    await expect.poll(() => page.locator('#action-1').isVisible()).toBe(true);
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { document.body.dataset.copied = text; } } }));
    await page.locator('#copy-actions').click();
    expect(await page.evaluate(() => document.body.dataset.copied!.split('\n').length)).toBeGreaterThan(5);
    await page.selectOption('#cookie-filter', 'problem');
    expect(await page.locator('#cookie-filter-empty').isVisible()).toBe(true);
    expect(await page.locator('[data-cookie-state]').isVisible()).toBe(false);
    expect(errors).toEqual([]);
    await page.close();
  });
});
