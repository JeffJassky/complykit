// POST /api/sites/:domain/rescan (remediation flow §1 step 6, §8): the last
// checklist step. Starts a new consent job for the site with the options of its
// latest job on the service (URL, checks, quick, slowRepeat; the body may choose
// quick or full, and the slowed repeat — the location is the service's own, the only one it scans from) — the runner applies the site
// workspace (C3), so the rescan reads the current classifications and compares
// the deployed complykit config with the workspace's latest (D10). The rescan's
// report, not the checklist, is the behavior proof: its section "Your complykit
// consent tool: what it controls" says controlled / not controlled / not
// observed per vendor, for the pages and locations it visited.

import type { CheckKind, JobDetail, RescanRequest, RescanResponse } from '../shared/api.js';
import { siteDomain } from './domains.js';
import { parseLaws } from './law-input.js';
import { newId, toSummary, type JobStore } from './store.js';
import { WorkspaceError, type WorkspaceStore } from './workspace.js';

const ACTIVE = new Set(['queued', 'running']);

function domainOf(url: string): string | undefined {
  try {
    return siteDomain(new URL(url).hostname);
  } catch {
    return undefined;
  }
}

/** The site's consent jobs on the service, newest first. */
export function siteConsentJobs(store: Pick<JobStore, 'list'>, domain: string): JobDetail[] {
  return store.list().filter((j) => j.checks.includes('consent') && domainOf(j.url) === domain);
}

export async function rescanSite(rawDomain: unknown, deps: { store: JobStore; workspaces: WorkspaceStore; enqueue: (id: string) => void }, body: RescanRequest = {}): Promise<RescanResponse> {
  const domain = deps.workspaces.domain(rawDomain);
  if (body.quick !== undefined && typeof body.quick !== 'boolean') throw new WorkspaceError(400, '`quick` must be a boolean');
  if (body.slowRepeat !== undefined && typeof body.slowRepeat !== 'boolean') throw new WorkspaceError(400, '`slowRepeat` must be a boolean');
  const jobs = siteConsentJobs(deps.store, domain);
  const active = jobs.find((j) => ACTIVE.has(j.status));
  if (active) throw new WorkspaceError(409, `a scan of ${domain} is already ${active.status} (job ${active.id}); its report is the rescan`);
  // Same options as the last run: the newest job that did not get cancelled, else the newest at all.
  const last = jobs.find((j) => j.status !== 'cancelled') ?? jobs[0];
  let from: RescanResponse['from'];
  if (last) {
    from = { jobId: last.id, url: last.url, checks: [...last.checks], quick: last.quick, slowRepeat: last.slowRepeat ?? false, ...(last.laws?.length ? { laws: [...last.laws] } : {}) };
  } else {
    // No job left on the service (retention): the workspace's newest run still names the URL.
    const ws = await deps.workspaces.get(domain);
    const url = [...ws.runs].reverse().find((r) => typeof r.url === 'string' && domainOf(r.url) === domain)?.url;
    if (!url) throw new WorkspaceError(404, `no earlier scan of ${domain} to repeat: start one from the checks page`);
    from = { url, checks: ['consent'] as CheckKind[], quick: false, slowRepeat: false };
  }
  const quick = body.quick ?? from.quick;
  // Quick is always one pass (the store enforces it too).
  const slowRepeat = !quick && (body.slowRepeat ?? from.slowRepeat);
  // Laws: as the latest job unless the body chooses; a result with laws needs the owner's confirmation again.
  const lawsIn = parseLaws(body.laws ?? from.laws, body.authorized, from.checks.includes('consent'));
  if (!lawsIn.ok) throw new WorkspaceError(400, lawsIn.error);
  const job = deps.store.create({ batchId: newId(), url: from.url, checks: from.checks, quick, slowRepeat, laws: lawsIn.laws, authorizedAt: lawsIn.authorizedAt });
  deps.enqueue(job.id);
  return { domain, job: toSummary(job), from };
}
