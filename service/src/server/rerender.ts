// POST /api/jobs/:id/rerender (remediation flow R2, plans/remediation-flow.md):
// re-render a finished consent job's report from its SAVED run with the site's
// CURRENT workspace — the compatibility section, the change list, the
// checklist and the matrix purposes follow the latest classifications in
// seconds, without a rescan. `complykit report --format consent-html
// --workspace <file>` does the work (the service never imports the package).
//
// The new report replaces the served one (<run>/consent-report.html, with its
// change-list.md and .json beside it); the previous files are kept once as
// *.prev.*. When the site's stored consent-tool config was generated from this
// run (or the request says `generate: true`), it is regenerated first with the
// same options, so config.value (config, snippet, change list, checklist)
// follows the classification too. Task status lives in task:change:<id>
// entries, not in config.value.tasks, and ids are content hashes: a
// regeneration that changes nothing keeps every task's status.
//
// When the config was generated and stored but the report could not be
// re-rendered, the error says so (`configStored: true`, RerenderErrorBody):
// the checklist exists, and "Update report" (a rerender without generate)
// is the retry.
//
// Where it runs (plans/do-hosting.md): in the job's scratch. With the fs backend
// that is the job's own directory, as always. With the cloud backend the run's
// evaluation (no HARs; screenshots stay, the report inlines them) is downloaded
// first, the changed files are uploaded after, and the scratch is deleted. One
// at a time per process: the largest site peaks near 1 GB.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ConsentConfigRequest, JobDetail, RerenderRequest, RerenderResponse, SiteWorkspace } from '../shared/api.js';
import type { ServiceConfig } from './config.js';
import { generateStagedConsentConfig } from './consent-config.js';
import { RUN_ID_RE, type JobFiles } from './job-files.js';
import { WorkspaceError, type WorkspaceStore } from './workspace.js';

const CLI_TIMEOUT_MS = 120_000;
const REPORT = 'consent-report.html';
const SIBLINGS = ['consent-report.json', 'change-list.md', 'owner-report.json'];

export interface RerenderDeps {
  config: ServiceConfig;
  workspaces: WorkspaceStore;
  /** The job's files: the CLI runs in its scratch; a finished job's evaluation is fetched from blobs and the changed files are put back. */
  files: JobFiles;
}

/** Upload order: previous copies first, then the side files, the data, and the pages readers open last (the owner report is the final switch). */
function commitOrder(files: string[]): string[] {
  const rank = (f: string): number => (/\.prev\./.test(f) ? 0 : f === 'consent-report.json' ? 2 : f === REPORT ? 3 : f === 'owner-report.json' ? 4 : 1);
  return [...files].sort((a, b) => rank(a) - rank(b));
}

const prevName = (f: string): string => f.replace(/(\.[a-z]+)$/i, '.prev$1');
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// One re-render per job at a time: a second click waits for the first.
const running = new Map<string, Promise<unknown>>();

/** A re-render of this job is running or queued (the report page says "Updating…"). */
export function rerenderRunning(jobId: string): boolean {
  return running.has(jobId);
}

export function rerenderJob(job: JobDetail, body: RerenderRequest, deps: RerenderDeps): Promise<RerenderResponse> {
  const prev = running.get(job.id) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(() => rerender(job, body, deps));
  running.set(job.id, next);
  void next.finally(() => {
    if (running.get(job.id) === next) running.delete(job.id);
  }).catch(() => undefined);
  return next;
}

async function rerender(job: JobDetail, body: RerenderRequest, deps: RerenderDeps): Promise<RerenderResponse> {
  const runId = job.result?.consent?.runId;
  if (job.status !== 'done' || !runId) throw new WorkspaceError(409, 'the job has no finished consent run');
  if (!RUN_ID_RE.test(runId)) throw new WorkspaceError(409, 'the job’s run id is not usable');
  const { files } = deps;
  await files.wait(job.id); // the job's files are in blobs once its publish has finished
  if (!(await files.head(job, `consent/.comply/runs/${runId}/tracking.json`))) throw new WorkspaceError(409, 'the consent run’s evaluation is no longer on disk');
  const by = body.by === undefined || body.by === null || body.by === '' ? undefined : body.by;
  if (by !== undefined && (typeof by !== 'string' || by.length > 80 || /[\u0000-\u001f]/.test(by))) throw new WorkspaceError(400, '`by` must be a string of at most 80 characters');
  if (body.generate !== undefined && typeof body.generate !== 'boolean') throw new WorkspaceError(400, '`generate` must be a boolean');

  const domain = deps.workspaces.domain(new URL(job.url).hostname);
  return files.exclusive(async () => {
    try {
      await files.stage(job);
      let ws = await deps.workspaces.get(domain);

      // The stored config follows the classification when it came from this run;
      // `generate: true` (the report's Generate button) makes it from this run in any case.
      let config: RerenderResponse['config'] = { regenerated: false };
      let storedAt: string | undefined;
      const fromThisRun = ws.config?.runId === runId && isObj(ws.config.value);
      if (fromThisRun || body.generate === true) {
        const options = isObj(ws.config?.value) ? storedOptions(ws.config.value, by ?? (fromThisRun ? ws.config.by : undefined)) : by ? { by } : {};
        const out = await generateStagedConsentConfig(job, options, { config: deps.config, workspaces: deps.workspaces, files });
        config = { regenerated: true, stale: out.stale };
        ws = await deps.workspaces.get(domain);
        if (!out.stale) storedAt = ws.config?.at;
      }

      try {
        return { ...(await renderReport(job, runId, ws, deps)), config };
      } catch (err) {
        // The config (and so the checklist) is stored; only the report could not follow.
        // Say exactly that, so the client offers "Update report" instead of a generic failure.
        if (storedAt === undefined || !(err instanceof WorkspaceError)) throw err;
        throw new WorkspaceError(err.status, err.message, { ...err.extra, configStored: true, configAt: storedAt });
      }
    } finally {
      await files.clean(job.id);
    }
  });
}

