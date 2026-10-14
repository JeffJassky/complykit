import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PEER_HEADER, WORKER_SECRET_HEADER } from '../src/server/worker-protocol.js';
import { createWorkerApp, loadWorkerConfig, type WorkerConfig, type WorkerService } from '../src/server/worker.js';
import { tempDir } from './helpers.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-worker-cli-regional.mjs');
const SECRET = 'test-secret';
const auth = { [WORKER_SECRET_HEADER]: SECRET };

interface Seen { method: string; path: string; peer?: string; secret?: string }
interface Started { w: WorkerService; config: WorkerConfig; url: string; seen: Seen[]; blobDir: string }

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(cleanups.splice(0).map((f) => f()));
});

/** An in-process worker on a real port (so peers can fetch from it), writing to `blobDir`. */
async function startWorker(opts: { blobDir?: string; noBlobs?: boolean; over?: Partial<WorkerConfig> } = {}): Promise<Started> {
  const blobDir = opts.blobDir ?? tempDir();
  const config: WorkerConfig = {
    ...loadWorkerConfig({ WORKER_SECRET: SECRET, WORKER_BLOB_DIR: blobDir }),
    tmpDir: tempDir(),
    cliPath: CLI,
    killGraceMs: 300,
    ...(opts.noBlobs ? { blobs: undefined } : {}),
    ...opts.over,
  };
  const w = createWorkerApp(config);
  const seen: Seen[] = [];
  const outer = express();
  outer.use((req, _res, next) => {
    seen.push({ method: req.method, path: req.path, peer: req.get(PEER_HEADER) ?? undefined, secret: req.get(WORKER_SECRET_HEADER) ?? undefined });
    next();
  });
  outer.use(w.app);
  const server = outer.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  cleanups.push(async () => {
    await w.stop(200);
    await new Promise((r) => server.close(() => r(undefined)));
  });
  return { w, config, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, blobDir };
}

async function settled(w: Started, id: string): Promise<{ state: string; error?: string }> {
  const start = Date.now();
  for (;;) {
    const s = (await request(w.w.app).get(`/internal/jobs/${id}`).set(auth).expect(200)).body as { state: string; error?: string };
    if (s.state !== 'running') return s;
    if (Date.now() - start > 10_000) throw new Error('timed out waiting for the job to settle');
    await new Promise((r) => setTimeout(r, 20));
  }
}
const post = (w: Started, route: string, body: unknown) => request(w.w.app).post(route).set(auth).send(body as object);

async function collect(w: Started, jobId: string, locationId: string): Promise<string> {
  await post(w, '/internal/collect', { jobId, url: 'https://site.example.com/', locationId, quick: false, runs: 1 }).expect(202);
  expect(await settled(w, jobId)).toEqual({ state: 'collected' });
  return `${w.url}/internal/jobs/${jobId}/run.tar`;
}

const keysUnder = (dir: string): string[] => (fs.existsSync(dir) ? (fs.readdirSync(dir, { recursive: true }) as string[]).map((p) => p.split(path.sep).join('/')) : []);
const readJson = <T,>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8')) as T;
const mergeBody = (sources: Array<{ law: string; locationId: string; tarUrl: string }>, over: Record<string, unknown> = {}) => ({
  jobId: 'j1-merge',
  url: 'https://site.example.com/',
  sources,
  failed: [],
  publish: { prefix: 'jobs/j1/consent/' },
  ...over,
});

