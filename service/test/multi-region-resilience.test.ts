import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { CreateBatchResponse, JobDetail } from '../src/shared/api.js';
import { fakeFleet, type Fleet } from '../src/server/fleet.js';
import { JobStore } from '../src/server/store.js';
import { RegionLocks } from '../src/server/region-lock.js';
import { createWorkerApp, loadWorkerConfig, type WorkerService } from '../src/server/worker.js';
import { startService, stopAll, tempDir, waitFor, waitForStatus } from './helpers.js';

// Host-side resilience of a fleet scan (plans/do-hosting.md, review fixes): kept workers stay awake,
// region locks cannot deadlock, shutdown is bounded, a restarted host cleans up, a lost merge worker
// that had already published is not a failed job.

const FAKE_WORKER_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-worker-cli-regional.mjs');
const SECRET = 'test-secret';

const workers: Array<{ w: WorkerService; close: () => Promise<void> }> = [];
afterEach(async () => {
  await stopAll();
  await Promise.all(workers.splice(0).map(async (x) => (await x.w.stop(200), x.close())));
});

interface Started {
  url: string;
  w: WorkerService;
  /** Every request the worker got: "METHOD /path". */
  seen: string[];
  tmpDir: string;
}

async function startWorker(blobDir: string, cut?: (req: express.Request, w: WorkerService, seen: string[]) => boolean): Promise<Started> {
  const tmpDir = tempDir();
  const w = createWorkerApp({ ...loadWorkerConfig({ WORKER_SECRET: SECRET, WORKER_BLOB_DIR: blobDir }), tmpDir, cliPath: FAKE_WORKER_CLI, killGraceMs: 500 });
  const seen: string[] = [];
  const outer = express();
  outer.use((req, _res, next) => {
    // A cut worker is unreachable: the connection dies without an answer.
    if (cut?.(req, w, seen)) return void req.socket.destroy();
    seen.push(`${req.method} ${req.path}`);
    next();
  });
  outer.use(w.app);
  const server = outer.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  workers.push({ w, close: () => new Promise((r) => server.close(() => r(undefined))) });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, w, seen, tmpDir };
}

const fast = { staggerMs: 10, remotePollMs: 25 };
async function fleetService(regions: string[], over: { config?: Record<string, unknown>; runner?: Record<string, unknown>; fleet?: (map: Record<string, string>) => Fleet; dataDir?: string; cut?: Parameters<typeof startWorker>[1] } = {}) {
  const dataDir = over.dataDir ?? tempDir();
  const ws: Record<string, Started> = {};
  for (const r of regions) ws[r] = await startWorker(dataDir, over.cut);
  const map = Object.fromEntries(regions.map((r) => [r, ws[r].url]));
  const s = await startService({ workerSecret: SECRET, dataDir, ...over.config }, { ...fast, fleet: over.fleet ? over.fleet(map) : fakeFleet(map), ...over.runner });
  return { s, ws, dataDir };
}
type S = Awaited<ReturnType<typeof startService>>;
async function scan(s: S, body: Record<string, unknown>): Promise<string> {
  const res = await request(s.app).post('/api/batches').send({ urls: 'https://site.example.com/', authorized: true, ...body }).expect(201);
  return (res.body as CreateBatchResponse).jobs[0].id;
}

