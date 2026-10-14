import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { CreateBatchResponse, JobReportResponse, SiteWorkspace } from '../src/shared/api.js';
import { startService, stopAll, waitForStatus } from './helpers.js';

// Scan history: every scan of a site is listed on its report page, and an
// earlier scan can't make the site's to-do list (that list, like the
// classifications, is site-wide and comes from the latest scan).

afterEach(stopAll);

type S = Awaited<ReturnType<typeof startService>>;

async function scan(s: S, url: string, status: 'done' | 'failed' = 'done'): Promise<string> {
  const res = await request(s.app).post('/api/batches').send({ urls: url, quick: true }).expect(201);
  const id = (res.body as CreateBatchResponse).jobs[0].id;
  await waitForStatus(s, id, [status]);
  // Distinct createdAt (ms resolution) for the next scan.
  await new Promise((r) => setTimeout(r, 5));
  return id;
}
const report = async (s: S, id: string): Promise<JobReportResponse> => (await request(s.app).get(`/api/jobs/${id}/report`).expect(200)).body as JobReportResponse;

describe('scan history on the report', () => {
  it('names the site’s first finished scan as the score baseline, with its score', async () => {
    const s = await startService();
    const first = await scan(s, 'shop.example.com');
    await scan(s, 'fail.example.com', 'failed');
    const latest = await scan(s, 'www.example.com');

    const a = await report(s, first);
    expect(a.firstScan).toMatchObject({ jobId: first, current: true });
    const b = await report(s, latest);
    expect(b.firstScan?.jobId).toBe(first);
    expect(b.firstScan?.current).toBeUndefined();
    expect(typeof b.firstScan?.score).toBe('number');
  });

  it('lists every scan of the site, newest first, marking this one; other sites are left out', async () => {
    const s = await startService();
    const first = await scan(s, 'shop.example.com');
    const failed = await scan(s, 'fail.example.com', 'failed');
    await scan(s, 'other.example.org');
    const latest = await scan(s, 'www.example.com');

    const r = await report(s, first);
    expect(r.history.map((h) => h.jobId)).toEqual([latest, failed, first]);
    expect(r.history.filter((h) => h.current).map((h) => h.jobId)).toEqual([first]);
    expect(r.history.find((h) => h.jobId === failed)).toMatchObject({ status: 'failed', available: true });
    expect(r.history.every((h) => h.available)).toBe(true);
    expect(r.history[0]).toMatchObject({ status: 'done', quick: true, checks: ['consent'] });
    // Summaries name the job's site, so the site page can list jobs that recorded no run.
    expect(r.job.site).toBe('example.com');
    const listed = (await request(s.app).get('/api/jobs').expect(200)).body.jobs as Array<{ id: string; site?: string }>;
    expect(listed.find((j) => j.id === failed)?.site).toBe('example.com');
    expect(listed.find((j) => j.id !== failed && j.site === 'example.org')).toBeTruthy();
  });

  it('lists runs whose job is gone (or ran elsewhere) as not available', async () => {
    const s = await startService();
    const id = await scan(s, 'shop.example.com');
    await request(s.app)
      .patch('/api/sites/example.com/workspace')
      .send({ runs: [{ id: 'r-gone', at: '2026-01-01T00:00:00.000Z', jobId: 'gonejob1', url: 'https://example.com/' }, { id: 'r-cli', at: '2026-01-02T00:00:00.000Z', url: 'https://example.com/' }] })
      .expect(200);
    const r = await report(s, id);
    expect(r.history.map((h) => [h.jobId, h.available])).toEqual([
      [id, true],
      [undefined, false],
      ['gonejob1', false],
    ]);
  });

  it('marks an earlier scan with the newer one; the latest has none', async () => {
    const s = await startService();
    const first = await scan(s, 'shop.example.com');
    const second = await scan(s, 'www.example.com');
    expect((await report(s, first)).newerScan).toEqual({ jobId: second, at: s.store.get(second)!.createdAt });
    expect((await report(s, second)).newerScan).toBeUndefined();
  });

  it('a newer scan that failed does not supersede the earlier one', async () => {
    const s = await startService();
    const first = await scan(s, 'shop.example.com');
    await scan(s, 'fail.example.com', 'failed');
    expect((await report(s, first)).newerScan).toBeUndefined();
  });
});

describe('an earlier scan cannot make the site’s to-do list', () => {
  it('refuses consent-config and rerender {generate:true} on an earlier scan, with the newer job id', async () => {
    const s = await startService();
    const first = await scan(s, 'shop.example.com');
    const second = await scan(s, 'www.example.com');

    const cfg = await request(s.app).post(`/api/jobs/${first}/consent-config`).send({}).expect(409);
    expect(cfg.body).toMatchObject({ newerJobId: second });
    expect(cfg.body.error).toMatch(/newer scan/);
    const gen = await request(s.app).post(`/api/jobs/${first}/rerender`).send({ generate: true }).expect(409);
    expect(gen.body).toMatchObject({ newerJobId: second });
    const ws = (await request(s.app).get('/api/sites/example.com/workspace').expect(200)).body as SiteWorkspace;
    expect(ws.config).toBeUndefined();

    // The latest scan makes it; the earlier one still re-renders with new classifications.
    await request(s.app).post(`/api/jobs/${second}/consent-config`).send({}).expect(200);
    await request(s.app).patch('/api/sites/example.com/workspace').send({ entries: { 'class:tool-1': { value: { category: 'analytics', categoryChosen: true } } } }).expect(200);
    const older = await request(s.app).post(`/api/jobs/${first}/rerender`).send({}).expect(200);
    expect(older.body.config).toEqual({ regenerated: false });
  });

  it('still allows it when the stored list came from that earlier scan', async () => {
    const s = await startService();
    const first = await scan(s, 'shop.example.com');
    await request(s.app).post(`/api/jobs/${first}/consent-config`).send({}).expect(200);
    await scan(s, 'www.example.com');
    await request(s.app).post(`/api/jobs/${first}/consent-config`).send({}).expect(200);
    await request(s.app).post(`/api/jobs/${first}/rerender`).send({ generate: true }).expect(200);
  });

  it('an earlier scan of a different site is not affected', async () => {
    const s = await startService();
    const a = await scan(s, 'shop.example.com');
    await scan(s, 'shop.example.org');
    await request(s.app).post(`/api/jobs/${a}/consent-config`).send({}).expect(200);
  });
});
