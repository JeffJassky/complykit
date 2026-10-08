// Worker mode (WORKER=1): the same image, serving only /internal/*. A regional
// worker runs one `consent --collect-only` at a time for the primary, which
// polls its events and fetches the run as a tar. Nothing here knows about the
// job store, workspaces or the normal API.

import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TarArchive } from 'archiver';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { SERVICE_DIR, readVersion } from './config.js';
import { walk } from './zip.js';

export const WORKER_SECRET_HEADER = 'x-complykit-worker-secret';

export interface WorkerConfig {
  port: number;
  /** Address to bind: 'fly-local-6pn' on Fly (private network only), '::' otherwise. */
  bind: string;
  secret: string;
  /** Job directories live here: <tmpDir>/<jobId>. */
  tmpDir: string;
  cliPath: string;
  version: string;
  /** 0 = never shut down on idle. */
  idleShutdownMinutes: number;
  /** Hard cap for one collection. */
  jobTimeoutMs: number;
  killGraceMs: number;
}

export interface WorkerService {
  app: Express;
  isBusy(): boolean;
  lastActivity(): number;
  /** Kill a running collection and wait for it to exit. */
  stop(killGraceMs?: number): Promise<void>;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const secret = env.WORKER_SECRET;
  if (!secret) throw new Error('WORKER_SECRET is required when WORKER=1 (refusing to serve /internal/* without it)');
  const num = (key: string, fallback: number, min: number): number => {
    const raw = env[key];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min) throw new Error(`${key} must be a number >= ${min} (got ${JSON.stringify(raw)})`);
    return Math.floor(n);
  };
  return {
    port: num('PORT', 8080, 1),
    bind: env.WORKER_BIND || (env.FLY_APP_NAME ? 'fly-local-6pn' : '::'),
    secret,
    tmpDir: path.resolve(env.WORKER_TMP || path.join(os.tmpdir(), 'complykit-worker')),
    cliPath: path.resolve(env.COMPLYKIT_CLI || path.join(SERVICE_DIR, '..', 'dist', 'cli.js')),
    version: readVersion(),
    idleShutdownMinutes: num('IDLE_SHUTDOWN_MINUTES', 0, 0),
    jobTimeoutMs: 45 * 60_000,
    killGraceMs: 10_000,
  };
}

const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;
const LOCATION_ID = /^(local|[a-z]{2}|us-[a-z]{2})$/;

type State = 'running' | 'collected' | 'failed';

interface WorkerJob {
  id: string;
  dir: string;
  state: State;
  error?: string;
  child?: ChildProcess;
  reason?: 'cancelled' | 'stopped' | 'timeout';
  stderr: string[];
  /** Resolves when the process has exited and the state is final. */
  finished: Promise<void>;
}

interface CollectRequest {
  jobId: string;
  url: string;
  locationId: string;
  quick: boolean;
  runs: number;
}

class BadRequest extends Error {}

function sha(s: string): Buffer {
  return crypto.createHash('sha256').update(s).digest();
}

/** Constant-time compare (both sides hashed to equal length first). */
function secretMatches(given: string | undefined, expected: string): boolean {
  return given !== undefined && crypto.timingSafeEqual(sha(given), sha(expected));
}

function parseCollect(b: unknown): CollectRequest {
  if (!b || typeof b !== 'object') throw new BadRequest('body must be a JSON object');
  const o = b as Record<string, unknown>;
  if (typeof o.jobId !== 'string' || !JOB_ID.test(o.jobId)) throw new BadRequest('jobId must match [A-Za-z0-9_-]{1,64}');
  let url: URL | undefined;
  try {
    url = typeof o.url === 'string' ? new URL(o.url) : undefined;
  } catch {
    /* falls through */
  }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) throw new BadRequest('url must be an http(s) URL');
  if (typeof o.locationId !== 'string' || !LOCATION_ID.test(o.locationId)) throw new BadRequest('locationId must be local, a two-letter country, or us-<state>');
  if (typeof o.runs !== 'number' || !Number.isInteger(o.runs) || o.runs < 1 || o.runs > 5) throw new BadRequest('runs must be an integer from 1 to 5');
  if (o.quick !== undefined && typeof o.quick !== 'boolean') throw new BadRequest('quick must be a boolean');
  if (o.slowRepeat !== undefined && typeof o.slowRepeat !== 'boolean') throw new BadRequest('slowRepeat must be a boolean');
  // slowRepeat is accepted for the primary's convenience; `runs` already says how many visits.
  return { jobId: o.jobId, url: url.href, locationId: o.locationId, quick: o.quick === true, runs: o.runs };
}

