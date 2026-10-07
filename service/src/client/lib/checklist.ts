import type { JobSummary, RemediationStatus, RemediationTask, RemediationTaskValue, SiteWorkspace } from '../../shared/api';

// The site page's checklist (R3): the latest generated config's tasks
// (`config.value.tasks`) with each one's status from its `task:change:<id>`
// workspace entry — the same merge GET /api/sites/:domain/remediation does,
// done here on the workspace the page already holds so a refresh updates both.

export const TASK_CHANGE_PREFIX = 'task:change:';

export const STATUS_LABEL: Record<RemediationStatus, string> = {
  todo: 'To do',
  'done-unverified': 'Marked done',
  verified: 'Verified ✓',
  failed: 'Failed ✗',
  'cannot-verify': 'Can’t verify automatically',
};

const STATUSES = new Set<string>(Object.keys(STATUS_LABEL));
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A workspace value as a task value (the report workbench's 'done' reads as done-unverified, never verified). */
export function readTaskValue(value: unknown): RemediationTaskValue | undefined {
  if (!isObject(value) || typeof value.status !== 'string') return undefined;
  const status = value.status === 'done' ? 'done-unverified' : value.status === 'open' || value.status === 'in-progress' ? 'todo' : value.status;
  if (!STATUSES.has(status)) return undefined;
  return { status: status as RemediationStatus, ...(typeof value.note === 'string' ? { note: value.note } : {}), ...(isObject(value.lastVerify) ? { lastVerify: value.lastVerify as unknown as RemediationTaskValue['lastVerify'] } : {}) };
}

/** The checklist, in order, with status from the workspace. Empty before a config with tasks exists. */
export function checklistFromWorkspace(ws: SiteWorkspace): RemediationTask[] {
  const value = ws.config?.value;
  const raw = isObject(value) && Array.isArray(value.tasks) ? (value.tasks as unknown[]) : [];
  const tasks = raw.filter((t): t is RemediationTask => isObject(t) && typeof t.id === 'string' && typeof t.title === 'string' && isObject(t.verify));
  return tasks
    .map((t) => {
      // Own entry, else one stored under an alias (an item folded into this task; a carried
      // pass reads as "marked done" unless this task's own check is a spot check too).
      const entry = ws.entries[TASK_CHANGE_PREFIX + t.id] ?? (t.aliases ?? []).map((a) => ws.entries[TASK_CHANGE_PREFIX + a]).find((e) => e && readTaskValue(e.value));
      if (!entry) return t;
      const carried = !ws.entries[TASK_CHANGE_PREFIX + t.id];
      const raw = readTaskValue(entry.value);
      const v = raw && carried && raw.status === 'verified' && t.verify.check !== 'spot-check' ? { ...raw, status: 'done-unverified' as const } : raw;
      const { lastVerify: _l, note: _n, ...rest } = t;
      return v ? { ...rest, status: v.status, ...(v.note ? { note: v.note } : {}), ...(v.lastVerify ? { lastVerify: v.lastVerify } : {}) } : { ...rest, status: 'todo' as const };
    })
    .sort((a, b) => a.order - b.order);
}

/** Required = not optional and not "classify first"; progress counts `verified` only. */
export function checklistProgress(tasks: RemediationTask[]): { required: number; verified: number; doneUnverified: number; failed: number } {
  const req = tasks.filter((t) => !t.optional && !t.classifyFirst);
  return {
    required: req.length,
    verified: req.filter((t) => t.status === 'verified').length,
    doneUnverified: req.filter((t) => t.status === 'done-unverified').length,
    failed: req.filter((t) => t.status === 'failed').length,
  };
}

/** The consent report of the run the config was generated from (else the newest one still here), at its checklist. */
export function reportChecklistHref(ws: SiteWorkspace, jobs: Record<string, JobSummary> | null): string | undefined {
  if (!jobs) return undefined;
  const runs = [...ws.runs].sort((a, b) => b.at.localeCompare(a.at));
  const preferred = ws.config?.runId ? runs.filter((r) => r.id === ws.config!.runId) : [];
  for (const r of [...preferred, ...runs]) {
    const url = r.jobId ? jobs[r.jobId]?.result?.consent?.reportUrl : undefined;
    if (url) return `${url}#remediation`;
  }
  return undefined;
}

export const installZipHref = (domain: string): string => `/api/sites/${encodeURIComponent(domain)}/install.zip`;
