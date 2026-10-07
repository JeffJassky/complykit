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
  /** Also repeat every visitor choice on a slowed connection (Slow 3G, CPU x4) to catch timing races; about 3x longer.
   *  Consent only; ignored with quick (quick is always one pass). Default false. */
  slowRepeat?: boolean;
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
  /** `run` is set only on slowed-connection repeats (2..); absent = the first visit. */
  scenarios: Array<{ location: string; scenario: string; run?: number; status: 'running' | 'tested' | 'not-tested' | 'not-applicable'; reason?: string; durationMs?: number }>;
  /** Every planned visit, in run order, as each location's plan arrives (absent on jobs from before it existed). */
  planned?: Array<{ location: string; scenario: string; run?: number }>;
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
    /** The developer's change list (change-list.md beside the report), when the CLI wrote one. */
    changeListUrl?: string;
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
  /** The consent scan repeats every visitor choice on a slowed connection (see CreateBatchRequest.slowRepeat). */
  slowRepeat: boolean;
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

// --- Site workspace ------------------------------------------------------------
// Shared, persistent state per registrable domain (DATA_DIR/sites/<domain>/
// workspace.json): a team's classifications and task status, the latest
// generated tool config, and pointers to runs. Scans stay ephemeral; this is
// what a person decided. Never swept by job retention.

/** One classification / task / override. Same key → latest `at` wins. */
export interface WorkspaceEntry {
  /** Any JSON. `null` is a cleared value, kept so an older write can't revive it. */
  value: unknown;
  /** ISO time of the change (the client's clock, clamped to the server's "now"). */
  at: string;
  /** Who made the change: a name asked once per browser. Attribution, not security. */
  by?: string;
}

/** The latest generated consent-tool config (one register, latest `at` wins). */
export interface WorkspaceConfig extends WorkspaceEntry {
  /** The run it was generated from. */
  runId?: string;
}

/** A pointer to a run of this site; upserted by `id`. */
export interface WorkspaceRun {
  id: string;
  at: string;
  /** Service job that ran it, when it ran here. */
  jobId?: string;
  url?: string;
  /** Small free-form facts about the run (counts, config hash seen…). */
  meta?: Record<string, unknown>;
}

export interface SiteWorkspace {
  version: 1;
  /** Registrable domain, e.g. "example.co.uk" for shop.example.co.uk. */
  domain: string;
  /** Absent until the first write. */
  createdAt?: string;
  updatedAt?: string;
  entries: Record<string, WorkspaceEntry>;
  config?: WorkspaceConfig;
  /** Oldest first, capped (the newest are kept). */
  runs: WorkspaceRun[];
}

/** POST /api/jobs/:id/consent-config body (all optional). */
export interface ConsentConfigRequest {
  /** Stamped on the workspace config. */
  by?: string;
  /** Where the snippet loads the tool from (default: a self-hosted placeholder path). */
  scriptSrc?: string;
  /** Include a consent-record endpoint: a path/URL, or true for this service's /api/consent-records. Omitted by default. */
  recordEndpoint?: string | true;
  privacyPolicyUrl?: string;
}

/** What the generator stores in the site workspace: `config.value`. The Sites page reads `changeList` from it. */
export interface ConsentConfigValue {
  /** The consent tool config (complykit-config.json). */
  config: Record<string, unknown>;
  /** snippet.html */
  snippet: string;
  /** change-list.md */
  changeList: string;
  notes: Array<{ code: string; level: 'refused' | 'flag' | 'info'; message: string; partyIds?: string[] }>;
  /** Where the snippet loads the tool from; the install zip puts the client files in its folder. */
  scriptSrc?: string;
  /** The guided remediation checklist (complykit's RemediationTask[], plans/remediation-flow.md §3), in order. */
  tasks?: RemediationTask[];
}

// --- Guided remediation (plans/remediation-flow.md) --------------------------------
// Mirrors of complykit's src/record/remediation.ts shapes (the service never
// imports the package). Status lives only in the workspace, under
// `task:change:<id>` → RemediationTaskValue; the stored `config.value.tasks`
// carry the checklist itself.

export type RemediationStatus = 'todo' | 'done-unverified' | 'verified' | 'failed' | 'cannot-verify';
export type VerifyResult = 'pass' | 'fail' | 'cannot-verify';

