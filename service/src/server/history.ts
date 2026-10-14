// Scan history: every scan of a site, and whether a given scan has been
// superseded by a newer one. Scans are kept for good (RETENTION_DAYS=0), so
// the list is the site's record of what was observed when.
//
// An earlier scan is read-only in one sense: it can't make the site's to-do
// list (generate a consent-tool config) — that list is site-wide and belongs
// to the latest scan. Classifications and task status are site-wide too, so
// an earlier report still saves them, and still re-renders with them.

import type { JobDetail, ScanHistoryItem, SiteWorkspace } from '../shared/api.js';
import { WorkspaceError } from './workspace.js';

type DomainOf = (host: string) => string;

function jobDomain(job: Pick<JobDetail, 'url'>, domainOf: DomainOf): string | undefined {
  try {
    return domainOf(new URL(job.url).hostname);
  } catch {
    return undefined;
  }
}

/** The newest finished consent scan of the job's site created after it, if any. */
export function newerScan(job: JobDetail, jobs: JobDetail[], domainOf: DomainOf): JobDetail | undefined {
  const domain = jobDomain(job, domainOf);
  if (!domain) return undefined;
  let newest: JobDetail | undefined;
  for (const j of jobs) {
    if (j.id === job.id) continue;
    if (j.status !== 'done' || !j.checks.includes('consent') || !j.result?.consent?.runId) continue;
    if (j.createdAt <= job.createdAt) continue;
    if (jobDomain(j, domainOf) !== domain) continue;
    if (!newest || j.createdAt > newest.createdAt) newest = j;
  }
  return newest;
}

/** Every scan of the site, newest first: the service's jobs, plus workspace runs whose job is gone or ran elsewhere. */
export function siteHistory(domain: string, jobs: JobDetail[], ws: SiteWorkspace, domainOf: DomainOf, currentJobId?: string): ScanHistoryItem[] {
  const out: ScanHistoryItem[] = [];
  const seen = new Set<string>();
  for (const j of jobs) {
    if (jobDomain(j, domainOf) !== domain) continue;
    seen.add(j.id);
    out.push({
      jobId: j.id,
      at: j.createdAt,
      url: j.url,
      status: j.status,
      checks: j.checks,
      quick: j.quick,
      available: true,
      ...(j.id === currentJobId ? { current: true } : {}),
    });
  }
  for (const r of ws.runs) {
    if (r.jobId && seen.has(r.jobId)) continue;
    if (r.jobId) seen.add(r.jobId);
    out.push({ ...(r.jobId ? { jobId: r.jobId } : {}), at: r.at, ...(r.url ? { url: r.url } : {}), available: false });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * Refuse to make the site's to-do list from an earlier scan. Allowed when the
 * stored list already came from this scan (re-rendering keeps it in step).
 */
export function assertCanGenerate(job: JobDetail, jobs: JobDetail[], ws: SiteWorkspace, domainOf: DomainOf): void {
  const newer = newerScan(job, jobs, domainOf);
  if (!newer) return;
  if (ws.config?.runId && ws.config.runId === job.result?.consent?.runId) return;
  throw new WorkspaceError(409, `a newer scan of this site exists (${newer.createdAt}); make the to-do list from the latest scan`, { newerJobId: newer.id });
}
