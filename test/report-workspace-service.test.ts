/// <reference path="../service/src/server/archiver.d.ts" />
// The report workbench against a running service (ticket C2): two browsers on
// the same served report see each other's classifications and task progress
// after a reload, and the same report opened offline still saves locally.
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Browser, Page } from 'playwright';
import { renderHtmlReport } from '../src/report/html.js';
import { renderConsentHtml } from '../src/report/consent-html.js';
import { buildConsentReportModel } from '../src/report/consent-model.js';
import { asRunId, asRuleId, asRequirementId, fingerprint, TrackingEvaluation, type Finding, type Run } from '../src/record/index.js';
import { startService, stopAll } from '../service/test/helpers.js';
import type { Service } from '../service/src/server/app.js';

let available = false;
try {
  const { chromium } = await import('playwright');
  available = fs.existsSync(chromium.executablePath());
} catch { /* Same optional browser convention as the collector tests. */ }
const suite = available ? describe : describe.skip;

const run: Run = { schemaVersion: 1, id: asRunId('workspace-service'), property: 'Example site', startedAt: '2026-10-05T10:00:00Z', versions: { package: '0', registry: '0', engines: {} }, accessLevels: ['public'], matrix: [], gaps: [], rulesExecuted: [] };
const subject = { property: 'Example site', routePattern: '/', locator: { role: 'text', name: '.hero > p', cssPath: '.hero > p', ordinal: 0 } };
const finding: Finding = { schemaVersion: 1, runId: run.id, ruleId: asRuleId('axe-core:color-contrast'), requirementId: asRequirementId('wcag22.1.4.3'), subject, confidence: 'violation', severity: 'serious', message: 'Contrast ratio is 2.8:1.', evidence: [{ kind: 'computed-style', properties: { ratio: '2.8', required: '4.5' } }], fingerprint: fingerprint({ detects: 'presence', ruleId: asRuleId('axe-core:color-contrast'), subject }), producer: { type: 'engine', name: 'axe-core', version: '4' } };
const evaluation = TrackingEvaluation.parse({ runId: 'r', property: 'Example site', site: { url: 'https://shop.example.com/', host: 'shop.example.com', registrableDomain: 'example.com' }, startedAt: '2026-10-05T10:00:00Z', finishedAt: '2026-10-05T10:01:00Z', versions: { kb: '0', registry: '0', package: '0' }, redacted: true,
  locations: [{ spec: { id: 'de', label: 'Germany', country: 'DE', proxied: false }, verification: { verdict: 'verified', expected: { country: 'DE' }, observed: { country: 'DE' }, sources: [], jurisdictions: ['eu'], checkedAt: 'now' }, scenarios: [{ scenario: 'reject', status: 'tested', choice: { kind: 'reject', ok: false, method: 'test' } }] }],
  inventory: [{ partyId: 'x', label: 'Example analytics', domain: 'analytics.example', hosts: ['analytics.example'], recognized: true, kbStatus: 'proposed', categories: ['analytics'], behavesLikeTracker: true, trackerSignals: [], sends: ['page-address'], stores: [{ name: '_visitor', kind: 'cookie', lifetimeDays: 30 }], sources: ['injected'], loadedBy: [], seenIn: [] }], notTested: [], researchQueue: [] });
const consentFinding: Finding = { ...finding, ruleId: asRuleId('tracking.prior-consent'), requirementId: asRequirementId('eprivacy.art5.3'), details: { party: { id: 'x', label: 'Example analytics', domain: 'analytics.example' }, occurrences: [{ location: 'de', scenario: 'reject', phases: ['before-choice'], firstMs: 20, requests: 1, sent: ['page-address'], stored: [], decoded: [], markers: [] }] } };

const SHARED = 'Saved to the shared workspace for example.com';

