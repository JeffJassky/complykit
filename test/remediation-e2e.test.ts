/// <reference path="../service/src/server/archiver.d.ts" />
// R6: the guided remediation flow end to end, for real — the built CLI
// (dist/cli.js), the built consent client (client/dist), the service in-process
// (temp DATA_DIR), a browser, and a fixture storefront on 127.0.0.1
// (test/fixtures/remediation-e2e-site.ts) that the test edits the way an owner
// would while following the checklist:
//
//   scan → classify the unknown widget (PATCH) → re-render → generate the config
//   → the checklist (install first, remove the old consent tool, rewrite the
//   tags, remove the leak) → Verify install fails → apply the zip's snippet and
//   client files, remove the old tool, rewrite the tags, remove the leak, Verify
//   each → pass (statuses persisted) → rescan → the report's proof section says
//   the gated vendors are controlled, with its scope, and nothing is "not
//   controlled".
//
// One location (the fixture's geolocation answers say Germany), --quick
// (do-nothing, reject, accept), one run per scenario (consentRuns 1).
// Honours COMPLYKIT_BROWSER_CHANNEL (e.g. chrome). Skips, visibly, without a
// browser, without the builds (`npm run build`, `npm --prefix client run
// build`) or without openssl (the fixture's throwaway TLS certificate).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { classificationKey } from '../src/site-workspace.js';
import { startE2eSite, opensslAvailable, SITE, GTAG_SRC, PIXEL_SRC, WIDGET_SRC, type E2eSite } from './fixtures/remediation-e2e-site.js';
import { clientBuilt } from './fixtures/proof-site.js';
import { startService, stopAll, waitForStatus } from '../service/test/helpers.js';
import type { Service } from '../service/src/server/app.js';
import type { ConsentConfigResponse, CreateBatchResponse, RemediationResponse, RemediationTask, RerenderResponse, RescanResponse, SitesResponse, SiteWorkspace, VerifyTaskResponse } from '../service/src/shared/api.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');

let browser = false;
try {
  const { chromium } = await import('playwright');
  browser = fs.existsSync(chromium.executablePath());
} catch {
  browser = false;
}
browser ||= Boolean(process.env.COMPLYKIT_BROWSER_CHANNEL);
const missing = [!browser && 'a browser (Playwright Chromium or COMPLYKIT_BROWSER_CHANNEL)', !fs.existsSync(CLI) && 'dist/cli.js (npm run build)', !clientBuilt() && 'client/dist (npm --prefix client run build)', !opensslAvailable() && 'openssl'].filter(Boolean);
if (missing.length) console.warn(`remediation e2e skipped: needs ${missing.join(', ')}`);
const suite = missing.length ? describe.skip : describe;

const SCAN_MS = 4 * 60_000;

/** The checklist for the fixture storefront, in order (one optional item last). */
const E2E_TITLES = [
  'Install the complykit consent tool',
  'Remove your old consent banner (OneTrust)',
  'Hold the Google Tag Manager / gtag.js script until consent',
  'Hold the Google Analytics 4 tag until consent',
  'Hold the Meta Pixel tag until consent',
  'Hold the e2e-widgets.test tag until consent',
  'Delete the Meta Pixel no-JavaScript fallback',
  'Start Google’s consent signals as “denied”',
  'Remove or hold the YouTube embed',
];

