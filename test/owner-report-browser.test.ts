// The report page (plans/simple-report.md) end to end, in a browser, for real:
// the built CLI, the built service client (service/dist/client), the service
// in-process with the automatic to-do list on, and the fixture storefront
// (test/fixtures/remediation-e2e-site.ts). A person's path through the page:
//
//   home: type the address, Scan → the report page opens at once → scan status
//   → the consent banner line → the matrix filling in (spinners → ✓ / ✕ / ?)
//   → the to-do list (decisions first) → classify the unknown widget in the list
//   → the report re-renders by itself → install the snippet on the site, Verify
//   → pass → mark the rest done → "Run the final scan" opens up → it starts a new
//   scan and its report page.
//
// --quick, one run per scenario. Honours COMPLYKIT_BROWSER_CHANNEL (e.g.
// chrome). Skips, visibly, without a browser, the builds (`npm run build`,
// `npm --prefix client run build`, `npm --prefix service run build`) or openssl.
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Browser, Page } from 'playwright';
import { startE2eSite, opensslAvailable, type E2eSite } from './fixtures/remediation-e2e-site.js';
import { clientBuilt } from './fixtures/proof-site.js';
import { startService, stopAll } from '../service/test/helpers.js';
import type { Service } from '../service/src/server/app.js';
import type { JobReportResponse } from '../service/src/shared/api.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const SERVICE_CLIENT = path.join(ROOT, 'service', 'dist', 'client');

let browserAvailable = false;
try {
  const { chromium } = await import('playwright');
  browserAvailable = fs.existsSync(chromium.executablePath());
} catch {
  browserAvailable = false;
}
browserAvailable ||= Boolean(process.env.COMPLYKIT_BROWSER_CHANNEL);
const missing = [
  !browserAvailable && 'a browser (Playwright Chromium or COMPLYKIT_BROWSER_CHANNEL)',
  !fs.existsSync(CLI) && 'dist/cli.js (npm run build)',
  !clientBuilt() && 'client/dist (npm --prefix client run build)',
  !fs.existsSync(path.join(SERVICE_CLIENT, 'index.html')) && 'service/dist/client (npm --prefix service run build)',
  !opensslAvailable() && 'openssl',
].filter(Boolean);
if (missing.length) console.warn(`report page browser test skipped: needs ${missing.join(', ')}`);
const suite = missing.length ? describe.skip : describe;

const SCAN_MS = 4 * 60_000;

