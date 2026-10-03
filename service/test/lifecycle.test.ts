import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { ConsentProgress, NdjsonTail } from '../src/server/events.js';
import { idleReason, sweepRetention } from '../src/server/lifecycle.js';
import { JobStore } from '../src/server/store.js';
import type { CreateBatchResponse, JobDetail, JobsResponse } from '../src/shared/api.js';
import { startService, stopAll, tempDir, waitFor, waitForStatus } from './helpers.js';

afterEach(stopAll);

describe('restart recovery', () => {
  it('reloads jobs from disk: running → failed, queued → re-run, done stays done', async () => {
    const dataDir = tempDir();
    const a = await startService({ dataDir, concurrency: 1 });
    const res = await request(a.app).post('/api/batches').send({ urls: 'site.example.com slow.example.com later.example.com' }).expect(201);
    const [doneId, runningId, queuedId] = (res.body as CreateBatchResponse).jobs.map((j) => j.id);
    await waitForStatus(a, doneId, ['done']);
    await waitForStatus(a, runningId, ['running']);
    await a.store.flush();

    // Simulate a crash: copy the on-disk state before the graceful stop
    // rewrites it, then restore it for the second instance.
    const snapshot = fs.readFileSync(path.join(a.store.jobDir(runningId), 'job.json'));
    await a.stop(200);
    fs.writeFileSync(path.join(a.store.jobDir(runningId), 'job.json'), snapshot);
    expect(JSON.parse(snapshot.toString()).status).toBe('running');

    const b = await startService({ dataDir, concurrency: 1 });
    const list = (await request(b.app).get('/api/jobs').expect(200)).body as JobsResponse;
    expect(list.jobs.map((j) => j.id)).toEqual(expect.arrayContaining([doneId, runningId, queuedId]));
    expect(b.store.get(doneId)?.status).toBe('done');
    expect(b.store.get(runningId)).toMatchObject({ status: 'failed', error: 'interrupted by a restart' });
    const requeued = await waitForStatus(b, queuedId, ['done']);
    expect(requeued.progress.fraction).toBe(1);
  });

  it('graceful stop marks running jobs "server stopped" and leaves queued ones queued', async () => {
    const s = await startService({ concurrency: 1 });
    const res = await request(s.app).post('/api/batches').send({ urls: 'slow.example.com later.example.com' }).expect(201);
    const [runningId, queuedId] = (res.body as CreateBatchResponse).jobs.map((j) => j.id);
    await waitForStatus(s, runningId, ['running']);
    await s.stop(200);
    const onDisk = (id: string) => JSON.parse(fs.readFileSync(path.join(s.store.jobDir(id), 'job.json'), 'utf8')) as JobDetail;
    expect(onDisk(runningId)).toMatchObject({ status: 'failed', error: 'server stopped' });
    expect(onDisk(queuedId).status).toBe('queued');
  });
});

describe('retention', () => {
  it('deletes finished jobs older than RETENTION_DAYS and orphan dirs', async () => {
    const dataDir = tempDir();
    const store = new JobStore(dataDir);
    await store.load();
    const old = store.create({ batchId: 'b', url: 'https://old.example.com/', checks: ['consent'], quick: false });
    old.status = 'done';
    old.createdAt = new Date(Date.now() - 20 * 86_400_000).toISOString();
    const fresh = store.create({ batchId: 'b', url: 'https://new.example.com/', checks: ['consent'], quick: false });
    fresh.status = 'done';
    const orphan = path.join(store.jobsDir, 'orphan123');
    fs.mkdirSync(orphan);
    const past = new Date(Date.now() - 30 * 86_400_000);
    fs.utimesSync(orphan, past, past);
    await store.flush();

    expect(await sweepRetention(store, 14)).toBe(2);
    expect(store.get(old.id)).toBeUndefined();
    expect(fs.existsSync(store.jobDir(old.id))).toBe(false);
    expect(store.get(fresh.id)).toBeDefined();
    expect(fs.existsSync(orphan)).toBe(false);
  });
});

