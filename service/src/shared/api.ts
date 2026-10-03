// The API contract between the service's server and its client. Both import
// this file; neither redefines these shapes. Types only — no runtime code here
// except the pure URL-list parser both sides use (so the textarea preview and
// the server agree exactly on what will be scanned).

export type CheckKind = 'consent' | 'accessibility';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/** What the user submits: the raw textarea plus options. */
export interface CreateBatchRequest {
  /** Raw text: URLs separated by newlines, commas, or whitespace. */
  urls: string;
  /** Default: { consent: true, accessibility: false }. */
  checks?: Partial<Record<CheckKind, boolean>>;
  /** Quick mode: shorter visits, reduced scenario set (consent only). Default false. */
  quick?: boolean;
}

export interface CreateBatchResponse {
  batchId: string;
  jobs: JobSummary[];
  /** Lines that were not valid URLs, verbatim, so the UI can show them. */
  rejected: string[];
}

/** Progress of the consent evaluation: scenarios done of the planned total. */
export interface JobProgress {
  /** 0..1. Consent scenarios count; accessibility is one unit of work if enabled. */
  fraction: number;
  done: number;
  total: number; // 0 until the location plan is known
  /** What is running right now, e.g. "local · reject". */
  current?: string;
  phase: 'queued' | 'verifying-location' | 'scenarios' | 'analyzing' | 'accessibility' | 'finished';
}

/** Live metrics, updated per completed scenario (max across scenarios for counts of things). */
export interface JobMetrics {
  requests: number; // total across scenarios
  thirdPartyRequests: number;
  parties: number; // max seen in one scenario
  cookies: number; // max seen in one scenario
  banner?: string; // consent tool detected, if any
  location?: { id: string; verdict: string; observed?: string };
  scenarios: Array<{ location: string; scenario: string; status: 'running' | 'tested' | 'not-tested' | 'not-applicable'; reason?: string; durationMs?: number }>;
}

export interface JobResult {
  consent?: {
    runId: string;
    findings: number;
    totals: { violation: number; 'needs-review': number; exposure: number; practice: number };
    parties: number;
    unrecognized: number;
    /** Served by the server, e.g. /reports/<jobId>/consent/consent-report.html */
    reportUrl: string;
  };
  accessibility?: {
    runId?: string;
    findings?: number;
    reportUrl: string; // /reports/<jobId>/accessibility/report.html
  };
  /** Zip of everything for this job: /api/jobs/<jobId>/download */
  downloadUrl: string;
}

export interface JobSummary {
  id: string;
  batchId: string;
  url: string;
  host: string;
  checks: CheckKind[];
  quick: boolean;
  status: JobStatus;
  createdAt: string; // ISO
  startedAt?: string;
  finishedAt?: string;
  progress: JobProgress;
  metrics: JobMetrics;
  result?: JobResult;
  error?: string;
}

export interface JobDetail extends JobSummary {
  /** Last ~200 log lines from the check processes. */
  log: string[];
}

export interface JobsResponse {
  jobs: JobSummary[]; // newest first
  /** Server facts for the header. */
  server: { concurrency: number; running: number; queued: number; retentionDays: number; region?: string; version: string };
}

/**
 * Server-sent events on GET /api/stream:
 *   event: job      data: JobSummary   (any change to a job)
 *   event: removed  data: { id }       (job deleted)
 *   event: ping     data: {}           (every 20s, keeps proxies + idle tracking honest)
 */
export type StreamEvent = { event: 'job'; data: JobSummary } | { event: 'removed'; data: { id: string } } | { event: 'ping'; data: Record<string, never> };

// --- Routes (all under HTTP Basic auth when SERVICE_PASSWORD is set) ---------
//
//   GET    /api/health                      → { ok: true }            (no auth — Fly health check)
//   GET    /api/jobs                        → JobsResponse
//   POST   /api/batches  CreateBatchRequest → CreateBatchResponse (201)
//   GET    /api/jobs/:id                    → JobDetail
//   POST   /api/jobs/:id/cancel             → JobSummary
//   DELETE /api/jobs/:id                    → 204 (cancels if running, deletes files)
//   GET    /api/jobs/:id/download           → application/zip
//   GET    /api/stream                      → text/event-stream (StreamEvent)
//   GET    /reports/:id/**                  → static files from the job's directory
//   GET    /*                               → the client SPA (dist/client, index.html fallback)

export const MAX_URLS_PER_BATCH = 50;

/** Parse the textarea: split on newlines, commas, whitespace; add https:// when
 *  no scheme; keep http(s) only; dedupe by normalized URL. */
export function parseUrlList(raw: string): { urls: string[]; rejected: string[] } {
  const urls: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const token of raw.split(/[\s,]+/)) {
    const t = token.trim().replace(/^[<("']+|[>)"';.]+$/g, '');
    if (!t) continue;
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`;
    let u: URL;
    try {
      u = new URL(withScheme);
    } catch {
      rejected.push(token);
      continue;
    }
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname.includes('.')) {
      rejected.push(token);
      continue;
    }
    u.hash = '';
    const key = u.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(key);
  }
  return { urls: urls.slice(0, MAX_URLS_PER_BATCH), rejected: [...rejected, ...urls.slice(MAX_URLS_PER_BATCH).map((u) => `${u} (over the ${MAX_URLS_PER_BATCH}-URL limit)`)] };
}