suite('the report page, end to end (real CLI, service, browser, fixture site)', () => {
  let site: E2eSite;
  let service: Service;
  let server: Server;
  let base: string;
  let browser: Browser;
  let page: Page;
  let prevArgs: string | undefined;

  beforeAll(async () => {
    site = await startE2eSite();
    prevArgs = process.env.COMPLYKIT_BROWSER_ARGS;
    process.env.COMPLYKIT_BROWSER_ARGS = site.launchArgs.join(' ');
    service = await startService({ cliPath: CLI, consentRuns: 1, pollMs: 250, concurrency: 1, killGraceMs: 2000, autoChecklist: true, clientDir: SERVICE_CLIENT });
    server = service.app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { chromium } = await import('playwright');
    const channel = process.env.COMPLYKIT_BROWSER_CHANNEL || undefined;
    browser = await chromium.launch({ ...(channel ? { channel } : {}) });
    page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  });

  afterAll(async () => {
    await browser?.close();
    if (prevArgs === undefined) delete process.env.COMPLYKIT_BROWSER_ARGS;
    else process.env.COMPLYKIT_BROWSER_ARGS = prevArgs;
    await new Promise((r) => server?.close(r));
    await stopAll();
    await site?.close();
  });

  const report = async (id: string): Promise<JobReportResponse> => (await (await fetch(`${base}/api/jobs/${id}/report`)).json()) as JobReportResponse;
  const jobIdOf = (url: string): string => /#report\/([A-Za-z0-9_-]+)/.exec(url)![1];

  it(
    'scan from home → live report → classify → automatic re-render → verify → final scan',
    async () => {
      // --- Home: an address and a Scan button (quick, under Options) -----------------
      await page.goto(base + '/');
      await page.getByPlaceholder('example.com').fill(site.url);
      await page.getByText('Options').click();
      await page.getByLabel(/Quick scan/).check();
      // The form always sends laws (multi-region scans). This test server has no regional
      // workers and the fixture site cannot be geolocated, so the request goes out as a
      // classic single-location scan from this machine.
      await page.getByTestId('authorized').check();
      await page.route('**/api/batches', async (route) => {
        const body = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
        delete body.laws;
        delete body.authorized;
        await route.continue({ postData: JSON.stringify(body) });
      });
      await page.getByRole('button', { name: 'Scan', exact: true }).click();
      await page.waitForURL(/#report\//);
      const jobId = jobIdOf(page.url());

      // --- While it runs: status, the banner line, the matrix filling in ----------
      await page.getByTestId('scan-status').waitFor();
      expect(await page.getByTestId('scan-status').textContent()).toMatch(/Scanning shop\.example-e2e\.test/);
      const seen = { pendingCell: false, judgedWhilePending: false, bannerLookingOrKnown: false };
      for (const start = Date.now(); Date.now() - start < SCAN_MS; ) {
        const r = await report(jobId);
        const pend = await page.locator('.rp-cell[data-state="pending"]').count();
        const judged = await page.locator('button.rp-cell').count();
        if (pend) seen.pendingCell = true;
        if (pend && judged) seen.judgedWhilePending = true;
        if (await page.getByTestId('banner').count()) seen.bannerLookingOrKnown = true;
        if (r.job.status !== 'running' && r.job.status !== 'queued') break;
        await page.waitForTimeout(300);
      }
      const finished = await report(jobId);
      expect(finished.job.status, finished.job.error).toBe('done');
      expect(seen.pendingCell, 'spinner cells while visits were still to come').toBe(true);
      expect(seen.judgedWhilePending, 'results appeared before the scan finished').toBe(true);
      expect(seen.bannerLookingOrKnown).toBe(true);

      // --- Finished: no status; banner line; matrix with no spinners; the list ----
      await page.getByTestId('scan-status').waitFor({ state: 'detached' });
      await page.locator('[data-testid="todo"][data-state="ready"]').waitFor({ timeout: 60_000 });
      expect(await page.locator('.rp-cell[data-state="pending"]').count()).toBe(0);
      expect(await page.getByTestId('banner').textContent()).toMatch(/consent banner/i);
      const matrix = page.getByTestId('matrix');
      expect(await matrix.textContent()).toContain('e2e-widgets.test');
      expect(await matrix.locator('button.rp-cell[data-state="needs-decision"]').count()).toBeGreaterThan(0);
      expect(await page.locator('.rp-footer a', { hasText: 'Technical details' }).getAttribute('href')).toMatch(/consent-report\.html$/);

      // A cell explains itself.
      await matrix.locator('button.rp-cell[data-state="mismatch"]').first().click();
      expect(await page.getByTestId('cell-detail').textContent()).toMatch(/Problem/);

      // --- 1. The decision, first in the list; answering it re-renders by itself ---
      const todos = page.locator('[data-testid="todo"] > ol > li');
      expect(await todos.first().textContent()).toContain('What is e2e-widgets.test for?');
      await todos.first().locator('[data-purpose="analytics"]').click();
      await page.waitForFunction(() => document.querySelector('[data-testid="todo"] > ol > li')?.getAttribute('data-status') === 'verified');
      // The re-render lands: the widget's row is classified in the matrix, no "?" left on it.
      for (const start = Date.now(); ; ) {
        const r = await report(jobId);
        const w = r.report?.matrix.tools.find((t) => t.label === 'e2e-widgets.test');
        if (w?.classified && !r.updating) break;
        if (Date.now() - start > 60_000) throw new Error('the report did not re-render with the classification');
        await page.waitForTimeout(300);
      }
      await page.waitForFunction(() => !document.querySelector('[data-testid="updating"]'), undefined, { timeout: 30_000 });
      await page.waitForFunction(() => Array.from(document.querySelectorAll('.rp-tool th')).some((th) => th.textContent?.includes('e2e-widgets.test') && th.textContent.includes('Analytics')));
      expect((await report(jobId)).todo.tasks[0]).toMatchObject({ kind: 'classify', status: 'verified' });

      // --- 2. Install on the site (the owner's hands), then Verify on the page -----
      const install = (await report(jobId)).todo.tasks.find((t) => t.id === 'install')!;
      site.state.head = install.snippet!.after;
      for (const f of ['complykit-consent.js', 'complykit-consent-ui.js']) site.state.clientFiles[f] = fs.readFileSync(path.join(ROOT, 'client', 'dist', f), 'utf8');
      const installItem = page.locator('li[data-task-id="install"]');
      await installItem.getByRole('button', { name: 'Verify' }).click();
      await installItem.locator('.rp-last').waitFor({ timeout: 90_000 });
      expect(await installItem.getAttribute('data-status'), (await installItem.locator('.rp-last').textContent()) ?? '').toBe('verified');

      // --- 3. The final scan opens up when everything above is done ---------------
      const final = page.getByTestId('final-scan').getByRole('button', { name: 'Run the final scan' });
      expect(await final.isDisabled()).toBe(true);
      for (;;) {
        const btn = page.locator('[data-testid="todo"] > ol > li.rp-todo[data-status="todo"] button', { hasText: /Mark done without checking|I’ve done this/ }).first();
        if (!(await btn.count())) break;
        const id = await btn.locator('xpath=ancestor::li[1]').getAttribute('data-task-id');
        await btn.click();
        await page.waitForFunction((tid) => document.querySelector(`li[data-task-id="${tid}"]`)?.getAttribute('data-status') !== 'todo', id);
      }
      await page.waitForFunction(() => !(document.querySelector('[data-testid="final-scan"] button') as HTMLButtonElement | null)?.disabled);
      await final.click();
      await page.waitForURL((u) => /#report\//.test(u.toString()) && jobIdOf(u.toString()) !== jobId);
      const rescanId = jobIdOf(page.url());
      await page.getByTestId('scan-status').waitFor();
      // Not waiting for the rescan: cancel it from its page.
      await page.getByTestId('scan-status').getByRole('button', { name: 'Cancel' }).click();
      for (const start = Date.now(); (await report(rescanId)).job.status === 'running' || (await report(rescanId)).job.status === 'queued'; ) {
        if (Date.now() - start > 30_000) throw new Error('the rescan did not stop');
        await page.waitForTimeout(200);
      }
      await page.getByTestId('scan-ended').waitFor();
    },
    SCAN_MS + 4 * 60_000,
  );
});
