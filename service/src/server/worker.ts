// Worker mode (WORKER=1): the same image, serving only /internal/*. A worker
// runs one job at a time for the host (protocol: worker-protocol.ts): a
// `consent --collect-only`, a merge of its peers' collections, a single-location
// consent scan, an accessibility check, or a Verify. Finished runs go to the
// blob store; raw collections never do. Nothing here knows about the job store,
// workspaces or the normal API.

import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { TarArchive } from 'archiver';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { SiteWorkspace } from '../shared/api.js';
import { SERVICE_DIR, readVersion } from './config.js';
import { FsBlobs } from './storage/fs-blobs.js';
import { SpacesBlobs } from './storage/spaces-blobs.js';
import { assertKey, type Blobs } from './storage/types.js';
import { PEER_HEADER, WORKER_SECRET_HEADER, type AccessibilityRequest, type CollectRequest, type ConsentRequest, type MergeRequest, type VerifyRequest } from './worker-protocol.js';
import { walk } from './zip.js';

export { WORKER_SECRET_HEADER };

export interface WorkerConfig {
  port: number;
  /** Address to bind: WORKER_BIND, else '::' (workers are reached through Fly's public proxy as well as the private network). */
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
  /** Where merge/consent/accessibility publish; without one those routes answer 503 (collect still works). */
  blobs?: Blobs;
  /** Hard cap for one Verify. */
  verifyTimeoutMs?: number;
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
    bind: env.WORKER_BIND || '::',
    secret,
    tmpDir: path.resolve(env.WORKER_TMP || path.join(os.tmpdir(), 'complykit-worker')),
    cliPath: path.resolve(env.COMPLYKIT_CLI || path.join(SERVICE_DIR, '..', 'dist', 'cli.js')),
    version: readVersion(),
    idleShutdownMinutes: num('IDLE_SHUTDOWN_MINUTES', 0, 0),
    jobTimeoutMs: 45 * 60_000,
    killGraceMs: 10_000,
    blobs: blobsFromEnv(env),
    verifyTimeoutMs: 5 * 60_000,
  };
}

function blobsFromEnv(env: NodeJS.ProcessEnv): Blobs | undefined {
  if (env.WORKER_BLOB_DIR) return new FsBlobs(env.WORKER_BLOB_DIR);
  const keys = ['SPACES_ENDPOINT', 'SPACES_BUCKET', 'SPACES_KEY', 'SPACES_SECRET'] as const;
  const have = keys.filter((k) => env[k]);
  if (have.length === 0) return undefined;
  if (have.length < keys.length) throw new Error(`incomplete Spaces settings: ${keys.filter((k) => !env[k]).join(', ')} missing`);
  return new SpacesBlobs({ endpoint: env.SPACES_ENDPOINT!, bucket: env.SPACES_BUCKET!, accessKeyId: env.SPACES_KEY!, secretAccessKey: env.SPACES_SECRET!, region: env.SPACES_REGION || 'us-east-1' });
}

const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;
const LOCATION_ID = /^(local|[a-z]{2}|us-[a-z]{2})$/;
/** A law id becomes a directory name under gather/. */
const LAW_DIR = /^[a-z0-9-]{1,32}$/;
const SITE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const MAX_SOURCES = 12;
const MAX_FAILED = 24;
const MAX_VERIFY_STDOUT = 8 * 1024 * 1024;

type State = 'running' | 'collected' | 'done' | 'failed';
type Kind = 'collect' | 'merge' | 'consent' | 'accessibility';

interface WorkerJob {
  id: string;
  kind: Kind;
  dir: string;
  state: State;
  error?: string;
  child?: ChildProcess;
  reason?: 'cancelled' | 'stopped' | 'timeout';
  stderr: string[];
  abort: AbortController;
  /** Resolves when the work has ended and the state is final. */
  finished: Promise<void>;
}

class BadRequest extends Error {}

function sha(s: string): Buffer {
  return crypto.createHash('sha256').update(s).digest();
}

/** Constant-time compare (both sides hashed to equal length first). */
function secretMatches(given: string | undefined, expected: string): boolean {
  return given !== undefined && crypto.timingSafeEqual(sha(given), sha(expected));
}

const asObject = (b: unknown): Record<string, unknown> => {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new BadRequest('body must be a JSON object');
  return b as Record<string, unknown>;
};

