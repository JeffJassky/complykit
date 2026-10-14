import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { CreateBatchResponse, RescanResponse } from '../src/shared/api.js';
import { fakeFleet } from '../src/server/fleet.js';
import { createWorkerApp, loadWorkerConfig, type WorkerService } from '../src/server/worker.js';
import { startService, stopAll, tempDir, waitFor, waitForStatus } from './helpers.js';

const FAKE_WORKER_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-worker-cli-regional.mjs');
const SECRET = 'test-secret';

const workers: Array<{ w: WorkerService; close: () => Promise<void> }> = [];
afterEach(async () => {
  await stopAll();
  await Promise.all(workers.splice(0).map(async (x) => (await x.w.stop(200), x.close())));
});

/**
 * An in-process worker (fake CLI) on a real port; returns its base URL. With a fleet the merge
 * runs on a worker, which publishes the finished run to the blob store: here the host's
 * DATA_DIR (the fs backend's blob root), so the host serves what the worker wrote.
 */
async function startWorker(blobDir: string): Promise<{ url: string; w: WorkerService; calls: string[]; tmpDir: string }> {
  const tmpDir = tempDir();
  const w = createWorkerApp({ ...loadWorkerConfig({ WORKER_SECRET: SECRET, WORKER_BLOB_DIR: blobDir }), tmpDir, cliPath: FAKE_WORKER_CLI, killGraceMs: 500 });
  const calls: string[] = [];
  const outer = express();
  outer.use((req, _res, next) => {
    if ((req.method === 'POST' && req.path === '/internal/collect') || req.method === 'DELETE') calls.push(`${req.method} ${req.method === 'DELETE' ? req.path : 'collect'}`);
    next();
  });
  outer.use(w.app);
  const server = outer.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  workers.push({ w, close: () => new Promise((r) => server.close(() => r(undefined))) });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, w, calls, tmpDir };
}

const fast = { staggerMs: 10, remotePollMs: 25 };
/** A host with a fleet of in-process workers (one per region) that publish into the host's DATA_DIR. */
async function fleetService(regions: string[], over: { concurrency?: number; missing?: string[] } = {}) {
  const dataDir = tempDir();
  const workers: Record<string, Awaited<ReturnType<typeof startWorker>>> = {};
  for (const r of regions) workers[r] = await startWorker(dataDir);
  const s = await startService({ workerSecret: SECRET, dataDir, ...(over.concurrency ? { concurrency: over.concurrency } : {}) }, { ...fast, fleet: fakeFleet(Object.fromEntries(regions.map((r) => [r, workers[r].url]))) });
  return { s, workers, dataDir };
}
type S = Awaited<ReturnType<typeof startService>>;

async function post(s: S, body: Record<string, unknown>, status = 201) {
  return request(s.app).post('/api/batches').send({ urls: 'https://site.example.com/', ...body }).expect(status);
}
async function scan(s: S, body: Record<string, unknown>): Promise<string> {
  return ((await post(s, body)).body as CreateBatchResponse).jobs[0].id;
}
const mergeArgv = (s: S, id: string): string[] => JSON.parse(fs.readFileSync(path.join(s.store.jobDir(id), 'consent', 'merge-argv.json'), 'utf8')) as string[];
const argOf = (argv: string[], flag: string): string[] => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []));

describe('laws: validation', () => {
  it('400s for bad ids, an empty list, a missing authorization, laws without consent', async () => {
    const s = await startService();
    const bad = async (b: Record<string, unknown>, re: RegExp) => expect(((await post(s, b, 400)).body as { error: string }).error).toMatch(re);
    await bad({ laws: ['eu', 'mars'], authorized: true }, /unknown law "mars"/);
    await bad({ laws: [], authorized: true }, /non-empty/);
    await bad({ laws: 'eu', authorized: true }, /non-empty array/);
    await bad({ laws: ['eu'] }, /authorized: true/);
    await bad({ laws: ['eu'], authorized: 'yes' }, /authorized: true/);
    await bad({ laws: ['eu'], authorized: true, checks: { consent: false, accessibility: true } }, /consent/);
    expect(s.store.list()).toHaveLength(0);
  });

  it('dedupes, orders as the catalog, and stamps authorizedAt on the job', async () => {
    const s = await startService({}, { fleet: fakeFleet({}) });
    const res = await post(s, { laws: ['us', 'ca', 'eu', 'ca'], authorized: true });
    const job = (res.body as CreateBatchResponse).jobs[0];
    expect(job.laws).toEqual(['eu', 'ca', 'us']);
    expect(Date.now() - Date.parse(job.authorizedAt!)).toBeLessThan(10_000);
    // Without laws: neither field.
    const plain = (await post(s, { authorized: true })).body as CreateBatchResponse;
    expect(plain.jobs[0].laws).toBeUndefined();
    expect(plain.jobs[0].authorizedAt).toBeUndefined();
  });
});

