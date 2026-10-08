import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { idleReason } from '../src/server/lifecycle.js';
import { WORKER_SECRET_HEADER, createWorkerApp, loadWorkerConfig, type WorkerConfig, type WorkerService } from '../src/server/worker.js';
import { binaryParser, tempDir } from './helpers.js';
import { fileURLToPath } from 'node:url';

const FAKE_WORKER_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-worker-cli.mjs');
const SECRET = 'test-secret';

const started: WorkerService[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((w) => w.stop(200)));
});

function startWorker(overrides: Partial<WorkerConfig> = {}): { w: WorkerService; config: WorkerConfig } {
  const config: WorkerConfig = { ...loadWorkerConfig({ WORKER_SECRET: SECRET }), tmpDir: tempDir(), cliPath: FAKE_WORKER_CLI, killGraceMs: 500, ...overrides };
  const w = createWorkerApp(config);
  started.push(w);
  return { w, config };
}

const auth = { [WORKER_SECRET_HEADER]: SECRET };
const body = (over: Record<string, unknown> = {}) => ({ jobId: 'job1', url: 'https://site.example.com/', locationId: 'de', quick: false, runs: 1, ...over });

async function state(w: WorkerService, id: string): Promise<{ state: string; error?: string }> {
  return (await request(w.app).get(`/internal/jobs/${id}`).set(auth).expect(200)).body;
}
async function collected(w: WorkerService, id: string): Promise<void> {
  const start = Date.now();
  while ((await state(w, id)).state === 'running') {
    if (Date.now() - start > 10_000) throw new Error('timed out waiting for the job to settle');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('worker config', () => {
  it('refuses to start without WORKER_SECRET', () => {
    expect(() => loadWorkerConfig({})).toThrow(/WORKER_SECRET/);
  });
  it('binds fly-local-6pn on Fly and :: elsewhere; WORKER_BIND wins', () => {
    expect(loadWorkerConfig({ WORKER_SECRET: 's', FLY_APP_NAME: 'x' }).bind).toBe('fly-local-6pn');
    expect(loadWorkerConfig({ WORKER_SECRET: 's' }).bind).toBe('::');
    expect(loadWorkerConfig({ WORKER_SECRET: 's', FLY_APP_NAME: 'x', WORKER_BIND: '127.0.0.1' }).bind).toBe('127.0.0.1');
  });
});

describe('worker auth', () => {
  it('401 without the header, with a wrong one, and on unknown paths', async () => {
    const { w } = startWorker();
    await request(w.app).get('/internal/health').expect(401);
    await request(w.app).get('/internal/health').set(WORKER_SECRET_HEADER, 'nope').expect(401);
    await request(w.app).get('/internal/health').set(WORKER_SECRET_HEADER, SECRET + 'x').expect(401);
    await request(w.app).get('/api/jobs').expect(401);
    await request(w.app).get('/api/jobs').set(auth).expect(404);
  });
  it('health returns ok and the version', async () => {
    const { w, config } = startWorker();
    const res = await request(w.app).get('/internal/health').set(auth).expect(200);
    expect(res.body).toEqual({ ok: true, version: config.version });
  });
});

describe('worker collect', () => {
  it('runs → collected, passes the right argv, serves events from an offset and the run tar', async () => {
    const { w, config } = startWorker();
    const res = await request(w.app).post('/internal/collect').set(auth).send(body({ quick: true, runs: 3 })).expect(202);
    expect(res.body).toMatchObject({ jobId: 'job1', state: 'running' });
    await collected(w, 'job1');
    expect(await state(w, 'job1')).toEqual({ state: 'collected' });

    const argv = JSON.parse(fs.readFileSync(path.join(config.tmpDir, 'job1', 'argv.json'), 'utf8')) as string[];
    const dir = path.join(config.tmpDir, 'job1');
    expect(argv).toEqual(expect.arrayContaining(['consent', '--collect-only', '--url', 'https://site.example.com/', '--locations', 'de', '--cwd', dir, '--events', path.join(dir, 'events.ndjson'), '--quick', '--runs', '3']));

    const all = (await request(w.app).get('/internal/jobs/job1/events').set(auth).expect(200)).text.trim().split('\n');
    expect(all.map((l) => JSON.parse(l).type)).toEqual(['start', 'collected']);
    const rest = (await request(w.app).get('/internal/jobs/job1/events?from=1').set(auth).expect(200)).text.trim().split('\n');
    expect(rest.map((l) => JSON.parse(l).type)).toEqual(['collected']);
    expect((await request(w.app).get('/internal/jobs/job1/events?from=2').set(auth).expect(200)).text).toBe('');
    await request(w.app).get('/internal/jobs/job1/events?from=-1').set(auth).expect(400);

    const tar = (await request(w.app).get('/internal/jobs/job1/run.tar').set(auth).buffer(true).parse(binaryParser).expect(200)).body as Buffer;
    const out = tempDir();
    const tarFile = path.join(tempDir(), 'run.tar');
    fs.writeFileSync(tarFile, tar);
    execFileSync('tar', ['-xf', tarFile, '-C', out]);
    expect(JSON.parse(fs.readFileSync(path.join(out, 'collection.json'), 'utf8'))).toEqual({ location: 'de' });
    expect(fs.readFileSync(path.join(out, 'evidence', 'a.txt'), 'utf8')).toBe('evidence');
  });

  it('409 busy while one runs; a second job is accepted once it finishes', async () => {
    const { w } = startWorker();
    await request(w.app).post('/internal/collect').set(auth).send(body({ url: 'https://slow.example.com/' })).expect(202);
    await request(w.app).post('/internal/collect').set(auth).send(body({ jobId: 'job2' })).expect(409);
    await request(w.app).post('/internal/collect').set(auth).send(body({ url: 'https://slow.example.com/' })).expect(409); // same id
    expect(w.isBusy()).toBe(true);
    await request(w.app).post('/internal/jobs/job1/cancel').set(auth).expect(200);
    expect(w.isBusy()).toBe(false);
    await request(w.app).post('/internal/collect').set(auth).send(body({ jobId: 'job2' })).expect(202);
    await collected(w, 'job2');
  });

  it('run.tar before collected is 409', async () => {
    const { w } = startWorker();
    await request(w.app).post('/internal/collect').set(auth).send(body({ url: 'https://slow.example.com/' })).expect(202);
    await request(w.app).get('/internal/jobs/job1/run.tar').set(auth).expect(409);
  });

  it('a failing CLI is failed with its stderr; a run with no collection.json is failed', async () => {
    const { w } = startWorker();
    await request(w.app).post('/internal/collect').set(auth).send(body({ url: 'https://fail.example.com/' })).expect(202);
    await collected(w, 'job1');
    const failed = await state(w, 'job1');
    expect(failed.state).toBe('failed');
    expect(failed.error).toMatch(/code 1/);
    expect(failed.error).toMatch(/boom: navigation failed/);
    await request(w.app).get('/internal/jobs/job1/run.tar').set(auth).expect(409);

    await request(w.app).post('/internal/collect').set(auth).send(body({ jobId: 'job2', url: 'https://empty.example.com/' })).expect(202);
    await collected(w, 'job2');
    expect(await state(w, 'job2')).toMatchObject({ state: 'failed', error: expect.stringMatching(/collection\.json/) });
  });

  it('fails when the CLI is missing', async () => {
    const { w } = startWorker({ cliPath: path.join(tempDir(), 'nope.js') });
    await request(w.app).post('/internal/collect').set(auth).send(body()).expect(202);
    expect(await state(w, 'job1')).toMatchObject({ state: 'failed', error: expect.stringMatching(/not found/) });
  });

  it('cancel kills the process and marks the job failed: cancelled', async () => {
    const { w } = startWorker();
    await request(w.app).post('/internal/collect').set(auth).send(body({ url: 'https://slow.example.com/' })).expect(202);
    const res = await request(w.app).post('/internal/jobs/job1/cancel').set(auth).expect(200);
    expect(res.body).toEqual({ state: 'failed', error: 'cancelled' });
    await request(w.app).post('/internal/jobs/nojob/cancel').set(auth).expect(404);
  });

  it('delete removes the job and its directory (and stops a running one)', async () => {
    const { w, config } = startWorker();
    await request(w.app).post('/internal/collect').set(auth).send(body()).expect(202);
    await collected(w, 'job1');
    expect(fs.existsSync(path.join(config.tmpDir, 'job1'))).toBe(true);
    await request(w.app).delete('/internal/jobs/job1').set(auth).expect(204);
    expect(fs.existsSync(path.join(config.tmpDir, 'job1'))).toBe(false);
    await request(w.app).get('/internal/jobs/job1').set(auth).expect(404);

    await request(w.app).post('/internal/collect').set(auth).send(body({ url: 'https://slow.example.com/' })).expect(202);
    await request(w.app).delete('/internal/jobs/job1').set(auth).expect(204);
    expect(w.isBusy()).toBe(false);
  });

  it('rejects bad bodies with 400', async () => {
    const { w } = startWorker();
    const bad: Record<string, unknown>[] = [
      body({ jobId: undefined }),
      body({ jobId: 'a'.repeat(65) }),
      body({ url: 'ftp://site.example.com/' }),
      body({ url: 'not a url' }),
      body({ url: undefined }),
      body({ locationId: 'germany' }),
      body({ locationId: 'US' }),
      body({ locationId: 'us-cal' }),
      body({ runs: 0 }),
      body({ runs: 6 }),
      body({ runs: 1.5 }),
      body({ runs: '2' }),
      body({ quick: 'yes' }),
    ];
    for (const b of bad) await request(w.app).post('/internal/collect').set(auth).send(b).expect(400);
    await request(w.app).post('/internal/collect').set(auth).send([]).expect(400);
    for (const id of ['de', 'us-ca', 'local', 'us-ny']) {
      await request(w.app).post('/internal/collect').set(auth).send(body({ jobId: id, locationId: id, url: 'https://slow.example.com/' })).expect(202);
      await request(w.app).delete(`/internal/jobs/${id}`).set(auth).expect(204);
    }
  });

  it('rejects path traversal in jobId everywhere it is used', async () => {
    const { w, config } = startWorker();
    await request(w.app).post('/internal/collect').set(auth).send(body({ jobId: '../escape' })).expect(400);
    await request(w.app).post('/internal/collect').set(auth).send(body({ jobId: 'a/b' })).expect(400);
    await request(w.app).get('/internal/jobs/..%2Fescape').set(auth).expect(400);
    await request(w.app).get('/internal/jobs/..%2Fescape/events').set(auth).expect(400);
    await request(w.app).get('/internal/jobs/a%2Eb/run.tar').set(auth).expect(400);
    await request(w.app).post('/internal/jobs/..%2Fescape/cancel').set(auth).expect(400);
    await request(w.app).delete('/internal/jobs/..%2Fescape').set(auth).expect(400);
    expect(fs.existsSync(path.join(config.tmpDir, '..', 'escape'))).toBe(false);
  });

  it('is idle-shutdown eligible only when no collection is running', async () => {
    const { w } = startWorker();
    const old = Date.now() - 10 * 60_000;
    expect(idleReason({ idleMinutes: 3, busy: w.isBusy(), lastActivity: old })).toMatch(/idle for 10 min/);
    await request(w.app).post('/internal/collect').set(auth).send(body({ url: 'https://slow.example.com/' })).expect(202);
    expect(idleReason({ idleMinutes: 3, busy: w.isBusy(), lastActivity: old })).toBeNull();
    // Health checks don't count as activity; real requests do.
    const before = w.lastActivity();
    await new Promise((r) => setTimeout(r, 10));
    await request(w.app).get('/internal/health').set(auth).expect(200);
    expect(w.lastActivity()).toBe(before);
    await request(w.app).get('/internal/jobs/job1').set(auth).expect(200);
    expect(w.lastActivity()).toBeGreaterThan(before);
  });
});
