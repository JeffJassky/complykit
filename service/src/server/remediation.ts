// The guided remediation checklist (plans/remediation-flow.md §7, ticket R4):
//
//   GET  /api/sites/:domain/remediation          the stored checklist (config.value.tasks)
//                                                with each task's status from its
//                                                `task:change:<id>` entry — a pure merge
//   POST /api/sites/:domain/remediation/:id/verify  runs `complykit verify-change` on the
//                                                task (one page / one container / one
//                                                spot check) and stores { status,
//                                                lastVerify } under task:change:<id>, by 'verify'
//
// One verify per site at a time: a second request while one runs is a 409 (the
// browser is the expensive part, and two verifies of one site would race on the
// same entry). Like every other piece of complykit here, the check is the CLI:
// the service never imports the package.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classificationDecided } from '../shared/api.js';
import type {
  RemediationLastVerify,
  RemediationResponse,
  RemediationStatus,
  RemediationTask,
  RemediationTaskValue,
  RemediationTotals,
  SiteWorkspace,
  VerifyResult,
  VerifyTaskResponse,
} from '../shared/api.js';
import type { ServiceConfig } from './config.js';
import { WorkspaceError, type WorkspaceStore } from './workspace.js';

export const REMEDIATION_TASK_KEY_PREFIX = 'task:change:';
/** A spot check is budgeted 60 s by the CLI; the launch and the JSON come on top. */
const CLI_TIMEOUT_MS = 90_000;
const MAX_STDOUT = 1024 * 1024;
const MAX_TASK_ID = 120;

const STATUSES = new Set<RemediationStatus>(['todo', 'done-unverified', 'verified', 'failed', 'cannot-verify']);
const RESULTS = new Set<VerifyResult>(['pass', 'fail', 'cannot-verify']);
// The report workbench's own vocabulary: 'done' marked there is done-unverified here, never verified.
const LEGACY: Record<string, RemediationStatus> = { open: 'todo', 'in-progress': 'todo', done: 'done-unverified' };
const STATUS_OF: Record<VerifyResult, RemediationStatus> = { pass: 'verified', fail: 'failed', 'cannot-verify': 'cannot-verify' };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const remediationTaskKey = (id: string): string => REMEDIATION_TASK_KEY_PREFIX + id;

function lastVerifyOf(v: unknown): RemediationLastVerify | undefined {
  if (!isObject(v) || typeof v.at !== 'string' || typeof v.message !== 'string' || !RESULTS.has(v.result as VerifyResult)) return undefined;
  return { at: v.at, result: v.result as VerifyResult, message: v.message, evidence: Array.isArray(v.evidence) ? v.evidence.filter((e): e is string => typeof e === 'string') : [] };
}

/** A `task:change:<id>` value as the checklist reads it; undefined when it carries no status. */
export function readTaskValue(value: unknown): RemediationTaskValue | undefined {
  if (!isObject(value) || typeof value.status !== 'string') return undefined;
  const status = LEGACY[value.status] ?? (STATUSES.has(value.status as RemediationStatus) ? (value.status as RemediationStatus) : undefined);
  if (!status) return undefined;
  const out: RemediationTaskValue = { status };
  if (typeof value.note === 'string') out.note = value.note;
  const lv = lastVerifyOf(value.lastVerify);
  if (lv) out.lastVerify = lv;
  return out;
}

/** The stored checklist (config.value.tasks), or [] before a config with tasks exists. */
export function storedTasks(ws: SiteWorkspace): RemediationTask[] {
  const v = ws.config?.value;
  const tasks = isObject(v) ? v.tasks : undefined;
  if (!Array.isArray(tasks)) return [];
  return tasks.filter((t): t is RemediationTask => isObject(t) && typeof t.id === 'string' && isObject(t.verify));
}

/**
 * A task's workspace value: its own entry, else the first one stored under an
 * alias (an item folded into it). A carried `verified` reads as done-unverified
 * unless the task's own check is a spot check, like the item's was — the same
 * rule as complykit's resolveRemediationTaskValue.
 */
export function taskValue(t: Pick<RemediationTask, 'id' | 'aliases' | 'verify' | 'classKey'>, ws: SiteWorkspace): RemediationTaskValue | undefined {
  // A decision (kind 'classify'): decided when the workspace holds a purpose for the tool — nothing else.
  if (t.classKey) return { status: classificationDecided(ws.entries[t.classKey]?.value) ? 'verified' : 'todo' };
  const own = ws.entries[remediationTaskKey(t.id)];
  if (own) return readTaskValue(own.value);
  for (const a of t.aliases ?? []) {
    const v = readTaskValue(ws.entries[remediationTaskKey(a)]?.value);
    if (v) return v.status === 'verified' && t.verify.check !== 'spot-check' ? { ...v, status: 'done-unverified' } : v;
  }
  return undefined;
}

/** Each task with the status / note / lastVerify its workspace entry holds (the stored task's own status is the default). */
export function mergeTaskStatus(tasks: RemediationTask[], ws: SiteWorkspace): RemediationTask[] {
  return tasks.map((t) => {
    const v = taskValue(t, ws);
    if (!v) return { ...t, status: STATUSES.has(t.status) ? t.status : 'todo' };
    const out: RemediationTask = { ...t, status: v.status };
    if (v.lastVerify) out.lastVerify = v.lastVerify;
    else delete out.lastVerify;
    if (v.note !== undefined) out.note = v.note;
    return out;
  });
}