describe('multi-region scan', () => {
  it('collects ca in lax and eu in fra, merges on a worker, removes gather/', async () => {
    const { s, workers } = await fleetService(['fra', 'lax']);
    const { fra, lax } = workers;
    const id = await scan(s, { laws: ['ca', 'eu'], authorized: true });
    const job = await waitForStatus(s, id, ['done']);
    expect(job.error).toBeUndefined();

    // The merge ran on the first law's worker (eu, fra): its argv is in the published run's directory.
    const argv = mergeArgv(s, id);
    const mergeDir = path.join(fra.tmpDir, `${id}-merge`);
    expect(argOf(argv, '--merge')).toEqual([`${path.join(mergeDir, 'gather', 'eu')},${path.join(mergeDir, 'gather', 'ca')}`]);
    expect(argOf(argv, '--url')).toEqual(['https://site.example.com/']);
    expect(argOf(argv, '--cwd')).toEqual([mergeDir]);
    for (const bad of ['--collect-only', '--quick', '--runs', '--locations', '--failed']) expect(argv).not.toContain(bad);
    expect(fs.existsSync(path.join(s.store.jobDir(id), 'consent', 'gather'))).toBe(false);

    // No law ran on the host: both started a worker.
    expect(job.log.some((l) => /--collect-only/.test(l))).toBe(false);
    expect(job.log.some((l) => /\[collect:ca\] starting the worker in lax/.test(l))).toBe(true);
    expect(job.log.some((l) => /\[collect:eu\] starting the worker in fra/.test(l))).toBe(true);
    // Every worker job was deleted (lax: its collection; fra: its collection and the merge) and both are free again.
    expect(lax.calls.filter((c) => c.startsWith('DELETE'))).toHaveLength(1);
    expect(fra.calls.filter((c) => c.startsWith('DELETE'))).toHaveLength(2);
    expect(lax.w.isBusy() || fra.w.isBusy()).toBe(false);

    // Progress sums the planned scenarios of both locations (2 each).
    expect(job.progress).toMatchObject({ done: 4, total: 4, fraction: 1, phase: 'finished' });
    const events = fs.readFileSync(path.join(s.store.jobDir(id), 'consent', 'events.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { type: string; location?: string });
    expect(new Set(events.filter((e) => e.type === 'scenario-done').map((e) => e.location))).toEqual(new Set(['us-ca', 'de']));
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);

    // The report is served like any consent job's.
    const url = job.result!.consent!.reportUrl;
    expect(url).toMatch(new RegExp(`^/reports/${id}/consent/\\.comply/runs/`));
    const html = (await request(s.app).get(url).expect(200)).text;
    expect(html).toContain('Merged');
    expect(html).toMatch(/de/);
    expect(html).toMatch(/us-ca/);
  });

  it('a failing law is passed to the merge as --failed; the job is still done', async () => {
    const { s } = await fleetService(['fra', 'lax']); // no worker for lhr
    const id = await scan(s, { laws: ['eu', 'uk', 'ca'], authorized: true });
    const job = await waitForStatus(s, id, ['done']);
    const argv = mergeArgv(s, id);
    expect(argOf(argv, '--merge')[0].split(',')).toHaveLength(2);
    expect(argOf(argv, '--failed')).toEqual([expect.stringMatching(/^uk=worker in lhr failed: no fake worker for region lhr$/)]);
    expect(job.log.some((l) => /UK law .*could not be scanned/.test(l))).toBe(true);
    expect(fs.existsSync(path.join(s.store.jobDir(id), 'consent', 'gather'))).toBe(false);
  });

  it('a worker whose collection fails is a failed law with its message', async () => {
    const { s, workers } = await fleetService(['fra', 'lax']);
    // fail.* makes every worker's collection fail → every law failed.
    const id = await scan(s, { urls: 'https://fail.example.com/', laws: ['ca', 'eu'], authorized: true });
    const job = await waitForStatus(s, id, ['failed']);
    expect(job.error).toMatch(/no law could be scanned/);
    expect(job.error).toMatch(/California law: worker in lax failed: .*code 1.*boom: navigation failed/);
    expect(job.error).toMatch(/EU law: worker in fra failed: .*code 1.*boom: navigation failed/);
    expect(workers.fra.w.isBusy() || workers.lax.w.isBusy()).toBe(false);
    expect(fs.existsSync(path.join(s.store.jobDir(id), 'consent', 'merge-argv.json'))).toBe(false);
    expect(fs.existsSync(path.join(s.store.jobDir(id), 'consent', 'gather'))).toBe(false);
  });

  it('without a configured fleet a remote law fails with a clear message; the local law still merges', async () => {
    const s = await startService(); // no fleet, no FLY_API_TOKEN
    const id = await scan(s, { laws: ['eu', 'ca'], authorized: true });
    await waitForStatus(s, id, ['done']);
    expect(argOf(mergeArgv(s, id), '--failed')).toEqual(['de=worker in fra failed: multi-region scanning is not configured on this server']);

    const id2 = await scan(s, { laws: ['eu'], authorized: true });
    const j2 = await waitForStatus(s, id2, ['failed']);
    expect(j2.error).toMatch(/multi-region scanning is not configured on this server/);
  });

  it('the merge worker gets the knowledge base (kb/ in blobs) and the job fails clearly when a fleet has no worker secret', async () => {
    const { s, workers, dataDir } = await fleetService(['fra']);
    fs.mkdirSync(path.join(dataDir, 'kb'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'kb', 'entries.json'), '{}');
    const id = await scan(s, { laws: ['eu'], authorized: true });
    await waitForStatus(s, id, ['done']);
    const seen = JSON.parse(fs.readFileSync(path.join(s.store.jobDir(id), 'consent', 'kb-seen.json'), 'utf8')) as { dir: string; files: string[] };
    expect(seen).toEqual({ dir: path.join(workers.fra.tmpDir, `${id}-merge`, 'kb'), files: ['entries.json'] });

    const noSecret = await startService({}, { ...fast, fleet: fakeFleet({ ord: 'http://127.0.0.1:1' }) });
    const id2 = await scan(noSecret, {});
    const j2 = await waitForStatus(noSecret, id2, ['failed']);
    expect(j2.error).toMatch(/WORKER_SECRET is not set/);
  });

  it('cancel cancels the workers and cleans up', async () => {
    const { s, workers } = await fleetService(['fra', 'lax']);
    const eu = workers.fra;
    const id = await scan(s, { urls: 'https://slow.example.com/', laws: ['ca', 'eu'], authorized: true });
    await waitFor(() => eu.w.isBusy() && workers.lax.w.isBusy(), 10_000, 'the workers to be collecting');
    const res = await request(s.app).post(`/api/jobs/${id}/cancel`).expect(200);
    expect(res.body.id).toBe(id);
    const job = await waitForStatus(s, id, ['cancelled']);
    expect(job.status).toBe('cancelled');
    expect(eu.w.isBusy() || workers.lax.w.isBusy()).toBe(false);
    expect(fs.existsSync(path.join(s.store.jobDir(id), 'consent', 'gather'))).toBe(false);
  });
});

describe('one worker per region at a time', () => {
  it('two concurrent jobs both scanning eu run their collections one after the other', async () => {
    const { s, workers } = await fleetService(['fra'], { concurrency: 2 });
    const eu = workers.fra;
    const a = await scan(s, { urls: 'https://a.example.com/', laws: ['eu'], authorized: true });
    const b = await scan(s, { urls: 'https://b.example.org/', laws: ['eu'], authorized: true });
    const [ja, jb] = await Promise.all([waitForStatus(s, a, ['done', 'failed']), waitForStatus(s, b, ['done', 'failed'])]);
    expect([ja.status, jb.status]).toEqual(['done', 'done']);
    // Each job's collection, then its merge's and its collection's deletion, all before the other job's collection starts.
    expect(eu.calls.map((c) => c.split(' ')[0])).toEqual(['POST', 'DELETE', 'DELETE', 'POST', 'DELETE', 'DELETE']);
    const waited = [ja, jb].filter((j) => j.log.some((l) => /waiting for the fra worker \(another scan is using it\)/.test(l)));
    expect(waited).toHaveLength(1);
  });

  it('cancel while waiting for the region stops promptly and never starts a collection', async () => {
    const { s, workers } = await fleetService(['fra'], { concurrency: 2 });
    const eu = workers.fra;
    const a = await scan(s, { urls: 'https://slow.a.example.com/', laws: ['eu'], authorized: true });
    await waitFor(() => eu.w.isBusy(), 10_000, 'first job collecting');
    const b = await scan(s, { urls: 'https://slow.b.example.org/', laws: ['eu'], authorized: true });
    await waitFor(() => s.store.get(b)!.log.some((l) => /waiting for the fra worker/.test(l)), 10_000, 'second job waiting');
    const t0 = Date.now();
    await request(s.app).post(`/api/jobs/${b}/cancel`).expect(200);
    await waitForStatus(s, b, ['cancelled']);
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(eu.calls.filter((c) => c.startsWith('POST'))).toHaveLength(1);
    expect(eu.w.isBusy()).toBe(true); // the first job is untouched
    await request(s.app).post(`/api/jobs/${a}/cancel`).expect(200);
    await waitForStatus(s, a, ['cancelled']);
    expect(eu.w.isBusy()).toBe(false);
  });
});

describe('laws on rescan', () => {
  it('carries the latest job’s laws, requires authorization again, reports from.laws', async () => {
    const { s } = await fleetService(['fra', 'lax']);
    const first = await scan(s, { laws: ['eu', 'ca'], authorized: true });
    await waitForStatus(s, first, ['done']);

    const noAuth = await request(s.app).post('/api/sites/example.com/rescan').send({}).expect(400);
    expect(noAuth.body.error).toMatch(/authorized: true/);
    expect(s.store.list()).toHaveLength(1);

    const res = await request(s.app).post('/api/sites/example.com/rescan').send({ authorized: true }).expect(201);
    const body = res.body as RescanResponse;
    expect(body.from.laws).toEqual(['eu', 'ca']);
    expect(body.job.laws).toEqual(['eu', 'ca']);
    expect(body.job.authorizedAt).toBeTruthy();
    await waitForStatus(s, body.job.id, ['done']);
    // The second merge was given the site's workspace and the first run's evaluation (fetched by the worker from blobs).
    const again = mergeArgv(s, body.job.id);
    expect(argOf(again, '--workspace')).toHaveLength(1);
    expect(argOf(again, '--previous')[0]).toMatch(/previous[\\/][^\\/]+$/);
    expect(argOf(mergeArgv(s, first), '--previous')).toEqual([]);

    // The owner can choose other laws; a bad one is a 400.
    await request(s.app).post('/api/sites/example.com/rescan').send({ laws: ['zz'], authorized: true }).expect(400);
    const only = (await request(s.app).post('/api/sites/example.com/rescan').send({ laws: ['ca'], authorized: true }).expect(201)).body as RescanResponse;
    expect(only.job.laws).toEqual(['ca']);
    await waitForStatus(s, only.job.id, ['done']);
  });

  it('a rescan of a job without laws needs no authorization and has no laws', async () => {
    const s = await startService();
    const id = await scan(s, {});
    await waitForStatus(s, id, ['done']);
    const body = (await request(s.app).post('/api/sites/example.com/rescan').send({}).expect(201)).body as RescanResponse;
    expect(body.from.laws).toBeUndefined();
    expect(body.job.laws).toBeUndefined();
    await waitForStatus(s, body.job.id, ['done']);
  });
});

describe('jobs without laws', () => {
  it('run exactly as before: one consent invocation, no gather/, no merge', async () => {
    const s = await startService();
    const id = await scan(s, {});
    const job = await waitForStatus(s, id, ['done']);
    expect(job.log.filter((l) => l.includes('$ complykit')).length).toBe(1);
    expect(job.log.some((l) => /--collect-only|--merge/.test(l))).toBe(false);
    expect(fs.existsSync(path.join(s.store.jobDir(id), 'consent', 'gather'))).toBe(false);
  });
});
