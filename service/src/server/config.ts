// Service configuration, read once from the environment at boot. Everything
// downstream takes a ServiceConfig, so tests build one directly instead of
// mutating process.env.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { siteDomain } from './domains.js';

export interface ServiceConfig {
  port: number;
  /** HTTP Basic password (any username). Undefined = open (local dev only). */
  password?: string;
  dataDir: string;
  /** complykit's knowledge-base store (queue, proposals, confirmed entries).
   *  Consent checks read and feed it; the KB routes manage it. */
  kbDir: string;
  /** ANTHROPIC_API_KEY is set, so `kb research` can run on this server. */
  researchAvailable: boolean;
  concurrency: number;
  retentionDays: number;
  /** Consent records older than this many days are pruned (CONSENT_RECORD_RETENTION_DAYS, default 1825 = 5 years). Separate from retentionDays: jobs are scan output, these are proof. */
  consentRecordRetentionDays: number;
  /** CONSENT_RECORD_DOMAINS (comma list of registrable domains): when set, the consent-record endpoint only accepts these sites. Unset = any site. */
  consentRecordDomains?: string[];
  /** 0 = never shut down on idle. */
  idleShutdownMinutes: number;
  region?: string;
  /** Path to complykit's dist/cli.js. */
  cliPath: string;
  /** Built client (vite output). May not exist. */
  clientDir: string;
  /** The built consent client (client/dist): the install zip copies complykit-consent.js and complykit-consent-ui.js from it. COMPLYKIT_CLIENT_DIST. */
  consentClientDist: string;
  version: string;
  production: boolean;
  /**
   * Visits per consent scenario for a job that opts into the slowed repeat
   * (`slowRepeat`): CONSENT_RUNS, default 2, 2 to 5 (below 2 counts as 2). Runs
   * after the first repeat under Slow 3G + CPU x4 to catch timing races. Every
   * other job, and every quick job, is a single pass: one visit per scenario.
   * See consentRunsFor.
   */
  consentRuns?: number;
  /** Hard cap per job for a single pass, all checks included (45 min). A job with
   *  repeat runs gets more: see jobTimeoutFor. */
  jobTimeoutMs: number;
  /** SIGTERM → SIGKILL grace when stopping a check process. */
  killGraceMs: number;
  /** events.ndjson poll interval. */
  pollMs: number;
  /** Make the site's to-do list (config + checklist) when a consent scan finishes, with no button (AUTO_CHECKLIST=0 turns it off). */
  autoChecklist: boolean;
}

/** The service directory (holds package.json). Same depth from src/server and
 *  dist/server, so this works under tsx and from the compiled output. */
export const SERVICE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * How much longer a slowed repeat takes than a normal visit. Mirrors the CLI's
 * THROTTLED_BUDGET_FACTOR (3): each repeat run gets three times the scenario
 * budget, so the job cap grows by the same factor per extra run.
 */
export const SLOW_REPEAT_TIMEOUT_FACTOR = 3;

/** Visits per consent scenario for this job: 1 unless it opted into the slowed repeat (never for quick). */
export function consentRunsFor(job: { quick: boolean; slowRepeat?: boolean }, config: Pick<ServiceConfig, 'consentRuns'>): number {
  if (job.quick || !job.slowRepeat) return 1;
  return Math.max(2, Math.min(5, config.consentRuns ?? 2));
}

/**
 * The job's hard cap: jobTimeoutMs x (1 + SLOW_REPEAT_TIMEOUT_FACTOR x (runs - 1)).
 * runs = 1 → 45 min; runs = 2 → 180 min; runs = 3 → 315 min.
 */
export function jobTimeoutFor(config: Pick<ServiceConfig, 'jobTimeoutMs'>, runs: number): number {
  return config.jobTimeoutMs * (1 + SLOW_REPEAT_TIMEOUT_FACTOR * Math.max(0, runs - 1));
}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number, min = 0): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) throw new Error(`${key} must be a number >= ${min} (got ${JSON.stringify(raw)})`);
  return Math.floor(n);
}

function domainList(raw: string | undefined): string[] | undefined {
  const list = (raw ?? '').split(/[,\s]+/).filter(Boolean).map((d) => siteDomain(d));
  if (list.some((d) => !d)) throw new Error(`CONSENT_RECORD_DOMAINS must be a comma-separated list of domains (got ${JSON.stringify(raw)})`);
  return list.length ? [...new Set(list as string[])] : undefined;
}

function readVersion(): string {
  // complykit's version is the interesting one; the service is private 0.0.0.
  for (const p of [path.join(SERVICE_DIR, '..', 'package.json'), path.join(SERVICE_DIR, 'package.json')]) {
    try {
      const v = (JSON.parse(fs.readFileSync(p, 'utf8')) as { version?: string }).version;
      if (v) return v;
    } catch {
      /* try the next one */
    }
  }
  return '0.0.0';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const production = env.NODE_ENV === 'production';
  const password = env.SERVICE_PASSWORD || undefined;
  // Running open in production must be a deliberate choice: ALLOW_OPEN=1.
  if (!password && production && env.ALLOW_OPEN !== '1') {
    throw new Error('SERVICE_PASSWORD is required when NODE_ENV=production (refusing to run an open scanner on the internet); set ALLOW_OPEN=1 to run without one on purpose');
  }
  const dataDir = path.resolve(env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(SERVICE_DIR, '.data')));
  return {
    port: int(env, 'PORT', 8080, 1),
    password,
    dataDir,
    kbDir: path.resolve(env.COMPLYKIT_KB_DIR || path.join(dataDir, 'kb')),
    researchAvailable: Boolean(env.ANTHROPIC_API_KEY),
    concurrency: int(env, 'CONCURRENCY', 2, 1),
    retentionDays: int(env, 'RETENTION_DAYS', 14, 1),
    consentRecordRetentionDays: int(env, 'CONSENT_RECORD_RETENTION_DAYS', 1825, 1),
    consentRecordDomains: domainList(env.CONSENT_RECORD_DOMAINS),
    idleShutdownMinutes: int(env, 'IDLE_SHUTDOWN_MINUTES', 0),
    region: env.FLY_REGION || undefined,
    cliPath: path.resolve(env.COMPLYKIT_CLI || path.join(SERVICE_DIR, '..', 'dist', 'cli.js')),
    clientDir: path.join(SERVICE_DIR, 'dist', 'client'),
    consentClientDist: path.resolve(env.COMPLYKIT_CLIENT_DIST || path.join(SERVICE_DIR, '..', 'client', 'dist')),
    version: readVersion(),
    production,
    consentRuns: Math.max(2, Math.min(5, int(env, 'CONSENT_RUNS', 2, 1))),
    jobTimeoutMs: 45 * 60_000,
    killGraceMs: 10_000,
    pollMs: 500,
    autoChecklist: env.AUTO_CHECKLIST !== '0',
  };
}