describe('POST /internal/merge', () => {
  it('pulls the peers\' tars (x-complykit-peer: merge), merges, publishes the run, never uploads gather/', async () => {
    const blobDir = tempDir();
    const a = await startWorker({ blobDir });
    const b = await startWorker({ blobDir });
    const m = await startWorker({ blobDir });
    const tarA = await collect(a, 'j1-ca', 'us-ca');
    const tarB = await collect(b, 'j1-eu', 'de');

    // The previous run of the site, as the host's blob store holds it (evaluation + evidence).
    const prevKey = 'jobs/old/consent/.comply/runs/2026-10-01T10-00-00.000Z/';
    fs.mkdirSync(path.join(blobDir, prevKey, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(blobDir, prevKey, 'tracking.json'), '{}');
    fs.writeFileSync(path.join(blobDir, prevKey, 'evidence', 'big.har'), 'x');

    const workspace = { version: 1, domain: 'example.com', entries: {}, runs: [] };
    const res = await post(m, '/internal/merge', mergeBody(
      [{ law: 'ca', locationId: 'us-ca', tarUrl: tarA }, { law: 'eu', locationId: 'de', tarUrl: tarB }],
      { failed: [{ locationId: 'uk', error: 'worker in lhr failed: no capacity' }], workspace, previous: prevKey },
    )).expect(202);
    expect(res.body).toEqual({ jobId: 'j1-merge', state: 'running' });
    expect(await settled(m, 'j1-merge')).toEqual({ state: 'done' });

    // Peers saw the merge header and the secret on their run.tar GETs.
    for (const peer of [a, b]) {
      const tars = peer.seen.filter((r) => r.path.endsWith('/run.tar'));
      expect(tars).toHaveLength(1);
      expect(tars[0]).toMatchObject({ method: 'GET', peer: 'merge', secret: SECRET });
    }

    // The CLI invocation, in the host's argument order.
    const dir = path.join(m.config.tmpDir, 'j1-merge');
    const argv = readJson<string[]>(path.join(dir, 'merge-argv.json'));
    expect(argv).toEqual([
      'consent', '--merge', `${path.join(dir, 'gather', 'ca')},${path.join(dir, 'gather', 'eu')}`,
      '--url', 'https://site.example.com/', '--cwd', dir, '--events', path.join(dir, 'events.ndjson'), '--quiet',
      '--failed', 'uk=worker in lhr failed: no capacity',
      '--workspace', path.join(dir, 'workspace.json'),
      '--previous', path.join(dir, 'previous', '2026-10-01T10-00-00.000Z'),
    ]);
    expect(readJson(path.join(dir, 'workspace.json'))).toEqual(workspace);
    expect(fs.existsSync(path.join(dir, 'previous', '2026-10-01T10-00-00.000Z', 'tracking.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'previous', '2026-10-01T10-00-00.000Z', 'evidence'))).toBe(false); // evidence is not fetched
    expect(fs.existsSync(path.join(dir, 'gather'))).toBe(false);

    // Published: the run, not the raw collections or scratch.
    const keys = keysUnder(path.join(blobDir, 'jobs', 'j1', 'consent'));
    const run = keys.find((k) => /^\.comply\/runs\/[^/]+\/owner-report\.json$/.test(k))!.replace(/owner-report\.json$/, '');
    expect(run).toBeTruthy();
    for (const f of ['owner-report.json', 'consent-report.html', 'tracking.json', 'evidence/note.txt']) expect(keys).toContain(run + f);
    const html = fs.readFileSync(path.join(blobDir, 'jobs', 'j1', 'consent', run, 'consent-report.html'), 'utf8');
    expect(html).toContain('Merged');
    expect(html).toContain('us-ca');
    expect(html).toContain('de');
    expect(keys.some((k) => /gather|live\/|previous\/|events\.ndjson|workspace\.json/.test(k))).toBe(false);
    expect(keys.some((k) => k.endsWith('collection.json'))).toBe(false);
    expect(keysUnder(blobDir).some((k) => k.includes('gather/'))).toBe(false);

    // Events: start and done, as the host parses them.
    const events = (await request(m.w.app).get('/internal/jobs/j1-merge/events').set(auth).expect(200)).text.trim().split('\n').map((l) => JSON.parse(l) as { type: string });
    expect(events.map((e) => e.type)).toEqual(['start', 'done']);
    expect(m.w.isBusy()).toBe(false);
  });

  it('a failing merge is failed with the stderr tail; gather/ is deleted and nothing is published', async () => {
    const blobDir = tempDir();
    const a = await startWorker({ blobDir });
    const m = await startWorker({ blobDir });
    const tarA = await collect(a, 'j1-ca', 'us-ca');
    await post(m, '/internal/merge', mergeBody([{ law: 'ca', locationId: 'us-ca', tarUrl: tarA }], { url: 'https://fail.example.com/' })).expect(202);
    const s = await settled(m, 'j1-merge');
    expect(s.state).toBe('failed');
    expect(s.error).toMatch(/consent merge exited with code 1/);
    expect(s.error).toMatch(/boom: merge failed/);
    expect(fs.existsSync(path.join(m.config.tmpDir, 'j1-merge', 'gather'))).toBe(false);
    expect(keysUnder(path.join(blobDir, 'jobs', 'j1'))).toEqual([]);
  });

  it('a peer that cannot be fetched fails the merge, and gather/ is gone', async () => {
    const blobDir = tempDir();
    const a = await startWorker({ blobDir });
    const m = await startWorker({ blobDir });
    // A collect that failed: its run.tar answers 409.
    await post(a, '/internal/collect', { jobId: 'j1-ca', url: 'https://fail.example.com/', locationId: 'us-ca', quick: false, runs: 1 }).expect(202);
    await settled(a, 'j1-ca');
    await post(m, '/internal/merge', mergeBody([{ law: 'ca', locationId: 'us-ca', tarUrl: `${a.url}/internal/jobs/j1-ca/run.tar` }])).expect(202);
    const s = await settled(m, 'j1-merge');
    expect(s).toMatchObject({ state: 'failed', error: expect.stringMatching(/could not fetch the ca collection: HTTP 409/) });
    expect(fs.existsSync(path.join(m.config.tmpDir, 'j1-merge', 'gather'))).toBe(false);
    expect(keysUnder(path.join(blobDir, 'jobs', 'j1'))).toEqual([]);
  });

  it('cancel during the merge kills it, deletes gather/ and publishes nothing', async () => {
    const blobDir = tempDir();
    const a = await startWorker({ blobDir });
    const m = await startWorker({ blobDir });
    const tarA = await collect(a, 'j1-ca', 'us-ca');
    await post(m, '/internal/merge', mergeBody([{ law: 'ca', locationId: 'us-ca', tarUrl: tarA }], { url: 'https://slow.example.com/' })).expect(202);
    // Wait until the CLI is running (it has written its start event).
    const events = path.join(m.config.tmpDir, 'j1-merge', 'events.ndjson');
    for (let i = 0; i < 200 && !fs.existsSync(events); i++) await new Promise((r) => setTimeout(r, 20));
    expect(fs.existsSync(path.join(m.config.tmpDir, 'j1-merge', 'gather', 'ca', 'collection.json'))).toBe(true);
    const res = await request(m.w.app).post('/internal/jobs/j1-merge/cancel').set(auth).expect(200);
    expect(res.body).toEqual({ state: 'failed', error: 'cancelled' });
    expect(fs.existsSync(path.join(m.config.tmpDir, 'j1-merge', 'gather'))).toBe(false);
    expect(keysUnder(path.join(blobDir, 'jobs', 'j1'))).toEqual([]);
    expect(m.w.isBusy()).toBe(false);
  });

  it('is only a worker-to-worker pull for collect jobs: a merge job has no run.tar', async () => {
    const blobDir = tempDir();
    const a = await startWorker({ blobDir });
    const m = await startWorker({ blobDir });
    const tarA = await collect(a, 'j1-ca', 'us-ca');
    await post(m, '/internal/merge', mergeBody([{ law: 'ca', locationId: 'us-ca', tarUrl: tarA }])).expect(202);
    await settled(m, 'j1-merge');
    await request(m.w.app).get('/internal/jobs/j1-merge/run.tar').set(auth).expect(409);
  });
});

describe('merge: peers that cannot be fetched', () => {
  it('one unreachable peer becomes a --failed law and the merge still finishes; the rest are merged', async () => {
    const blobDir = tempDir();
    const a = await startWorker({ blobDir });
    const gone = await startWorker({ blobDir }); // never collected: its run.tar answers 404
    const m = await startWorker({ blobDir });
    const tarA = await collect(a, 'j1-ca', 'us-ca');
    await post(m, '/internal/merge', mergeBody([
      { law: 'eu', locationId: 'de', tarUrl: `${gone.url}/internal/jobs/j1-eu/run.tar` },
      { law: 'ca', locationId: 'us-ca', tarUrl: tarA },
    ])).expect(202);
    expect(await settled(m, 'j1-merge')).toEqual({ state: 'done' });
    const argv = readJson<string[]>(path.join(blobDir, 'jobs', 'j1', 'consent', 'merge-argv.json'));
    const merged = argv[argv.indexOf('--merge') + 1].split(',');
    expect(merged).toEqual([path.join(m.config.tmpDir, 'j1-merge', 'gather', 'ca')]);
    expect(argv).toContain('--failed');
    expect(argv[argv.indexOf('--failed') + 1]).toMatch(/^de=could not fetch the eu collection: HTTP 404$/);
  });

  it('a redirect from a peer is never followed (the secret header must not travel)', async () => {
    const blobDir = tempDir();
    const hits: string[] = [];
    const target = express().use((req, res) => (hits.push(req.path), void res.status(200).send('x')));
    const targetServer = target.listen(0, '127.0.0.1');
    await new Promise((r) => targetServer.once('listening', r));
    const hop = express().use((_req, res) => void res.redirect(302, `http://127.0.0.1:${(targetServer.address() as AddressInfo).port}/stolen`));
    const hopServer = hop.listen(0, '127.0.0.1');
    await new Promise((r) => hopServer.once('listening', r));
    cleanups.push(async () => {
      await new Promise((r) => hopServer.close(() => r(undefined)));
      await new Promise((r) => targetServer.close(() => r(undefined)));
    });
    const m = await startWorker({ blobDir });
    await post(m, '/internal/merge', mergeBody([{ law: 'ca', locationId: 'us-ca', tarUrl: `http://127.0.0.1:${(hopServer.address() as AddressInfo).port}/internal/jobs/x/run.tar` }])).expect(202);
    const s = await settled(m, 'j1-merge');
    expect(s.state).toBe('failed');
    expect(s.error).toMatch(/could not fetch the ca collection/);
    expect(hits).toEqual([]);
  });
});

describe('POST /internal/consent', () => {
  it('runs the single-location consent invocation and publishes the run', async () => {
    const w = await startWorker();
    const workspace = { version: 1, domain: 'example.com', entries: {}, runs: [] };
    const res = await post(w, '/internal/consent', { jobId: 'j2', url: 'https://site.example.com/', quick: true, runs: 3, workspace, publish: { prefix: 'jobs/j2/consent/' } }).expect(202);
    expect(res.body).toEqual({ jobId: 'j2', state: 'running' });
    expect(await settled(w, 'j2')).toEqual({ state: 'done' });
    const dir = path.join(w.config.tmpDir, 'j2');
    expect(readJson<string[]>(path.join(dir, 'consent-argv.json'))).toEqual([
      'consent', '--url', 'https://site.example.com/', '--cwd', dir, '--events', path.join(dir, 'events.ndjson'), '--quiet', '--runs', '3', '--quick', '--workspace', path.join(dir, 'workspace.json'),
    ]);
    const keys = keysUnder(path.join(w.blobDir, 'jobs', 'j2', 'consent'));
    expect(keys.some((k) => /^\.comply\/runs\/[^/]+\/owner-report\.json$/.test(k))).toBe(true);
    expect(keys.some((k) => /consent-report\.html$/.test(k))).toBe(true);
    expect(keys).not.toContain('events.ndjson');
    expect(keys).not.toContain('workspace.json');
    const events = (await request(w.w.app).get('/internal/jobs/j2/events').set(auth)).text.trim().split('\n').map((l) => JSON.parse(l) as { type: string });
    expect(events.at(-1)!.type).toBe('done');
  });

  it('without a workspace passes no --workspace; a failing scan is failed with its stderr', async () => {
    const w = await startWorker();
    await post(w, '/internal/consent', { jobId: 'j2', url: 'https://site.example.com/', quick: false, runs: 1, publish: { prefix: 'jobs/j2/consent/' } }).expect(202);
    await settled(w, 'j2');
    expect(readJson<string[]>(path.join(w.config.tmpDir, 'j2', 'consent-argv.json'))).not.toContain('--workspace');
    await post(w, '/internal/consent', { jobId: 'j3', url: 'https://fail.example.com/', quick: false, runs: 1, publish: { prefix: 'jobs/j3/consent/' } }).expect(202);
    expect(await settled(w, 'j3')).toMatchObject({ state: 'failed', error: expect.stringMatching(/boom/) });
    expect(keysUnder(path.join(w.blobDir, 'jobs', 'j3'))).toEqual([]);
  });
});

describe('POST /internal/accessibility', () => {
  it('scans, reports into the job dir and publishes it', async () => {
    const w = await startWorker();
    await post(w, '/internal/accessibility', { jobId: 'j4', url: 'https://site.example.com/', publish: { prefix: 'jobs/j4/accessibility/' } }).expect(202);
    expect(await settled(w, 'j4')).toEqual({ state: 'done' });
    const keys = keysUnder(path.join(w.blobDir, 'jobs', 'j4', 'accessibility'));
    expect(keys).toContain('report.html');
    expect(keys).toContain('report.json');
    expect(keys.some((k) => /^\.comply\/runs\/[^/]+\/findings\.jsonl$/.test(k))).toBe(true);
    expect(readJson<{ run: { id: string } }>(path.join(w.blobDir, 'jobs', 'j4', 'accessibility', 'report.json')).run.id).toBe('a11y-1');
    expect(fs.readFileSync(path.join(w.blobDir, 'jobs', 'j4', 'accessibility', 'report.html'), 'utf8')).toContain('Accessibility');
  });

  it('a failing scan is failed and publishes nothing', async () => {
    const w = await startWorker();
    await post(w, '/internal/accessibility', { jobId: 'j4', url: 'https://fail.example.com/', publish: { prefix: 'jobs/j4/accessibility/' } }).expect(202);
    expect(await settled(w, 'j4')).toMatchObject({ state: 'failed', error: expect.stringMatching(/accessibility scan exited with code 1/) });
    expect(keysUnder(path.join(w.blobDir, 'jobs', 'j4'))).toEqual([]);
  });
});

describe('POST /internal/verify', () => {
  const task = { id: 'install', verify: { check: 'install', method: 'static' } };

  it('answers 200 with the CLI outcome; the task file is gone afterwards', async () => {
    const w = await startWorker();
    const res = await post(w, '/internal/verify', { task, site: 'example.com' }).expect(200);
    expect(res.body).toMatchObject({ result: 'pass', message: 'ok', evidence: [], check: 'install', site: 'example.com' });
    expect(typeof res.body.at).toBe('string');
    expect(fs.existsSync(res.body.taskFile)).toBe(false);
    expect(w.w.isBusy()).toBe(false);
  });

  it('exit 2 → 400 with the message; another failure → 500', async () => {
    const w = await startWorker();
    const bad = await post(w, '/internal/verify', { task, site: 'bad.example.com' }).expect(400);
    expect(bad.body.error).toMatch(/no verify\.check/);
    const boom = await post(w, '/internal/verify', { task, site: 'fail.example.com' }).expect(500);
    expect(boom.body.error).toMatch(/exited with code 1/);
    expect(boom.body.error).toMatch(/verify crashed/);
  });

  it('is busy while it runs (409 for everything else), and gives up at its time budget', async () => {
    const w = await startWorker({ over: { verifyTimeoutMs: 600 } });
    const pending = post(w, '/internal/verify', { task, site: 'slow.example.com' }).then((r) => r);
    for (let i = 0; i < 100 && !w.w.isBusy(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(w.w.isBusy()).toBe(true);
    await post(w, '/internal/verify', { task, site: 'example.com' }).expect(409);
    await post(w, '/internal/collect', { jobId: 'c1', url: 'https://site.example.com/', locationId: 'de', quick: false, runs: 1 }).expect(409);
    await post(w, '/internal/accessibility', { jobId: 'a1', url: 'https://site.example.com/', publish: { prefix: 'jobs/a1/accessibility/' } }).expect(409);
    const res = await pending;
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/timed out/);
    expect(w.w.isBusy()).toBe(false);
  });
});

describe('busy and idle', () => {
  it('a running job answers 409 to every other job-style route; cancel frees the worker', async () => {
    const w = await startWorker();
    await post(w, '/internal/consent', { jobId: 'j5', url: 'https://slow.example.com/', quick: false, runs: 1, publish: { prefix: 'jobs/j5/consent/' } }).expect(202);
    const src = [{ law: 'ca', locationId: 'us-ca', tarUrl: 'http://127.0.0.1:1/internal/jobs/x/run.tar' }];
    await post(w, '/internal/merge', mergeBody(src)).expect(409);
    await post(w, '/internal/consent', { jobId: 'j6', url: 'https://site.example.com/', quick: false, runs: 1, publish: { prefix: 'jobs/j6/consent/' } }).expect(409);
    await post(w, '/internal/verify', { task: {}, site: 'example.com' }).expect(409);
    await post(w, '/internal/consent', { jobId: 'j5', url: 'https://slow.example.com/', quick: false, runs: 1, publish: { prefix: 'jobs/j5/consent/' } }).expect(409);
    const res = await request(w.w.app).post('/internal/jobs/j5/cancel').set(auth).expect(200);
    expect(res.body).toEqual({ state: 'failed', error: 'cancelled' });
    await post(w, '/internal/consent', { jobId: 'j6', url: 'https://site.example.com/', quick: false, runs: 1, publish: { prefix: 'jobs/j6/consent/' } }).expect(202);
    expect(await settled(w, 'j6')).toEqual({ state: 'done' });
    // DELETE removes the finished job's directory.
    await request(w.w.app).delete('/internal/jobs/j6').set(auth).expect(204);
    expect(fs.existsSync(path.join(w.config.tmpDir, 'j6'))).toBe(false);
  });
});

describe('without a blob store', () => {
  it('merge, consent and accessibility answer 503; collect still works', async () => {
    const w = await startWorker({ noBlobs: true });
    const src = [{ law: 'ca', locationId: 'us-ca', tarUrl: 'http://127.0.0.1:1/internal/jobs/x/run.tar' }];
    for (const [route, body] of [
      ['/internal/merge', mergeBody(src)],
      ['/internal/consent', { jobId: 'j7', url: 'https://site.example.com/', quick: false, runs: 1, publish: { prefix: 'jobs/j7/consent/' } }],
      ['/internal/accessibility', { jobId: 'j7', url: 'https://site.example.com/', publish: { prefix: 'jobs/j7/accessibility/' } }],
    ] as const) {
      const res = await post(w, route, body).expect(503);
      expect(res.body.error).toMatch(/no blob store configured/);
    }
    await collect(w, 'c1', 'de');
  });
});

describe('kb', () => {
  const tar = 'http://127.0.0.1:1/internal/jobs/x/run.tar';
  const src = { law: 'ca', locationId: 'us-ca', tarUrl: tar };

  function seedKb(blobDir: string): void {
    fs.mkdirSync(path.join(blobDir, 'kb', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(blobDir, 'kb', 'entries.json'), '{}');
    fs.writeFileSync(path.join(blobDir, 'kb', 'sub', 'queue.json'), '[]');
  }

  it('merge downloads kb/ into the job and points COMPLYKIT_KB_DIR at it; the KB is not published', async () => {
    const blobDir = tempDir();
    seedKb(blobDir);
    const a = await startWorker({ blobDir });
    const m = await startWorker({ blobDir });
    const tarA = await collect(a, 'k1-ca', 'us-ca');
    await post(m, '/internal/merge', mergeBody([{ law: 'ca', locationId: 'us-ca', tarUrl: tarA }], { jobId: 'k1-merge', kb: 'kb/', publish: { prefix: 'jobs/k1/consent/' } })).expect(202);
    expect(await settled(m, 'k1-merge')).toEqual({ state: 'done' });
    const published = path.join(blobDir, 'jobs', 'k1', 'consent');
    const seen = readJson<{ dir: string; files: string[] }>(path.join(published, 'kb-seen.json'));
    expect(seen.dir).toBe(path.join(m.config.tmpDir, 'k1-merge', 'kb'));
    expect(seen.files).toEqual(['entries.json', 'sub', 'sub/queue.json']);
    expect(keysUnder(published).some((k) => k.startsWith('kb/'))).toBe(false);
  });

  it('consent does the same; without kb the env is left alone', async () => {
    const blobDir = tempDir();
    seedKb(blobDir);
    const w = await startWorker({ blobDir });
    const body = { jobId: 'k2', url: 'https://site.example.com/', quick: false, runs: 1, publish: { prefix: 'jobs/k2/consent/' } };
    await post(w, '/internal/consent', { ...body, kb: 'kb/' }).expect(202);
    expect(await settled(w, 'k2')).toEqual({ state: 'done' });
    expect(readJson<{ files: string[] }>(path.join(blobDir, 'jobs', 'k2', 'consent', 'kb-seen.json')).files).toEqual(['entries.json', 'sub', 'sub/queue.json']);
    await post(w, '/internal/consent', { ...body, jobId: 'k3', publish: { prefix: 'jobs/k3/consent/' } }).expect(202);
    expect(await settled(w, 'k3')).toEqual({ state: 'done' });
    expect(fs.existsSync(path.join(blobDir, 'jobs', 'k3', 'consent', 'kb-seen.json'))).toBe(false);
  });

  it('only the prefix kb/ is accepted', async () => {
    const w = await startWorker();
    for (const kb of ['kb', 'kb/x/', 'jobs/x/', '../kb/', '', 7, null]) {
      await post(w, '/internal/merge', mergeBody([src], { kb })).expect(400);
      await post(w, '/internal/consent', { jobId: 'k4', url: 'https://site.example.com/', quick: false, runs: 1, publish: { prefix: 'jobs/k4/consent/' }, kb }).expect(400);
    }
    expect(fs.readdirSync(w.config.tmpDir)).toEqual([]);
  });
});

describe('the CLI child\'s environment', () => {
  it('never sees the worker\'s secrets (Chromium renders arbitrary sites); it keeps what it needs', async () => {
    vi.stubEnv('SPACES_KEY', 'spaces-key-value');
    vi.stubEnv('SPACES_SECRET', 'spaces-secret-value');
    vi.stubEnv('FLY_API_TOKEN', 'fly-token-value');
    vi.stubEnv('COMPLYKIT_BROWSER_CHANNEL', 'chrome');
    const blobDir = tempDir();
    fs.mkdirSync(path.join(blobDir, 'kb'), { recursive: true });
    fs.writeFileSync(path.join(blobDir, 'kb', 'entries.json'), '{}');
    const w = await startWorker({ blobDir, over: { secret: 'worker-secret-value' } });
    const auth2 = { [WORKER_SECRET_HEADER]: 'worker-secret-value' };
    vi.stubEnv('WORKER_SECRET', 'worker-secret-value');
    await request(w.w.app).post('/internal/consent').set(auth2).send({ jobId: 'e1', url: 'https://site.example.com/', quick: false, runs: 1, kb: 'kb/', publish: { prefix: 'jobs/e1/consent/' } }).expect(202);
    for (let i = 0; i < 200 && (await request(w.w.app).get('/internal/jobs/e1').set(auth2)).body.state === 'running'; i++) await new Promise((r) => setTimeout(r, 20));
    const names = readJson<string[]>(path.join(blobDir, 'jobs', 'e1', 'consent', 'env-seen.json'));
    for (const secret of ['WORKER_SECRET', 'SPACES_KEY', 'SPACES_SECRET', 'SPACES_ENDPOINT', 'FLY_API_TOKEN', 'ANTHROPIC_API_KEY']) expect(names).not.toContain(secret);
    for (const keep of ['PATH', 'COMPLYKIT_BROWSER_CHANNEL', 'COMPLYKIT_KB_DIR']) expect(names).toContain(keep);
  });
});

describe('validation', () => {
  const tar = 'http://127.0.0.1:1/internal/jobs/x/run.tar';
  const src = { law: 'ca', locationId: 'us-ca', tarUrl: tar };
  const consent = (over: Record<string, unknown> = {}) => ({ jobId: 'j8', url: 'https://site.example.com/', quick: false, runs: 1, publish: { prefix: 'jobs/j8/consent/' }, ...over });
  const a11y = (over: Record<string, unknown> = {}) => ({ jobId: 'j8', url: 'https://site.example.com/', publish: { prefix: 'jobs/j8/accessibility/' }, ...over });

  it('rejects unsafe or out-of-scope publish prefixes and previous prefixes (no job is started)', async () => {
    const w = await startWorker();
    for (const prefix of ['../x/', 'kb/', 'kb/jobs/x/', 'jobs/x', 'jobs/../x/', 'jobs//x/', '/jobs/x/', 'jobs\\x/', '', 'jobs/./x/', 42, null]) {
      await post(w, '/internal/merge', mergeBody([src], { publish: { prefix } })).expect(400);
      await post(w, '/internal/consent', consent({ publish: { prefix } })).expect(400);
      await post(w, '/internal/accessibility', a11y({ publish: { prefix } })).expect(400);
    }
    for (const previous of ['kb/x/', '../x/', 'jobs/x', 'jobs/../kb/', 7]) {
      await post(w, '/internal/merge', mergeBody([src], { previous })).expect(400);
      await post(w, '/internal/consent', consent({ previous })).expect(400);
    }
    await post(w, '/internal/merge', mergeBody([src], { publish: undefined })).expect(400);
    await post(w, '/internal/merge', mergeBody([src], { publish: [] })).expect(400);
    expect(w.w.isBusy()).toBe(false);
    expect(fs.readdirSync(w.config.tmpDir)).toEqual([]);
  });

  it('only accepts a peer tar on the private network at exactly /internal/jobs/<id>/run.tar over http', async () => {
    const w = await startWorker();
    const bad = [
      'https://[fdaa:0:1::2]:8080/internal/jobs/j1-ca/run.tar', // https
      'http://203.0.113.9:8080/internal/jobs/j1-ca/run.tar', // a public address
      'http://example.com/internal/jobs/j1-ca/run.tar',
      'http://evil.internal.example.com/internal/jobs/j1-ca/run.tar',
      'http://127.0.0.1:1/internal/jobs/x/run.tar/extra',
      'http://127.0.0.1:1/internal/jobs/x/events',
      'http://127.0.0.1:1/internal/jobs/../x/run.tar',
      'http://127.0.0.1:1/x.tar',
      'http://127.0.0.1:1/internal/jobs/x/run.tar?next=http://evil',
      'http://u:p@127.0.0.1:1/internal/jobs/x/run.tar',
      'http://127.0.0.1:1/internal/jobs/x/run.tar#a',
    ];
    for (const tarUrl of bad) await post(w, '/internal/merge', mergeBody([{ ...src, tarUrl }])).expect(400);
    // The accepted shapes get as far as the job (202); the fetch itself then fails, and that is a failed job, not a bad request.
    for (const [i, tarUrl] of ['http://[fdaa:0:1::2]:8080/internal/jobs/j1-ca/run.tar', 'http://abcd.vm.complykit-workers.internal:8080/internal/jobs/j1-ca/run.tar'].entries()) {
      await post(w, '/internal/merge', mergeBody([{ ...src, tarUrl }], { jobId: `m${i}-merge`, publish: { prefix: `jobs/m${i}/consent/` } })).expect(202);
      await request(w.w.app).post(`/internal/jobs/m${i}-merge/cancel`).set(auth).expect(200);
    }
    // Loopback is for tests and local development only.
    vi.stubEnv('NODE_ENV', 'production');
    await post(w, '/internal/merge', mergeBody([src], { jobId: 'p1-merge', publish: { prefix: 'jobs/p1/consent/' } })).expect(400);
  });

  it('publish.prefix must be this job\'s own jobs/<id>/consent/ (accessibility: .../accessibility/); previous must be a run directory', async () => {
    const w = await startWorker();
    const run = '2026-10-01T10-00-00.000Z';
    const wrong: Array<[string, Record<string, unknown>]> = [
      ['/internal/merge', mergeBody([src], { publish: { prefix: 'jobs/other/consent/' } })],
      ['/internal/merge', mergeBody([src], { publish: { prefix: 'jobs/j1/accessibility/' } })],
      ['/internal/merge', mergeBody([src], { publish: { prefix: 'jobs/j1/consent/.comply/' } })],
      ['/internal/merge', mergeBody([src], { publish: { prefix: 'jobs/j1/' } })],
      ['/internal/consent', consent({ publish: { prefix: 'jobs/j9/consent/' } })],
      ['/internal/consent', consent({ publish: { prefix: 'jobs/j8/accessibility/' } })],
      ['/internal/accessibility', a11y({ publish: { prefix: 'jobs/j8/consent/' } })],
      ['/internal/accessibility', a11y({ publish: { prefix: 'jobs/j9/accessibility/' } })],
      ['/internal/consent', consent({ previous: 'jobs/old/consent/.comply/runs/r0/' })],
      ['/internal/consent', consent({ previous: `jobs/old/accessibility/.comply/runs/${run}/` })],
      ['/internal/consent', consent({ previous: `jobs/old/consent/.comply/runs/${run}/evidence/` })],
      ['/internal/consent', consent({ previous: `jobs/old/consent/.comply/${run}/` })],
      ['/internal/merge', mergeBody([src], { previous: 'jobs/old/consent/' })],
    ];
    for (const [route, b] of wrong) await post(w, route, b).expect(400);
    // The host's own shapes pass: the worker job id carries -merge / -consent / -accessibility.
    await post(w, '/internal/consent', consent({ jobId: 'j8-consent', previous: `jobs/old/consent/.comply/runs/${run}/` })).expect(202);
    await request(w.w.app).post('/internal/jobs/j8-consent/cancel').set(auth).expect(200);
    await post(w, '/internal/accessibility', a11y({ jobId: 'j8-accessibility' })).expect(202);
    await request(w.w.app).post('/internal/jobs/j8-accessibility/cancel').set(auth).expect(200);
  });

  it('rejects bad merge bodies', async () => {
    const w = await startWorker();
    const bad: Array<Record<string, unknown>> = [
      { jobId: '../x' },
      { jobId: undefined },
      { url: 'ftp://site.example.com/' },
      { sources: [] },
      { sources: 'ca' },
      { sources: Array.from({ length: 13 }, (_, i) => ({ ...src, law: `l${i}` })) },
      { sources: [{ ...src, tarUrl: 'file:///etc/passwd' }] },
      { sources: [{ ...src, tarUrl: 'ftp://x/y.tar' }] },
      { sources: [{ ...src, tarUrl: 'not a url' }] },
      { sources: [{ ...src, law: '../ca' }] },
      { sources: [{ ...src, law: 'CA' }] },
      { sources: [{ ...src, locationId: 'germany' }] },
      { sources: [src, src] },
      { failed: 'x' },
      { failed: [{ locationId: 'uk' }] },
      { failed: [{ locationId: 'UK', error: 'x' }] },
      { failed: [{ locationId: 'uk', error: 'x'.repeat(1001) }] },
      { failed: Array.from({ length: 25 }, () => ({ locationId: 'uk', error: 'x' })) },
      { workspace: [] },
      { workspace: 'x' },
    ];
    for (const over of bad) await post(w, '/internal/merge', mergeBody([src], over)).expect(400);
    await post(w, '/internal/merge', []).expect(400);
    expect(fs.readdirSync(w.config.tmpDir)).toEqual([]);
  });

  it('rejects bad consent, accessibility and verify bodies', async () => {
    const w = await startWorker();
    for (const over of [{ runs: 0 }, { runs: 6 }, { runs: '2' }, { quick: 'yes' }, { url: 'ftp://x/' }, { jobId: 'a/b' }, { workspace: [] }]) await post(w, '/internal/consent', consent(over)).expect(400);
    for (const over of [{ url: 'javascript:alert(1)' }, { url: undefined }, { jobId: '' }]) await post(w, '/internal/accessibility', a11y(over)).expect(400);
    for (const b of [{ site: 'example.com' }, { task: {}, site: '../etc' }, { task: {}, site: '' }, { task: {}, site: 'a b' }, { task: [], site: 'example.com' }, { task: {} }, []]) await post(w, '/internal/verify', b).expect(400);
  });

  it('401 without the secret on the new routes', async () => {
    const w = await startWorker();
    for (const route of ['merge', 'consent', 'accessibility', 'verify']) await request(w.w.app).post(`/internal/${route}`).send({}).expect(401);
  });
});
