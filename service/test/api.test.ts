import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { CreateBatchResponse, JobDetail, JobsResponse } from '../src/shared/api.js';
import { binaryParser, startService, stopAll, waitFor, waitForStatus } from './helpers.js';

afterEach(stopAll);

/** File names from a zip's central directory (enough to check the layout). */
function zipEntries(buf: Buffer): string[] {
  const names: string[] = [];
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) !== 0x06054b50) continue; // end of central directory
    let p = buf.readUInt32LE(i + 16);
    const count = buf.readUInt16LE(i + 10);
    for (let n = 0; n < count; n++) {
      const nameLen = buf.readUInt16LE(p + 28);
      const extra = buf.readUInt16LE(p + 30);
      const comment = buf.readUInt16LE(p + 32);
      names.push(buf.toString('utf8', p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extra + comment;
    }
    break;
  }
  return names;
}

describe('POST /api/batches', () => {
  it('parses newline/comma/whitespace lists, adds https, dedupes, reports rejects', async () => {
    const s = await startService({ concurrency: 1 });
    const res = await request(s.app)
      .post('/api/batches')
      .send({ urls: 'example.com\nhttps://example.com/, http://other.org/page\n\nnot a url  ftp://x.org localhost https://example.com/#top' })
      .expect(201);
    const body = res.body as CreateBatchResponse;
    expect(body.jobs.map((j) => j.url)).toEqual(['https://example.com/', 'http://other.org/page']);
    expect(body.rejected).toEqual(['not', 'a', 'url', 'ftp://x.org', 'localhost']);
    expect(body.jobs.every((j) => j.batchId === body.batchId)).toBe(true);
    expect(body.jobs[0]).toMatchObject({ host: 'example.com', checks: ['consent'], quick: false });
    // concurrency 1: the first job has already started, the second waits.
    expect(body.jobs.map((j) => j.status)).toEqual(['running', 'queued']);
    expect(body.jobs[0]).not.toHaveProperty('log');
  });

  it('rejects a list with no valid URLs, a missing field, and no checks', async () => {
    const s = await startService();
    const none = await request(s.app).post('/api/batches').send({ urls: 'nope' }).expect(400);
    expect(none.body.rejected).toEqual(['nope']);
    await request(s.app).post('/api/batches').send({}).expect(400);
    await request(s.app)
      .post('/api/batches')
      .send({ urls: 'example.com', checks: { consent: false } })
      .expect(400);
    expect(s.store.list()).toHaveLength(0);
  });
});

