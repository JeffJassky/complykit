import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { CreateBatchResponse, JobReportResponse } from '../src/shared/api.js';
import { fakeFleet } from '../src/server/fleet.js';
import { WORKER_SECRET_HEADER, createWorkerApp, loadWorkerConfig, type WorkerService } from '../src/server/worker.js';
import { startService, stopAll, tempDir, waitFor, waitForStatus } from './helpers.js';

// plans/per-law-report-contract.md, PR B: while a multi-law job runs, GET
// /api/jobs/:id/report carries one entry per law — its state and its collector's live
// owner report — so the page can show each law's scan on its own.
//
// Fixture hostnames (both fake CLIs, PR B5):
//   hold.*  waits ~500 ms before its first visit and ~1500 ms after its last, so a
//           test can see a law mid-scan and after its visits but before the merge
//   fail.*  exits 1; slow.* waits (cancel tests)
// Each visit rewrites <run>/owner-report.json (banner provider FakeCMP) and emits `live`.

const REGIONAL_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-worker-cli-regional.mjs');
const SECRET = 'test-secret';
const auth = { [WORKER_SECRET_HEADER]: SECRET };

const workers: Array<{ w: WorkerService; close: () => Promise<void> }> = [];
afterEach(async () => {
  await stopAll();
  await Promise.all(workers.splice(0).map(async (x) => (await x.w.stop(200), x.close())));
});

async function startWorker(): Promise<{ url: string; w: WorkerService }> {
  const w = createWorkerApp({ ...loadWorkerConfig({ WORKER_SECRET: SECRET }), tmpDir: tempDir(), cliPath: REGIONAL_CLI, killGraceMs: 500 });
  const outer = express();
  outer.use(w.app);
  const server = outer.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  workers.push({ w, close: () => new Promise((r) => server.close(() => r(undefined))) });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, w };
}

