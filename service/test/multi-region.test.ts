import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

/** An in-process worker (fake collect-only CLI) on a real port; returns its base URL. */
async function startWorker(): Promise<{ url: string; w: WorkerService }> {
  const w = createWorkerApp({ ...loadWorkerConfig({ WORKER_SECRET: SECRET }), tmpDir: tempDir(), cliPath: FAKE_WORKER_CLI, killGraceMs: 500 });
  const server = w.app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  workers.push({ w, close: () => new Promise((r) => server.close(() => r(undefined))) });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, w };
}

const fast = { staggerMs: 10, remotePollMs: 25 };
const withFleet = (map: Record<string, string>) => startService({ workerSecret: SECRET }, { ...fast, fleet: fakeFleet(map) });
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
  it('collects ca locally and eu on a worker, merges both, removes gather/', async () => {
    const eu = await startWorker();
    const s = await withFleet({ fra: eu.url });
    const id = await scan(s, { laws: ['ca', 'eu'], authorized: true });
    const job = await waitForStatus(s, id, ['done']);
    expect(job.error).toBeUndefined();

    const argv = mergeArgv(s, id);
    const dirs = argOf(argv, '--merge')[0].split(',');
    expect(dirs).toHaveLength(2);
    expect(dirs.map((d) => path.relative(path.join(s.store.jobDir(id), 'consent'), d)).sort()).toEqual([path.join('gather', 'ca', '.comply', 'runs', path.basename(dirs.find((d) => d.includes(`${path.sep}ca${path.sep}`))!)), path.join('gather', 'eu')].sort());
    expect(argOf(argv, '--url')).toEqual(['https://site.example.com/']);
    expect(argOf(argv, '--cwd')).toEqual([path.join(s.store.jobDir(id), 'consent')]);
    for (const bad of ['--collect-only', '--quick', '--runs', '--locations', '--failed']) expect(argv).not.toContain(bad);
    expect(fs.existsSync(path.join(s.store.jobDir(id), 'consent', 'gather'))).toBe(false);

    // The local collector ran for us-ca only; the log says so.
    expect(job.log.some((l) => /--collect-only .*--locations us-ca/.test(l))).toBe(true);
    // The worker's job was deleted and it is free again.
    expect(eu.w.isBusy()).toBe(false);

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
    const eu = await startWorker();
    const s = await withFleet({ fra: eu.url }); // no worker for lhr
    const id = await scan(s, { laws: ['eu', 'uk', 'ca'], authorized: true });
    const job = await waitForStatus(s, id, ['done']);
    const argv = mergeArgv(s, id);
    expect(argOf(argv, '--merge')[0].split(',')).toHaveLength(2);
    expect(argOf(argv, '--failed')).toEqual([expect.stringMatching(/^uk=worker in lhr failed: no fake worker for region lhr$/)]);
    expect(job.log.some((l) => /UK law .*could not be scanned/.test(l))).toBe(true);
    expect(fs.existsSync(path.join(s.store.jobDir(id), 'consent', 'gather'))).toBe(false);
  });

  it('a worker whose collection fails is a failed law with its message', async () => {
    const eu = await startWorker();
    const s = await withFleet({ fra: eu.url });
    // fail.* makes both the worker's and the local CLI fail → every law failed.
    const id = await scan(s, { urls: 'https://fail.example.com/', laws: ['ca', 'eu'], authorized: true });
    const job = await waitForStatus(s, id, ['failed']);
    expect(job.error).toMatch(/no law could be scanned/);
    expect(job.error).toMatch(/California law: collection exited with code 1/);
    expect(job.error).toMatch(/EU law: worker in fra failed: .*code 1.*boom: navigation failed/);
    expect(eu.w.isBusy()).toBe(false);
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

  it('cancel stops the local child, cancels the worker and cleans up', async () => {
    const eu = await startWorker();
    const s = await withFleet({ fra: eu.url });
    const id = await scan(s, { urls: 'https://slow.example.com/', laws: ['ca', 'eu'], authorized: true });
    await waitFor(() => eu.w.isBusy(), 10_000, 'the worker to be collecting');
    const res = await request(s.app).post(`/api/jobs/${id}/cancel`).expect(200);
    expect(res.body.id).toBe(id);
    const job = await waitForStatus(s, id, ['cancelled']);
    expect(job.status).toBe('cancelled');
    expect(eu.w.isBusy()).toBe(false);
    expect(fs.existsSync(path.join(s.store.jobDir(id), 'consent', 'gather'))).toBe(false);
  });
});

describe('laws on rescan', () => {
  it('carries the latest job’s laws, requires authorization again, reports from.laws', async () => {
    const eu = await startWorker();
    const s = await withFleet({ fra: eu.url });
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
