import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { CreateBatchResponse, RerenderResponse, SiteWorkspace } from '../src/shared/api.js';
import { startService, stopAll, waitForStatus } from './helpers.js';

afterEach(stopAll);

// R2: POST /api/jobs/:id/rerender runs `complykit report --format consent-html
// --workspace <current workspace>` on the job's saved run and replaces the
// served report (the old one kept as consent-report.prev.html). No rescan.

async function scan(s: Awaited<ReturnType<typeof startService>>, url: string, status: 'done' | 'failed' = 'done'): Promise<string> {
  const res = await request(s.app).post('/api/batches').send({ urls: url, quick: true }).expect(201);
  const id = (res.body as CreateBatchResponse).jobs[0].id;
  await waitForStatus(s, id, [status]);
  return id;
}

function calls(s: Awaited<ReturnType<typeof startService>>, id: string): string[][] {
  const f = path.join(s.store.jobDir(id), 'consent', 'report-calls.ndjson');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]) : [];
}

describe('POST /api/jobs/:id/rerender', () => {
  it('re-renders the served report with the current workspace and keeps the previous one', async () => {
    const s = await startService();
    const id = await scan(s, 'shop.example.com');
    const job = s.store.get(id)!;
    const reportUrl = job.result!.consent!.reportUrl;
    const before = (await request(s.app).get(reportUrl).expect(200)).text;
    expect(before).toContain('Consent report for');

    // Classified AFTER the scan; a cleared one is not applied.
    await request(s.app).patch('/api/sites/example.com/workspace').send({ entries: { 'class:tool-abc': { value: { category: 'analytics', categoryChosen: true } }, 'class:tool-gone': { value: null } } }).expect(200);
    const res = await request(s.app).post(`/api/jobs/${id}/rerender`).send({}).expect(200);
    const body = res.body as RerenderResponse;
    expect(body).toMatchObject({ ok: true, runId: job.result!.consent!.runId, reportUrl, classifications: 1, config: { regenerated: false } });
    expect(Date.parse(body.at)).not.toBeNaN();

    const after = (await request(s.app).get(reportUrl).expect(200)).text;
    expect(after).toContain('Re-rendered');
    expect(after).toContain('class:tool-abc');
    expect(after).not.toContain('tool-gone');
    expect((await request(s.app).get(body.previousReportUrl).expect(200)).text).toBe(before);
    expect((await request(s.app).get(job.result!.consent!.changeListUrl!).expect(200)).text).toMatch(/re-rendered with 1 classification/);

    const [argv] = calls(s, id);
    expect(argv.slice(0, 8)).toEqual(['report', '--run', job.result!.consent!.runId, '--cwd', path.join(s.store.jobDir(id), 'consent'), '--format', 'consent-html', '--workspace']);
    expect(argv).not.toContain('--previous'); // the site's first run
  });

  it('compares with the site’s earlier run and regenerates a config generated from this run', async () => {
    const s = await startService();
    const first = await scan(s, 'shop.example.com');
    const second = await scan(s, 'www.example.com');
    await request(s.app).post(`/api/jobs/${second}/consent-config`).send({ by: 'Ann', recordEndpoint: '/consent-record' }).expect(200);
    await request(s.app).patch('/api/sites/example.com/workspace').send({ entries: { 'class:tool-1': { value: { category: 'advertising', categoryChosen: true } }, 'class:tool-2': { value: { category: 'analytics', categoryChosen: true } } } }).expect(200);

    const body = (await request(s.app).post(`/api/jobs/${second}/rerender`).send({ by: 'Bo' }).expect(200)).body as RerenderResponse;
    expect(body.config).toEqual({ regenerated: true, stale: false });
    const ws = (await request(s.app).get('/api/sites/example.com/workspace').expect(200)).body as SiteWorkspace;
    expect(ws.config).toMatchObject({ by: 'Bo', runId: s.store.get(second)!.result!.consent!.runId });
    expect((ws.config!.value as { config: { classified: number; record?: { endpoint: string } } }).config).toMatchObject({ classified: 2, record: { endpoint: '/consent-record' } });

    const firstRun = path.join(s.store.jobDir(first), 'consent', '.comply', 'runs', s.store.get(first)!.result!.consent!.runId);
    const argv = calls(s, second).at(-1)!;
    expect(argv[argv.indexOf('--previous') + 1]).toBe(firstRun);

    // The older job's config is not touched by its own re-render (the config came from the newer run).
    const older = (await request(s.app).post(`/api/jobs/${first}/rerender`).send({}).expect(200)).body as RerenderResponse;
    expect(older.config).toEqual({ regenerated: false });
    expect(calls(s, first).at(-1)).not.toContain('--previous');
  });

  it('refuses a job without a finished consent run and reports a CLI failure', async () => {
    const s = await startService();
    const failed = await scan(s, 'fail.example.net', 'failed');
    await request(s.app).post(`/api/jobs/${failed}/rerender`).send({}).expect(409);
    await request(s.app).post('/api/jobs/aaaaaaaaaaaaaaaa/rerender').send({}).expect(404);
    const id = await scan(s, 'ok.example.net');
    await request(s.app).post(`/api/jobs/${id}/rerender`).send({ by: 42 }).expect(400);
    const job = s.store.get(id)!;
    const before = (await request(s.app).get(job.result!.consent!.reportUrl).expect(200)).text;
    process.env.FAKE_REPORT_FAIL = '1';
    try {
      const bad = await request(s.app).post(`/api/jobs/${id}/rerender`).send({}).expect(500);
      expect(bad.body.error).toMatch(/report crashed/);
      expect(bad.body.configStored).toBeUndefined(); // no config was generated: a plain failure
      // Generate stores the config (the checklist exists), then the report step fails: the error says exactly that.
      const gen = await request(s.app).post(`/api/jobs/${id}/rerender`).send({ generate: true }).expect(500);
      expect(gen.body).toMatchObject({ configStored: true, error: expect.stringMatching(/report crashed/) });
      const ws = (await request(s.app).get('/api/sites/example.net/workspace').expect(200)).body as SiteWorkspace;
      expect(gen.body.configAt).toBe(ws.config!.at);
      expect(Array.isArray((ws.config!.value as { tasks?: unknown }).tasks)).toBe(true);
    } finally {
      delete process.env.FAKE_REPORT_FAIL;
    }
    // A failed re-render leaves the served report alone.
    expect((await request(s.app).get(job.result!.consent!.reportUrl).expect(200)).text).toBe(before);
  });
});