suite('remediation flow, end to end (real CLI, service, browser, fixture site)', () => {
  let site: E2eSite;
  let service: Service;
  let server: Server;
  let base: string;
  let prevArgs: string | undefined;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'complykit-e2e-'));

  beforeAll(async () => {
    site = await startE2eSite();
    // The CLI children (scan, verify-change) inherit the environment: the fixture's host mapping.
    prevArgs = process.env.COMPLYKIT_BROWSER_ARGS;
    process.env.COMPLYKIT_BROWSER_ARGS = site.launchArgs.join(' ');
    service = await startService({ cliPath: CLI, consentRuns: 1, pollMs: 250, concurrency: 1, killGraceMs: 2000 });
    server = service.app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (prevArgs === undefined) delete process.env.COMPLYKIT_BROWSER_ARGS;
    else process.env.COMPLYKIT_BROWSER_ARGS = prevArgs;
    await new Promise((r) => server?.close(r));
    await stopAll();
    await site?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function api<T>(method: string, url: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await fetch(base + url, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* html, markdown */
    }
    return { status: res.status, body: parsed as T };
  }
  async function scanDone(id: string): Promise<string> {
    const job = await waitForStatus(service, id, ['done', 'failed', 'cancelled'], SCAN_MS);
    expect(job.status, `job ${id}: ${job.error ?? ''}\n${job.log.slice(-30).join('\n')}`).toBe('done');
    return job.result!.consent!.reportUrl;
  }
  const remediation = async (): Promise<RemediationTask[]> => (await api<RemediationResponse>('GET', `/api/sites/${SITE}/remediation`)).body.tasks;
  async function verify(task: RemediationTask): Promise<VerifyTaskResponse> {
    const r = await api<VerifyTaskResponse>('POST', `/api/sites/${SITE}/remediation/${encodeURIComponent(task.id)}/verify`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body;
  }
  const expectPass = async (task: RemediationTask): Promise<void> => {
    const v = await verify(task);
    expect(v.outcome.result, `${task.id}: ${v.outcome.message} ${v.outcome.evidence.join(' | ')}`).toBe('pass');
    expect(v.task.status).toBe('verified');
  };
  /** A rewrite-tag task's verify spec (the service passes complykit's spec through; typed loosely there). */
  interface RewriteSpec {
    check: 'rewrite-tag';
    category: string;
    element: { host?: string; path?: string; inline?: { match: string } };
  }
  const rewriteSpec = (t: RemediationTask): RewriteSpec => {
    expect(t.verify.check).toBe('rewrite-tag');
    return t.verify as unknown as RewriteSpec;
  };
  /** The fixture script src a rewrite-tag task's element signature names. */
  const srcOf = (spec: RewriteSpec): string | undefined => [GTAG_SRC, PIXEL_SRC, WIDGET_SRC].find((s) => spec.element.host && new URL(s).host === spec.element.host && new URL(s).pathname === spec.element.path);

  it(
    'scan → classify → re-render → generate → checklist → fix and verify each change → rescan: the gated vendors are controlled',
    async () => {
      // --- 1. Scan --------------------------------------------------------------
      const created = await api<CreateBatchResponse>('POST', '/api/batches', { urls: site.url, quick: true });
      expect(created.status).toBe(201);
      const jobId = created.body.jobs[0].id;
      const firstReport = await scanDone(jobId);

      // --- 2. Classify the unknown widget (the report's workbench writes this same entry) ---
      const widget = { kind: 'tool' as const, partyId: 'unknown:e2e-widgets.test', domain: 'e2e-widgets.test', recognized: false };
      const key = classificationKey(widget); // 'class:<hash>'
      const report1 = (await api<string>('GET', firstReport)).body;
      expect(report1).toContain(`data-class-key="${key.slice('class:'.length)}"`);
      expect((await api('PATCH', `/api/sites/${SITE}/workspace`, { by: 'e2e', entries: { [key]: { value: { category: 'analytics', categoryChosen: true } } } })).status).toBe(200);

      // --- 3. Re-render (R2): the report reads the classification, no rescan -----
      const rr = await api<RerenderResponse>('POST', `/api/jobs/${jobId}/rerender`, {});
      expect(rr.status, JSON.stringify(rr.body)).toBe(200);
      expect(rr.body).toMatchObject({ ok: true, classifications: 1, config: { regenerated: false } });

      // --- 4. Generate the config: stored with tasks + scriptSrc ------------------
      const gen = await api<ConsentConfigResponse>('POST', `/api/jobs/${jobId}/consent-config`, { by: 'e2e' });
      expect(gen.status, JSON.stringify(gen.body)).toBe(200);
      const ws = (await api<SiteWorkspace>('GET', `/api/sites/${SITE}/workspace`)).body;
      const stored = ws.config!.value as { tasks?: RemediationTask[]; scriptSrc?: string; snippet: string };
      expect(stored.scriptSrc).toBe('/complykit/v1/complykit-consent.js');
      expect(stored.tasks?.length).toBeGreaterThan(4);

      // --- 5. The checklist ---------------------------------------------------------
      let tasks = await remediation();
      const kinds = tasks.map((t) => t.kind);
      expect(tasks[0].id).toBe('install');
      expect(tasks[1].kind).toBe('remove-existing-tool');
      expect(kinds).toContain('rewrite-tag');
      expect(kinds).toContain('remove-leak');
      // Short and unambiguous: what another task already fixes is folded into it, not listed again.
      console.log(`remediation e2e checklist:\n${tasks.map((t, i) => `  ${i + 1}. ${t.title}${t.optional ? ' (optional)' : ''}${t.alsoFixes?.length ? `\n       also fixes: ${t.alsoFixes.join(' | ')}` : ''}`).join('\n')}`);
      expect(kinds).not.toContain('behavior-mismatch');
      expect(kinds).not.toContain('call-consent-api');
      expect(kinds).not.toContain('confirm-in-browser'); // every folded tool has a static check (its tag)
      expect(tasks.map((t) => t.title)).toEqual(E2E_TITLES);
      expect(tasks[0].alsoFixes?.join(' ')).toMatch(/Telling Google Analytics 4 the visitor’s choice/);
      const ga = tasks.find((t) => t.kind === 'rewrite-tag' && t.partyIds.includes('google.analytics'))!;
      expect(ga.aliases?.some((a) => a.startsWith('behavior-mismatch:'))).toBe(true);
      // The tool sets Google's default (its google-consent-mode adapter): nothing to paste.
      const def = tasks.find((t) => t.kind === 'set-consent-default')!;
      expect(def.steps[0]).toMatch(/^Nothing to paste — the complykit tool sets this/);
      expect(def.snippet).toBeUndefined();
      for (const t of tasks) expect(`${t.title} ${t.summary} ${t.steps.join(' ')}`).not.toMatch(/\bcompliant\b/i);
      const rewrites = tasks.filter((t) => t.kind === 'rewrite-tag');
      // The classified widget's tag is held under the team's category, not the strictest one.
      const widgetTask = rewrites.find((t) => t.partyIds.includes(widget.partyId))!;
      expect(rewriteSpec(widgetTask).category).toBe('analytics');
      // Generator and report reconcile the same way: after a re-render (which regenerates
      // the config, it came from this run), every change-list item in the report is a task.
      const rr2 = await api<RerenderResponse>('POST', `/api/jobs/${jobId}/rerender`, {});
      expect(rr2.body.config.regenerated).toBe(true);
      tasks = await remediation();
      const report2 = (await api<string>('GET', firstReport)).body;
      const changeIds = new Set([...report2.matchAll(/data-change-id="([a-z-]+:[0-9a-f]{12})"/g)].map((m) => m[1]));
      expect(changeIds.size).toBeGreaterThan(0);
      // Each change-list item is a task, or folded into one (its id kept as an alias).
      const known = tasks.flatMap((t) => [t.id, ...(t.aliases ?? [])]);
      for (const id of changeIds) expect(known).toContain(id);
      const cardIds = new Set([...report2.matchAll(/data-remediation-id="(install|[a-z-]+:[0-9a-f]{12})"/g)].map((m) => m[1]));
      expect([...cardIds].sort()).toEqual(tasks.map((t) => t.id).sort());
      expect(report2).toContain(`data-rem-config-at="${(await api<SiteWorkspace>('GET', `/api/sites/${SITE}/workspace`)).body.config!.at}"`);

      // --- 6. Verify the install before it is done: fail -----------------------------
      const install = tasks[0];
      const before = await verify(install);
      expect(before.outcome.result).toBe('fail');
      expect(before.task.status).toBe('failed');

      // --- 7. Install: the zip's snippet first in <head>, its client files at /complykit/v1/ ---
      const zipRes = await fetch(`${base}/api/sites/${SITE}/install.zip`);
      expect(zipRes.status).toBe(200);
      const zipFile = path.join(tmp, 'install.zip');
      fs.writeFileSync(zipFile, Buffer.from(await zipRes.arrayBuffer()));
      const unzipped = path.join(tmp, 'install');
      execFileSync('unzip', ['-o', '-q', zipFile, '-d', unzipped]);
      const files = fs.readdirSync(unzipped, { recursive: true }).map(String);
      for (const f of ['complykit-consent.js', 'complykit-consent-ui.js']) {
        const rel = files.find((x) => path.basename(x) === f);
        expect(rel, `${f} in the zip (${files.join(', ')})`).toBeDefined();
        site.state.clientFiles[f] = fs.readFileSync(path.join(unzipped, rel!), 'utf8');
      }
      expect(fs.readFileSync(path.join(unzipped, 'snippet.html'), 'utf8')).toContain(install.snippet!.after!);
      site.state.head = install.snippet!.after!;
      await expectPass(install);

      // --- 8. Remove the old consent tool ------------------------------------------------
      site.state.oldToolRemoved = true;
      for (const t of tasks.filter((x) => x.kind === 'remove-existing-tool')) await expectPass(t);

      // --- 9. Rewrite every tag the checklist names ---------------------------------------
      for (const t of rewrites) {
        const spec = rewriteSpec(t);
        const src = srcOf(spec);
        if (src) site.state.held[src] = spec.category;
        else if (spec.element.inline) site.state.held['inline:gtag'] = spec.category;
        else throw new Error(`no fixture tag for ${t.id}`);
      }
      for (const t of rewrites) await expectPass(t);

      // --- 10. Remove the leak --------------------------------------------------------------
      site.state.leakRemoved = true;
      for (const t of tasks.filter((x) => x.kind === 'remove-leak' && !x.optional)) await expectPass(t);

      // --- 11. The rest: what Verify can check (the Consent Mode default comes with the tool;
      // spot checks reject then accept on the page), the rest marked done by the owner. ---
      for (const t of tasks.filter((x) => !x.optional && !['install', 'remove-existing-tool', 'rewrite-tag', 'remove-leak'].includes(x.kind))) {
        if (t.verify.method === 'manual') {
          expect((await api('PATCH', `/api/sites/${SITE}/workspace`, { by: 'e2e', entries: { [`task:change:${t.id}`]: { value: { status: 'done-unverified', note: 'decided with counsel' } } } })).status).toBe(200);
        } else {
          await expectPass(t);
        }
      }

      // --- 12. Statuses persisted (workspace entries, not the tasks), progress on the sites list ---
      tasks = await remediation();
      const required = tasks.filter((t) => !t.optional && !t.classifyFirst);
      for (const t of required) expect(['verified', 'done-unverified'], `${t.id} is ${t.status}`).toContain(t.status);
      expect(tasks.find((t) => t.id === 'install')!.lastVerify?.result).toBe('pass');
      const row = (await api<SitesResponse>('GET', '/api/sites')).body.sites.find((s) => s.domain === SITE)!;
      expect(row.checklist).toMatchObject({ required: required.length, verified: required.filter((t) => t.status === 'verified').length, failed: 0 });

      // --- 13. Rescan (the owner keeps quick, as the last job); the proof section has the final word ---
      const rescan = await api<RescanResponse>('POST', `/api/sites/${SITE}/rescan`, { quick: true });
      expect(rescan.status, JSON.stringify(rescan.body)).toBe(201);
      expect(rescan.body.from).toMatchObject({ jobId, url: site.url, quick: true, checks: ['consent'] });
      expect(rescan.body.job.quick).toBe(true);
      const finalReport = (await api<string>('GET', await scanDone(rescan.body.job.id))).body;
      const proof = /<section id="consent-tool-proof"[\s\S]*?<\/section>/.exec(finalReport)?.[0] ?? '';
      expect(proof).toContain('data-detected="true"');
      expect(proof).toContain('data-not-controlled="0"');
      expect(proof).toContain('It covers the pages, locations and visitor actions tested here');
      const results = Object.fromEntries([...proof.matchAll(/data-proof-vendor="([^"]+)" data-result="([^"]+)"/g)].map((m) => [m[1], m[2]]));
      for (const v of ['google.analytics', 'meta.pixel', widget.partyId]) expect(results[v], `${v}: ${JSON.stringify(results)}`).toBe('controlled');
      expect(Object.values(results)).not.toContain('not-controlled');
      expect(finalReport).not.toMatch(/\bcompliant\b/i);
    },
    15 * 60_000,
  );
});
