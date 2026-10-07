/// <reference path="../service/src/server/archiver.d.ts" />
// R2 in a browser: the served report offers "Update report with my
// classifications" once a classification differs from the ones it was rendered
// with, the click re-renders it on the service (POST /api/jobs/:id/rerender,
// the fake CLI here) and reloads where the reader was; the same report opened
// without the service shows how to re-render it locally instead.
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Browser, Page } from 'playwright';
import { renderConsentHtml } from '../src/report/consent-html.js';
import { buildConsentReportModel } from '../src/report/consent-model.js';
import { reportRenderInfo } from '../src/report/consent-rerender.js';
import { TrackingEvaluation } from '../src/record/index.js';
import { startService, stopAll } from '../service/test/helpers.js';
import type { Service } from '../service/src/server/app.js';

let available = false;
try {
  const { chromium } = await import('playwright');
  available = fs.existsSync(chromium.executablePath());
} catch { /* Same optional browser convention as the collector tests. */ }
// COMPLYKIT_BROWSER_CHANNEL (an installed Chrome / Edge) counts as a browser too.
const suite = available || process.env.COMPLYKIT_BROWSER_CHANNEL ? describe : describe.skip;

const RUN = '2026-10-05T10-00-00-000Z';
const evaluation = TrackingEvaluation.parse({ runId: RUN, property: 'Example site', site: { url: 'https://shop.example.com/', host: 'shop.example.com', registrableDomain: 'example.com' }, startedAt: '2026-10-05T10:00:00Z', finishedAt: '2026-10-05T10:01:00Z', versions: { kb: '0', registry: '0', package: '0' }, redacted: true,
  locations: [{ spec: { id: 'de', label: 'Germany', country: 'DE', proxied: false }, verification: { verdict: 'verified', expected: { country: 'DE' }, observed: { country: 'DE' }, sources: [], jurisdictions: ['eu'], checkedAt: 'now' }, scenarios: [{ scenario: 'reject', status: 'tested', choice: { kind: 'reject', ok: false, method: 'test' } }] }],
  inventory: [{ partyId: 'x', label: 'Example analytics', domain: 'analytics.example', hosts: ['analytics.example'], recognized: true, kbStatus: 'proposed', categories: ['analytics'], behavesLikeTracker: true, trackerSignals: [], sends: ['page-address'], stores: [{ name: '_visitor', kind: 'cookie', lifetimeDays: 30 }], sources: ['injected'], loadedBy: [], seenIn: [] }], notTested: [], researchQueue: [] });
const html = renderConsentHtml(buildConsentReportModel(evaluation, []), { render: reportRenderInfo(RUN, undefined, '2026-10-05T10:02:00.000Z') });

const SHARED = 'Saved to the shared workspace for example.com';