describe('idle rule', () => {
  const now = 1_000_000_000;
  it('only fires when enabled, idle long enough, and no jobs', () => {
    expect(idleReason({ idleMinutes: 0, busy: false, lastActivity: 0, now })).toBeNull();
    expect(idleReason({ idleMinutes: 15, busy: true, lastActivity: 0, now })).toBeNull();
    expect(idleReason({ idleMinutes: 15, busy: false, lastActivity: now - 14 * 60_000, now })).toBeNull();
    expect(idleReason({ idleMinutes: 15, busy: false, lastActivity: now - 16 * 60_000, now })).toMatch(/idle for 16 min/);
  });

  it('health checks do not count as activity; other requests do', async () => {
    const s = await startService();
    const before = s.lastActivity();
    await new Promise((r) => setTimeout(r, 15));
    await request(s.app).get('/api/health').expect(200);
    expect(s.lastActivity()).toBe(before);
    await request(s.app).get('/api/jobs').expect(200);
    expect(s.lastActivity()).toBeGreaterThan(before);
  });
});

describe('NdjsonTail', () => {
  it('handles partial lines and junk, delivering each event once', async () => {
    const file = path.join(tempDir(), 'events.ndjson');
    const got: string[] = [];
    const tail = new NdjsonTail(file, (ev) => got.push(ev.type), 10);
    tail.start();
    await new Promise((r) => setTimeout(r, 30)); // file doesn't exist yet: fine
    fs.appendFileSync(file, '{"type":"start","runId":"r","url":"u","locations":["local"]}\n{"type":"loc');
    await waitFor(() => got.length === 1, 2000);
    fs.appendFileSync(file, 'ation","location":"local","verdict":"verified","scenarios":[]}\nnot json\n');
    await waitFor(() => got.length === 2, 2000);
    fs.appendFileSync(file, '{"type":"done","runId":"r"}'); // no trailing newline
    await tail.stop();
    expect(got).toEqual(['start', 'location', 'done']);
  });
});

describe('ConsentProgress', () => {
  it('maps a real-shaped event sequence (two locations) into progress', () => {
    const job = {
      id: 'job1abc',
      progress: { fraction: 0, done: 0, total: 0, phase: 'verifying-location' },
      metrics: { requests: 0, thirdPartyRequests: 0, parties: 0, cookies: 0, scenarios: [] },
    } as unknown as JobDetail;
    const m = new ConsentProgress(job, 1);
    const at = '2026-10-03T00:00:00Z';
    m.apply({ at, type: 'start', runId: 'r1', url: 'https://x.com/', locations: ['local', 'eu'] });
    expect(job.progress.phase).toBe('verifying-location');
    m.apply({ at, type: 'location', location: 'local', verdict: 'verified', scenarios: ['a', 'b'] });
    expect(job.progress).toMatchObject({ total: 3, phase: 'scenarios' });
    m.apply({ at, type: 'location', location: 'eu', verdict: 'unverified', scenarios: [], note: 'no proxy' });
    m.apply({ at, type: 'scenario-start', location: 'local', scenario: 'a' });
    expect(job.progress.current).toBe('local · a');
    m.apply({ at, type: 'scenario-done', location: 'local', scenario: 'a', status: 'tested', requests: 5, thirdPartyRequests: 1, parties: 3, cookies: 1, durationMs: 9 });
    expect(job.progress.fraction).toBeCloseTo(1 / 3);
    m.apply({ at, type: 'scenario-start', location: 'local', scenario: 'b' });
    m.apply({ at, type: 'scenario-done', location: 'local', scenario: 'b', status: 'tested', requests: 7, thirdPartyRequests: 2, parties: 2, cookies: 5, durationMs: 9, banner: 'cookiebot' });
    expect(job.progress).toMatchObject({ done: 2, total: 3, phase: 'analyzing' });
    expect(job.metrics).toMatchObject({ requests: 12, thirdPartyRequests: 3, parties: 3, cookies: 5, banner: 'cookiebot', location: { id: 'eu', verdict: 'unverified' } });
  });
});