suite('report workbench on the service', () => {
  let browser: Browser;
  let service: Service;
  let server: Server;
  let base: string;
  let jobId: string;

  beforeAll(async () => {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    service = await startService();
    const job = service.store.create({ batchId: 'b1', url: 'https://shop.example.com/', checks: ['consent', 'accessibility'], quick: false });
    jobId = job.id;
    const dir = service.store.jobDir(job.id);
    fs.mkdirSync(path.join(dir, 'consent'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'accessibility'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'consent', 'consent-report.html'), renderConsentHtml(buildConsentReportModel(evaluation, [consentFinding])));
    fs.writeFileSync(path.join(dir, 'accessibility', 'report.html'), renderHtmlReport(run, [finding]));
    server = service.app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await browser?.close();
    await new Promise((r) => server?.close(r));
    await stopAll();
  });

  async function open(page: Page, report: string): Promise<void> {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/reports/${jobId}/${report}`);
    await expect.poll(() => page.locator('#work-storage-status').textContent()).toBe(SHARED);
    expect(errors).toEqual([]);
  }

  it('injects the site workspace config only into served reports with a workbench', async () => {
    const res = await fetch(`${base}/reports/${jobId}/consent/consent-report.html`);
    const html = await res.text();
    const block = html.match(/<script type="application\/json" id="ck-service">([^<]*)<\/script>/);
    expect(JSON.parse(block![1])).toEqual({ version: 1, domain: 'example.com', workspace: '/api/sites/example.com/workspace', jobId });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('shares classifications and task progress between two browsers, stamped with an optional name', async () => {
    const alice = await browser.newContext();
    const bob = await browser.newContext();
    alice.setDefaultTimeout(5000);
    bob.setDefaultTimeout(5000);
    const a = await alice.newPage();
    await open(a, 'consent/consent-report.html');
    // Asked once per browser; skippable.
    expect(await a.locator('#work-name-form').isVisible()).toBe(false); // inside the collapsed checklist
    await a.evaluate(() => { (document.getElementById('work-name') as HTMLInputElement).value = 'Alice'; document.getElementById('work-name-save')!.click(); });
    expect(await a.locator('#work-name-status').textContent()).toContain('“Alice”');

    const tool = a.locator('#tool-1');
    await a.locator('[data-matrix-kind=tool] .matrix-result').first().click();
    await tool.locator('[name=category]').selectOption('analytics');
    await tool.locator('[data-class-research] > summary').click();
    await tool.locator('[name=purpose]').fill('Measures product-page visits');
    await tool.locator('[name=owner]').fill('Example vendor');
    await expect.poll(() => a.locator('#work-storage-status').textContent()).toBe(SHARED);

    const classKey = await tool.getAttribute('data-class-key');
    const ws = await service.workspaces.get('example.com');
    expect(ws.entries[`class:${classKey}`]).toMatchObject({ by: 'Alice', value: { category: 'analytics', purpose: 'Measures product-page visits', owner: 'Example vendor' } });

    // Bob, another browser, sees Alice's answers and adds his own; he skips the name.
    const b = await bob.newPage();
    await open(b, 'consent/consent-report.html');
    await b.evaluate(() => document.getElementById('work-name-skip')!.click());
    expect(await b.locator('#work-name-status').textContent()).toContain('not stamped');
    const bTool = b.locator('#tool-1');
    await b.locator('[data-matrix-kind=tool] .matrix-result').first().click();
    expect(await bTool.locator('[name=purpose]').inputValue()).toBe('Measures product-page visits');
    await bTool.locator('[data-class-research] > summary').click();
    await bTool.locator('[name=information]').fill('Page URL and a visitor identifier');
    await expect.poll(() => b.locator('#work-storage-status').textContent()).toBe(SHARED);

    await a.reload();
    await expect.poll(() => a.locator('#work-storage-status').textContent()).toBe(SHARED);
    await a.locator('[data-matrix-kind=tool] .matrix-result').first().click();
    await expect.poll(() => tool.locator('[name=information]').inputValue()).toBe('Page URL and a visitor identifier');
    expect(await tool.locator('[name=owner]').inputValue()).toBe('Example vendor');

    // Clearing is shared too (a null entry, so an older write can't revive it).
    await tool.locator('[data-class-clear]').evaluate((el: HTMLElement) => el.click());
    await expect.poll(() => a.locator('#work-storage-status').textContent()).toBe(SHARED);
    expect((await service.workspaces.get('example.com')).entries[`class:${classKey}`].value).toBeNull();
    await b.reload();
    await expect.poll(() => b.locator('#work-storage-status').textContent()).toBe(SHARED);
    await b.locator('[data-matrix-kind=tool] .matrix-result').first().click();
    expect(await bTool.locator('[name=purpose]').inputValue()).toBe('');

    // Task progress on another report of the same site.
    const a2 = await alice.newPage();
    await open(a2, 'accessibility/report.html');
    await a2.selectOption('[data-work-status]', 'done');
    await a2.locator('[data-work-note]').fill('Fixed by marketing');
    await expect.poll(() => a2.locator('#work-storage-status').textContent()).toBe(SHARED);
    const b2 = await bob.newPage();
    await open(b2, 'accessibility/report.html');
    expect(await b2.locator('[data-work-status]').inputValue()).toBe('done');
    expect(await b2.locator('[data-work-note]').inputValue()).toBe('Fixed by marketing');
    const actionKey = await b2.locator('[data-action-key]').first().getAttribute('data-action-key');
    expect((await service.workspaces.get('example.com')).entries[`task:${actionKey}`]).toMatchObject({ by: 'Alice', value: { status: 'done' } });

    // The backup restores through the shared workspace.
    const downloadPromise = b2.waitForEvent('download');
    await b2.evaluate(() => document.getElementById('work-export')!.click());
    const backup = fs.readFileSync((await (await downloadPromise).path())!, 'utf8');
    b2.on('dialog', (d) => d.accept());
    await b2.evaluate(() => document.getElementById('work-reset')!.click());
    await expect.poll(() => b2.locator('#work-storage-status').textContent()).toBe(SHARED);
    expect((await service.workspaces.get('example.com')).entries[`task:${actionKey}`].value).toBeNull();
    await b2.locator('#work-import').setInputFiles({ name: 'progress.json', mimeType: 'application/json', buffer: Buffer.from(backup) });
    await expect.poll(async () => (await service.workspaces.get('example.com')).entries[`task:${actionKey}`].value).toMatchObject({ status: 'done', note: 'Fixed by marketing' });
    await a2.reload();
    await expect.poll(() => a2.locator('[data-work-status]').inputValue()).toBe('done');

    // Nothing was left in either browser's own report storage.
    expect(await a2.evaluate(() => localStorage.getItem(JSON.parse(document.getElementById('workspace-config')!.textContent!).key))).toBeNull();
    await alice.close();
    await bob.close();
  });

  it('keeps unsent changes in the browser when the service is unreachable, then sends them', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await open(page, 'accessibility/report.html');
    await context.route('**/api/sites/**', (route) => route.abort());
    await page.locator('[data-work-note]').fill('Written while offline');
    await expect.poll(() => page.locator('#work-storage-status').textContent()).toContain('Saved in this browser only — 0 classifications are not shared; export them. 1 task update is not shared either.');
    await context.unroute('**/api/sites/**');
    await page.reload();
    await expect.poll(() => page.locator('#work-storage-status').textContent()).toBe(SHARED);
    const actionKey = await page.locator('[data-action-key]').first().getAttribute('data-action-key');
    expect((await service.workspaces.get('example.com')).entries[`task:${actionKey}`].value).toMatchObject({ note: 'Written while offline' });
    await context.close();
  });

  it('still works offline: the same report without the service saves in this browser only', async () => {
    const context = await browser.newContext();
    await context.route('https://reports.example/**', (route) => route.fulfill({ contentType: 'text/html', body: renderConsentHtml(buildConsentReportModel(evaluation, [consentFinding])) }));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('https://reports.example/consent');
    expect(await page.locator('#ck-service').count()).toBe(0);
    expect(await page.locator('#work-identity').isHidden()).toBe(true);
    const tool = page.locator('#tool-1');
    await page.locator('[data-matrix-kind=tool] .matrix-result').first().click();
    await tool.locator('[name=category]').selectOption('analytics');
    expect(await page.locator('#work-storage-status').textContent()).toBe('Saved in this browser only — 1 classification is not shared; export them');
    await page.reload();
    await page.locator('[data-matrix-kind=tool] .matrix-result').first().click();
    expect(await tool.locator('[name=category]').inputValue()).toBe('analytics');
    expect(errors).toEqual([]);
    await context.close();
  });
});
