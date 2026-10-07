/// <reference path="../service/src/server/archiver.d.ts" />
// Ticket C5: "Export for sharing" on a served report downloads one HTML file
// with a dated snapshot of the workspace and a link back; opened offline (file://,
// no service) it shows the banner and the snapshot's classifications, and local
// edits layer on top.
import fs from 'node:fs';
import os from 'node:os';
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

suite('exported report snapshot', () => {
  let browser: Browser;
  let service: Service;
  let server: Server;
  let base: string;
  let jobId: string;
  let tmp: string;

  beforeAll(async () => {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    service = await startService();
    const job = service.store.create({ batchId: 'b1', url: 'https://shop.example.com/', checks: ['consent'], quick: false });
    jobId = job.id;
    const dir = service.store.jobDir(job.id);
    fs.mkdirSync(path.join(dir, 'consent'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'consent', 'consent-report.html'), renderConsentHtml(buildConsentReportModel(evaluation, [consentFinding])));
    server = service.app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-export-'));
  });
  afterAll(async () => {
    await browser?.close();
    await new Promise((r) => server?.close(r));
    await stopAll();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('exports a dated snapshot that opens offline with its classifications and a way back', async () => {
    const context = await browser.newContext({ acceptDownloads: true });
    context.setDefaultTimeout(5000);
    const page = await context.newPage();
    await page.goto(`${base}/reports/${jobId}/consent/consent-report.html`);
    await expect.poll(() => page.locator('#work-storage-status').textContent()).toBe(SHARED);
    const tool = page.locator('#tool-1');
    await page.locator('[data-matrix-kind=tool] .matrix-result').first().click();
    await tool.locator('[name=category]').selectOption('analytics');
    await tool.locator('[data-class-research] > summary').click();
    await tool.locator('[name=purpose]').fill('Measures product-page visits');
    await expect.poll(() => page.locator('#work-storage-status').textContent()).toBe(SHARED);

    // The checklist panel is collapsed, so drive the button directly.
    expect(await page.locator('#work-snapshot').evaluate((el: HTMLElement) => el.hidden)).toBe(false);
    const download = page.waitForEvent('download');
    await page.evaluate(() => document.getElementById('work-snapshot')!.click());
    const file = path.join(tmp, 'export.html');
    await (await download).saveAs(file);
    const html = fs.readFileSync(file, 'utf8');
    expect(html).not.toMatch(/<script type="application\/json" id="ck-service">/);
    const live = `${base}/reports/${jobId}/consent/consent-report.html`;
    const snap = JSON.parse(html.match(/<script type="application\/json" id="ck-snapshot">([^<]*)<\/script>/)![1]);
    expect(snap).toMatchObject({ version: 1, domain: 'example.com', liveUrl: live });
    expect(Object.keys(snap.entries).some((k) => k.startsWith('class:'))).toBe(true);
    await context.close();

    // Offline: opened from disk, no service anywhere.
    const offline = await browser.newContext();
    offline.setDefaultTimeout(5000);
    const requests: string[] = [];
    offline.on('request', (r) => { if (!r.url().startsWith('file:')) requests.push(r.url()); });
    const view = await offline.newPage();
    const errors: string[] = [];
    view.on('pageerror', (e) => errors.push(e.message));
    await view.goto(`file://${file}`);
    const banner = view.locator('#ck-snapshot-banner');
    expect(await banner.isVisible()).toBe(true);
    expect(await banner.textContent()).toBe(`Snapshot from ${snap.at.slice(0, 10)} — live version: ${live}`);
    expect(await banner.locator('a').getAttribute('href')).toBe(live);
    expect(await view.locator('#work-snapshot').evaluate((el: HTMLElement) => el.hidden)).toBe(true);
    expect(await view.locator('#work-storage-status').textContent()).toContain('Saved in this browser only — 1 classification is not shared');
    await view.locator('[data-matrix-kind=tool] .matrix-result').first().click();
    expect(await view.locator('#tool-1 [name=category]').inputValue()).toBe('analytics');
    expect(await view.locator('#tool-1 [name=purpose]').inputValue()).toBe('Measures product-page visits');

    // A local edit layers on top of the snapshot and survives a reload.
    await view.locator('#tool-1 [data-class-research] > summary').click();
    await view.locator('#tool-1 [name=owner]').fill('Added offline');
    await view.reload();
    await view.locator('[data-matrix-kind=tool] .matrix-result').first().click();
    expect(await view.locator('#tool-1 [name=owner]').inputValue()).toBe('Added offline');
    expect(await view.locator('#tool-1 [name=purpose]').inputValue()).toBe('Measures product-page visits');
    expect(await view.locator('#ck-snapshot-banner').count()).toBe(1);
    expect(errors).toEqual([]);
    expect(requests).toEqual([]);
    await offline.close();
  });
});
