// GET /api/jobs/:id/report (plans/simple-report.md): the owner report page in
// one poll — the job (status, progress), the owner report the CLI writes
// (owner-report.json: live after every visit, final when done and after each
// re-render) and the site's to-do list with its status from the workspace.
//
// The to-do list is made without a button: when a consent scan finishes, the
// service generates the site's consent tool config + checklist from it and
// re-renders the report (rerender with `generate`), unless complykit's tool is
// deployed from the earlier list (its install task done or verified) —
// regenerating then could move the install hash under that tool. The rescan's
// report then still shows that list, with its status.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { RUN_ID_RE, isFinal, type JobFiles } from './job-files.js';
import { firstScan, newerScan, siteHistory } from './history.js';
import { scoreReport } from '../shared/score.js';
import type { CompanionCmp, JobDetail, JobReportResponse, OwnerReport, SiteWorkspace } from '../shared/api.js';
import { toSummary } from './store.js';
import { detectedBannerOf, storedConsentSettings } from './consent-settings.js';
import { checklistProgress, mergeTaskStatus, rehomeHostedUrl, storedTasks } from './remediation.js';
import { rerenderJob, rerenderRunning, type RerenderDeps } from './rerender.js';
import type { WorkspaceStore } from './workspace.js';

export const OWNER_REPORT_FILE = 'owner-report.json';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** consent-report.json beside the finished job's HTML report (older jobs have it too). */
async function jsonReportExists(job: JobDetail, files: JobFiles): Promise<boolean> {
  const runId = job.result?.consent?.runId;
  if (!runId || !RUN_ID_RE.test(runId) || !job.result?.consent?.reportUrl.endsWith('.html')) return false;
  return (await files.head(job, `consent/.comply/runs/${runId}/consent-report.json`)) !== null;
}

/**
 * Where the job's owner report is (a path relative to the job): beside its consent report once done; while
 * running, in its (only) run directory, the most recently written one.
 */
export async function ownerReportRel(job: JobDetail, files: JobFiles): Promise<string | undefined> {
  const runId = job.result?.consent?.runId;
  if (runId) return RUN_ID_RE.test(runId) ? `consent/.comply/runs/${runId}/${OWNER_REPORT_FILE}` : undefined;
  const runs = path.join(files.scratchDir(job.id), 'consent', '.comply', 'runs');
  let best: { rel: string; at: number } | undefined;
  try {
    for (const d of await fsp.readdir(runs)) {
      if (!RUN_ID_RE.test(d)) continue;
      try {
        const { mtimeMs } = await fsp.stat(path.join(runs, d, OWNER_REPORT_FILE));
        if (!best || mtimeMs > best.at) best = { rel: `consent/.comply/runs/${d}/${OWNER_REPORT_FILE}`, at: mtimeMs };
      } catch {
        /* not written yet */
      }
    }
  } catch {
    /* no scratch run directory (a finished job's files are in blobs) */
  }
  if (best || files.local || !isFinal(job)) return best?.rel;
  // A finished job without a run id (failed after writing a live report): published, so look in blobs.
  const prefix = `jobs/${job.id}/consent/.comply/runs/`;
  for await (const b of files.blobs.list(prefix)) {
    if (!b.key.endsWith(`/${OWNER_REPORT_FILE}`)) continue;
    const at = Date.parse(b.modified);
    if (!RUN_ID_RE.test(b.key.slice(prefix.length).split('/')[0])) continue;
    if (!best || at > best.at) best = { rel: b.key.slice(`jobs/${job.id}/`.length), at };
  }
  return best?.rel;
}

function toOwnerReport(raw: unknown): OwnerReport | null {
  if (!isObj(raw) || raw.version !== 1 || !isObj(raw.matrix) || !Array.isArray(raw.matrix.columns) || !Array.isArray(raw.matrix.tools) || !isObj(raw.scan) || !isObj(raw.banner)) return null;
  return { ...(raw as unknown as OwnerReport), decisions: Array.isArray(raw.decisions) ? (raw.decisions as OwnerReport['decisions']) : [] };
}

/** Parsed owner reports of finished jobs, by blob etag (a 2-second poll must not refetch and reparse 9 MB). Newest use last. */
const parsed = new Map<string, { etag: string; report: OwnerReport | null }>();
const PARSED_MAX = 6;

/** The owner report, when it is there and has the shape the page reads (else null: the page waits for the next one). */
export async function readOwnerReport(job: JobDetail, files: JobFiles, rel: string | undefined): Promise<OwnerReport | null> {
  if (!rel) return null;
  try {
    const stable = isFinal(job);
    const info = stable ? await files.head(job, rel) : null;
    if (stable && !info) return null;
    const cacheKey = `${job.id}/${rel}`;
    const hit = info && parsed.get(cacheKey);
    if (info && hit && hit.etag === info.etag) {
      parsed.delete(cacheKey);
      parsed.set(cacheKey, hit);
      return hit.report;
    }
    const buf = await files.get(job, rel);
    if (!buf) return null;
    const report = toOwnerReport(JSON.parse(buf.toString('utf8')));
    if (info) {
      parsed.set(cacheKey, { etag: info.etag, report });
      while (parsed.size > PARSED_MAX) parsed.delete(parsed.keys().next().value as string);
    }
    return report;
  } catch {
    return null; // not written yet, or a reader caught a writer (the CLI renames into place, so rarely)
  }
}

