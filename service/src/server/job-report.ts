// GET /api/jobs/:id/report (plans/simple-report.md): the owner report page in
// one poll — the job (status, progress), the owner report the CLI writes
// (owner-report.json: live after every visit, final when done and after each
// re-render) and the site's to-do list with its status from the workspace.
//
// The to-do list is made without a button: when a consent scan finishes, the
// service generates the site's consent tool config + checklist from it and
// re-renders the report (rerender with `generate`), unless the owner is
// already working an earlier scan's list (a task verified, marked done or
// failed) — regenerating then could move the install hash under a deployed
// tool. The rescan's report still shows that list, with its status.

import fsp from 'node:fs/promises';
import path from 'node:path';
import type { JobDetail, JobReportResponse, OwnerReport, SiteWorkspace } from '../shared/api.js';
import { toSummary } from './store.js';
import { checklistProgress, mergeTaskStatus, storedTasks } from './remediation.js';
import { rerenderJob, rerenderRunning, type RerenderDeps } from './rerender.js';
import type { WorkspaceStore } from './workspace.js';

export const OWNER_REPORT_FILE = 'owner-report.json';
const RUN_ID_RE = /^[0-9TZ:.-]{10,40}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** consent-report.json beside the finished job's HTML report (older jobs have it too). */
async function jsonReportExists(job: JobDetail, jobDir: string): Promise<boolean> {
  const runId = job.result?.consent?.runId;
  if (!runId || !RUN_ID_RE.test(runId) || !job.result?.consent?.reportUrl.endsWith('.html')) return false;
  return fsp
    .access(path.join(jobDir, 'consent', '.comply', 'runs', runId, 'consent-report.json'))
    .then(() => true, () => false);
}

/** Where the job's owner report is: beside its consent report once done; while running, in its (only) run directory. */
export async function ownerReportFile(job: JobDetail, jobDir: string): Promise<string | undefined> {
  const runs = path.join(jobDir, 'consent', '.comply', 'runs');
  const runId = job.result?.consent?.runId;
  if (runId) return RUN_ID_RE.test(runId) ? path.join(runs, runId, OWNER_REPORT_FILE) : undefined;
  let dirs: string[];
  try {
    dirs = await fsp.readdir(runs);
  } catch {
    return undefined;
  }
  let best: { file: string; mtime: number } | undefined;
  for (const d of dirs) {
    if (!RUN_ID_RE.test(d)) continue;
    const file = path.join(runs, d, OWNER_REPORT_FILE);
    try {
      const { mtimeMs } = await fsp.stat(file);
      if (!best || mtimeMs > best.mtime) best = { file, mtime: mtimeMs };
    } catch {
      /* not written yet */
    }
  }
  return best?.file;
}

/** The owner report, when it is there and has the shape the page reads (else null: the page waits for the next one). */
export async function readOwnerReport(file: string | undefined): Promise<OwnerReport | null> {
  if (!file) return null;
  try {
    const raw = JSON.parse(await fsp.readFile(file, 'utf8')) as unknown;
    if (!isObj(raw) || raw.version !== 1 || !isObj(raw.matrix) || !Array.isArray(raw.matrix.columns) || !Array.isArray(raw.matrix.tools) || !isObj(raw.scan) || !isObj(raw.banner)) return null;
    return { ...(raw as unknown as OwnerReport), decisions: Array.isArray(raw.decisions) ? (raw.decisions as OwnerReport['decisions']) : [] };
  } catch {
    return null; // not written yet, or a reader caught a writer (the CLI renames into place, so rarely)
  }
}

/**
 * Should the finished scan `runId` (re)make the site's checklist? Yes when there
 * is none, when it already came from this run, or when nobody has worked the
 * current one yet (every change still "to do"; decisions don't count — they are
 * classifications, which any regeneration keeps).
 */
export function shouldGenerate(ws: SiteWorkspace, runId: string): boolean {
  const tasks = mergeTaskStatus(storedTasks(ws), ws);
  if (!tasks.length) return true;
  if (ws.config?.runId === runId) return true;
  return tasks.every((t) => !!t.classKey || t.status === 'todo');
}

type AutoState = { status: 'preparing' } | { status: 'error'; error: string };

/** Makes the to-do list when a consent scan finishes (config + checklist + re-rendered report). */
export class ChecklistMaker {
  private readonly states = new Map<string, AutoState>();
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly deps: RerenderDeps) {}

  state(jobId: string): AutoState | undefined {
    return this.states.get(jobId);
  }

  /** Fire and forget; `settled()` waits for every one in flight (shutdown, tests). */
  afterScan(job: JobDetail): void {
    const runId = job.result?.consent?.runId;
    if (job.status !== 'done' || !job.checks.includes('consent') || !runId) return;
    this.states.set(job.id, { status: 'preparing' });
    const p = (async () => {
      const ws = await this.deps.workspaces.get(this.deps.workspaces.domain(new URL(job.url).hostname));
      await rerenderJob(job, { generate: shouldGenerate(ws, runId), by: 'complykit' }, this.deps);
    })()
      .then(() => this.states.delete(job.id))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[report] to-do list for job ${job.id}: ${message}`);
        this.states.set(job.id, { status: 'error', error: message });
      });
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  async settled(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}

export async function jobReport(job: JobDetail, deps: { jobDir: string; workspaces: WorkspaceStore; maker?: ChecklistMaker }): Promise<JobReportResponse> {
  const consent = job.checks.includes('consent');
  const domain = deps.workspaces.domain(new URL(job.url).hostname);
  const report = consent ? await readOwnerReport(await ownerReportFile(job, deps.jobDir)) : null;
  const ws = await deps.workspaces.get(domain);
  const tasks = mergeTaskStatus(storedTasks(ws), ws).sort((a, b) => a.order - b.order);
  const runId = job.result?.consent?.runId;
  const auto = deps.maker?.state(job.id);

  let state: JobReportResponse['todo']['state'];
  if (!consent) state = 'none';
  else if (job.status === 'queued' || job.status === 'running') state = 'waiting';
  else if (job.status !== 'done') state = 'none';
  else if (auto?.status === 'preparing') state = 'preparing';
  else if (tasks.length) state = 'ready';
  else if (auto?.status === 'error') state = 'error';
  else state = 'none';

  const ready = state === 'ready';
  const progress = ready ? checklistProgress(ws) : undefined;
  return {
    job: toSummary(job),
    domain,
    report,
    todo: {
      state,
      tasks: ready ? tasks : [],
      ...(progress ? { progress } : {}),
      ...(state === 'error' && auto?.status === 'error' ? { error: auto.error } : {}),
      ...(ready && ws.config?.at ? { configAt: ws.config.at } : {}),
      ...(ready && ws.config?.runId ? { runId: ws.config.runId, fromThisRun: ws.config.runId === runId } : {}),
    },
    updating: rerenderRunning(job.id),
    ...(job.result?.consent?.reportUrl ? { technicalReportUrl: job.result.consent.reportUrl } : {}),
    ...(job.result?.accessibility?.reportUrl ? { accessibilityReportUrl: job.result.accessibility.reportUrl } : {}),
    ...((await jsonReportExists(job, deps.jobDir)) && job.result?.consent ? { jsonReportUrl: job.result.consent.reportUrl.replace(/\.html$/, '.json') } : {}),
    ...(job.result?.downloadUrl ? { downloadUrl: job.result.downloadUrl } : {}),
    ...(ready ? { installZipUrl: `/api/sites/${encodeURIComponent(domain)}/install.zip` } : {}),
  };
}