export interface RemediationLastVerify {
  at: string;
  result: VerifyResult;
  message: string;
  evidence: string[];
}

/** The workspace entry value under `task:change:<id>`. */
export interface RemediationTaskValue {
  status: RemediationStatus;
  note?: string;
  lastVerify?: RemediationLastVerify;
}

/** What Verify needs: `method` says what runs it (static fetch, browser spot check, or nothing: manual). */
export interface RemediationVerifySpec {
  check: 'install' | 'rewrite-tag' | 'remove-leak' | 'gtm-tag-consent' | 'consent-default' | 'remove-existing-tool' | 'spot-check' | 'manual';
  method: 'static' | 'browser' | 'manual';
  page?: string;
  [key: string]: unknown;
}

export interface RemediationTask {
  id: string;
  kind: string;
  group: string;
  title: string;
  summary: string;
  party?: string;
  tools: string[];
  partyIds: string[];
  steps: string[];
  snippet?: { before?: string; after?: string };
  pages: string[];
  verify: RemediationVerifySpec;
  status: RemediationStatus;
  lastVerify?: RemediationLastVerify;
  /** The owner's note, from the workspace entry (merged views only). */
  note?: string;
  optional: boolean;
  classifyFirst?: boolean;
  notes: string[];
  guide?: { label: string; href: string };
  /** Ids of change-list items folded into this task (a behavior mismatch, a vendor call, an exposure): a status stored under one is still found. */
  aliases?: string[];
  /** "This also fixes: …" — one plain line per folded item. */
  alsoFixes?: string[];
  /** Steps whose wording depends on the surface: each replaces steps[step] here (`service`) or in a report file / the CLI (`offline`). */
  stepVariants?: Array<{ step: number; service: string; offline: string }>;
  order: number;
}

export interface RemediationTotals {
  total: number;
  verified: number;
  doneUnverified: number;
  failed: number;
  cannotVerify: number;
  todo: number;
  /** Tasks that are not optional. */
  required: number;
}

/** GET /api/sites/:domain/remediation */
export interface RemediationResponse {
  domain: string;
  /** The stored checklist with each task's status / note / lastVerify from the workspace. Empty before a config is generated. */
  tasks: RemediationTask[];
  totals: RemediationTotals;
  /** When the config (and so the checklist) was generated; absent without one. */
  configAt?: string;
  runId?: string;
}

/** POST /api/sites/:domain/remediation/:id/verify */
export interface VerifyTaskResponse {
  /** The task with its new status and lastVerify. */
  task: RemediationTask;
  /** What `complykit verify-change` returned. */
  outcome: RemediationLastVerify & { check: string; fetched?: { url: string; status?: number; via?: string; error?: string } };
  /** True when a newer status was already stored (this one was not saved). */
  stale: boolean;
}

/** POST /api/jobs/:id/rerender body (all optional). */
export interface RerenderRequest {
  /** Stamped on a regenerated config. */
  by?: string;
  /** Generate the site's consent tool config from this run first, even when the stored one did not come from it
   *  (the report's "Generate" button: the config, the checklist and the report then agree in one step). */
  generate?: boolean;
}

/** POST /api/sites/:domain/rescan body (optional). The location is not a choice: the service scans from its own connection only. */
export interface RescanRequest {
  /** Quick (shorter visits, fewer visitor choices) or full; default: as the site's latest job. */
  quick?: boolean;
  /** Repeat on a slowed connection (full scans only); default: as the site's latest job. Always false when the rescan is quick. */
  slowRepeat?: boolean;
}

/** POST /api/sites/:domain/rescan: a new consent job with the options of the site's latest one (quick / full as the request chooses). */
export interface RescanResponse {
  domain: string;
  /** The new job (queued). */
  job: JobSummary;
  /** What it repeats: the latest job's URL, checks, quick and slowRepeat flags (or the workspace's newest run URL when no job is left). The new job's own `quick` / `slowRepeat` are the request's choice when it made one. */
  from: { jobId?: string; url: string; checks: CheckKind[]; quick: boolean; slowRepeat: boolean };
}

/** The job's consent report re-rendered from its saved run with the site's current workspace (R2). */
export interface RerenderResponse {
  ok: true;
  /** When it was re-rendered (the server's clock). */
  at: string;
  runId: string;
  /** The served report, now the new one. */
  reportUrl: string;
  /** The report it replaced (one generation kept). */
  previousReportUrl: string;
  /** class: entries with a value in the workspace it was rendered with. */
  classifications: number;
  /** The site's stored config is regenerated when it came from this run. */
  config: { regenerated: boolean; stale?: boolean };
}

