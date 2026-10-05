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

suite('report checklist persistence', () => {
  let browser: Browser;
  beforeAll(async () => { const { chromium } = await import('playwright'); browser = await chromium.launch({ headless: true }); });
  afterAll(async () => { await browser?.close(); });

  it('updates counts, restores notes, isolates scans, and supports remaining-task filters', async () => {
    const context = await browser.newContext();
    await context.route('https://reports.example/**', route => route.fulfill({ contentType: 'text/html', body: renderHtmlReport({ ...run, id: asRunId(route.request().url().endsWith('/two') ? 'other-scan' : String(run.id)) }, [finding]) }));
    const page = await context.newPage();
    await page.goto('https://reports.example/one');
    expect(await page.locator('#work-fix-count').textContent()).toBe('1');
    await page.locator('[data-work-note]').fill('Checked by marketing <img src=x onerror=alert(1)>');
    const question = page.locator('[data-review-answer=implementation]');
    const initial = Number(await page.locator('#work-question-count').textContent());
    await question.fill('Changed foreground to #111; measured contrast 7:1');
    expect(Number(await page.locator('#work-question-count').textContent())).toBe(initial - 1);
    await page.selectOption('[data-work-status]', 'done');
    expect(Number(await page.locator('#work-question-count').textContent())).toBe(initial - 1);
    expect(await page.locator('#work-fix-count').textContent()).toBe('0');
    expect(await page.locator('#work-done-count').textContent()).toBe('1');
    expect(await page.locator('.finding > .human-status').textContent()).toContain('Problem observed');
    await page.reload();
    expect(await page.locator('[data-work-status]').inputValue()).toBe('done');
    expect(await page.locator('[data-work-note]').inputValue()).toContain('<img src=x');
    expect(await page.locator('[data-review-answer=implementation]').inputValue()).toContain('measured contrast');
    await page.selectOption('#work-filter', 'remaining');
    expect(await page.locator('#groups .finding').count()).toBe(0);
    await page.selectOption('#work-filter', 'done');
    expect(await page.locator('#groups .finding').count()).toBe(1);
    await page.goto('https://reports.example/two');
    expect(await page.locator('[data-work-status]').inputValue()).toBe('open');
    await page.goto('https://reports.example/one');
    expect(await page.locator('[data-work-status]').inputValue()).toBe('done');
    await context.close();
  });

  it('saves classifications independently, preserves problems, and restores backups only to their report', async () => {
    const model = buildConsentReportModel(evaluation, [consentFinding]);
    const before = JSON.stringify(model);
    const context = await browser.newContext();
    await context.route('https://reports.example/**', route => route.fulfill({ contentType: 'text/html', body: renderConsentHtml(model) }));
    const page = await context.newPage();
    await page.goto('https://reports.example/consent');
    expect(await page.locator('#work-class-count').textContent()).toBe('2');
    const tool = page.locator('#tool-1');
    await tool.locator('.classification-controls summary').click();
    await tool.locator('[name=category]').selectOption('analytics');
    await tool.locator('[name=purpose]').fill('Measures product-page visits');
    expect(await page.locator('#work-class-count').textContent()).toBe('2');
    await page.reload();
    await tool.locator('.classification-controls summary').click();
    expect(await tool.locator('[name=purpose]').inputValue()).toBe('Measures product-page visits');
    expect(await tool.locator('[data-class-answer]').textContent()).toContain('owner');
    await tool.locator('[name=owner]').fill('Example vendor / marketing team');
    await tool.locator('[name=information]').fill('Page URL and anonymous visit identifier');
    await tool.locator('[name=control]').selectOption('consent');
    await tool.locator('[name=controlReason]').fill('Nonessential analytics; gate in the consent platform for the reviewed location');
    await tool.locator('[name=source]').fill('Vendor docs reviewed by marketing, 2026-10-05');
    await tool.locator('button[type=submit]').click();
    expect(await page.locator('#work-class-count').textContent()).toBe('1');
    expect(await tool.locator('[data-class-badge]').getAttribute('data-tone')).toBe('green');
    await page.selectOption('#tool-filter', 'problem');
    expect(await tool.isVisible()).toBe(true);
    await page.selectOption('#tool-filter', 'classify');
    expect(await tool.isVisible()).toBe(false);
    await page.reload();
    expect(await tool.locator('[data-class-badge]').textContent()).toContain('Reviewed by you');
    const saved = await page.evaluate(() => { const config = JSON.parse(document.getElementById('workspace-config')!.textContent!); return localStorage.getItem(config.key)!; });
    page.on('dialog', dialog => dialog.accept());
    await page.locator('#work-reset').click();
    expect(await page.locator('#work-class-count').textContent()).toBe('2');
    await page.locator('#work-import').setInputFiles({ name: 'wrong.json', mimeType: 'application/json', buffer: Buffer.from(saved.replace(/"reportKey":"[^"]+"/, '"reportKey":"wrong-report"')) });
    await expect.poll(() => page.locator('#work-storage-status').textContent()).toContain('not for this report');
    expect(await page.locator('#work-class-count').textContent()).toBe('2');
    await page.locator('#work-import').setInputFiles({ name: 'progress.json', mimeType: 'application/json', buffer: Buffer.from(saved) });
    await expect.poll(() => page.locator('#work-class-count').textContent()).toBe('1');
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#work-export').click();
    const download = await downloadPromise;
    const backup = JSON.parse(fs.readFileSync((await download.path())!, 'utf8'));
    expect(backup.classifications).toEqual(JSON.parse(saved).classifications);
    expect(Object.keys(backup).sort()).toEqual(['actions', 'classifications', 'reportKey', 'version']);
    expect(JSON.stringify(model)).toBe(before);
    await context.close();
  });

  it('preserves older classification answers as incomplete research and accepts independent cookie answers', async () => {
    const context = await browser.newContext();
    await context.route('https://reports.example/**', route => route.fulfill({ contentType: 'text/html', body: renderConsentHtml(buildConsentReportModel(evaluation, [consentFinding])) }));
    const page = await context.newPage();
    await page.goto('https://reports.example/legacy');
    await page.evaluate(() => {
      const key = JSON.parse(document.getElementById('workspace-config')!.textContent!).key;
      const id = document.getElementById('tool-1')!.dataset.classKey!;
      localStorage.setItem(key, JSON.stringify({ version: 1, reportKey: key, actions: {}, classifications: { [id]: { category: 'analytics', purpose: 'Counts visits', source: 'Existing vendor notes' } } }));
    });
    await page.reload();
    expect(await page.locator('#work-class-count').textContent()).toBe('2');
    const tool = page.locator('#tool-1');
    await tool.locator('.classification-controls summary').click();
    expect(await tool.locator('[name=purpose]').inputValue()).toBe('Counts visits');
    expect(await tool.locator('[data-class-answer]').textContent()).toContain('consent / control decision');
    const cookie = page.locator('[data-cookie-state]');
    await cookie.locator('.classification-controls summary').click();
    for (const [name, value] of Object.entries({purpose:'Remembers an anonymous visitor',owner:'Example vendor',information:'Random visitor ID',controlReason:'Analytics cookie gated by consent',source:'Vendor cookie guide and site owner'})) await cookie.locator('[name='+name+']').fill(value);
    await cookie.locator('[name=category]').selectOption('analytics');
    await cookie.locator('[name=control]').selectOption('consent');
    expect(await page.locator('#work-class-count').textContent()).toBe('1');
    expect(await cookie.locator('[data-class-badge]').getAttribute('data-tone')).toBe('green');
    expect(await tool.locator('[data-class-badge]').getAttribute('data-tone')).toBe('amber');
    await cookie.locator('[data-class-clear]').click();
    expect(await page.locator('#work-class-count').textContent()).toBe('2');
    await context.close();
  });

  it('keeps the checklist usable when browser storage is blocked', async () => {
    const context = await browser.newContext();
    await context.addInitScript(() => { Object.defineProperty(Storage.prototype, 'setItem', { value: () => { throw new Error('Blocked'); } }); });
    await context.route('https://reports.example/**', route => route.fulfill({ contentType: 'text/html', body: renderHtmlReport(run, [finding]) }));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('https://reports.example/blocked');
    await page.selectOption('[data-work-status]', 'done');
    expect(await page.locator('#work-done-count').textContent()).toBe('1');
    expect(await page.locator('#work-storage-status').textContent()).toContain('download a backup');
    expect(errors).toEqual([]);
    await context.close();
  });
});