/**
 * Should the finished scan `runId` (re)make the site's checklist? The newest scan
 * is what the site does now, so yes, unless complykit's consent tool is deployed
 * from the stored config (its install task done or verified): regenerating then
 * could move the install hash under that deployed tool. Work on other tasks does
 * not hold the list back; their status carries over by task id. (2026-10-10: a
 * failed check on a since-dropped task kept a clean site's nine stale to-dos.)
 */
export function shouldGenerate(ws: SiteWorkspace, runId: string): boolean {
  const tasks = mergeTaskStatus(storedTasks(ws), ws);
  if (!tasks.length) return true;
  if (ws.config?.runId === runId) return true;
  return !tasks.some((t) => t.kind === 'install' && (t.status === 'verified' || t.status === 'done-unverified'));
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

/** First-scan scores by job id, kept while the owner report is unchanged (a re-render with new classifications rewrites it). */
const baselineCache = new Map<string, { etag: string; score: number | undefined }>();

async function baselineScore(job: JobDetail, files: JobFiles): Promise<number | undefined> {
  const rel = await ownerReportRel(job, files);
  if (!rel) return undefined;
  const info = await files.head(job, rel);
  if (!info) return undefined;
  const hit = baselineCache.get(job.id);
  if (hit && hit.etag === info.etag) return hit.score;
  const score = scoreReport(await readOwnerReport(job, files, rel)).score;
  baselineCache.set(job.id, { etag: info.etag, score });
  return score;
}

export async function jobReport(job: JobDetail, deps: { files: JobFiles; workspaces: WorkspaceStore; maker?: ChecklistMaker; jobs?: JobDetail[]; publicOrigin?: string }): Promise<JobReportResponse> {
  const consent = job.checks.includes('consent');
  const domain = deps.workspaces.domain(new URL(job.url).hostname);
  const report = consent ? await readOwnerReport(job, deps.files, await ownerReportRel(job, deps.files)) : null;
  // Per-law live reports (collectors'), only while the job is not done: a finished job's live files are gone and its final report covers every location.
  const laws =
    job.metrics.laws?.length
      ? await Promise.all(
          job.metrics.laws.map(async (progress) => ({
            id: progress.id,
            progress,
            report: job.status === 'done' ? null : await readOwnerReport(job, deps.files, `consent/live/${progress.id}.json`),
          })),
        )
      : undefined;
  const ws = await deps.workspaces.get(domain);
  const tasks = mergeTaskStatus(storedTasks(ws, deps.publicOrigin), ws).sort((a, b) => a.order - b.order);
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
  const storedValue = ws.config?.value as { hostedScriptUrl?: unknown } | null | undefined;
  const hostedScriptUrl = typeof storedValue?.hostedScriptUrl === 'string' ? (deps.publicOrigin ? rehomeHostedUrl(storedValue.hostedScriptUrl, deps.publicOrigin) : storedValue.hostedScriptUrl) : undefined;
  const jobs = deps.jobs ?? [job];
  const domainOf = (host: string) => deps.workspaces.domain(host);
  const newer = newerScan(job, jobs, domainOf);
  const first = consent ? firstScan(job, jobs, domainOf) : undefined;
  const firstScore = first && first.id !== job.id ? await baselineScore(first, deps.files) : undefined;
  const progress = ready ? checklistProgress(ws) : undefined;
  return {
    job: toSummary(job),
    domain,
    report,
    ...(laws ? { laws } : {}),
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
    ...((await jsonReportExists(job, deps.files)) && job.result?.consent ? { jsonReportUrl: job.result.consent.reportUrl.replace(/\.html$/, '.json') } : {}),
    ...(job.result?.downloadUrl ? { downloadUrl: job.result.downloadUrl } : {}),
    ...(ready && hostedScriptUrl ? { hostedScriptUrl } : {}),
    ...(ready ? { consentSettings: consentSettingsView(ws) } : {}),
    history: siteHistory(domain, jobs, ws, domainOf, job.id),
    ...(newer ? { newerScan: { jobId: newer.id, at: newer.createdAt } } : {}),
    ...(first ? { firstScan: { jobId: first.id, at: first.createdAt, ...(first.id === job.id ? { current: true as const } : {}), ...(firstScore !== undefined ? { score: firstScore } : {}) } } : {}),
  };
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** What the install task's form needs: the settings, the banner the scan saw, and the site's own category ids and defaults. */
function consentSettingsView(ws: SiteWorkspace): NonNullable<JobReportResponse['consentSettings']> {
  const v = ws.config?.value;
  const cfg = isRec(v) && isRec(v.config) ? v.config : {};
  const detected = isRec(v) && typeof v.detectedCmp === 'string' ? (v.detectedCmp as CompanionCmp) : undefined;
  const banner = detectedBannerOf(v);
  const categoryIds = Array.isArray(cfg.categories) ? cfg.categories.filter((c): c is { id: string } => isRec(c) && typeof c.id === 'string').map((c) => c.id) : [];
  return {
    settings: storedConsentSettings(ws) ?? { mode: 'full' },
    ...(detected ? { detectedCmp: detected } : {}),
    ...(banner ? { detectedBanner: banner } : {}),
    categoryIds,
    defaults: { ...(typeof cfg.layout === 'string' ? { layout: cfg.layout } : {}), ...(typeof cfg.blockPage === 'boolean' ? { blockPage: cfg.blockPage } : {}), ...(typeof cfg.privacyPolicyUrl === 'string' ? { privacyPolicyUrl: cfg.privacyPolicyUrl } : {}) },
  };
}