describe('kept workers stay awake until the merge', () => {
  it('pings a collected worker while it waits for the other laws (its 3-minute idle shutdown would otherwise take the run)', async () => {
    const { s, ws } = await fleetService(['fra', 'lax'], { runner: { staggerMs: 700, keepAliveMs: 40 } });
    const id = await scan(s, { laws: ['eu', 'ca'] });
    const job = await waitForStatus(s, id, ['done']);
    expect(job.error).toBeUndefined();
    const eu = ws.fra.seen;
    const lastEvents = eu.map((r, i) => (r === `GET /internal/jobs/${id}-eu/events` ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    const pings = eu.slice(lastEvents + 1).filter((r) => r === `GET /internal/jobs/${id}-eu`);
    expect(lastEvents).toBeGreaterThan(-1);
    expect(pings.length).toBeGreaterThanOrEqual(3);
    // Released after the merge: no pings once its job was deleted.
    const lastDelete = eu.lastIndexOf(`DELETE /internal/jobs/${id}-eu`);
    expect(lastDelete).toBeGreaterThan(-1);
  });
});

describe('region locks', () => {
  it('two multi-law jobs that overlap in some regions finish (all regions are taken up front, in catalog order)', async () => {
    const { s } = await fleetService(['fra', 'lhr', 'lax'], { config: { concurrency: 2 }, runner: { staggerMs: 150 } });
    // Law by law, B would hold lax while waiting for fra, and A (holding fra and lhr) would wait for lax.
    const a = await scan(s, { urls: 'https://a.example.com/', laws: ['eu', 'uk', 'ca'] });
    const b = await scan(s, { urls: 'https://b.example.org/', laws: ['eu', 'ca'] });
    const [ja, jb] = await Promise.all([waitForStatus(s, a, ['done', 'failed'], 30_000), waitForStatus(s, b, ['done', 'failed'], 30_000)]);
    expect([ja.status, jb.status]).toEqual(['done', 'done']);
  }, 40_000);

  it('a wait cap makes lock() give up without holding up the next waiter', async () => {
    const locks = new RegionLocks();
    const sig = new AbortController().signal;
    const first = await locks.lock('fra', sig);
    await expect(locks.lock('fra', sig, () => {}, 60)).rejects.toThrow(/waited more than .* for the fra worker/);
    const third = locks.lock('fra', sig);
    first();
    (await third)();
  });

  it('a job waiting behind another scan for its region fails with a clear message after the cap', async () => {
    const { s } = await fleetService(['fra'], { config: { concurrency: 2 }, runner: { lockWaitMs: 400 } });
    const a = await scan(s, { urls: 'https://hold.a.example.com/', laws: ['eu'] });
    await waitFor(() => s.store.get(a)!.log.some((l) => /starting the worker in fra/.test(l)), 10_000, 'first job to hold fra');
    const b = await scan(s, { urls: 'https://b.example.org/', laws: ['eu'] });
    const jb = await waitForStatus(s, b, ['failed'], 10_000);
    expect(jb.error).toMatch(/waited more than .* for the fra worker/);
    await waitForStatus(s, a, ['done'], 20_000);
  });

  it('the job time limit does not run while the job waits for a region', async () => {
    // Each hold scan takes ~2.5 s of its own; B waits ~2.5 s for A. A 4 s limit would kill B if it ran from the job\'s start.
    const { s } = await fleetService(['fra'], { config: { concurrency: 2, jobTimeoutMs: 4_000 } });
    const a = await scan(s, { urls: 'https://hold.a.example.com/', laws: ['eu'] });
    await waitFor(() => s.store.get(a)!.log.some((l) => /starting the worker in fra/.test(l)), 10_000, 'first job to hold fra');
    const b = await scan(s, { urls: 'https://hold.b.example.org/', laws: ['eu'] });
    const [ja, jb] = await Promise.all([waitForStatus(s, a, ['done', 'failed'], 30_000), waitForStatus(s, b, ['done', 'failed'], 30_000)]);
    expect(ja.error).toBeUndefined();
    expect(jb.error).toBeUndefined();
    expect([ja.status, jb.status]).toEqual(['done', 'done']);
    expect(jb.log.some((l) => /waiting for the fra worker/.test(l))).toBe(true);
  }, 40_000);
});

describe('shutdown', () => {
  it('persists the job as failed first, halts the Machines without waiting for them, and is bounded even if release hangs', async () => {
    const halted: Array<{ region: string; statusThen: string | undefined }> = [];
    let stopId = '';
    let ctx: S | undefined;
    const { s } = await fleetService(['fra', 'lax'], {
      runner: { shutdownBoundMs: 5_000 },
      fleet: (map) => {
        const base = fakeFleet(map);
        return {
          acquire: base.acquire,
          release: () => new Promise<void>(() => {}), // a stop that never lands
          halt: async (h) => void halted.push({ region: h.region, statusThen: ctx?.store.get(stopId)?.status }),
          stopAll: base.stopAll,
        };
      },
    });
    ctx = s;
    const id = (stopId = await scan(s, { urls: 'https://slow.example.com/', laws: ['ca', 'eu'] }));
    await waitFor(() => s.store.get(id)!.log.filter((l) => /collecting from/.test(l)).length === 2, 10_000, 'both workers collecting');
    const t0 = Date.now();
    await s.runner.shutdown(200);
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(halted.map((h) => h.region).sort()).toEqual(['fra', 'lax']);
    // The record said failed before any Machine was touched: a SIGKILL after this point cannot leave the job "running".
    expect(halted.every((h) => h.statusThen === 'failed')).toBe(true);
    expect(s.store.get(id)).toMatchObject({ status: 'failed', error: 'server stopped' });
    await s.store.flush();
    const onDisk = JSON.parse(fs.readFileSync(path.join(s.config.dataDir, 'jobs', id, 'job.json'), 'utf8')) as JobDetail;
    expect(onDisk).toMatchObject({ status: 'failed', error: 'server stopped' });
  });
});

describe('boot', () => {
  it('stops every worker Machine before re-enqueueing the queue (an earlier host\'s jobs may still be running there)', async () => {
    const dataDir = tempDir();
    const earlier = new JobStore(dataDir);
    earlier.create({ batchId: 'b1', url: 'https://site.example.com/', checks: ['consent'], quick: false });
    await earlier.flush();
    const order: string[] = [];
    await fleetService([], {
      dataDir,
      fleet: () => ({
        async acquire() {
          order.push('acquire');
          throw new Error('no worker');
        },
        async release() {},
        async halt() {},
        async stopAll() {
          order.push('stopAll:start');
          await new Promise((r) => setTimeout(r, 150));
          order.push('stopAll:end');
        },
      }),
    });
    await waitFor(() => order.includes('acquire'), 10_000, 'the recovered job to start');
    expect(order).toEqual(['stopAll:start', 'stopAll:end', 'acquire']);
  });

  it('a late second recovery pass fails jobs an earlier host left running (started before this boot, not owned here)', async () => {
    const stale: JobDetail[] = [];
    const s = await startService({}, { lateRecoveryMs: 150, reloadJobs: async () => stale.map((j) => ({ ...j })) });
    const old = s.store.create({ batchId: 'b', url: 'https://old.example.com/', checks: ['consent'], quick: false });
    const fresh = s.store.create({ batchId: 'b', url: 'https://fresh.example.com/', checks: ['consent'], quick: false });
    const doneJob = s.store.create({ batchId: 'b', url: 'https://done.example.com/', checks: ['consent'], quick: false });
    const hour = 3_600_000;
    stale.push(
      { ...old, status: 'running', startedAt: new Date(Date.now() - hour).toISOString() },
      { ...fresh, status: 'running', startedAt: new Date(Date.now() + hour).toISOString() },
      { ...doneJob, status: 'done', startedAt: new Date(Date.now() - hour).toISOString() },
    );
    await waitForStatus(s, old.id, ['failed'], 5_000);
    expect(s.store.get(old.id)).toMatchObject({ status: 'failed', error: 'interrupted by a restart' });
    expect(s.store.get(fresh.id)!.status).toBe('queued'); // began after this boot: not ours to judge
    expect(s.store.get(doneJob.id)!.status).toBe('queued'); // finished by the other host: left alone
  });
});

describe('a lost merge worker', () => {
  /** Cuts every request to the merge job once the merge has been posted and the worker is idle (it has finished and published). */
  const cutAfterMerge = (req: express.Request, w: WorkerService, seen: string[]): boolean => /-merge(\/|$)/.test(req.path) && seen.some((r) => r === 'POST /internal/merge') && !w.isBusy();

  it('is not a failed job when its run is already in blobs: the job finishes from the published files', async () => {
    const { s, dataDir } = await fleetService(['fra', 'lax'], { cut: cutAfterMerge });
    const id = await scan(s, { laws: ['eu', 'ca'] });
    const job = await waitForStatus(s, id, ['done', 'failed'], 20_000);
    expect(job.error).toBeUndefined();
    expect(job.status).toBe('done');
    expect(job.result?.consent?.runId).toBeTruthy();
    expect(job.log.some((l) => /lost contact with the merge worker/.test(l))).toBe(true);
    const runs = fs.readdirSync(path.join(dataDir, 'jobs', id, 'consent', '.comply', 'runs'));
    expect(runs).toContain(job.result!.consent!.runId);
    // The run is recorded in the site workspace as usual.
    const ws = (await request(s.app).get('/api/sites/example.com/workspace').expect(200)).body as { runs: Array<{ jobId: string }> };
    expect(ws.runs.map((r) => r.jobId)).toContain(id);
  });

  it('is still a failed job when nothing was published', async () => {
    const hostDir = tempDir();
    const ws: Record<string, Started> = {};
    ws.fra = await startWorker(tempDir(), cutAfterMerge); // publishes where the host does not look
    ws.lax = await startWorker(tempDir());
    const s = await startService({ workerSecret: SECRET, dataDir: hostDir }, { ...fast, fleet: fakeFleet({ fra: ws.fra.url, lax: ws.lax.url }) });
    const id = await scan(s, { laws: ['eu', 'ca'] });
    const job = await waitForStatus(s, id, ['done', 'failed'], 20_000);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/lost contact with the worker/);
  });
});