describe('job lifecycle', () => {
  it('queued → running → done, with progress reaching 1 and metrics accumulated', async () => {
    const s = await startService();
    const seen = new Set<string>();
    const fractions: number[] = [];
    s.store.on('change', (j) => {
      seen.add(j.status);
      fractions.push(j.progress.fraction);
    });
    const res = await request(s.app).post('/api/batches').send({ urls: 'site.example.com', quick: true }).expect(201);
    const id = (res.body as CreateBatchResponse).jobs[0].id;
    await waitForStatus(s, id, ['done']);

    const job = (await request(s.app).get(`/api/jobs/${id}`).expect(200)).body as JobDetail;
    expect([...seen]).toEqual(expect.arrayContaining(['running', 'done']));
    expect(job.status).toBe('done');
    expect(job.quick).toBe(true);
    expect(job.progress).toMatchObject({ fraction: 1, done: 3, total: 3, phase: 'finished' });
    // Progress climbs monotonically through partial values.
    expect(fractions.some((f) => f > 0 && f < 1)).toBe(true);
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
    expect(job.metrics).toMatchObject({
      requests: 60, // 10 + 20 + 30
      thirdPartyRequests: 18,
      parties: 4, // max
      cookies: 4, // max
      banner: 'onetrust',
      location: { id: 'local', verdict: 'verified', observed: 'US-FL' },
    });
    expect(job.metrics.scenarios.map((x) => [x.scenario, x.status])).toEqual([
      ['do-nothing', 'tested'],
      ['reject', 'not-applicable'],
      ['gpc', 'tested'],
    ]);
    expect(job.result?.consent).toMatchObject({ findings: 2, parties: 4, unrecognized: 1, totals: { violation: 1, exposure: 1 } });
    expect(job.result?.consent?.reportUrl).toMatch(new RegExp(`^/reports/${id}/consent/\\.comply/runs/[^/]+/consent-report\\.html$`));
    expect(job.result?.downloadUrl).toBe(`/api/jobs/${id}/download`);
    expect(job.log.some((l) => l.includes('$ complykit consent --url https://site.example.com/'))).toBe(true);
    expect(job.log.some((l) => l.includes('--quick'))).toBe(true);

    // Persisted to disk.
    await s.store.flush();
    const onDisk = JSON.parse(fs.readFileSync(path.join(s.store.jobDir(id), 'job.json'), 'utf8')) as JobDetail;
    expect(onDisk.status).toBe('done');
  });

  it('runs accessibility after consent as one more unit of progress', async () => {
    const s = await startService();
    const res = await request(s.app)
      .post('/api/batches')
      .send({ urls: 'site.example.com', checks: { consent: true, accessibility: true } })
      .expect(201);
    const id = (res.body as CreateBatchResponse).jobs[0].id;
    const job = await waitForStatus(s, id, ['done', 'failed']);
    expect(job.error).toBeUndefined();
    expect(job.progress).toMatchObject({ fraction: 1, done: 4, total: 4 });
    expect(job.result?.accessibility).toMatchObject({ findings: 3, reportUrl: `/reports/${id}/accessibility/report.html` });
    const html = await request(s.app).get(job.result!.accessibility!.reportUrl).expect(200);
    expect(html.text).toContain('Accessibility');
  });

  it('accessibility-only jobs count one unit', async () => {
    const s = await startService();
    const res = await request(s.app)
      .post('/api/batches')
      .send({ urls: 'site.example.com', checks: { consent: false, accessibility: true } })
      .expect(201);
    const job = await waitForStatus(s, (res.body as CreateBatchResponse).jobs[0].id, ['done', 'failed']);
    expect(job.status).toBe('done');
    expect(job.progress).toMatchObject({ fraction: 1, done: 1, total: 1 });
    expect(job.result?.consent).toBeUndefined();
  });

  it('an unverified location finishes with zero scenarios', async () => {
    const s = await startService();
    const res = await request(s.app).post('/api/batches').send({ urls: 'unverified.example.com' }).expect(201);
    const job = await waitForStatus(s, (res.body as CreateBatchResponse).jobs[0].id, ['done', 'failed']);
    expect(job.status).toBe('done');
    expect(job.metrics.location?.verdict).toBe('unverified');
    expect(job.progress).toMatchObject({ fraction: 1, total: 0 });
  });

  it('non-zero exit and error events fail the job with a useful message', async () => {
    const s = await startService();
    const res = await request(s.app).post('/api/batches').send({ urls: 'fail.example.com, error.example.com' }).expect(201);
    const [failId, errId] = (res.body as CreateBatchResponse).jobs.map((j) => j.id);
    const failed = await waitForStatus(s, failId, ['failed', 'done']);
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('exited with code 1');
    expect(failed.error).toContain('ERR_NAME_NOT_RESOLVED');
    const errored = await waitForStatus(s, errId, ['failed', 'done']);
    expect(errored.status).toBe('failed');
    expect(errored.error).toContain('location verification crashed');
  });

  it('a job over the hard timeout is killed and failed', async () => {
    const s = await startService({ jobTimeoutMs: 400 });
    const res = await request(s.app).post('/api/batches').send({ urls: 'slow.example.com' }).expect(201);
    const job = await waitForStatus(s, (res.body as CreateBatchResponse).jobs[0].id, ['failed', 'done']);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/^timed out after/);
  });

  it('fails cleanly when the CLI is missing', async () => {
    const s = await startService({ cliPath: '/nonexistent/cli.js' });
    const res = await request(s.app).post('/api/batches').send({ urls: 'site.example.com' }).expect(201);
    const job = await waitForStatus(s, (res.body as CreateBatchResponse).jobs[0].id, ['failed', 'done']);
    expect(job.error).toContain('CLI not found');
  });
});