const fast = { staggerMs: 10, remotePollMs: 25 };
type S = Awaited<ReturnType<typeof startService>>;
const withFleet = (map: Record<string, string>) => startService({ workerSecret: SECRET }, { ...fast, fleet: fakeFleet(map) });
async function scan(s: S, body: Record<string, unknown>): Promise<string> {
  const res = await request(s.app).post('/api/batches').send({ urls: 'https://hold.example.com/', ...body }).expect(201);
  return (res.body as CreateBatchResponse).jobs[0].id;
}
const report = async (s: S, id: string): Promise<JobReportResponse> => (await request(s.app).get(`/api/jobs/${id}/report`).expect(200)).body as JobReportResponse;
async function poll<T>(fn: () => Promise<T | undefined>, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const liveDir = (s: S, id: string) => path.join(s.store.jobDir(id), 'consent', 'live');

describe('per-law live state on the report endpoint', () => {
  it('each law carries its state and its own live report while the job runs; a failed law says why', async () => {
    const eu = await startWorker();
    const s = await withFleet({ fra: eu.url }); // no worker for lhr
    const id = await scan(s, { laws: ['eu', 'uk', 'ca'], authorized: true });

    const mid = await poll(
      async () => {
        const r = await report(s, id);
        const e = r.laws?.find((l) => l.id === 'eu');
        const c = r.laws?.find((l) => l.id === 'ca');
        return e?.report?.banner.provider === 'FakeCMP' && c?.report ? r : undefined;
      },
      10_000,
      'live reports for eu and ca',
    );
    expect(mid.laws!.map((l) => l.id)).toEqual(['eu', 'uk', 'ca']);
    const [e, u, c] = mid.laws!;
    expect(e.progress).toMatchObject({ id: 'eu', locationId: 'de', region: 'fra', local: false });
    expect(['scanning', 'collected']).toContain(e.progress.state);
    expect(e.report!.locations?.map((l) => l.id)).toEqual(['de']);
    expect(c.progress).toMatchObject({ id: 'ca', locationId: 'us-ca', local: true });
    expect(c.report!.locations?.map((l) => l.id)).toEqual(['us-ca']);
    expect(u.progress).toMatchObject({ state: 'failed', error: 'worker in lhr failed: no fake worker for region lhr' });
    expect(u.report).toBeNull();
    expect(fs.existsSync(path.join(liveDir(s, id), 'eu.json'))).toBe(true);

    await waitForStatus(s, id, ['done']);
    const end = await report(s, id);
    expect(end.laws!.map((l) => [l.id, l.progress.state])).toEqual([['eu', 'done'], ['uk', 'failed'], ['ca', 'done']]);
    expect(end.laws!.every((l) => l.report === null)).toBe(true);
    expect(fs.existsSync(liveDir(s, id))).toBe(false);
    expect(fs.existsSync(path.join(s.store.jobDir(id), 'consent', 'gather'))).toBe(false);
    // The job's own record carries the same states.
    const job = (await request(s.app).get(`/api/jobs/${id}`).expect(200)).body as { metrics: { laws?: Array<{ id: string; state: string }> } };
    expect(job.metrics.laws?.map((l) => l.state)).toEqual(['done', 'failed', 'done']);
  });

  it('a law whose collection fails is failed with the same message the job reports', async () => {
    const eu = await startWorker();
    const s = await withFleet({ fra: eu.url });
    const id = await scan(s, { urls: 'https://fail.example.com/', laws: ['eu', 'ca'], authorized: true });
    const job = await waitForStatus(s, id, ['failed']);
    const r = await report(s, id);
    expect(r.laws!.map((l) => l.progress.state)).toEqual(['failed', 'failed']);
    for (const l of r.laws!) expect(job.error).toContain(l.progress.error!);
    expect(r.laws![0].progress.error).toMatch(/^worker in fra failed: .*boom: navigation failed/);
  });

  it('cancel freezes the laws where they were: none becomes done', async () => {
    const eu = await startWorker();
    const s = await withFleet({ fra: eu.url });
    const id = await scan(s, { urls: 'https://slow.example.com/', laws: ['eu', 'ca'], authorized: true });
    await waitFor(() => eu.w.isBusy(), 10_000, 'the worker to be collecting');
    await request(s.app).post(`/api/jobs/${id}/cancel`).expect(200);
    await waitForStatus(s, id, ['cancelled']);
    const r = await report(s, id);
    expect(r.laws).toHaveLength(2);
    expect(r.laws!.some((l) => l.progress.state === 'done')).toBe(false);
  });

  it('jobs without laws have no laws field', async () => {
    const s = await startService();
    const res = await request(s.app).post('/api/batches').send({ urls: 'https://site.example.com/' }).expect(201);
    const id = (res.body as CreateBatchResponse).jobs[0].id;
    await waitForStatus(s, id, ['done']);
    expect((await report(s, id)).laws).toBeUndefined();
  });
});

describe('worker: GET /internal/jobs/:jobId/report', () => {
  it('401 without the secret; 404 before the first visit; the collector’s owner report after', async () => {
    const { w } = await startWorker();
    await request(w.app).post('/internal/collect').set(auth).send({ jobId: 'job1', url: 'https://hold.example.com/', locationId: 'de', quick: true, runs: 1 }).expect(202);
    await request(w.app).get('/internal/jobs/job1/report').expect(401);
    await request(w.app).get('/internal/jobs/job1/report').set(auth).expect(404);
    await request(w.app).get('/internal/jobs/nope/report').set(auth).expect(404);
    const body = await poll(
      async () => {
        const res = await request(w.app).get('/internal/jobs/job1/report').set(auth);
        return res.status === 200 ? (res.body as { stage: string; locations?: Array<{ id: string }>; banner: { provider?: string } }) : undefined;
      },
      10_000,
      'the worker report',
    );
    expect(body.stage).toBe('live');
    expect(body.locations?.map((l) => l.id)).toEqual(['de']);
    expect(body.banner.provider).toBe('FakeCMP');
  });
});