/** POST /api/jobs/:id/rerender error body: `configStored` when the config (and so the checklist) was generated and stored but the report could not be re-rendered — retry without `generate`. */
export interface RerenderErrorBody {
  error: string;
  configStored?: boolean;
  /** When the stored config was generated (configStored only). */
  configAt?: string;
}

export interface ConsentConfigResponse {
  domain: string;
  runId: string;
  value: ConsentConfigValue;
  /** The written files, served under /reports/<jobId>/. */
  files: { config: string; snippet: string; changeList: string; notes: string };
  /** True when a newer config was already stored (this one was not saved). */
  stale: boolean;
}

/** PATCH body. Every part is optional, but at least one must be present.
 *  `at` defaults to the server's now; `by` defaults to the top-level `by`. */
export interface SiteWorkspacePatch {
  by?: string;
  entries?: Record<string, { value: unknown; at?: string; by?: string }>;
  config?: { value: unknown; at?: string; by?: string; runId?: string };
  runs?: Array<{ id: string; at?: string; jobId?: string; url?: string; meta?: Record<string, unknown> }>;
}

export interface SiteWorkspacePatchResponse {
  workspace: SiteWorkspace;
  /** Writes that lost to a newer value already stored (the client should take the stored one). */
  stale: { entries: string[]; config: boolean; runs: string[] };
}

/**
 * Injected into a served report as <script type="application/json" id="ck-service">
 * (service/src/server/report-config.ts); complykit's report workbench reads it
 * (src/report/workspace.ts) and saves to `workspace` instead of localStorage.
 * Entry keys the workbench writes: `task:<data-action-key>` → { status, note,
 * answers, comparisonKey? } (done = status 'done') and `class:<data-class-key>` → { category,
 * additionalCategories, categoryChosen, purpose, owner, information, control,
 * controlReason, source }; a cleared one is `null`.
 */
export interface ReportServiceConfig {
  version: 1;
  domain: string;
  /** Same-origin path of the site's workspace API. */
  workspace: string;
  jobId: string;
}

export interface SiteSummary {
  domain: string;
  updatedAt?: string;
  /** Entries with a non-null value. */
  entries: number;
  runs: number;
  lastRunAt?: string;
  configAt?: string;
  /** Checklist progress over the required tasks (not optional, not classify-first), as the report and site page count it. Absent before a config with tasks exists. */
  checklist?: { verified: number; required: number; doneUnverified: number; failed: number };
}

export interface SitesResponse {
  /** Most recently updated first. */
  sites: SiteSummary[];
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
//   POST   /api/jobs/:id/consent-config  ConsentConfigRequest → ConsentConfigResponse
//          (a finished consent job: generates the consent tool config with the
//          site's current workspace and stores it as the workspace `config`)
//   POST   /api/jobs/:id/rerender  RerenderRequest → RerenderResponse
//          (re-renders the job's consent report from its saved run with the
//          site's current workspace — no rescan; regenerates the stored config
//          when it came from this run, or from this run in any case with
//          `generate: true`; the old report is kept as *.prev.html)
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
//   Site workspaces (DATA_DIR/sites/<registrable-domain>/workspace.json). :domain
//   may be any host of the site (shop.example.com → example.com):
//   GET    /api/sites                       → SitesResponse
//   GET    /api/sites/:domain/workspace     → SiteWorkspace (empty, not 404, when none yet)
//   PATCH  /api/sites/:domain/workspace  SiteWorkspacePatch → SiteWorkspacePatchResponse
//   GET    /api/sites/:domain/remediation   → RemediationResponse (config.value.tasks + task:change:* status)
//   POST   /api/sites/:domain/rescan  RescanRequest → RescanResponse (201: a new consent job with the
//          latest job's URL / checks / quick / slowRepeat, or the requested ones; 409 while a scan of the site is queued or running)
//   POST   /api/sites/:domain/remediation/:id/verify → VerifyTaskResponse (runs `complykit
//          verify-change`, stores { status, lastVerify } by 'verify'; 409 while another
//          verify for the site runs, or for a manual task)
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