describe('queue', () => {
  it('never runs more than CONCURRENCY jobs at once, and runs them FIFO', async () => {
    const s = await startService({ concurrency: 2 });
    let maxRunning = 0;
    const startOrder: string[] = [];
    s.store.on('change', (j) => {
      if (j.status === 'running' && !startOrder.includes(j.id)) startOrder.push(j.id);
      maxRunning = Math.max(maxRunning, s.store.list().filter((x) => x.status === 'running').length);
    });
    const res = await request(s.app).post('/api/batches').send({ urls: 'a.example.com b.example.com c.example.com d.example.com e.example.com' }).expect(201);
    const ids = (res.body as CreateBatchResponse).jobs.map((j) => j.id);
    const mid = (await request(s.app).get('/api/jobs').expect(200)).body as JobsResponse;
    expect(mid.server).toMatchObject({ concurrency: 2, running: 2, queued: 3, retentionDays: 14 });
    for (const id of ids) await waitForStatus(s, id, ['done']);
    expect(maxRunning).toBe(2);
    expect(startOrder).toEqual(ids);
  });
});

describe('cancel and delete', () => {
  it('cancels a running job (child killed) and a queued one', async () => {
    const s = await startService({ concurrency: 1 });
    const res = await request(s.app).post('/api/batches').send({ urls: 'slow.example.com slow2.example.com' }).expect(201);
    const [runId, queuedId] = (res.body as CreateBatchResponse).jobs.map((j) => j.id);
    await waitFor(() => s.store.get(runId)?.metrics.scenarios.length, 10_000, 'first scenario');

    const q = await request(s.app).post(`/api/jobs/${queuedId}/cancel`).expect(200);
    expect(q.body.status).toBe('cancelled');
    const r = await request(s.app).post(`/api/jobs/${runId}/cancel`).expect(200);
    expect(r.body.status).toBe('cancelled');
    expect(s.runner.running).toBe(0);
    // Cancelling again is a conflict, not a crash.
    await request(s.app).post(`/api/jobs/${runId}/cancel`).expect(409);
    // No `done` ever lands for the killed run.
    await new Promise((r) => setTimeout(r, 400));
    expect(s.store.get(runId)?.status).toBe('cancelled');
    expect(s.store.get(runId)?.result?.consent).toBeUndefined();
  });

  it('DELETE kills a running job, removes its files, and emits removed', async () => {
    const s = await startService();
    const removed: string[] = [];
    s.store.on('removed', (id) => removed.push(id));
    const res = await request(s.app).post('/api/batches').send({ urls: 'slow.example.com' }).expect(201);
    const id = (res.body as CreateBatchResponse).jobs[0].id;
    await waitForStatus(s, id, ['running']);
    const dir = s.store.jobDir(id);
    await request(s.app).delete(`/api/jobs/${id}`).expect(204);
    expect(fs.existsSync(dir)).toBe(false);
    expect(removed).toEqual([id]);
    await request(s.app).get(`/api/jobs/${id}`).expect(404);
    await request(s.app).delete(`/api/jobs/${id}`).expect(404);
  });
});

describe('reports and downloads', () => {
  async function doneJob() {
    const s = await startService();
    const res = await request(s.app).post('/api/batches').send({ urls: 'site.example.com' }).expect(201);
    const job = await waitForStatus(s, (res.body as CreateBatchResponse).jobs[0].id, ['done']);
    return { s, job };
  }

  it('serves report files from the job dir with content types (dotfile paths allowed)', async () => {
    const { s, job } = await doneJob();
    const url = job.result!.consent!.reportUrl;
    const html = await request(s.app).get(url).expect(200);
    expect(html.headers['content-type']).toMatch(/text\/html/);
    expect(html.text).toContain('Consent report for https://site.example.com/');
    // The report's run-relative evidence link resolves.
    const ev = await request(s.app).get(url.replace('consent-report.html', 'evidence/note.txt')).expect(200);
    expect(ev.headers['content-type']).toMatch(/text\/plain/);
    // The developer's change list sits beside the report and is downloadable (B2).
    const cl = await request(s.app).get(job.result!.consent!.changeListUrl!).expect(200);
    expect(cl.text).toContain('# Change list');
    await request(s.app).get(`/reports/${job.id}/nope.html`).expect(404);
    await request(s.app).get('/reports/zzzzzzzzzzzz/job.json').expect(404);
  });

  it('blocks path traversal out of the job dir', async () => {
    const { s, job } = await doneJob();
    // A file next to the jobs dir that must never be reachable.
    fs.writeFileSync(path.join(s.config.dataDir, 'secret.txt'), 'secret');
    for (const p of [
      `/reports/${job.id}/../../secret.txt`,
      `/reports/${job.id}/..%2F..%2Fsecret.txt`,
      `/reports/${job.id}/%2e%2e/%2e%2e/secret.txt`,
      `/reports/${job.id}/consent/..%2F..%2F..%2Fsecret.txt`,
    ]) {
      const res = await request(s.app).get(p);
      expect([403, 404], p).toContain(res.status);
      expect(res.text ?? '').not.toContain('secret');
    }
  });

  it('streams a zip with readable names', async () => {
    const { s, job } = await doneJob();
    const res = await request(s.app).get(`/api/jobs/${job.id}/download`).buffer(true).parse(binaryParser as Parameters<request.Test["parse"]>[0]).expect(200);
    expect(res.headers['content-type']).toBe('application/zip');
    const date = job.createdAt.slice(0, 10);
    expect(res.headers['content-disposition']).toContain(`complykit-site.example.com-${date}.zip`);
    const names = zipEntries(res.body as Buffer);
    const root = `complykit-site.example.com-${date}`;
    expect(names).toEqual(
      expect.arrayContaining([`${root}/job.json`, `${root}/consent/consent-report.html`, `${root}/consent/evidence/note.txt`, `${root}/consent/tracking.json`, `${root}/consent/events.ndjson`]),
    );
    expect(names.some((n) => n.includes('.comply'))).toBe(false);
  });
});