function parseJobId(o: Record<string, unknown>): string {
  if (typeof o.jobId !== 'string' || !JOB_ID.test(o.jobId)) throw new BadRequest('jobId must match [A-Za-z0-9_-]{1,64}');
  return o.jobId;
}

function parseHttpUrl(v: unknown, field: string): string {
  let url: URL | undefined;
  try {
    url = typeof v === 'string' ? new URL(v) : undefined;
  } catch {
    /* falls through */
  }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) throw new BadRequest(`${field} must be an http(s) URL`);
  return url.href;
}

function parseCollect(b: unknown): CollectRequest {
  const o = asObject(b);
  const jobId = parseJobId(o);
  const url = parseHttpUrl(o.url, 'url');
  if (typeof o.locationId !== 'string' || !LOCATION_ID.test(o.locationId)) throw new BadRequest('locationId must be local, a two-letter country, or us-<state>');
  const runs = parseRuns(o.runs);
  if (o.quick !== undefined && typeof o.quick !== 'boolean') throw new BadRequest('quick must be a boolean');
  if (o.slowRepeat !== undefined && typeof o.slowRepeat !== 'boolean') throw new BadRequest('slowRepeat must be a boolean');
  // slowRepeat is accepted for the primary's convenience; `runs` already says how many visits.
  return { jobId, url, locationId: o.locationId, quick: o.quick === true, runs };
}

function parseRuns(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 5) throw new BadRequest('runs must be an integer from 1 to 5');
  return v;
}

/** A blob prefix a worker may write or read: ends in '/', safe (assertKey), under jobs/. */
function parsePrefix(v: unknown, field: string): string {
  if (typeof v !== 'string') throw new BadRequest(`${field} must be a blob prefix`);
  try {
    assertKey(v, { prefix: true });
  } catch (err) {
    throw new BadRequest(`${field}: ${(err as Error).message}`);
  }
  if (!v.startsWith('jobs/')) throw new BadRequest(`${field} must be under jobs/`);
  return v;
}

function parsePublish(o: Record<string, unknown>): { prefix: string } {
  const p = o.publish;
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new BadRequest('publish must be an object with a prefix');
  return { prefix: parsePrefix((p as Record<string, unknown>).prefix, 'publish.prefix') };
}

function parseSiteInputs(o: Record<string, unknown>): { workspace?: SiteWorkspace; previous?: string } {
  let workspace: SiteWorkspace | undefined;
  if (o.workspace !== undefined) {
    if (!o.workspace || typeof o.workspace !== 'object' || Array.isArray(o.workspace)) throw new BadRequest('workspace must be an object');
    workspace = o.workspace as SiteWorkspace;
  }
  return { workspace, previous: o.previous === undefined ? undefined : parsePrefix(o.previous, 'previous') };
}

function parseMerge(b: unknown): MergeRequest {
  const o = asObject(b);
  const jobId = parseJobId(o);
  const url = parseHttpUrl(o.url, 'url');
  if (!Array.isArray(o.sources) || o.sources.length < 1 || o.sources.length > MAX_SOURCES) throw new BadRequest(`sources must be an array of 1 to ${MAX_SOURCES} entries`);
  const seen = new Set<string>();
  const sources = o.sources.map((s: unknown, i: number) => {
    const x = asObject(s);
    if (typeof x.law !== 'string' || !LAW_DIR.test(x.law)) throw new BadRequest(`sources[${i}].law must match ${LAW_DIR}`);
    if (seen.has(x.law)) throw new BadRequest(`sources[${i}].law repeats ${x.law}`);
    seen.add(x.law);
    if (typeof x.locationId !== 'string' || !LOCATION_ID.test(x.locationId)) throw new BadRequest(`sources[${i}].locationId is not a location id`);
    return { law: x.law as MergeRequest['sources'][number]['law'], locationId: x.locationId, tarUrl: parseHttpUrl(x.tarUrl, `sources[${i}].tarUrl`) };
  });
  const rawFailed = o.failed ?? [];
  if (!Array.isArray(rawFailed) || rawFailed.length > MAX_FAILED) throw new BadRequest(`failed must be an array of at most ${MAX_FAILED} entries`);
  const failed = rawFailed.map((f: unknown, i: number) => {
    const x = asObject(f);
    if (typeof x.locationId !== 'string' || !LOCATION_ID.test(x.locationId)) throw new BadRequest(`failed[${i}].locationId is not a location id`);
    if (typeof x.error !== 'string' || x.error.length > 1000) throw new BadRequest(`failed[${i}].error must be a string of at most 1000 characters`);
    return { locationId: x.locationId, error: x.error };
  });
  return { jobId, url, sources, failed, ...parseSiteInputs(o), publish: parsePublish(o) };
}

