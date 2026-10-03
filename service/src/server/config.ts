// Service configuration, read once from the environment at boot. Everything
// downstream takes a ServiceConfig, so tests build one directly instead of
// mutating process.env.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  /** 0 = never shut down on idle. */
  idleShutdownMinutes: number;
  region?: string;
  /** Path to complykit's dist/cli.js. */
  cliPath: string;
  /** Built client (vite output). May not exist. */
  clientDir: string;
  version: string;
  production: boolean;
  /** Hard cap per job, all checks included. */
  jobTimeoutMs: number;
  /** SIGTERM → SIGKILL grace when stopping a check process. */
  killGraceMs: number;
  /** events.ndjson poll interval. */
  pollMs: number;
}

/** The service directory (holds package.json). Same depth from src/server and
 *  dist/server, so this works under tsx and from the compiled output. */
export const SERVICE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function int(env: NodeJS.ProcessEnv, key: string, fallback: number, min = 0): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) throw new Error(`${key} must be a number >= ${min} (got ${JSON.stringify(raw)})`);
  return Math.floor(n);
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
    idleShutdownMinutes: int(env, 'IDLE_SHUTDOWN_MINUTES', 0),
    region: env.FLY_REGION || undefined,
    cliPath: path.resolve(env.COMPLYKIT_CLI || path.join(SERVICE_DIR, '..', 'dist', 'cli.js')),
    clientDir: path.join(SERVICE_DIR, 'dist', 'client'),
    version: readVersion(),
    production,
    jobTimeoutMs: 45 * 60_000,
    killGraceMs: 10_000,
    pollMs: 500,
  };
}
