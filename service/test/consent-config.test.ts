import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConsentConfigResponse, CreateBatchResponse, SiteWorkspace } from '../src/shared/api.js';
import { startService, stopAll, waitForStatus } from './helpers.js';

afterEach(stopAll);

// D8: POST /api/jobs/:id/consent-config runs `complykit consent-config` on the
// job's consent run with the site's CURRENT workspace and stores the result as
// the workspace `config` ({ value: { config, snippet, changeList, notes }, runId }).

async function scan(s: Awaited<ReturnType<typeof startService>>, url: string, status: 'done' | 'failed' = 'done'): Promise<string> {
  const res = await request(s.app).post('/api/batches').send({ urls: url, quick: true }).expect(201);
  const id = (res.body as CreateBatchResponse).jobs[0].id;
  await waitForStatus(s, id, [status]);
  return id;
}

describe('POST /api/jobs/:id/consent-config', () => {
  it('generates with the current workspace and stores it as the workspace config', async () => {
    const s = await startService();
    const id = await scan(s, 'shop.example.com');
    // Classified AFTER the scan: the generator must see it.
    await request(s.app).patch('/api/sites/example.com/workspace').send({ by: 'Dana', entries: { 'class:tool-abc': { value: { category: 'analytics', categoryChosen: true } } } }).expect(200);

    const res = await request(s.app).post(`/api/jobs/${id}/consent-config`).send({ by: 'Ann' }).expect(200);
    const body = res.body as ConsentConfigResponse;
    const runId = s.store.get(id)!.result!.consent!.runId;
    expect(body).toMatchObject({ domain: 'example.com', runId, stale: false });
    expect(body.value.config).toMatchObject({ classified: 1 });
    expect(body.value.changeList).toMatch(/^# Change list/);
    expect(body.value.snippet).toBe('<script src="http://localhost:8080/s/example.com.js" referrerpolicy="no-referrer"></script>\n');
    expect(body.value.hostedScriptUrl).toBe('http://localhost:8080/s/example.com.js');

    const ws = (await request(s.app).get('/api/sites/example.com/workspace').expect(200)).body as SiteWorkspace;
    expect(ws.config).toMatchObject({ by: 'Ann', runId });
    expect((ws.config!.value as { changeList: string }).changeList).toBe(body.value.changeList);
    expect((ws.config!.value as { snippet: string }).snippet).toBe(body.value.snippet);

    // The files are served with the job's reports.
    const snippet = await request(s.app).get(body.files.snippet).expect(200);
    expect(snippet.text).toContain('/s/example.com.js');
    expect(fs.existsSync(path.join(s.store.jobDir(id), 'consent', 'consent-config', 'complykit-config.json'))).toBe(true);
  });

  it('always asks for the hosted install: --hosted and --record-endpoint from the public origin, whatever the request says', async () => {
    const s = await startService({ publicOrigin: 'https://ck.example-host.test' });
    const id = await scan(s, 'www.example.org');
    const res = await request(s.app).post(`/api/jobs/${id}/consent-config`).send({ recordEndpoint: 'https://elsewhere.test/r', scriptSrc: '/assets/ck/complykit-consent.js' }).expect(200);
    const body = res.body as ConsentConfigResponse;
    const cfg = body.value.config as { record?: { endpoint: string } };
    expect(cfg.record?.endpoint).toBe('https://ck.example-host.test/api/consent-records');
    expect(body.value.hostedScriptUrl).toBe('https://ck.example-host.test/s/example.org.js');
    expect(body.value.snippet).toContain('src="https://ck.example-host.test/s/example.org.js"');
    const install = body.value.tasks!.find((t) => t.kind === 'install')!;
    expect(install.verify).toMatchObject({ mode: 'hosted', scriptSrc: 'https://ck.example-host.test/s/example.org.js' });
  });

  it('refuses a job without a finished consent run, an unknown job, and a bad option', async () => {
    const s = await startService();
    const failed = await scan(s, 'fail.example.net', 'failed');
    await request(s.app).post(`/api/jobs/${failed}/consent-config`).send({}).expect(409);
    await request(s.app).post('/api/jobs/aaaaaaaaaaaaaaaa/consent-config').send({}).expect(404);
    const id = await scan(s, 'ok.example.net');
    const bad = await request(s.app).post(`/api/jobs/${id}/consent-config`).send({ privacyPolicyUrl: 'http://example.net/privacy' }).expect(400);
    expect(bad.body.error).toMatch(/https/);
    await request(s.app).post(`/api/jobs/${id}/consent-config`).send({ by: 42 }).expect(400);
  });
});
