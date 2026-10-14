// Host ↔ worker protocol (plans/do-hosting.md, "Host ↔ worker", "The merge worker").
//
// Every route is under /internal/*, needs `x-complykit-worker-secret`, and is
// reached by the host through Fly's public proxy (`https://<workers-app>.fly.dev`
// with `fly-force-instance-id: <machineId>`), or, between workers, over Fly's
// private network. Workers run one job at a time (409 busy otherwise).
//
// Job-style routes (collect, merge, consent, accessibility) all answer 202 with
// `{ jobId }` and share the existing job routes:
//   GET    /internal/jobs/:jobId             → WorkerJobState
//   GET    /internal/jobs/:jobId/events?from → NDJSON lines from offset (consent CLI --events)
//   GET    /internal/jobs/:jobId/report      → the live owner-report.json (collect only)
//   GET    /internal/jobs/:jobId/run.tar     → the collected run (collect only; 409 before 'collected')
//   POST   /internal/jobs/:jobId/cancel
//   DELETE /internal/jobs/:jobId             → stop if running, delete the job's directory
//
// Uploads: merge, consent and accessibility put their output in the blob store
// under `publish.prefix` (e.g. `jobs/<jobId>/consent/`) before reporting 'done'.
// They upload the job's working directory minus `gather/`, `live/` and
// `events.ndjson` (the host keeps the events it relayed and publishes those).
// Raw collections (gather/, run.tar) are never uploaded.

import type { LawId } from '../shared/laws.js';
import type { SiteWorkspace } from '../shared/api.js';

export const WORKER_SECRET_HEADER = 'x-complykit-worker-secret';
/** Set by a merge worker on the run.tar GETs it makes to its peers. */
export const PEER_HEADER = 'x-complykit-peer';
/** Fly proxy: route this request to one Machine. */
export const FLY_INSTANCE_HEADER = 'fly-force-instance-id';

/** Region for work that isn't a law's: legacy single-location consent, accessibility, Verify (Chicago: US, no state privacy law). */
export const DEFAULT_WORKER_REGION = 'ord';

export interface WorkerJobState {
  jobId: string;
  /** collect: running → collected | failed. merge/consent/accessibility: running → done | failed. */
  state: 'running' | 'collected' | 'done' | 'failed';
  error?: string;
}

/** POST /internal/collect (exists today in worker.ts; unchanged — move its type here). */
export interface CollectRequest {
  jobId: string;
  url: string;
  locationId: string;
  quick: boolean;
  /** 1–5 visits per scenario. */
  runs: number;
}

/** Where a job-style route puts its output. */
export interface Publish {
  /** Blob prefix, ending in '/': `jobs/<jobId>/consent/` or `jobs/<jobId>/accessibility/`. */
  prefix: string;
}

/** POST /internal/merge: pull the peers' collections, run `consent --merge`, publish the finished run. */
export interface MergeRequest {
  /** The worker-side job id (the host uses `<jobId>-merge`). */
  jobId: string;
  url: string;
  /** One per law that collected: where to GET its run.tar (private address), sent with the worker secret and `x-complykit-peer: merge`. */
  sources: Array<{ law: LawId; locationId: string; tarUrl: string }>;
  /** Laws that could not be scanned: passed as `--failed <locationId>=<error>`. */
  failed: Array<{ locationId: string; error: string }>;
  workspace?: SiteWorkspace;
  /** Blob prefix of the site's previous run (`jobs/<id>/consent/.comply/runs/<runId>/`), passed as `--previous` after download (its evaluation files only, not evidence/). */
  previous?: string;
  /** Blob prefix of the knowledge base, always 'kb/'. Downloaded before the CLI runs; the CLI reads it through COMPLYKIT_KB_DIR. */
  kb?: string;
  publish: Publish;
}

/** POST /internal/consent: a single-location consent scan from this worker (a job without laws). */
export interface ConsentRequest {
  jobId: string;
  url: string;
  quick: boolean;
  runs: number;
  workspace?: SiteWorkspace;
  previous?: string;
  /** As in MergeRequest. */
  kb?: string;
  publish: Publish;
}

/** POST /internal/accessibility */
export interface AccessibilityRequest {
  jobId: string;
  url: string;
  publish: Publish;
}

/** POST /internal/verify: synchronous; answers 200 with the CLI's `verify-change --json` stdout parsed, or 4xx/5xx { error }. */
export interface VerifyRequest {
  /** The RemediationTask, as the CLI's --task file. */
  task: unknown;
  site: string;
}