suite('re-render the served report with my classifications', () => {
  let browser: Browser;
  let service: Service;
  let server: Server;
  let base: string;
  let reportUrl: string;

  beforeAll(async () => {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true, ...(process.env.COMPLYKIT_BROWSER_CHANNEL ? { channel: process.env.COMPLYKIT_BROWSER_CHANNEL } : {}) });
    service = await startService();
    const job = service.store.create({ batchId: 'b1', url: 'https://shop.example.com/', checks: ['consent'], quick: false });
    const runDir = path.join(service.store.jobDir(job.id), 'consent', '.comply', 'runs', RUN);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'tracking.json'), JSON.stringify(evaluation));
    fs.writeFileSync(path.join(runDir, 'consent-report.html'), html);
    fs.writeFileSync(path.join(runDir, 'rerender-template.html'), html);
    reportUrl = `/reports/${job.id}/consent/.comply/runs/${RUN}/consent-report.html`;
    Object.assign(job, { status: 'done', result: { consent: { runId: RUN, findings: 0, totals: { violation: 0, 'needs-review': 0, exposure: 0, practice: 0 }, parties: 1, unrecognized: 0, reportUrl }, downloadUrl: `/api/jobs/${job.id}/download` } });
    service.store.update(job);
    server = service.app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await browser?.close();
    await new Promise((r) => server?.close(r));
    await stopAll();
  });

  async function open(page: Page): Promise<string[]> {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base + reportUrl);
    await expect.poll(() => page.locator('#work-storage-status').textContent()).toBe(SHARED);
    return errors;
  }

  it('is quiet while current, highlights after a classification, and re-renders in place', async () => {
    const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
    context.setDefaultTimeout(8000);
    const page = await context.newPage();
    const errors = await open(page);
    const panel = page.locator('#ck-rerender');
    await expect.poll(() => panel.getAttribute('data-state')).toBe('current');
    expect(await page.locator('#ck-rerender-button').isVisible()).toBe(true);
    expect(await page.locator('[data-rerender-offline]').isHidden()).toBe(true);
    expect(await page.locator('#ck-rerender-status').textContent()).toContain('reflects the current classifications');

    // Classify the tool: the report now shows earlier answers than the workspace has.
    const tool = page.locator('#tool-1');
    await page.locator('[data-matrix-kind=tool] .matrix-result').first().click();
    await tool.locator('[name=category]').selectOption('advertising');
    await expect.poll(() => page.locator('#work-storage-status').textContent()).toBe(SHARED);
    await expect.poll(() => panel.getAttribute('data-state')).toBe('changed');
    expect(await page.locator('#ck-rerender-status').textContent()).toMatch(/^1 classification has changed since this report was rendered \(rendered 2026-10-05 10:02 UTC\)/);
    // Sticky while changed: still on screen after scrolling down.
    await page.evaluate(() => window.scrollTo(0, 600));
    const y = await page.evaluate(() => window.scrollY);
    expect(y).toBeGreaterThan(0);
    expect(await page.locator('#ck-rerender-button').isVisible()).toBe(true);
    // What the reader is looking at: the element under the middle of the viewport, and where it sits.
    const spot = await page.evaluate(() => { const el = document.elementFromPoint(400, 450)!.closest('main [id]')!; return { id: el.id, top: Math.round(el.getBoundingClientRect().top) }; });
    expect(spot.id).not.toBe('');

    // One click: the service re-renders from the saved run and the page reloads where it was —
    // the same content at the same place on screen, although the re-rendered page grew above it.
    await Promise.all([page.waitForEvent('load'), page.locator('#ck-rerender-button').click()]);
    await expect.poll(() => page.locator('#rerendered').count()).toBe(1);
    await expect.poll(() => page.locator('#work-storage-status').textContent()).toBe(SHARED);
    await expect.poll(() => panel.getAttribute('data-state')).toBe('current');
    expect(await page.locator('#ck-rerender-message').textContent()).toMatch(/^Report updated at \d\d:\d\d UTC\.$/);
    // Within a line or so: Linux font metrics shift the restored position by a few px.
    await expect.poll(() => page.evaluate((id) => Math.round(document.getElementById(id)!.getBoundingClientRect().top), spot.id)).toBeGreaterThanOrEqual(spot.top - 24);
    expect(await page.evaluate((id) => Math.round(document.getElementById(id)!.getBoundingClientRect().top), spot.id)).toBeLessThanOrEqual(spot.top + 24);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(y);
    expect(await page.evaluate(() => history.scrollRestoration)).toBe('manual'); // until the reader moves or the page settles
    await page.mouse.wheel(0, 10);
    await expect.poll(() => page.evaluate(() => history.scrollRestoration)).toBe('auto');
    expect(fs.existsSync(path.join(service.store.jobDir(service.store.list()[0].id), 'consent', '.comply', 'runs', RUN, 'consent-report.prev.html'))).toBe(true);
    expect(errors).toEqual([]);
    await context.close();
  });

  it('says why when the re-render fails, and keeps the button', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await open(page);
    await context.route('**/rerender', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'report crashed' }) }));
    await page.locator('#ck-rerender-button').click();
    await expect.poll(() => page.locator('#ck-rerender-message').textContent()).toBe('Could not update the report: report crashed');
    expect(await page.locator('#ck-rerender-button').isEnabled()).toBe(true);
    await context.close();
  });

  it('offline (no service): shows the local command and downloads the classifications as a workspace file', async () => {
    const context = await browser.newContext();
    await context.route('https://reports.example/**', (route) => route.fulfill({ contentType: 'text/html', body: html }));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('https://reports.example/consent');
    expect(await page.locator('[data-rerender-service]').isHidden()).toBe(true);
    expect(await page.locator('[data-rerender-offline] pre').textContent()).toBe(`complykit report --run ${RUN} --format consent-html --workspace complykit-workspace.json --out consent-report.html`);
    await page.locator('[data-matrix-kind=tool] .matrix-result').first().click();
    await page.locator('#tool-1 [name=category]').selectOption('advertising');
    const download = page.waitForEvent('download');
    await page.locator('#ck-rerender-download').click();
    const ws = JSON.parse(fs.readFileSync((await (await download).path())!, 'utf8')) as { entries: Record<string, { value: { category: string } }> };
    const key = await page.locator('#tool-1').getAttribute('data-class-key');
    expect(ws.entries[`class:${key}`].value).toMatchObject({ category: 'advertising', categoryChosen: true });
    expect(errors).toEqual([]);
    await context.close();
  });
});
