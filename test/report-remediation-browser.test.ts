/// <reference path="../service/src/server/archiver.d.ts" />
// The report's checklist on the service, in a browser (remediation flow,
// integration): "Generate" makes the config AND re-renders the report, then
// reloads where the reader was (one path with "Update report", R2); a config
// regenerated elsewhere (the site page, another tab) is announced with a
// reload offer; the checklist ends with "Rescan site", which starts a job with
// the site's last options and says the rescan's proof section is the final word.
// The CLI is the service's fake (service/test/fixtures/fake-cli.mjs).
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Browser, Page } from 'playwright';
import { renderConsentHtml } from '../src/report/consent-html.js';
import { buildConsentReportModel } from '../src/report/consent-model.js';
import { reportRenderInfo } from '../src/report/consent-rerender.js';
import { generateConsentConfig } from '../src/consent-generator.js';
import { compatibilityEvaluation } from './fixtures/compatibility-report.js';
import { startService, stopAll } from '../service/test/helpers.js';
import type { Service } from '../service/src/server/app.js';
import type { SiteWorkspace } from '../service/src/shared/api.js';

let available = false;
try {
  const { chromium } = await import('playwright');
  available = fs.existsSync(chromium.executablePath());
} catch { /* Same optional browser convention as the collector tests. */ }
const suite = available || process.env.COMPLYKIT_BROWSER_CHANNEL ? describe : describe.skip;

const RUN = '2026-10-05T10-00-00-000Z';
const SHARED = 'Saved to the shared workspace for example-shop.test';
const evaluation = { ...compatibilityEvaluation(), runId: RUN };
const empty = renderConsentHtml(buildConsentReportModel(evaluation, []), { render: reportRenderInfo(RUN, undefined, '2026-10-05T10:02:00.000Z') });
const generated = generateConsentConfig(evaluation, { complykitVersion: '0.0.0-test', now: '2026-10-05T10:03:00.000Z' });
const withTasksModel = buildConsentReportModel(evaluation, []);
withTasksModel.remediation = { tasks: generated.tasks, source: 'workspace', configAt: '2026-10-05T10:03:00.000Z', runId: RUN };
const withTasks = renderConsentHtml(withTasksModel, { render: reportRenderInfo(RUN, undefined, '2026-10-05T10:04:00.000Z') });