function parseConsent(b: unknown): ConsentRequest {
  const o = asObject(b);
  if (o.quick !== undefined && typeof o.quick !== 'boolean') throw new BadRequest('quick must be a boolean');
  return { jobId: parseJobId(o), url: parseHttpUrl(o.url, 'url'), quick: o.quick === true, runs: parseRuns(o.runs), ...parseSiteInputs(o), publish: parsePublish(o) };
}

function parseAccessibility(b: unknown): AccessibilityRequest {
  const o = asObject(b);
  return { jobId: parseJobId(o), url: parseHttpUrl(o.url, 'url'), publish: parsePublish(o) };
}

function parseVerify(b: unknown): VerifyRequest {
  const o = asObject(b);
  if (typeof o.site !== 'string' || !SITE.test(o.site)) throw new BadRequest('site must be a domain name');
  if (!o.task || typeof o.task !== 'object' || Array.isArray(o.task)) throw new BadRequest('task must be an object');
  return { task: o.task, site: o.site };
}

/** What a finished or published job leaves out of the blob store. */
function excludedFromPublish(rel: string): boolean {
  const top = rel.split('/')[0];
  return top === 'gather' || top === 'live' || top === 'previous' || rel === 'events.ndjson' || rel === 'workspace.json';
}

export function createWorkerApp(config: WorkerConfig): WorkerService {
  const jobs = new Map<string, WorkerJob>();
  const verifyChildren = new Set<ChildProcess>();
  /** Work reserved between the busy check (no await before the increment) and its registration in `jobs`, or a Verify in flight. */
  let starting = 0;
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
  // The site workspace rides along on merge/consent (its config is capped at 1 MB).
  app.use(express.json({ limit: '3mb' }));

  const isBusy = () => starting > 0 || [...jobs.values()].some((j) => j.state === 'running');

  const reasonText = (job: WorkerJob): string => (job.reason === 'cancelled' ? 'cancelled' : job.reason === 'stopped' ? 'worker stopped' : `timed out after ${Math.round(config.jobTimeoutMs / 60_000)} minutes`);
  const withTail = (job: WorkerJob, m: string): string => {
    const tail = job.stderr.slice(-6).join('\n').trim();
    return tail ? `${m}\n${tail}` : m;
  };
  const exitText = (code: number | null, signal: NodeJS.Signals | null) => (signal ? `signal ${signal}` : `code ${code}`);

  function stopJob(job: WorkerJob, reason: NonNullable<WorkerJob['reason']>, graceMs = config.killGraceMs): void {
    job.reason ??= reason;
    job.abort.abort();
    if (job.child) killTree(job.child, graceMs);
  }

  /** Throws once the job has been cancelled, stopped or timed out. */
  function checkpoint(job: WorkerJob): void {
    if (job.reason) throw new Error(reasonText(job));
  }

  /** One CLI invocation as the job's child (own process group); stderr feeds the job's tail. */
  function runCli(job: WorkerJob, args: string[], cwd: string): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    checkpoint(job);
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(config.cliPath)) {
        reject(new Error(`complykit CLI not found at ${config.cliPath}`));
        return;
      }
      // detached → its own process group, so a kill reaches Chromium too.
      const child = spawn(process.execPath, [config.cliPath, ...args], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      job.child = child;
      child.stdout!.resume();
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (chunk: string) => {
        job.stderr.push(...chunk.split(/\r?\n/).filter((l) => l.trim()));
        if (job.stderr.length > 50) job.stderr.splice(0, job.stderr.length - 50);
      });
      child.on('error', (err) => {
        job.child = undefined;
        reject(err);
      });
      child.on('close', (code, signal) => {
        job.child = undefined;
        resolve({ code, signal });
      });
    });
  }

  /** Make the job's directory and run `body`; ends in `final` or, on any error, 'failed'. */
  async function startJob(kind: Kind, id: string, final: 'collected' | 'done', body: (job: WorkerJob) => Promise<void>): Promise<WorkerJob> {
    const dir = path.join(config.tmpDir, id);
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
    const job: WorkerJob = { id, kind, dir, state: 'running', stderr: [], abort: new AbortController(), finished: Promise.resolve() };
    const timer = setTimeout(() => stopJob(job, 'timeout'), config.jobTimeoutMs);
    job.finished = (async () => {
      try {
        await body(job);
        checkpoint(job);
        job.state = final;
      } catch (err) {
        job.state = 'failed';
        job.error = job.reason ? reasonText(job) : (err as Error).message;
      } finally {
        clearTimeout(timer);
        job.child = undefined;
      }
    })();
    return job;
  }

  const eventsFile = (job: WorkerJob) => path.join(job.dir, 'events.ndjson');
  const quiet = () => (process.env.COMPLYKIT_DEBUG ? [] : ['--quiet']);

  async function hasDoneEvent(job: WorkerJob): Promise<boolean> {
    let text = '';
    try {
      text = await fsp.readFile(eventsFile(job), 'utf8');
    } catch {
      return false;
    }
    return text.split('\n').some((l) => {
      try {
        return (JSON.parse(l) as { type?: unknown }).type === 'done';
      } catch {
        return false;
      }
    });
  }

  /** The workspace file and the previous run, as `--workspace` / `--previous` arguments (same order as the host's). */
  async function siteArgs(job: WorkerJob, b: { workspace?: SiteWorkspace; previous?: string }): Promise<string[]> {
    if (!b.workspace) return [];
    const file = path.join(job.dir, 'workspace.json');
    await fsp.writeFile(file, JSON.stringify(b.workspace, null, 2) + '\n');
    const args = ['--workspace', file];
    if (b.previous && config.blobs) {
      const runId = b.previous.replace(/\/$/, '').split('/').pop()!;
      const dest = path.join(job.dir, 'previous', runId);
      // The evaluation only; the evidence (HARs, screenshots) is not what a comparison needs.
      await config.blobs.download(b.previous, dest, (rel) => !rel.startsWith('evidence/'));
      if (fs.existsSync(path.join(dest, 'tracking.json'))) args.push('--previous', dest);
    }
    return args;
  }

  /** Upload the finished job directory (minus raw collections and scratch) to the blob prefix. */
  async function publish(job: WorkerJob, prefix: string): Promise<void> {
    checkpoint(job);
    await config.blobs!.upload(job.dir, prefix, (rel) => !excludedFromPublish(rel));
  }

  async function runConsentCli(job: WorkerJob, args: string[], what: string): Promise<void> {
    const res = await runCli(job, args, job.dir);
    checkpoint(job);
    if (res.code !== 0) throw new Error(withTail(job, `${what} exited with ${exitText(res.code, res.signal)}`));
    if (!(await hasDoneEvent(job))) throw new Error(withTail(job, `${what} exited without a result`));
  }

  function collectJob(b: CollectRequest): Promise<WorkerJob> {
    return startJob('collect', b.jobId, 'collected', async (job) => {
      const args = ['consent', '--collect-only', '--url', b.url, '--locations', b.locationId, '--cwd', job.dir, '--events', eventsFile(job), '--quiet', '--runs', String(b.runs), ...(b.quick ? ['--quick'] : [])];
      const res = await runCli(job, args, job.dir);
      checkpoint(job);
      if (res.code !== 0) throw new Error(withTail(job, `consent collect exited with ${exitText(res.code, res.signal)}`));
      const runDir = await singleRunDir(job.dir);
      if (!runDir || !fs.existsSync(path.join(runDir, 'collection.json'))) throw new Error(withTail(job, 'consent collect finished without a collection.json'));
    });
  }

  function mergeJob(b: MergeRequest): Promise<WorkerJob> {
    return startJob('merge', b.jobId, 'done', async (job) => {
      const gather = path.join(job.dir, 'gather');
      try {
        await fsp.mkdir(gather, { recursive: true });
        const dirs = await Promise.all(
          b.sources.map(async (src) => {
            const dest = path.join(gather, src.law);
            await fsp.mkdir(dest, { recursive: true });
            const tarFile = path.join(gather, `${src.law}.tar`);
            try {
              const res = await fetch(src.tarUrl, { headers: { [WORKER_SECRET_HEADER]: config.secret, [PEER_HEADER]: 'merge' }, signal: job.abort.signal });
              if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
              await pipeline(Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream), fs.createWriteStream(tarFile));
              await untar(tarFile, dest);
              if (!fs.existsSync(path.join(dest, 'collection.json'))) throw new Error('the run had no collection.json');
            } catch (err) {
              if (job.reason) throw err;
              throw new Error(`could not fetch the ${src.law} collection: ${(err as Error).message}`);
            } finally {
              await fsp.rm(tarFile, { force: true });
            }
            return dest;
          }),
        );
        checkpoint(job);
        const site = await siteArgs(job, b);
        const failedArgs = b.failed.flatMap((f) => ['--failed', `${f.locationId}=${f.error}`]);
        const args = ['consent', '--merge', dirs.join(','), '--url', b.url, '--cwd', job.dir, '--events', eventsFile(job), ...quiet(), ...failedArgs, ...site];
        await runConsentCli(job, args, 'consent merge');
      } finally {
        // Raw collections carry unredacted request bodies and cookie values: never kept, whatever happened.
        await fsp.rm(gather, { recursive: true, force: true });
      }
      await publish(job, b.publish.prefix);
    });
  }

  function consentJob(b: ConsentRequest): Promise<WorkerJob> {
    return startJob('consent', b.jobId, 'done', async (job) => {
      const site = await siteArgs(job, b);
      const args = ['consent', '--url', b.url, '--cwd', job.dir, '--events', eventsFile(job), ...quiet(), '--runs', String(b.runs), ...(b.quick ? ['--quick'] : []), ...site];
      await runConsentCli(job, args, 'consent');
      await publish(job, b.publish.prefix);
    });
  }

  function accessibilityJob(b: AccessibilityRequest): Promise<WorkerJob> {
    return startJob('accessibility', b.jobId, 'done', async (job) => {
      // Its own cwd (the job directory): `report` renders the newest run in it.
      const scan = await runCli(job, ['scan', '--url', b.url, '--cwd', job.dir, '--quiet', '--max-pages', '15'], job.dir);
      checkpoint(job);
      if (scan.code !== 0) throw new Error(withTail(job, `accessibility scan exited with ${exitText(scan.code, scan.signal)}`));
      const rep = await runCli(job, ['report', '--format', 'html', '--out', path.join(job.dir, 'report.html'), '--cwd', job.dir], job.dir);
      checkpoint(job);
      if (rep.code !== 0) throw new Error(withTail(job, `accessibility report exited with ${exitText(rep.code, rep.signal)}`));
      await publish(job, b.publish.prefix);
    });
  }

  /** Verify: synchronous, one `verify-change --task <file> --site <site> --json`. */
  async function runVerify(b: VerifyRequest): Promise<{ status: number; body: unknown }> {
    if (!fs.existsSync(config.cliPath)) return { status: 500, body: { error: `complykit CLI not found at ${config.cliPath}` } };
    await fsp.mkdir(config.tmpDir, { recursive: true });
    const dir = await fsp.mkdtemp(path.join(config.tmpDir, 'verify-'));
    try {
      const file = path.join(dir, 'task.json');
      await fsp.writeFile(file, JSON.stringify(b.task));
      const child = spawn(process.execPath, [config.cliPath, 'verify-change', '--task', file, '--site', b.site, '--json'], { cwd: dir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      verifyChildren.add(child);
      child.once('close', () => verifyChildren.delete(child));
      const out: Buffer[] = [];
      let bytes = 0;
      let stderr = '';
      let timedOut = false;
      let tooBig = false;
      child.stdout!.on('data', (c: Buffer) => {
        bytes += c.length;
        if (bytes > MAX_VERIFY_STDOUT) {
          tooBig = true;
          killTree(child, 200);
        } else out.push(c);
      });
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (c: string) => {
        stderr = (stderr + c).slice(-4000);
      });
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child, config.killGraceMs);
      }, config.verifyTimeoutMs ?? 5 * 60_000);
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null } | Error>((resolve) => {
        child.on('error', (err) => resolve(err));
        child.on('close', (code, signal) => resolve({ code, signal }));
      });
      clearTimeout(timer);
      const tail = stderr.trim().split(/\r?\n/).slice(-6).join('\n');
      if (result instanceof Error) return { status: 500, body: { error: `complykit verify-change: ${result.message}` } };
      if (timedOut) return { status: 500, body: { error: `verify-change timed out after ${Math.round((config.verifyTimeoutMs ?? 300_000) / 1000)} s` } };
      if (tooBig) return { status: 500, body: { error: 'verify-change printed too much' } };
      if (result.code === 2) return { status: 400, body: { error: tail || 'verify-change rejected the task' } };
      if (result.code !== 0) return { status: 500, body: { error: `verify-change exited with ${exitText(result.code, result.signal)}${tail ? `\n${tail}` : ''}` } };
      try {
        return { status: 200, body: JSON.parse(Buffer.concat(out).toString('utf8')) };
      } catch {
        return { status: 500, body: { error: 'verify-change printed something other than JSON' } };
      }
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }

  app.get('/internal/health', (_req, res) => {
    res.json({ ok: true, version: config.version });
  });

  /** Shared by every job-style route: validate, then (503 / 409), start, 202. */
  function jobRoute<T extends { jobId: string }>(parse: (b: unknown) => T, start: (b: T) => Promise<WorkerJob>, needsBlobs: boolean) {
    return async (req: Request, res: Response) => {
      let reserved = false;
      try {
        const body = parse(req.body);
        if (needsBlobs && !config.blobs) {
          res.status(503).json({ error: 'no blob store configured' });
          return;
        }
        if (isBusy()) {
          res.status(409).json({ error: 'busy: a job is already running' });
          return;
        }
        if (jobs.has(body.jobId)) {
          res.status(409).json({ error: `job ${body.jobId} already exists` });
          return;
        }
        starting++;
        reserved = true;
        const job = await start(body);
        jobs.set(job.id, job);
        res.status(202).json({ jobId: job.id, state: job.state });
      } catch (err) {
        if (err instanceof BadRequest) res.status(400).json({ error: err.message });
        else res.status(500).json({ error: (err as Error).message });
      } finally {
        if (reserved) starting--;
      }
    };
  }

  app.post('/internal/collect', jobRoute(parseCollect, collectJob, false));
  app.post('/internal/merge', jobRoute(parseMerge, mergeJob, true));
  app.post('/internal/consent', jobRoute(parseConsent, consentJob, true));
  app.post('/internal/accessibility', jobRoute(parseAccessibility, accessibilityJob, true));

  app.post('/internal/verify', async (req: Request, res: Response) => {
    let reserved = false;
    try {
      const body = parseVerify(req.body);
      if (isBusy()) {
        res.status(409).json({ error: 'busy: a job is already running' });
        return;
      }
      starting++;
      reserved = true;
      const out = await runVerify(body);
      res.status(out.status).json(out.body);
    } catch (err) {
      if (err instanceof BadRequest) res.status(400).json({ error: err.message });
      else res.status(500).json({ error: (err as Error).message });
    } finally {
      if (reserved) starting--;
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
      text = await fsp.readFile(eventsFile(job), 'utf8');
    } catch {
      /* not written yet */
    }
    // Complete lines only: the CLI may be mid-write.
    const lines = text.split('\n');
    lines.pop();
    const out = lines.slice(from);
    res.type('application/x-ndjson').send(out.length ? out.join('\n') + '\n' : '');
  });

  // The collector's owner report as it stands (rewritten after each visit); the primary shows it live.
  app.get('/internal/jobs/:jobId/report', async (req, res) => {
    const job = need(req, res);
    if (!job) return;
    const runDir = await singleRunDir(job.dir);
    let body: string | undefined;
    if (runDir) {
      try {
        body = await fsp.readFile(path.join(runDir, 'owner-report.json'), 'utf8');
      } catch {
        /* not written yet */
      }
    }
    if (body === undefined) {
      res.status(404).json({ error: 'no report yet' });
      return;
    }
    res.type('application/json').send(body);
  });

  app.get('/internal/jobs/:jobId/run.tar', async (req, res) => {
    const job = need(req, res);
    if (!job) return;
    if (job.kind !== 'collect' || job.state !== 'collected') {
      res.status(409).json({ error: job.kind !== 'collect' ? `job is a ${job.kind}, not a collection` : `job is ${job.state}, not collected` });
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
      const verifying = [...verifyChildren];
      for (const c of verifying) {
        killTree(c, killGraceMs);
      }
      await Promise.all([...running.map((j) => j.finished), ...verifying.map((c) => (c.exitCode === null && c.signalCode === null ? new Promise<void>((r) => c.once('close', () => r())) : undefined))]);
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

/** `tar -xf file -C dest` (system tar). */
function untar(file: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xf', file, '-C', dest], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr!.on('data', (c: Buffer) => (err += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`could not unpack the run: tar exited with code ${code} ${err.replace(/\s+/g, ' ').trim().slice(0, 200)}`.trim()))));
  });
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
