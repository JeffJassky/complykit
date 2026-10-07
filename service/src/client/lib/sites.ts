import type { JobSummary, SiteWorkspace, WorkspaceRun } from '../../shared/api';

// Workspace entries are one flat key space (see SiteWorkspace.entries). The
// report writes a task under `task:<id>` and a classification under
// `class:<id>`; the legacy report-side names `action` and `classification`
// are read the same way, so counts survive that naming being settled.
const TASK_KEY = /^(task|action)[:/.]/;
const CLASS_KEY = /^(class|classification|classifications)[:/.]/;

export interface SiteSummaryView {
  /** Newest first (the API returns oldest first). */
  runs: WorkspaceRun[];
  openTasks: number;
  doneTasks: number;
  classifications: number;
}

const isDone = (value: unknown): boolean => {
  const status = value && typeof value === 'object' ? (value as { status?: unknown }).status : value;
  return status === 'done';
};

export function summarizeWorkspace(ws: SiteWorkspace): SiteSummaryView {
  let openTasks = 0;
  let doneTasks = 0;
  let classifications = 0;
  for (const [key, entry] of Object.entries(ws.entries)) {
    if (entry.value === null) continue; // cleared
    if (key.startsWith('task:change:')) continue; // the guided checklist's own status (counted by the Checklist panel)
    if (TASK_KEY.test(key)) {
      if (isDone(entry.value)) doneTasks++;
      else openTasks++;
    } else if (CLASS_KEY.test(key)) classifications++;
  }
  return { runs: [...ws.runs].sort((a, b) => b.at.localeCompare(a.at)), openTasks, doneTasks, classifications };
}

/** The config's downloadable parts. The config is always offered as JSON; a
 *  `changeList` inside it (when the generator wrote one) is offered on its own. */
export function configDownloads(ws: SiteWorkspace): Array<{ label: string; filename: string; body: string }> {
  if (!ws.config || ws.config.value === null || ws.config.value === undefined) return [];
  const out = [{ label: 'Latest config', filename: `${ws.domain}-consent-config.json`, body: JSON.stringify(ws.config.value, null, 2) }];
  const value = ws.config.value as { changeList?: unknown; snippet?: unknown };
  if (value && typeof value === 'object' && value.changeList !== undefined && value.changeList !== null) {
    // The generator (D8) writes change-list.md as a string: offer it as Markdown.
    out.push(
      typeof value.changeList === 'string'
        ? { label: 'Change list', filename: `${ws.domain}-change-list.md`, body: value.changeList }
        : { label: 'Change list', filename: `${ws.domain}-change-list.json`, body: JSON.stringify(value.changeList, null, 2) },
    );
  }
  if (value && typeof value === 'object' && typeof value.snippet === 'string') {
    out.push({ label: 'Snippet', filename: `${ws.domain}-snippet.html`, body: value.snippet });
  }
  return out;
}

/** Runs the generator can work from: the job is still here, finished, and has a consent run.
 *  Newest first, so the first is the latest. Without the jobs list nothing can be said. */
export function generatableRuns(runs: WorkspaceRun[], jobs: Record<string, JobSummary> | null): WorkspaceRun[] {
  if (!jobs) return [];
  return runs.filter((r) => {
    const job = r.jobId ? jobs[r.jobId] : undefined;
    return job?.status === 'done' && !!job.result?.consent?.runId;
  });
}

/** A failed generation, in words for the person who pressed the button. */
export function generateErrorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 409) return `This run can’t be used: ${message}. Run a new consent scan of the site and generate from that.`;
  if (status === 400) return `The request was refused: ${message}.`;
  return `Couldn’t generate the config: ${message}`;
}

/** Generate stored the config (and so the checklist), but the report re-render after it failed. */
export const REPORT_REFRESH_FAILED = 'Your checklist was generated; the report couldn’t refresh — reload or press Update report.';

/** True when a rerender error says the config was generated and stored before the report step failed (RerenderErrorBody). */
export function configStoredOf(err: unknown): boolean {
  const body = (err as { body?: unknown } | null)?.body;
  return typeof body === 'object' && body !== null && (body as { configStored?: unknown }).configStored === true;
}
