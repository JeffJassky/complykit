import crypto from 'node:crypto';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CreateBatchResponse } from '../src/shared/api.js';
import { fakeFleet, type Fleet } from '../src/server/fleet.js';
import { FsBlobs } from '../src/server/storage/fs-blobs.js';
import { mongoRecords } from '../src/server/storage/mongo.js';
import type { Storage } from '../src/server/storage/types.js';
import { createWorkerApp, loadWorkerConfig, type WorkerService } from '../src/server/worker.js';
import { startService, stopAll, tempDir, waitForStatus } from './helpers.js';

// Phase 3 contract (plans/do-hosting.md, "What runs where", "Host ↔ worker",
// "The merge worker"). With a fleet configured, the host runs no scan itself:
//
// - every law collects on a worker; California's worker is in lax;
// - the merge runs on a worker (POST /internal/merge), which pulls the other
//   workers' collections itself (GET run.tar with header x-complykit-peer: merge)
//   and uploads the finished run to blobs; the host never downloads a run.tar;
// - a consent job without laws runs on a worker in `ord` (POST /internal/consent);
// - accessibility runs on a worker in `ord` (POST /internal/accessibility);
// - Verify runs on a worker in `ord` (POST /internal/verify);
// - raw collections (gather/) never reach blobs.
//
// Workers write to the same blob store as the host: WorkerConfig.blobs (env:
// SPACES_* for Spaces, or WORKER_BLOB_DIR for a directory — tests and local dev).
// Without a fleet (local dev, the older tests) everything still runs locally.

const FAKE_WORKER_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-worker-cli-regional.mjs');
const SECRET = 'test-secret';

let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
}, 120_000);
afterAll(async () => {
  await mongo?.stop();
});

const workers: Array<{ w: WorkerService; close: () => Promise<void> }> = [];
afterEach(async () => {
  await stopAll();
  await Promise.all(workers.splice(0).map(async (x) => (await x.w.stop(200), x.close())));
});

interface Seen {
  method: string;
  path: string;
  peer?: string;
}

/** An in-process worker writing to `blobDir`; records every /internal request it gets. */
async function startWorker(blobDir: string): Promise<{ url: string; w: WorkerService; seen: Seen[] }> {
  const w = createWorkerApp({ ...loadWorkerConfig({ WORKER_SECRET: SECRET, WORKER_BLOB_DIR: blobDir }), tmpDir: tempDir(), cliPath: FAKE_WORKER_CLI, killGraceMs: 500 });
  const seen: Seen[] = [];
  const outer = express();
  outer.use((req, _res, next) => {
    seen.push({ method: req.method, path: req.path, peer: req.get('x-complykit-peer') ?? undefined });
    next();
  });
  outer.use(w.app);
  const server = outer.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  workers.push({ w, close: () => new Promise((r) => server.close(() => r(undefined))) });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, w, seen };
}

/** fakeFleet that records which regions were acquired. */
function recordingFleet(map: Record<string, string>): { fleet: Fleet; regions: string[] } {
  const inner = fakeFleet(map);
  const regions: string[] = [];
  return {
    regions,
    fleet: {
      acquire: (r) => {
        regions.push(r);
        return inner.acquire(r);
      },
      release: (h) => inner.release(h),
      halt: (h) => inner.halt(h),
      stopAll: () => inner.stopAll(),
    },
  };
}

async function host(blobDir: string, fleet: Fleet) {
  const records = await mongoRecords({ url: mongo.getUri(), db: `ck_fly_${crypto.randomBytes(4).toString('hex')}` });
  const storage: Storage = { kind: 'cloud', blobs: new FsBlobs(blobDir), jobs: records.jobs, workspaces: records.workspaces, consentRecords: records.consentRecords, close: records.close };
  const s = await startService({ workerSecret: SECRET }, { staggerMs: 10, remotePollMs: 25, fleet }, { storage });
  return { s, storage };
}

