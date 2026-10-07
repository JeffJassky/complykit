// POST /api/jobs/:id/consent-config (client-consent epic, ticket D8): turn a
// finished consent job's run into the consent tool config, with the site's
// CURRENT workspace (its classifications may be newer than the scan), and store
// the result as the workspace `config` — `{ value: { config, snippet,
// changeList, notes }, runId }`. The Sites page reads `config.value` and
// `config.value.changeList`.
//
// The generator is the complykit CLI (`consent-config <run-dir> --json`), like
// every other piece of complykit the service runs: the service never imports
// the package. Files land in <job>/consent/consent-config/ and are served under
// /reports/<jobId>/ with the rest of the job.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ConsentConfigRequest, ConsentConfigResponse, ConsentConfigValue, JobDetail } from '../shared/api.js';
import type { ServiceConfig } from './config.js';
import { WorkspaceError, type WorkspaceStore } from './workspace.js';

const CLI_TIMEOUT_MS = 120_000;
const MAX_STDOUT = 4 * 1024 * 1024;
const RUN_ID_RE = /^[0-9TZ:.-]{10,40}$/;

function text(v: unknown, field: string, max: number): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || v.length > max || /[\u0000-\u001f]/.test(v)) throw new WorkspaceError(400, `\`${field}\` must be a string of at most ${max} characters`);
  return v;
}

export interface ConsentConfigDeps {
  config: ServiceConfig;
  workspaces: WorkspaceStore;
  jobDir: string;
  /** This service's own origin, for `recordEndpoint: true`. */
  origin: string;
}

/** Generate and store. Throws WorkspaceError with the HTTP status for anything the caller asked wrong. */
export async function generateConsentConfigForJob(job: JobDetail, body: ConsentConfigRequest, deps: ConsentConfigDeps): Promise<ConsentConfigResponse> {
  const runId = job.result?.consent?.runId;
  if (job.status !== 'done' || !runId) throw new WorkspaceError(409, 'the job has no finished consent run');
  if (!RUN_ID_RE.test(runId)) throw new WorkspaceError(409, 'the job’s run id is not usable');
  const consentDir = path.join(deps.jobDir, 'consent');
  const runDir = path.join(consentDir, '.comply', 'runs', runId);
  if (!fs.existsSync(path.join(runDir, 'tracking.json'))) throw new WorkspaceError(409, 'the consent run’s evaluation is no longer on disk');

  const by = text(body.by, 'by', 80);
  const scriptSrc = text(body.scriptSrc, 'scriptSrc', 500);
  const privacyPolicyUrl = text(body.privacyPolicyUrl, 'privacyPolicyUrl', 500);
  const recordEndpoint = body.recordEndpoint === true ? `${deps.origin}/api/consent-records` : text(body.recordEndpoint, 'recordEndpoint', 500);

  const domain = deps.workspaces.domain(new URL(job.url).hostname);
  const ws = await deps.workspaces.get(domain);
  const outDir = path.join(consentDir, 'consent-config');
  await fsp.mkdir(outDir, { recursive: true });
  const wsFile = path.join(outDir, 'workspace.json');
  await fsp.writeFile(wsFile, JSON.stringify(ws, null, 2) + '\n');

  const args = ['consent-config', runDir, '--workspace', wsFile, '--out', outDir, '--json'];
  if (scriptSrc) args.push('--script-src', scriptSrc);
  if (recordEndpoint) args.push('--record-endpoint', recordEndpoint);
  if (privacyPolicyUrl) args.push('--privacy-policy', privacyPolicyUrl);
  const stdout = await runCli(deps.config, args);
  let printed: { config: Record<string, unknown>; snippet: string; changeList: string; notes: ConsentConfigValue['notes']; scriptSrc?: string; tasks?: ConsentConfigValue['tasks'] };
  try {
    printed = JSON.parse(stdout);
  } catch {
    throw new WorkspaceError(500, 'complykit consent-config printed something other than JSON');
  }
  const value: ConsentConfigValue = { config: printed.config, snippet: printed.snippet, changeList: printed.changeList, notes: printed.notes, ...(printed.scriptSrc ? { scriptSrc: printed.scriptSrc } : {}), ...(Array.isArray(printed.tasks) ? { tasks: printed.tasks } : {}) };
  const res = await deps.workspaces.patch(domain, { ...(by ? { by } : {}), config: { value, runId } });
  const rel = (f: string) => `/reports/${job.id}/consent/consent-config/${f}`;
  return {
    domain,
    runId,
    value,
    files: { config: rel('complykit-config.json'), snippet: rel('snippet.html'), changeList: rel('change-list.md'), notes: rel('generator-notes.md') },
    stale: res.stale.config,
  };
}

/** `node <cli> <args>` → stdout. Exit 2 = a bad request (400); anything else non-zero = ours (500). */
function runCli(config: ServiceConfig, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(config.cliPath)) {
      reject(new WorkspaceError(500, `complykit CLI not found at ${config.cliPath} (build complykit or set COMPLYKIT_CLI)`));
      return;
    }
    const child = spawn(process.execPath, [config.cliPath, ...args], { env: { ...process.env, COMPLYKIT_KB_DIR: config.kbDir }, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let bytes = 0;
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (c: Buffer) => {
      bytes += c.length;
      if (bytes > MAX_STDOUT) child.kill('SIGKILL');
      else out.push(c);
    });
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
      reject(new WorkspaceError(500, `complykit consent-config: ${err.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const tail = stderr.trim().split('\n').slice(-5).join('\n').replace(/^complykit: /, '');
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else if (timedOut) reject(new WorkspaceError(500, `complykit consent-config timed out after ${CLI_TIMEOUT_MS / 1000}s`));
      else if (code === 2) reject(new WorkspaceError(400, tail || 'complykit consent-config: invalid request'));
      else reject(new WorkspaceError(500, tail || `complykit consent-config exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
    });
  });
}
