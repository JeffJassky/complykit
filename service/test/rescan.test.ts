import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { CreateBatchResponse, RemediationResponse, RerenderResponse, RescanResponse, SitesResponse } from '../src/shared/api.js';
import { startService, stopAll, waitForStatus } from './helpers.js';

afterEach(stopAll);

// The remediation flow's integration points on the service: the rescan (the
// checklist's last step), the report's Generate (rerender with generate: true),
// checklist progress on the sites list, and task status across a regeneration.

type S = Awaited<ReturnType<typeof startService>>;
async function scan(s: S, url: string, opts: { quick?: boolean; accessibility?: boolean } = {}): Promise<string> {
  const res = await request(s.app).post('/api/batches').send({ urls: url, quick: opts.quick ?? false, checks: { consent: true, accessibility: opts.accessibility ?? false } }).expect(201);
  const id = (res.body as CreateBatchResponse).jobs[0].id;
  await waitForStatus(s, id, ['done']);
  return id;
}

describe('POST /api/sites/:domain/rescan', () => {
  it('starts a consent job with the URL, checks and quick flag of the site’s latest job; 409 while one is queued or running', async () => {
    const s = await startService({ concurrency: 1 });
    await scan(s, 'https://www.example.com/old', { quick: false });
    const last = await scan(s, 'https://shop.example.com/start', { quick: true });
    await scan(s, 'https://other.example.org/');
    const res = await request(s.app).post('/api/sites/example.com/rescan').send({}).expect(201);
    const body = res.body as RescanResponse;
    expect(body.domain).toBe('example.com');
    expect(body.from).toEqual({ jobId: last, url: 'https://shop.example.com/start', checks: ['consent'], quick: true });
    expect(body.job).toMatchObject({ url: 'https://shop.example.com/start', checks: ['consent'], quick: true });
    expect(['queued', 'running']).toContain(body.job.status);
    // A second click while it runs: refused, naming the job.
    const again = await request(s.app).post('/api/sites/www.example.com/rescan').send({}).expect(409);
    expect(again.body.error).toContain(body.job.id);
    await waitForStatus(s, body.job.id, ['done']);
    // Recorded as a run of the site, like any consent job (the workspace applies to it).
    const ws = (await request(s.app).get('/api/sites/example.com/workspace').expect(200)).body as { runs: Array<{ jobId?: string }> };
    expect(ws.runs.some((r) => r.jobId === body.job.id)).toBe(true);
  });

  it('the owner can choose full or quick (the location is not a choice); a bad mode is a 400', async () => {
    const s = await startService();
    await scan(s, 'https://shop.example.com/', { quick: true });
    await request(s.app).post('/api/sites/example.com/rescan').send({ quick: 'yes' }).expect(400);
    const b = (await request(s.app).post('/api/sites/example.com/rescan').send({ quick: false }).expect(201)).body as RescanResponse;
    expect(b.from.quick).toBe(true);
    expect(b.job.quick).toBe(false);
    await waitForStatus(s, b.job.id, ['done']);
  });

  it('keeps the accessibility check when the last job had it; falls back to the workspace’s newest run URL; 404 with nothing to repeat', async () => {
    const s = await startService();
    await scan(s, 'https://a11y.example.net/', { accessibility: true });
    const b = (await request(s.app).post('/api/sites/example.net/rescan').send({}).expect(201)).body as RescanResponse;
    expect(b.job.checks).toEqual(['consent', 'accessibility']);
    await waitForStatus(s, b.job.id, ['done']);

    await request(s.app).patch('/api/sites/example.org/workspace').send({ runs: [{ id: 'r1', url: 'https://www.example.org/home' }] }).expect(200);
    const f = (await request(s.app).post('/api/sites/example.org/rescan').send({}).expect(201)).body as RescanResponse;
    expect(f.from).toEqual({ url: 'https://www.example.org/home', checks: ['consent'], quick: false });
    await waitForStatus(s, f.job.id, ['done']);

    const none = await request(s.app).post('/api/sites/nothing.example/rescan').send({}).expect(404);
    expect(none.body.error).toMatch(/no earlier scan/);
    await request(s.app).post('/api/sites/not a domain/rescan').send({}).expect(400);
  });
});

describe('the report’s Generate, the sites list, and status across a regeneration', () => {
  it('rerender with generate: true makes the config from this run even when none is stored, then re-renders', async () => {
    const s = await startService();
    const id = await scan(s, 'https://shop.example.com/');
    const body = (await request(s.app).post(`/api/jobs/${id}/rerender`).send({ generate: true, by: 'Ann' }).expect(200)).body as RerenderResponse;
    expect(body.config).toEqual({ regenerated: true, stale: false });
    const rem = (await request(s.app).get('/api/sites/example.com/remediation').expect(200)).body as RemediationResponse;
    expect(rem.runId).toBe(s.store.get(id)!.result!.consent!.runId);
    expect(rem.tasks.map((t) => t.id)).toEqual(['install', 'rewrite-tag:0123456789ab']);
    await request(s.app).post(`/api/jobs/${id}/rerender`).send({ generate: 'yes' }).expect(400);
  });

  it('a regeneration keeps every task’s status (statuses live in task:change:<id>, ids do not move); the sites list shows N of M verified', async () => {
    const s = await startService();
    const id = await scan(s, 'https://shop.example.com/');
    let sites = (await request(s.app).get('/api/sites').expect(200)).body as SitesResponse;
    expect(sites.sites.find((x) => x.domain === 'example.com')!.checklist).toBeUndefined();

    await request(s.app).post(`/api/jobs/${id}/consent-config`).send({}).expect(200);
    await request(s.app)
      .patch('/api/sites/example.com/workspace')
      .send({ entries: { 'task:change:install': { value: { status: 'verified', note: 'pasted', lastVerify: { at: '2026-10-07T10:00:00.000Z', result: 'pass', message: 'ok', evidence: [] } } }, 'task:change:rewrite-tag:0123456789ab': { value: { status: 'done-unverified' } } } })
      .expect(200);
    sites = (await request(s.app).get('/api/sites').expect(200)).body as SitesResponse;
    expect(sites.sites.find((x) => x.domain === 'example.com')!.checklist).toEqual({ verified: 1, required: 2, doneUnverified: 1, failed: 0 });

    // A classification changes → the report's update regenerates the config from this run.
    await request(s.app).patch('/api/sites/example.com/workspace').send({ entries: { 'class:tool-1': { value: { category: 'analytics', categoryChosen: true } } } }).expect(200);
    const before = ((await request(s.app).get('/api/sites/example.com/workspace').expect(200)).body as { config: { at: string } }).config.at;
    const r = (await request(s.app).post(`/api/jobs/${id}/rerender`).send({}).expect(200)).body as RerenderResponse;
    expect(r.config.regenerated).toBe(true);
    const ws = (await request(s.app).get('/api/sites/example.com/workspace').expect(200)).body as { config: { at: string; value: { config: { classified: number } } } };
    expect(ws.config.value.config.classified).toBe(1);
    expect(ws.config.at >= before).toBe(true);
    const rem = (await request(s.app).get('/api/sites/example.com/remediation').expect(200)).body as RemediationResponse;
    expect(rem.tasks.map((t) => [t.id, t.status])).toEqual([
      ['install', 'verified'],
      ['rewrite-tag:0123456789ab', 'done-unverified'],
    ]);
    expect(rem.tasks[0]).toMatchObject({ note: 'pasted', lastVerify: { result: 'pass' } });
  });
});