type S = Awaited<ReturnType<typeof startService>>;
async function scan(s: S, body: Record<string, unknown>): Promise<string> {
  return ((await request(s.app).post('/api/batches').send({ urls: 'https://site.example.com/', ...body }).expect(201)).body as CreateBatchResponse).jobs[0].id;
}
const keysUnder = (dir: string): string[] => (fs.existsSync(dir) ? (fs.readdirSync(dir, { recursive: true, withFileTypes: false }) as string[]).map((p) => p.split(path.sep).join('/')) : []);

describe('fleet configured: the host runs no scan', () => {
  it('California collects on a worker in lax; the merge runs on a worker; the host never downloads a run', async () => {
    const blobDir = tempDir();
    const lax = await startWorker(blobDir);
    const fra = await startWorker(blobDir);
    const { fleet, regions } = recordingFleet({ lax: lax.url, fra: fra.url });
    const { s } = await host(blobDir, fleet);
    const id = await scan(s, { laws: ['ca', 'eu'], authorized: true });
    const job = await waitForStatus(s, id, ['done']);
    await s.settled();
    expect(job.error).toBeUndefined();

    expect(regions).toContain('lax');
    expect(regions).toContain('fra');
    // No local collector ran.
    expect(job.log.some((l) => /--collect-only .*--locations us-ca/.test(l) && !/worker/.test(l))).toBe(false);

    const all = [...lax.seen, ...fra.seen];
    expect(all.filter((r) => r.method === 'POST' && r.path === '/internal/collect')).toHaveLength(2);
    expect(all.filter((r) => r.method === 'POST' && r.path === '/internal/merge')).toHaveLength(1);
    const tars = all.filter((r) => r.path.endsWith('/run.tar'));
    expect(tars.length).toBeGreaterThanOrEqual(1);
    expect(tars.every((r) => r.peer === 'merge')).toBe(true); // only the merge worker pulls runs

    // The finished run is in blobs; raw collections are not.
    const runId = job.result!.consent!.runId!;
    const keys = keysUnder(path.join(blobDir, 'jobs', id));
    expect(keys).toContain(`consent/.comply/runs/${runId}/owner-report.json`);
    expect(keys).toContain(`consent/.comply/runs/${runId}/consent-report.html`);
    expect(keys.some((k) => k.includes('gather/'))).toBe(false);

    // The host's scratch never held a gathered run.
    expect(fs.existsSync(path.join(s.store.jobDir(id), 'consent', 'gather'))).toBe(false);
    // Workers are free and released.
    expect(lax.w.isBusy() || fra.w.isBusy()).toBe(false);

    const html = (await request(s.app).get(job.result!.consent!.reportUrl).expect(200)).text;
    expect(html).toContain('Merged');
    expect(html).toMatch(/us-ca/);
    expect(html).toMatch(/de/);
  });

  it('a law with no worker is passed to the merge as --failed; the rest still merge', async () => {
    const blobDir = tempDir();
    const lax = await startWorker(blobDir);
    const { s } = await host(blobDir, recordingFleet({ lax: lax.url }).fleet);
    const id = await scan(s, { laws: ['ca', 'eu'], authorized: true });
    await waitForStatus(s, id, ['done']);
    await s.settled();
    // The fake CLI records its argv beside the run's cwd; the worker uploads the consent dir (minus gather/ and live/).
    const argv = JSON.parse(fs.readFileSync(path.join(blobDir, 'jobs', id, 'consent', 'merge-argv.json'), 'utf8')) as string[];
    const failed = argv.flatMap((a, i) => (a === '--failed' ? [argv[i + 1]] : []));
    expect(failed).toEqual([expect.stringMatching(/^de=worker in fra failed: no fake worker for region fra$/)]);
  });

  it('a consent job without laws runs on the ord worker', async () => {
    const blobDir = tempDir();
    const ord = await startWorker(blobDir);
    const { fleet, regions } = recordingFleet({ ord: ord.url });
    const { s } = await host(blobDir, fleet);
    const id = await scan(s, {});
    const job = await waitForStatus(s, id, ['done']);
    await s.settled();
    expect(regions).toEqual(['ord']);
    expect(ord.seen.some((r) => r.method === 'POST' && r.path === '/internal/consent')).toBe(true);
    await request(s.app).get(job.result!.consent!.reportUrl).expect(200);
  });

  it('a fleet scan feeds the host KB: kb ingest gets the run tracking.json, then kb/ is saved to blobs', async () => {
    for (const body of [{}, { laws: ['ca', 'eu'], authorized: true }]) {
      const blobDir = tempDir();
      const lax = await startWorker(blobDir);
      const fra = await startWorker(blobDir);
      const ord = await startWorker(blobDir);
      const { s } = await host(blobDir, recordingFleet({ lax: lax.url, fra: fra.url, ord: ord.url }).fleet);
      const id = await scan(s, body);
      const job = await waitForStatus(s, id, ['done']);
      await s.settled();
      expect(job.error).toBeUndefined();
      const calls = path.join(s.config.kbDir, 'ingest-calls.ndjson');
      const lines = fs.readFileSync(calls, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; files: string[] });
      expect(lines).toHaveLength(1); // once, not twice
      expect(lines[0].files).toEqual(['tracking.json']);
      expect(fs.existsSync(lines[0].args[0])).toBe(false); // the temp dir is gone
      // The save follows the ingest: blobs' kb/ ends up holding the ingest record.
      const saved = path.join(blobDir, 'kb', 'ingest-calls.ndjson');
      for (let i = 0; i < 100 && !fs.existsSync(saved); i++) await new Promise((r) => setTimeout(r, 50));
      expect(fs.existsSync(saved)).toBe(true);
      // And a worker never publishes its KB copy.
      expect(keysUnder(path.join(blobDir, 'jobs', id)).some((k) => k.startsWith('kb/') || k.includes('/kb/'))).toBe(false);
    }
  });

  it('accessibility runs on the ord worker and its report is served from blobs', async () => {
    const blobDir = tempDir();
    const ord = await startWorker(blobDir);
    const { s } = await host(blobDir, recordingFleet({ ord: ord.url }).fleet);
    const id = await scan(s, { checks: { consent: false, accessibility: true } });
    const job = await waitForStatus(s, id, ['done']);
    await s.settled();
    expect(ord.seen.some((r) => r.method === 'POST' && r.path === '/internal/accessibility')).toBe(true);
    expect(job.result?.accessibility?.reportUrl).toBe(`/reports/${id}/accessibility/report.html`);
    await request(s.app).get(job.result!.accessibility!.reportUrl).expect(200);
    expect(fs.existsSync(path.join(blobDir, 'jobs', id, 'accessibility', 'report.html'))).toBe(true);
  });

  it('Verify runs on the ord worker', async () => {
    const blobDir = tempDir();
    const ord = await startWorker(blobDir);
    const { s, storage } = await host(blobDir, recordingFleet({ ord: ord.url }).fleet);
    // A site with one checkable task (the fake CLI answers verify-change with a JSON outcome).
    const task = { id: 'install', kind: 'install', group: 'g', title: 'Install', summary: 's', tools: [], partyIds: [], steps: [], pages: ['https://example.com/'], verify: { check: 'install', method: 'static' }, status: 'todo', optional: false, notes: [], order: 0 };
    await storage.workspaces.write('example.com', { version: 1, domain: 'example.com', entries: {}, runs: [], config: { value: { tasks: [task] }, at: new Date().toISOString() } } as never, undefined);
    const res = await request(s.app).post('/api/sites/example.com/remediation/install/verify').send({});
    expect([200, 409]).toContain(res.status); // the outcome itself is the fake's business; where it ran is the contract
    expect(ord.seen.some((r) => r.method === 'POST' && r.path === '/internal/verify')).toBe(true);
  });
});

describe('workers are reachable from outside Fly', () => {
  it('worker binds :: (all interfaces) on Fly so the public service can reach it', () => {
    expect(loadWorkerConfig({ WORKER_SECRET: 'x', FLY_APP_NAME: 'complykit-workers' }).bind).toBe('::');
  });
});