describe('auth', () => {
  it('401 without credentials, 200 with any username + the password; health stays open', async () => {
    const s = await startService({ password: 'hunter2' });
    const no = await request(s.app).get('/api/jobs').expect(401);
    expect(no.headers['www-authenticate']).toMatch(/^Basic/);
    await request(s.app).get('/api/jobs').auth('anyone', 'wrong').expect(401);
    await request(s.app).get('/api/jobs').auth('anyone', 'hunter2').expect(200);
    await request(s.app).get('/reports/abcdefabcdef/x.html').expect(401);
    await request(s.app).get('/').expect(401);
    const health = await request(s.app).get('/api/health').expect(200);
    expect(health.body).toEqual({ ok: true });
  });
});

describe('client + misc routes', () => {
  it('serves a "client not built" page when dist/client is missing; unknown /api is JSON 404', async () => {
    const s = await startService();
    const page = await request(s.app).get('/some/spa/route').expect(503);
    expect(page.text).toContain('Client not built');
    const api = await request(s.app).get('/api/nope').expect(404);
    expect(api.body).toEqual({ error: 'not found' });
  });

  it('serves the built client with SPA fallback', async () => {
    const clientDir = path.join(fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'client-')));
    fs.writeFileSync(path.join(clientDir, 'index.html'), '<!doctype html><div id="root">app</div>');
    fs.writeFileSync(path.join(clientDir, 'app.js'), 'console.log(1)');
    const s = await startService({ clientDir });
    expect((await request(s.app).get('/').expect(200)).text).toContain('id="root"');
    expect((await request(s.app).get('/jobs/abc').expect(200)).text).toContain('id="root"');
    const js = await request(s.app).get('/app.js').expect(200);
    expect(js.headers['content-type']).toMatch(/javascript/);
  });

  it('SSE stream sends job events with the contract framing', async () => {
    const s = await startService();
    const server = s.app.listen(0);
    try {
      const port = (server.address() as { port: number }).port;
      const ctrl = new AbortController();
      const resp = await fetch(`http://127.0.0.1:${port}/api/stream`, { signal: ctrl.signal });
      expect(resp.headers.get('content-type')).toMatch(/text\/event-stream/);
      expect(resp.headers.get('x-accel-buffering')).toBe('no');
      const reader = resp.body!.getReader();
      await request(s.app).post('/api/batches').send({ urls: 'site.example.com' }).expect(201);
      let text = '';
      const dec = new TextDecoder();
      while (!/event: job\ndata: .*"status":"done"/.test(text)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += dec.decode(value);
      }
      ctrl.abort();
      const frames = text.split('\n\n').filter((f) => f.startsWith('event: job'));
      expect(frames.length).toBeGreaterThan(1);
      const last = JSON.parse(frames.at(-1)!.split('\ndata: ')[1]) as JobDetail;
      expect(last.status).toBe('done');
      expect(last).not.toHaveProperty('log');
    } finally {
      s.hub.closeAll();
      server.close();
    }
  });
});
