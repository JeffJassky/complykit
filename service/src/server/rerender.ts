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

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ConsentConfigRequest, JobDetail, RerenderRequest, RerenderResponse, SiteWorkspace } from '../shared/api.js';
import type { ServiceConfig } from './config.js';
import { generateConsentConfigForJob } from './consent-config.js';
import { WorkspaceError, type WorkspaceStore } from './workspace.js';

const CLI_TIMEOUT_MS = 120_000;
const RUN_ID_RE = /^[0-9TZ:.-]{10,40}$/;
/** The generator's placeholder path: passing it explicitly would change the snippet's note, so it is never carried over. */
const DEFAULT_SCRIPT_SRC = '/complykit/v1/complykit-consent.js';
const REPORT = 'consent-report.html';
const SIBLINGS = ['consent-report.json', 'change-list.md'];

export interface RerenderDeps {
  config: ServiceConfig;
  workspaces: WorkspaceStore;
  jobDir: (id: string) => string;
  origin: string;
}

const prevName = (f: string): string => f.replace(/(\.[a-z]+)$/i, '.prev$1');
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// One re-render per job at a time: a second click waits for the first.
const running = new Map<string, Promise<unknown>>();

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
  const jobDir = deps.jobDir(job.id);
  const consentDir = path.join(jobDir, 'consent');
  const runDir = path.join(consentDir, '.comply', 'runs', runId);
  if (!fs.existsSync(path.join(runDir, 'tracking.json'))) throw new WorkspaceError(409, 'the consent run’s evaluation is no longer on disk');
  const by = body.by === undefined || body.by === null || body.by === '' ? undefined : body.by;
  if (by !== undefined && (typeof by !== 'string' || by.length > 80 || /[\u0000-\u001f]/.test(by))) throw new WorkspaceError(400, '`by` must be a string of at most 80 characters');

  const domain = deps.workspaces.domain(new URL(job.url).hostname);
  let ws = await deps.workspaces.get(domain);

  if (body.generate !== undefined && typeof body.generate !== 'boolean') throw new WorkspaceError(400, '`generate` must be a boolean');
  // The stored config follows the classification when it came from this run;
  // `generate: true` (the report's Generate button) makes it from this run in any case.
  let config: RerenderResponse['config'] = { regenerated: false };
  let storedAt: string | undefined;
  const fromThisRun = ws.config?.runId === runId && isObj(ws.config.value);
  if (fromThisRun || body.generate === true) {
    const options = isObj(ws.config?.value) ? storedOptions(ws.config.value, by ?? (fromThisRun ? ws.config.by : undefined)) : by ? { by } : {};
    const out = await generateConsentConfigForJob(job, options, { config: deps.config, workspaces: deps.workspaces, jobDir, origin: deps.origin });
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
    throw new WorkspaceError(err.status, err.message, { configStored: true, configAt: storedAt });
  }
}

async function renderReport(job: JobDetail, runId: string, ws: SiteWorkspace, deps: RerenderDeps): Promise<Omit<RerenderResponse, 'config'>> {
  const jobDir = deps.jobDir(job.id);
  const consentDir = path.join(jobDir, 'consent');
  const runDir = path.join(consentDir, '.comply', 'runs', runId);

  const work = path.join(consentDir, 'rerender');
  await fsp.mkdir(work, { recursive: true });
  const wsFile = path.join(work, 'workspace.json');
  await fsp.writeFile(wsFile, JSON.stringify(ws, null, 2) + '\n');
  const tmp = path.join(work, REPORT);
  await Promise.all([REPORT, ...SIBLINGS].map((f) => fsp.rm(path.join(work, f), { force: true })));

  const args = ['report', '--run', runId, '--cwd', consentDir, '--format', 'consent-html', '--workspace', wsFile, '--out', tmp];
  const previous = previousRunDir(ws.runs, runId, job.id, deps.jobDir);
  if (previous) args.push('--previous', previous);
  await runCli(deps.config, args);
  if (!fs.existsSync(tmp)) throw new WorkspaceError(500, 'complykit report wrote no report');

  // Swap in: keep one previous generation of each file, then move the new ones over.
  for (const f of [REPORT, ...SIBLINGS]) {
    const fresh = path.join(work, f);
    if (!fs.existsSync(fresh)) continue;
    const served = path.join(runDir, f);
    if (fs.existsSync(served)) await fsp.copyFile(served, path.join(runDir, prevName(f)));
    await fsp.rename(fresh, served);
  }
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

/** The options the stored config was generated with, read back from it. */
function storedOptions(value: Record<string, unknown>, by: string | undefined): ConsentConfigRequest {
  const cfg = isObj(value.config) ? value.config : {};
  const record = isObj(cfg.record) && typeof cfg.record.endpoint === 'string' ? cfg.record.endpoint : undefined;
  const scriptSrc = typeof value.scriptSrc === 'string' && value.scriptSrc !== DEFAULT_SCRIPT_SRC ? value.scriptSrc : undefined;
  return {
    ...(by ? { by } : {}),
    ...(scriptSrc ? { scriptSrc } : {}),
    ...(record ? { recordEndpoint: record } : {}),
    ...(typeof cfg.privacyPolicyUrl === 'string' ? { privacyPolicyUrl: cfg.privacyPolicyUrl } : {}),
  };
}

/** The run the scan compared with ("Since"): the newest earlier run of the site whose job directory is still on disk. */
function previousRunDir(runs: Array<{ id: string; at: string; jobId?: string }>, runId: string, jobId: string, jobDir: (id: string) => string): string | undefined {
  const self = runs.find((r) => r.id === runId);
  for (const r of [...runs].reverse()) {
    if (!r.jobId || r.jobId === jobId || r.id === runId) continue;
    if (self && r.at >= self.at) continue;
    const dir = path.join(jobDir(r.jobId), 'consent', '.comply', 'runs', r.id);
    if (fs.existsSync(path.join(dir, 'tracking.json'))) return dir;
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