async function renderReport(job: JobDetail, runId: string, ws: SiteWorkspace, deps: RerenderDeps): Promise<Omit<RerenderResponse, 'config'>> {
  const { files } = deps;
  const consentDir = path.join(files.scratchDir(job.id), 'consent');
  const runDir = path.join(consentDir, '.comply', 'runs', runId);

  const work = path.join(consentDir, 'rerender');
  await fsp.mkdir(work, { recursive: true });
  const wsFile = path.join(work, 'workspace.json');
  await fsp.writeFile(wsFile, JSON.stringify(ws, null, 2) + '\n');
  const tmp = path.join(work, REPORT);
  await Promise.all([REPORT, ...SIBLINGS].map((f) => fsp.rm(path.join(work, f), { force: true })));

  const args = ['report', '--run', runId, '--cwd', consentDir, '--format', 'consent-html', '--workspace', wsFile, '--out', tmp];
  const previous = await previousRunDir(ws.runs, runId, job.id, files);
  if (previous) args.push('--previous', previous);
  await runCli(deps.config, args);
  if (!fs.existsSync(tmp)) throw new WorkspaceError(500, 'complykit report wrote no report');

  // Swap in: keep one previous generation of each file, then move the new ones over.
  const changed: string[] = [];
  for (const f of [REPORT, ...SIBLINGS]) {
    const fresh = path.join(work, f);
    if (!fs.existsSync(fresh)) continue;
    const served = path.join(runDir, f);
    if (fs.existsSync(served)) {
      await fsp.copyFile(served, path.join(runDir, prevName(f)));
      changed.push(prevName(f));
    }
    await fsp.rename(fresh, served);
    changed.push(f);
  }
  await files.commit(job, commitOrder(changed).map((f) => `consent/.comply/runs/${runId}/${f}`));
  const rel = (f: string) => `/reports/${job.id}/consent/.comply/runs/${encodeURIComponent(runId)}/${f}`;
  return {
    ok: true,
    at: new Date().toISOString(),
    runId,
    reportUrl: rel(REPORT),
    previousReportUrl: rel(prevName(REPORT)),
    classifications: Object.keys(ws.entries).filter((k) => k.startsWith('class:') && ws.entries[k].value !== null).length,
  };
}

/** The options the stored config was generated with, read back from it (the privacy policy link). */
function storedOptions(value: Record<string, unknown>, by: string | undefined): ConsentConfigRequest {
  const cfg = isObj(value.config) ? value.config : {};
  // The script URL and record endpoint are the service's own (config.publicOrigin), never carried over.
  return {
    ...(by ? { by } : {}),
    ...(typeof cfg.privacyPolicyUrl === 'string' ? { privacyPolicyUrl: cfg.privacyPolicyUrl } : {}),
  };
}

/** The run the scan compared with ("Since"): the newest earlier run of the site whose evaluation is still stored (staged into this job's scratch with the cloud backend). */
async function previousRunDir(runs: Array<{ id: string; at: string; jobId?: string }>, runId: string, jobId: string, files: JobFiles): Promise<string | undefined> {
  const self = runs.find((r) => r.id === runId);
  for (const r of [...runs].reverse()) {
    if (!r.jobId || r.jobId === jobId || r.id === runId) continue;
    if (self && r.at >= self.at) continue;
    const dir = await files.previousRunDir(jobId, r.jobId, r.id);
    if (dir) return dir;
  }
  return undefined;
}

/** `node <cli> <args>`. Exit 2 = a bad request (400); anything else non-zero = ours (500). */
function runCli(config: ServiceConfig, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(config.cliPath)) {
      reject(new WorkspaceError(500, `complykit CLI not found at ${config.cliPath} (build complykit or set COMPLYKIT_CLI)`));
      return;
    }
    const child = spawn(process.execPath, [config.cliPath, ...args], { env: { ...process.env, COMPLYKIT_KB_DIR: config.kbDir }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let timedOut = false;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => {
      stderr = (stderr + c).slice(-8192);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, CLI_TIMEOUT_MS);
    timer.unref();
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new WorkspaceError(500, `complykit report: ${err.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const tail = stderr.trim().split('\n').slice(-5).join('\n').replace(/^complykit: /, '');
      if (code === 0) resolve();
      else if (timedOut) reject(new WorkspaceError(500, `complykit report timed out after ${CLI_TIMEOUT_MS / 1000}s`));
      else if (code === 2) reject(new WorkspaceError(400, tail || 'complykit report: invalid request'));
      else reject(new WorkspaceError(500, tail || `complykit report exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
    });
  });
}