export function createWorkerApp(config: WorkerConfig): WorkerService {
  const jobs = new Map<string, WorkerJob>();
  let lastActivity = Date.now();
  const app = express();
  app.disable('x-powered-by');

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!secretMatches(req.get(WORKER_SECRET_HEADER), config.secret)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    // Health checks don't keep an idle worker awake.
    if (req.path !== '/internal/health') lastActivity = Date.now();
    next();
  });
  app.use(express.json({ limit: '64kb' }));

  const isBusy = () => [...jobs.values()].some((j) => j.state === 'running');

  function stopJob(job: WorkerJob, reason: NonNullable<WorkerJob['reason']>, graceMs = config.killGraceMs): void {
    job.reason ??= reason;
    if (job.child) killTree(job.child, graceMs);
  }

  async function settle(job: WorkerJob, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    const tail = job.stderr.slice(-6).join('\n').trim();
    const withTail = (m: string) => (tail ? `${m}\n${tail}` : m);
    const fail = (m: string) => {
      job.state = 'failed';
      job.error = m;
    };
    if (job.reason === 'cancelled') return fail('cancelled');
    if (job.reason === 'stopped') return fail('worker stopped');
    if (job.reason === 'timeout') return fail(`timed out after ${Math.round(config.jobTimeoutMs / 60_000)} minutes`);
    if (code !== 0) return fail(withTail(`consent collect exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
    const runDir = await singleRunDir(job.dir);
    if (runDir && fs.existsSync(path.join(runDir, 'collection.json'))) job.state = 'collected';
    else fail(withTail('consent collect finished without a collection.json'));
  }

  async function startJob(b: CollectRequest): Promise<WorkerJob> {
    const dir = path.join(config.tmpDir, b.jobId);
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
    const eventsFile = path.join(dir, 'events.ndjson');
    const args = [config.cliPath, 'consent', '--collect-only', '--url', b.url, '--locations', b.locationId, '--cwd', dir, '--events', eventsFile, '--quiet', '--runs', String(b.runs), ...(b.quick ? ['--quick'] : [])];
    const job: WorkerJob = { id: b.jobId, dir, state: 'running', stderr: [], finished: Promise.resolve() };

    job.finished = new Promise<void>((resolve) => {
      const fail = (message: string) => {
        job.state = 'failed';
        job.error = message;
        resolve();
      };
      if (!fs.existsSync(config.cliPath)) {
        fail(`complykit CLI not found at ${config.cliPath}`);
        return;
      }
      // detached → its own process group, so a kill reaches Chromium too.
      const child = spawn(process.execPath, args, { cwd: dir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      job.child = child;
      child.stdout!.resume();
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (chunk: string) => {
        job.stderr.push(...chunk.split(/\r?\n/).filter((l) => l.trim()));
        if (job.stderr.length > 50) job.stderr.splice(0, job.stderr.length - 50);
      });
      const timer = setTimeout(() => stopJob(job, 'timeout'), config.jobTimeoutMs);
      child.on('error', (err) => {
        clearTimeout(timer);
        job.child = undefined;
        fail(err.message);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        job.child = undefined;
        void settle(job, code, signal).then(resolve);
      });
    });
    return job;
  }

  app.get('/internal/health', (_req, res) => {
    res.json({ ok: true, version: config.version });
  });

  app.post('/internal/collect', async (req: Request, res: Response) => {
    try {
      const body = parseCollect(req.body);
      if (isBusy()) {
        res.status(409).json({ error: 'busy: a collection is already running' });
        return;
      }
      if (jobs.has(body.jobId)) {
        res.status(409).json({ error: `job ${body.jobId} already exists` });
        return;
      }
      const job = await startJob(body);
      jobs.set(job.id, job);
      res.status(202).json({ jobId: job.id, state: job.state });
    } catch (err) {
      if (err instanceof BadRequest) res.status(400).json({ error: err.message });
      else res.status(500).json({ error: (err as Error).message });
    }
  });

  // Every :jobId route validates the id first: it becomes a path component.
  app.param('jobId', (_req, res, next, id: string) => {
    if (!JOB_ID.test(id)) {
      res.status(400).json({ error: 'invalid jobId' });
      return;
    }
    next();
  });

  const need = (req: Request, res: Response): WorkerJob | undefined => {
    const job = jobs.get(String(req.params.jobId));
    if (!job) res.status(404).json({ error: 'unknown job' });
    return job;
  };

  app.get('/internal/jobs/:jobId', (req, res) => {
    const job = need(req, res);
    if (job) res.json({ state: job.state, ...(job.error ? { error: job.error } : {}) });
  });

  app.get('/internal/jobs/:jobId/events', async (req, res) => {
    const job = need(req, res);
    if (!job) return;
    const from = Number(req.query.from ?? 0);
    if (!Number.isInteger(from) || from < 0) {
      res.status(400).json({ error: 'from must be a non-negative integer' });
      return;
    }
    let text = '';
    try {
      text = await fsp.readFile(path.join(job.dir, 'events.ndjson'), 'utf8');
    } catch {
      /* not written yet */
    }
    // Complete lines only: the CLI may be mid-write.
    const lines = text.split('\n');
    lines.pop();
    const out = lines.slice(from);
    res.type('application/x-ndjson').send(out.length ? out.join('\n') + '\n' : '');
  });

  app.get('/internal/jobs/:jobId/run.tar', async (req, res) => {
    const job = need(req, res);
    if (!job) return;
    if (job.state !== 'collected') {
      res.status(409).json({ error: `job is ${job.state}, not collected` });
      return;
    }
    const runDir = await singleRunDir(job.dir);
    if (!runDir) {
      res.status(500).json({ error: 'run directory missing' });
      return;
    }
    // Entries are relative to the run dir (collection.json at the top), so the
    // primary extracts straight into its gather/<law>/ folder.
    const files = (await walk(runDir)).sort();
    res.status(200).set('Content-Type', 'application/x-tar');
    const tar = new TarArchive();
    tar.on('error', (err: Error) => res.destroy(err));
    res.on('close', () => {
      if (!res.writableFinished) tar.abort();
    });
    tar.pipe(res);
    for (const rel of files) tar.file(path.join(runDir, rel), { name: rel });
    await tar.finalize();
  });

  app.post('/internal/jobs/:jobId/cancel', async (req, res) => {
    const job = need(req, res);
    if (!job) return;
    if (job.state === 'running') {
      stopJob(job, 'cancelled');
      await job.finished;
    }
    res.json({ state: job.state, ...(job.error ? { error: job.error } : {}) });
  });

  app.delete('/internal/jobs/:jobId', async (req, res) => {
    const job = need(req, res);
    if (!job) return;
    if (job.state === 'running') {
      stopJob(job, 'cancelled');
      await job.finished;
    }
    jobs.delete(job.id);
    await fsp.rm(job.dir, { recursive: true, force: true });
    res.status(204).end();
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  return {
    app,
    isBusy,
    lastActivity: () => lastActivity,
    async stop(killGraceMs = config.killGraceMs) {
      const running = [...jobs.values()].filter((j) => j.state === 'running');
      for (const j of running) stopJob(j, 'stopped', killGraceMs);
      await Promise.all(running.map((j) => j.finished));
    },
  };
}

/** The one run directory a collect-only invocation leaves in <jobDir>/.comply/runs/. */
async function singleRunDir(jobDir: string): Promise<string | undefined> {
  const runs = path.join(jobDir, '.comply', 'runs');
  try {
    const dirs = (await fsp.readdir(runs, { withFileTypes: true })).filter((e) => e.isDirectory());
    return dirs.length === 1 ? path.join(runs, dirs[0].name) : undefined;
  } catch {
    return undefined;
  }
}

/** SIGTERM the child's process group, then SIGKILL after `graceMs`. */
function killTree(child: ChildProcess, graceMs: number): void {
  const signal = (sig: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        /* already gone */
      }
    }
  };
  signal('SIGTERM');
  const t = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signal('SIGKILL');
  }, graceMs);
  t.unref();
  child.once('close', () => clearTimeout(t));
}