suite('the report checklist on the service: generate, stale config, rescan', () => {
  let browser: Browser;
  let service: Service;
  let server: Server;
  let base: string;

  function addJob(html: string): { id: string; reportUrl: string } {
    const job = service.store.create({ batchId: 'b1', url: 'https://www.example-shop.test/', checks: ['consent'], quick: true });
    const runDir = path.join(service.store.jobDir(job.id), 'consent', '.comply', 'runs', RUN);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'tracking.json'), JSON.stringify(evaluation));
    fs.writeFileSync(path.join(runDir, 'consent-report.html'), html);
    fs.writeFileSync(path.join(runDir, 'rerender-template.html'), html);
    const reportUrl = `/reports/${job.id}/consent/.comply/runs/${RUN}/consent-report.html`;
    Object.assign(job, { status: 'done', result: { consent: { runId: RUN, findings: 0, totals: { violation: 0, 'needs-review': 0, exposure: 0, practice: 0 }, parties: 1, unrecognized: 0, reportUrl }, downloadUrl: `/api/jobs/${job.id}/download` } });
    service.store.update(job);
    return { id: job.id, reportUrl };
  }

  beforeAll(async () => {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true, ...(process.env.COMPLYKIT_BROWSER_CHANNEL ? { channel: process.env.COMPLYKIT_BROWSER_CHANNEL } : {}) });
    service = await startService();
    server = service.app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await browser?.close();
    await new Promise((r) => server?.close(r));
    await stopAll();
  });

  async function open(page: Page, url: string): Promise<string[]> {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base + url);
    await expect.poll(() => page.locator('#work-storage-status').textContent()).toBe(SHARED);
    return errors;
  }
  const workspace = async (): Promise<SiteWorkspace> => (await (await fetch(`${base}/api/sites/example-shop.test/workspace`)).json()) as SiteWorkspace;

  it('Generate makes the config from this run and re-renders the report, reloading where the reader was; a newer config is announced with a reload', async () => {
    const { id, reportUrl } = addJob(empty);
    const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
    context.setDefaultTimeout(10000);
    const page = await context.newPage();
    const errors = await open(page, reportUrl);
    const gen = page.locator('[data-rem-generate]');
    expect(await gen.isVisible()).toBe(true);
    expect(await page.locator('[data-rem-stale]').isHidden()).toBe(true);
    // Scrolled so the checklist section sits part-way down the screen.
    await page.evaluate(() => window.scrollTo({ top: document.getElementById('remediation')!.getBoundingClientRect().top + window.scrollY - 150, behavior: 'instant' }));
    const at = await page.evaluate(() => Math.round(document.getElementById('remediation')!.getBoundingClientRect().top));
    expect(at).toBe(150);
    const rerender = page.waitForRequest((r) => r.url().endsWith(`/api/jobs/${id}/rerender`) && r.method() === 'POST');
    await Promise.all([page.waitForEvent('load'), gen.click()]);
    expect(JSON.parse((await rerender).postData() ?? '{}')).toEqual({ generate: true });
    await expect.poll(() => page.locator('#rerendered').count()).toBe(1);
    // The reload lands on the checklist where it was on screen (the re-rendered page grew above it).
    await expect.poll(() => page.evaluate(() => Math.round(document.getElementById('remediation')!.getBoundingClientRect().top))).toBe(at);
    expect(await page.locator('#ck-rerender-message').textContent()).toMatch(/^Report updated at \d\d:\d\d UTC\.$/);
    const ws = await workspace();
    expect(ws.config?.runId).toBe(RUN);
    expect((ws.config?.value as { tasks: unknown[] }).tasks.length).toBeGreaterThan(0);
    // The re-rendered report shows the config it was rendered with: no notice.
    await expect.poll(() => page.locator('#remediation').getAttribute('data-rem-config-at')).toBe(ws.config!.at);
    expect(await page.locator('[data-rem-stale]').isHidden()).toBe(true);

    // Regenerated elsewhere (the site page): this report is now behind, and says so.
    await new Promise((r) => setTimeout(r, 5)); // a later `at`
    const res = await fetch(`${base}/api/jobs/${id}/consent-config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(200);
    await page.reload();
    await expect.poll(() => page.locator('[data-rem-stale]').isVisible()).toBe(true);
    expect(await page.locator('[data-rem-stale]').textContent()).toContain('The checklist was regenerated after this report was rendered.');
    await Promise.all([page.waitForEvent('load'), page.locator('[data-rem-refresh]').click()]);
    await expect.poll(() => page.locator('#work-storage-status').textContent()).toBe(SHARED);
    expect(await page.locator('[data-rem-stale]').isHidden()).toBe(true);
    expect(errors).toEqual([]);
    await context.close();
  });

  it('the checklist ends with “Rescan site”: the location as fixed text, full or quick (preselected from the last scan); it follows the new job inline and links straight to the new report’s proof section', async () => {
    const { reportUrl } = addJob(withTasks);
    const context = await browser.newContext();
    context.setDefaultTimeout(10000);
    const page = await context.newPage();
    const errors = await open(page, reportUrl);
    const block = page.locator('[data-rem-rescan]');
    expect(await block.textContent()).toContain('“Your complykit consent tool: what it controls”');
    expect(await block.textContent()).toContain('Location: this service’s own connection');
    expect(await block.locator('select').count()).toBe(0);
    expect(await block.textContent()).not.toMatch(/compliant/i);
    expect(await page.locator('[data-rem-rescan-offline]').isHidden()).toBe(true);
    // The last scan was quick: preselected. The owner picks full for the final check.
    await expect.poll(() => page.locator('[data-rem-rescan-mode][value="quick"]').isChecked()).toBe(true);
    await page.locator('[data-rem-rescan-mode][value="full"]').check();
    const before = service.store.list().length;
    await page.locator('[data-rem-rescan-button]').click();
    await expect.poll(() => page.locator('[data-rem-rescan-status]').textContent()).toBe('Rescan started (full).');
    expect(service.store.list().length).toBe(before + 1);
    expect(service.store.list()[0]).toMatchObject({ url: 'https://www.example-shop.test/', quick: false, checks: ['consent'] });
    // Followed inline until done, then one link to the new report's proof section.
    const link = page.locator('[data-rem-rescan-report]');
    await expect.poll(() => link.count(), { timeout: 20000 }).toBe(1);
    const job = service.store.list()[0];
    expect(await link.getAttribute('href')).toBe(`${job.result!.consent!.reportUrl}#consent-tool-proof`);
    expect(await page.locator('[data-rem-rescan-button]').textContent()).toBe('Rescan again');
    expect(errors).toEqual([]);
    await context.close();
  });

  it('Generate whose report step fails says the checklist was generated and offers “Update report”', async () => {
    const { id, reportUrl } = addJob(empty);
    const context = await browser.newContext();
    context.setDefaultTimeout(10000);
    const page = await context.newPage();
    const errors = await open(page, reportUrl);
    process.env.FAKE_REPORT_FAIL = '1';
    try {
      await page.locator('[data-rem-generate]').click();
      const partial = page.locator('[data-rem-generate-partial]');
      await expect.poll(() => partial.isVisible()).toBe(true);
      expect(await partial.textContent()).toContain('Your checklist was generated; the report couldn’t refresh — reload or press Update report.');
      expect(await page.locator('[data-rem-generate-reason]').textContent()).toMatch(/^Why: .*report crashed/);
      expect(await page.locator('[data-rem-generate-status]').textContent()).toBe('');
      expect(((await workspace()).config?.value as { tasks: unknown[] }).tasks.length).toBeGreaterThan(0);
    } finally {
      delete process.env.FAKE_REPORT_FAIL;
    }
    const rerender = page.waitForRequest((r) => r.url().endsWith(`/api/jobs/${id}/rerender`) && r.method() === 'POST');
    await Promise.all([page.waitForEvent('load'), page.locator('[data-rem-update-report]').click()]);
    expect(JSON.parse((await rerender).postData() ?? '{}')).toEqual({});
    await expect.poll(() => page.locator('#rerendered').count()).toBe(1);
    expect(errors).toEqual([]);
    await context.close();
  });

  it('statuses stored elsewhere (the site page, the API) show up when the reader comes back to the tab — no reload', async () => {
    const { reportUrl } = addJob(withTasks);
    const context = await browser.newContext();
    context.setDefaultTimeout(10000);
    const page = await context.newPage();
    const errors = await open(page, reportUrl);
    const install = page.locator('[data-remediation-id="install"]');
    expect(await install.locator('[data-rem-pill]').textContent()).toBe('To do');
    const res = await fetch(`${base}/api/sites/example-shop.test/workspace`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ by: 'elsewhere', entries: { 'task:change:install': { value: { status: 'verified', lastVerify: { at: '2026-10-05T11:00:00.000Z', result: 'pass', message: 'checked from the site page', evidence: [] } } } } }) });
    expect(res.status).toBe(200);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => install.locator('[data-rem-pill]').textContent()).toBe('Verified ✓');
    expect(await page.locator('[data-rem-progress-text]').textContent()).toMatch(/^1 of \d+ done$/);
    expect(errors).toEqual([]);
    await context.close();
  });

  it('one list: classifying a tool in the grid marks its decision done at once, unblocks the change waiting on it, and survives “Update report”', async () => {
    const { reportUrl } = addJob(withTasks);
    const context = await browser.newContext();
    context.setDefaultTimeout(10000);
    const page = await context.newPage();
    const errors = await open(page, reportUrl);
    const decisionTask = generated.tasks.find((t) => t.kind === 'classify')!;
    const blockedTask = generated.tasks.find((t) => t.waitingOn?.includes(decisionTask.id))!;
    const required = generated.tasks.filter((t) => !t.optional).length;
    const decision = page.locator(`[data-remediation-id="${decisionTask.id}"]`);
    const blocked = page.locator(`[data-remediation-id="${blockedTask.id}"]`);
    // The decision is first in the one list; the change waiting on it says so and hides its buttons.
    expect(await page.locator('#remediation .ck-rem-list > [data-remediation-id]').first().getAttribute('data-remediation-id')).toBe(decisionTask.id);
    expect(await decision.locator('[data-rem-pill]').textContent()).toBe('To decide');
    expect(await blocked.locator('[data-rem-waiting]').isVisible()).toBe(true);
    expect(await blocked.locator('[data-rem-done]').isVisible()).toBe(false);
    // (The site's workspace is shared with the tests above: count from what is already done.)
    const before = Number(/^(\d+) of (\d+) done$/.exec((await page.locator('[data-rem-progress-text]').textContent()) ?? '')?.[1]);
    expect(await page.locator('[data-rem-progress-text]').textContent()).toBe(`${before} of ${required} done`);
    // Classify it from the decision's button: the grid's classify form for that tool.
    await decision.locator('[data-matrix-select]').click();
    const form = page.locator('#matrix-classification [data-class-form]');
    await form.locator('select[name=category]').selectOption('analytics');
    await form.locator('[data-class-apply]').click();
    await expect.poll(() => decision.locator('[data-rem-pill]').textContent()).toBe('Decided ✓');
    expect(await blocked.locator('[data-rem-waiting]').isVisible()).toBe(false);
    expect(await blocked.locator('[data-rem-unblocked]').isVisible()).toBe(true);
    expect(await blocked.locator('[data-rem-done]').isVisible()).toBe(true);
    expect(await page.locator('[data-rem-progress-text]').textContent()).toBe(`${before + 1} of ${required} done`);
    await expect.poll(() => page.locator('#work-storage-status').textContent()).toBe(SHARED);
    expect(Object.keys((await workspace()).entries)).toContain(decisionTask.classKey);
    // Update report: re-rendered from the saved scan; the decision reads done from the workspace.
    await Promise.all([page.waitForEvent('load'), page.locator('#ck-rerender-button').click()]);
    await expect.poll(() => page.locator('#rerendered').count()).toBe(1);
    await expect.poll(() => page.locator(`[data-remediation-id="${decisionTask.id}"] [data-rem-pill]`).textContent()).toBe('Decided ✓');
    expect(await page.locator(`[data-remediation-id="${blockedTask.id}"] [data-rem-waiting]`).isVisible()).toBe(false);
    expect(errors).toEqual([]);
    await context.close();
  });

  it('offline (no service): the rescan is the command, the buttons are hidden', async () => {
    const context = await browser.newContext();
    await context.route('https://reports.example/**', (route) => route.fulfill({ contentType: 'text/html', body: withTasks }));
    const page = await context.newPage();
    await page.goto('https://reports.example/consent');
    expect(await page.locator('[data-rem-rescan-service]').isHidden()).toBe(true);
    expect(await page.locator('[data-rem-rescan-offline]').isVisible()).toBe(true);
    expect(await page.locator('[data-rem-stale]').isHidden()).toBe(true);
    await context.close();
  });
});
