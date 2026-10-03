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
 *   event: kb       data: {}           (knowledge base changed — refetch GET /api/kb)
 *   event: ping     data: {}           (every 20s, keeps proxies + idle tracking honest)
 */
export type StreamEvent =
  { event: 'job'; data: JobSummary } | { event: 'removed'; data: { id: string } } | { event: 'kb'; data: Record<string, never> } | { event: 'ping'; data: Record<string, never> };

// --- Knowledge base -------------------------------------------------------------
// Mirrors of complykit's research records (src/research/schema.ts and
// src/registry/kb/schema.ts). The service never imports complykit; it shells
// out to `complykit kb … --json` and passes these shapes through unchanged.

/** The category vocabulary (complykit's PartyCategory, in its order). A test
 *  compares this list against complykit's schema so the two can't drift. */
export const KB_CATEGORIES = [
  { id: 'necessary', help: 'Needed for the service the visitor asked for (cart, login, load balancing)' },
  { id: 'functional', help: 'Remembers visitor choices or adds a feature the visitor uses' },
  { id: 'analytics', help: 'Measures visits and behavior' },
  { id: 'advertising', help: 'Ads, retargeting, conversion tracking, audience building' },
  { id: 'session-recording', help: 'Records clicks, scrolls, keystrokes or replays sessions' },
  { id: 'chat', help: 'Live chat or support widget' },
  { id: 'identity-resolution', help: 'Links the visitor to an identity across sites or devices' },
  { id: 'fingerprinting', help: 'Identifies the device from its characteristics' },
  { id: 'embed', help: 'Third-party content embedded in the page (video, maps, social posts)' },
  { id: 'fonts', help: 'Web font delivery' },
  { id: 'captcha', help: 'Bot / abuse protection challenge' },
  { id: 'cdn', help: 'Serves static files only, no visitor data use' },
  { id: 'payments', help: 'Payment processing' },
  { id: 'tag-manager', help: 'Loads other tags' },
  { id: 'consent', help: 'The consent tool itself' },
  { id: 'error-monitoring', help: 'Error and performance reporting' },
  { id: 'marketing-email', help: 'Email / SMS marketing capture and attribution' },
  { id: 'reviews', help: 'Product reviews / ratings widget' },
] as const;

export type KbCategory = (typeof KB_CATEGORIES)[number]['id'];

export type KbQueueStatus = 'open' | 'proposed' | 'resolved' | 'dismissed';

/** One research-queue item: a registrable domain a scan couldn't explain
 *  (`unrecognized`) or that behaved unlike its entry (`drift`). */
export interface KbQueueItem {
  domain: string;
  kind: 'unrecognized' | 'drift';
  status: KbQueueStatus;
  reason: string;
  entryId?: string;
  firstSeen: string;
  lastSeen: string;
  sites: string[];
  runs: number;
  requests: number;
  hosts: string[];
  behavesLikeTracker: boolean;
  trackerSignals: string[];
  sends: string[];
  stores: Array<{ name: string; kind: string; lifetimeDays: number | null }>;
  sources: string[];
  loadedBy: string[];
  samples: string[];
  phases: string[];
  proposalId?: string;
  note?: string;
}

/** A knowledge-base entry as a researcher proposes it (no provenance yet). */
export interface KbEntryBody {
  id: string;
  vendor: string;
  owner?: string;
  match: { hosts: string[]; path?: string };
  categories: KbCategory[];
  sends: string[];
  stores: Array<{ name: string; kind: 'cookie' | 'local' | 'session'; lifetimeDays?: number }>;
  consentApi?: string;
  decoder: string;
  restrictedMode?: string;
  notes?: string;
}

/** A confirmed entry: recognized on every later scan. */
export interface KbEntry extends KbEntryBody {
  provenance: { proposedBy: string; proposedAt: string; confirmedBy?: string; confirmedAt?: string; sources: string[] };
}

export interface KbProposal {
  id: string; // 'p-<domain>-<n>'
  domain: string;
  status: 'proposed' | 'confirmed' | 'rejected';
  entry: KbEntryBody;
  sources: string[];
  rationale: string;
  confidence: 'high' | 'medium' | 'low';
  /** Where what complykit observed disagrees with the vendor's documentation. */
  disagreements: string[];
  firstParty: boolean;
  proposedBy: string;
  proposedAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewNote?: string;
}

/** The background `kb research` run (one at a time). */
export interface KbResearchState {
  running: boolean;
  /** What is (or was last) being researched. */
  domains: string[];
  startedAt?: string;
  finishedAt?: string;
  model?: string;
  /** The run failed as a whole (e.g. no API key, process crashed). */
  lastError?: string;
  /** Per-domain outcome of the last finished run. */
  lastResults?: Array<{ domain: string; proposalId?: string; error?: string }>;
}

export interface KbResponse {
  /** The store directory (COMPLYKIT_KB_DIR). */
  dir: string;
  /** Every item, open or not, most widespread first. */
  queue: KbQueueItem[];
  counts: Partial<Record<KbQueueStatus, number>>;
  /** Every proposal, any status. */
  proposals: KbProposal[];
  entries: KbEntry[];
  /** ANTHROPIC_API_KEY is set, so `kb research` can run here. */
  researchAvailable: boolean;
  research: KbResearchState;
}

export interface KbResearchRequest {
  /** Domains from the queue. Omit to research the `top` open items. */
  domains?: string[];
  /** 1..20, default 5. Ignored when `domains` is given. */
  top?: number;
}

export interface KbConfirmRequest {
  /** The person confirming (never an agent). */
  by: string;
  /** Replaces the proposal's categories. */
  categories?: KbCategory[];
  vendor?: string;
  owner?: string;
  consentApi?: string;
  note?: string;
}

export interface KbRejectRequest {
  by: string;
  /** Required: the next researcher reads it. */
  reason: string;
}

export interface KbDismissRequest {
  domain: string;
  note?: string;
}

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
//
//   Knowledge base (the store at COMPLYKIT_KB_DIR; `event: kb` on any change):
//   GET    /api/kb                          → KbResponse
//   GET    /api/kb/packet/:domain           → text/markdown (research brief)
//   POST   /api/kb/research  KbResearchRequest → 202 KbResearchState (409 if one is running)
//   POST   /api/kb/proposals/:id/confirm  KbConfirmRequest → KbEntry
//   POST   /api/kb/proposals/:id/reject   KbRejectRequest  → KbProposal
//   POST   /api/kb/dismiss   KbDismissRequest → 204
//
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