export function remediationTotals(tasks: RemediationTask[]): RemediationTotals {
  const count = (s: RemediationStatus): number => tasks.filter((t) => t.status === s).length;
  return { total: tasks.length, verified: count('verified'), doneUnverified: count('done-unverified'), failed: count('failed'), cannotVerify: count('cannot-verify'), todo: count('todo'), required: tasks.filter((t) => !t.optional).length };
}

/** Progress over the required tasks (not optional; decisions included) — the count the report and the site page show. `verified` = done: checks passed and decisions made. */
export function checklistProgress(ws: SiteWorkspace): { verified: number; required: number; doneUnverified: number; failed: number } | undefined {
  const tasks = mergeTaskStatus(storedTasks(ws), ws).filter((t) => !t.optional);
  if (!tasks.length) return undefined;
  const count = (s: RemediationStatus): number => tasks.filter((t) => t.status === s).length;
  return { verified: count('verified'), required: tasks.length, doneUnverified: count('done-unverified'), failed: count('failed') };
}

export function remediationView(ws: SiteWorkspace): RemediationResponse {
  const tasks = mergeTaskStatus(storedTasks(ws), ws);
  return { domain: ws.domain, tasks, totals: remediationTotals(tasks), ...(ws.config ? { configAt: ws.config.at } : {}), ...(ws.config?.runId ? { runId: ws.config.runId } : {}) };
}

export interface VerifyDeps {
  config: ServiceConfig;
  workspaces: WorkspaceStore;
}

/** Runs verifies one site at a time. */
export class RemediationVerifier {
  private readonly busy = new Set<string>();

  constructor(private readonly deps: VerifyDeps) {}

  running(domain: string): boolean {
    return this.busy.has(domain);
  }

  async verify(rawDomain: unknown, rawId: unknown): Promise<VerifyTaskResponse> {
    const { workspaces } = this.deps;
    const domain = workspaces.domain(rawDomain);
    const id = typeof rawId === 'string' ? rawId : '';
    if (!id || id.length > MAX_TASK_ID || /[\u0000-\u001f]/.test(id)) throw new WorkspaceError(404, 'no such task');
    const task = storedTasks(await workspaces.get(domain)).find((t) => t.id === id);
    if (!task) throw new WorkspaceError(404, 'no such task in the site’s current checklist (generate the config first)');
    if (task.classKey) throw new WorkspaceError(409, 'this is a decision, not a change: classify the tool in the report; it is done once the site’s workspace holds its purpose');
    if (task.verify.method === 'manual') throw new WorkspaceError(409, 'this change cannot be checked from outside: mark it done (the rescan decides)');
    if (this.busy.has(domain)) throw new WorkspaceError(409, `a verify for ${domain} is already running; try again when it finishes`);
    this.busy.add(domain);
    try {
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'complykit-verify-'));
      let printed: unknown;
      try {
        const file = path.join(dir, 'task.json');
        await fsp.writeFile(file, JSON.stringify(task));
        const stdout = await runCli(this.deps.config, ['verify-change', '--task', file, '--site', domain, '--json']);
        try {
          printed = JSON.parse(stdout);
        } catch {
          throw new WorkspaceError(500, 'complykit verify-change printed something other than JSON');
        }
      } finally {
        await fsp.rm(dir, { recursive: true, force: true });
      }
      const lastVerify = lastVerifyOf(printed);
      if (!lastVerify) throw new WorkspaceError(500, 'complykit verify-change printed no outcome');
      const p = printed as Record<string, unknown>;
      const outcome: VerifyTaskResponse['outcome'] = { ...lastVerify, check: typeof p.check === 'string' ? p.check : task.verify.check, ...(isObject(p.fetched) ? { fetched: p.fetched as VerifyTaskResponse['outcome']['fetched'] } : {}) };

      // The note is the owner's: read it now (it may have changed while the check ran) and keep it.
      const key = remediationTaskKey(id);
      const before = readTaskValue((await workspaces.get(domain)).entries[key]?.value);
      const value: RemediationTaskValue = { status: STATUS_OF[lastVerify.result], ...(before?.note !== undefined ? { note: before.note } : {}), lastVerify };
      const res = await workspaces.patch(domain, { by: 'verify', entries: { [key]: { value } } });
      const merged = mergeTaskStatus([task], res.workspace)[0];
      return { task: merged, outcome, stale: res.stale.entries.includes(key) };
    } finally {
      this.busy.delete(domain);
    }
  }
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
      reject(new WorkspaceError(500, `complykit verify-change: ${err.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const tail = stderr.trim().split('\n').slice(-5).join('\n').replace(/^complykit: /, '');
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else if (timedOut) reject(new WorkspaceError(500, `complykit verify-change timed out after ${CLI_TIMEOUT_MS / 1000}s`));
      else if (code === 2) reject(new WorkspaceError(400, tail || 'complykit verify-change: invalid task'));
      else reject(new WorkspaceError(500, tail || `complykit verify-change exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
    });
  });
}
