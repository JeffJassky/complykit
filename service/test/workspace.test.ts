import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { SERVICE_DIR } from '../src/server/config.js';
import { registrableDomain, siteDomain } from '../src/server/domains.js';
import { sweepRetention } from '../src/server/lifecycle.js';
import { emptyWorkspace, mergeWorkspace, normalizePatch, WorkspaceStore } from '../src/server/workspace.js';
import type { CreateBatchResponse, SitesResponse, SiteWorkspace, SiteWorkspacePatchResponse } from '../src/shared/api.js';
import { startService, stopAll, tempDir, waitForStatus } from './helpers.js';

afterEach(stopAll);

const T = (s: number) => new Date(Date.UTC(2026, 9, 6, 12, 0, s)).toISOString();
const NOW = Date.parse(T(59));

function merge(ws: SiteWorkspace, body: unknown) {
  return mergeWorkspace(ws, normalizePatch(body, NOW), NOW);
}

describe('domain normalization', () => {
  it('keys a workspace by registrable domain', () => {
    expect(siteDomain('example.com')).toBe('example.com');
    expect(siteDomain('Shop.Example.COM')).toBe('example.com');
    expect(siteDomain('www.example.co.uk')).toBe('example.co.uk');
    expect(siteDomain('example.com.')).toBe('example.com');
    expect(siteDomain('shop.example.com:8443')).toBe('example.com');
    expect(siteDomain('store-a.myshopify.com')).toBe('store-a.myshopify.com');
    expect(siteDomain('bücher.example')).toBe('xn--bcher-kva.example');
  });

  it('rejects anything that is not a single safe domain segment', () => {
    for (const bad of ['', '..', '.', 'localhost', '../etc', '..%2f..', 'a/b.com', 'a\\b.com', 'user@evil.com', 'evil.com/..', 'a..b.com', '-x.com', 'co.uk', 'myshopify.com', '[::1]', ' ', 'x'.repeat(300) + '.com', 42, undefined]) {
      expect(siteDomain(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("matches complykit's registrableDomain (the copy must not drift)", async () => {
    // Imported by runtime path: the service's tsconfig never compiles complykit's source.
    const mod = (await import(pathToFileURL(path.join(SERVICE_DIR, '..', 'src', 'registry', 'kb', 'domains.ts')).href)) as { registrableDomain(h: string): string };
    for (const host of ['px.ads.linkedin.com', 'shop.example.co.uk', 'a.b.c.example.com.au', 'store.myshopify.com', 'x.y.github.io', 'example.com', '10.0.0.1', 'co.uk', 'deep.sub.example.org']) {
      expect(registrableDomain(host), host).toBe(mod.registrableDomain(host));
    }
    const src = (f: string) => fs.readFileSync(f, 'utf8').match(/const MULTI_LABEL_SUFFIXES = new Set\(\[[\s\S]*?\]\);/)?.[0];
    expect(src(path.join(SERVICE_DIR, 'src', 'server', 'domains.ts'))).toBe(src(path.join(SERVICE_DIR, '..', 'src', 'registry', 'kb', 'domains.ts')));
  });
});

describe('merge semantics', () => {
  it('different keys merge; the same key keeps the latest `at`', () => {
    let ws = emptyWorkspace('example.com');
    ws = merge(ws, { entries: { a: { value: 'A1', at: T(10), by: 'Ann' }, b: { value: 'B1', at: T(10) } } }).workspace;
    const r = merge(ws, { by: 'Bo', entries: { a: { value: 'A0', at: T(5) }, b: { value: 'B2', at: T(20) }, c: { value: { done: true } } } });
    expect(r.workspace.entries).toEqual({
      a: { value: 'A1', at: T(10), by: 'Ann' }, // older write lost
      b: { value: 'B2', at: T(20), by: 'Bo' }, // top-level `by` is the default
      c: { value: { done: true }, at: T(59), by: 'Bo' }, // `at` defaults to now
    });
    expect(r.stale).toEqual({ entries: ['a'], config: false, runs: [] });
    expect(r.changed).toBe(true);
    expect(r.workspace.createdAt).toBe(T(59));
  });

  it('a tie goes to the incoming write; resending is harmless', () => {
    const ws = merge(emptyWorkspace('example.com'), { entries: { k: { value: 1, at: T(10) } } }).workspace;
    expect(merge(ws, { entries: { k: { value: 2, at: T(10) } } }).workspace.entries.k.value).toBe(2);
    expect(merge(ws, { entries: { k: { value: 1, at: T(10) } } }).workspace.entries.k).toEqual({ value: 1, at: T(10) });
  });

  it('null clears a value and a late older write cannot bring it back', () => {
    let ws = merge(emptyWorkspace('example.com'), { entries: { k: { value: 'x', at: T(10) } } }).workspace;
    ws = merge(ws, { entries: { k: { value: null, at: T(20) } } }).workspace;
    const late = merge(ws, { entries: { k: { value: 'x', at: T(15) } } });
    expect(late.workspace.entries.k).toEqual({ value: null, at: T(20) });
    expect(late.changed).toBe(false);
  });

  it('config is one latest-wins register; runs upsert by id, oldest first', () => {
    let ws = merge(emptyWorkspace('example.com'), {
      config: { value: { v: 1 }, at: T(30), runId: 'run-2' },
      runs: [
        { id: 'run-2', at: T(30), jobId: 'abc123', url: 'https://example.com/' },
        { id: 'run-1', at: T(10) },
      ],
    }).workspace;
    const r = merge(ws, { config: { value: { v: 0 }, at: T(20) }, runs: [{ id: 'run-1', at: T(11), meta: { cookies: 4 } }, { id: 'run-2', at: T(1) }] });
    ws = r.workspace;
    expect(ws.config).toEqual({ value: { v: 1 }, at: T(30), runId: 'run-2' });
    expect(ws.runs.map((x) => [x.id, x.at])).toEqual([
      ['run-1', T(11)],
      ['run-2', T(30)],
    ]);
    expect(ws.runs[0].meta).toEqual({ cookies: 4 });
    expect(r.stale).toEqual({ entries: [], config: true, runs: ['run-2'] });
  });

  it('a client clock far ahead is clamped to now, so it cannot freeze a key', () => {
    const p = normalizePatch({ entries: { k: { value: 1, at: '2099-01-01T00:00:00Z' } } }, NOW);
    expect(p.entries[0][1].at).toBe(T(59));
  });

  it('rejects malformed patches', () => {
    const bad = [
      undefined,
      [],
      {},
      { entries: [] },
      { entries: { k: { at: T(1) } } }, // no value
      { entries: { k: { value: 1, at: 'yesterday' } } },
      { entries: { __proto__x: 1 } },
      { entries: JSON.parse('{"__proto__": {"value": 1}}') },
      { entries: { 'a\nb': { value: 1 } } },
      { entries: { k: { value: 'x'.repeat(20_000) } } },
      { entries: { k: { value: 1, by: 7 } } },
      { config: { value: 1, runId: '../x' } },
      { runs: [{ id: '../../etc' }] },
      { runs: [{ id: 'r1', url: 'javascript:alert(1)' }] },
    ];
    for (const b of bad) expect(() => normalizePatch(b, NOW), JSON.stringify(b)).toThrow();
  });
});

describe('workspace API', () => {
  it('GET is an empty workspace (not 404) before the first write, and writes nothing', async () => {
    const s = await startService();
    const ws = (await request(s.app).get('/api/sites/www.example.com/workspace').expect(200)).body as SiteWorkspace;
    expect(ws).toEqual({ version: 1, domain: 'example.com', entries: {}, runs: [] });
    expect(fs.existsSync(path.join(s.config.dataDir, 'sites', 'example.com'))).toBe(false);
    expect(((await request(s.app).get('/api/sites').expect(200)).body as SitesResponse).sites).toEqual([]);
  });

  it('PATCH via any host of the site lands in one file; GET and the list read it back', async () => {
    const s = await startService();
    const r1 = (await request(s.app).patch('/api/sites/shop.example.co.uk/workspace').send({ by: 'Ann', entries: { 'task-1': { value: { status: 'done' }, at: T(10) } } }).expect(200)).body as SiteWorkspacePatchResponse;
    expect(r1.workspace.domain).toBe('example.co.uk');
    await request(s.app)
      .patch('/api/sites/example.co.uk/workspace')
      .send({ entries: { 'class-_ga': { value: { category: 'analytics' } }, 'task-1': { value: { status: 'open' }, at: T(5) } }, runs: [{ id: 'r1', at: T(1) }], config: { value: { banner: 'bar' } } })
      .expect(200)
      .expect((res) => expect((res.body as SiteWorkspacePatchResponse).stale.entries).toEqual(['task-1']));

    const file = path.join(s.config.dataDir, 'sites', 'example.co.uk', 'workspace.json');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as SiteWorkspace;
    expect(onDisk.entries['task-1']).toEqual({ value: { status: 'done' }, at: T(10), by: 'Ann' });
    expect(Object.keys(onDisk.entries).sort()).toEqual(['class-_ga', 'task-1']);
    expect((await request(s.app).get('/api/sites/www.example.co.uk/workspace').expect(200)).body).toEqual(onDisk);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['workspace.json']); // no lock or temp file left behind

    const { sites } = (await request(s.app).get('/api/sites').expect(200)).body as SitesResponse;
    expect(sites).toEqual([{ domain: 'example.co.uk', updatedAt: onDisk.updatedAt, entries: 2, runs: 1, lastRunAt: T(1), configAt: onDisk.config?.at }]);
  });

  it('400s bad domains and bodies; path traversal never reaches the filesystem', async () => {
    const s = await startService();
    for (const d of ['localhost', '..', '..%2F..%2Fetc', '%2e%2e', 'a%2Fb.com', 'co.uk']) {
      await request(s.app).get(`/api/sites/${d}/workspace`).expect((res) => expect([400, 404], d).toContain(res.status));
      await request(s.app).patch(`/api/sites/${d}/workspace`).send({ entries: { k: { value: 1 } } }).expect((res) => expect([400, 404], d).toContain(res.status));
    }
    await request(s.app).patch('/api/sites/example.com/workspace').send({}).expect(400);
    await request(s.app).patch('/api/sites/example.com/workspace').send({ entries: { k: { value: 1, at: 'nope' } } }).expect(400);
    expect(fs.existsSync(path.join(s.config.dataDir, 'sites'))).toBe(false);
    expect(fs.readdirSync(s.config.dataDir).sort()).toEqual(['jobs']);
  });

  it('an unreadable workspace is a 500 and is left untouched, never reset', async () => {
    const s = await startService();
    const dir = path.join(s.config.dataDir, 'sites', 'example.com');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'workspace.json'), '{"version":1,"domain":"example.com","entr');
    await request(s.app).get('/api/sites/example.com/workspace').expect(500);
    await request(s.app).patch('/api/sites/example.com/workspace').send({ entries: { k: { value: 1 } } }).expect(500);
    expect(fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8')).toBe('{"version":1,"domain":"example.com","entr');
    expect(((await request(s.app).get('/api/sites').expect(200)).body as SitesResponse).sites).toEqual([]);
  });

  it('persists across a restart', async () => {
    const dataDir = tempDir();
    const a = await startService({ dataDir });
    await request(a.app).patch('/api/sites/example.com/workspace').send({ entries: { k: { value: 'kept' } } }).expect(200);
    await a.stop(200);
    const b = await startService({ dataDir });
    expect(((await request(b.app).get('/api/sites/example.com/workspace').expect(200)).body as SiteWorkspace).entries.k.value).toBe('kept');
  });
});

describe('concurrent PATCH', () => {
  it('parallel writes to different keys all land', async () => {
    const s = await startService();
    const n = 40;
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) => request(s.app).patch('/api/sites/example.com/workspace').send({ by: `p${i}`, entries: { [`key-${i}`]: { value: i } } })),
    );
    for (const r of results) expect(r.status).toBe(200);
    const ws = (await request(s.app).get('/api/sites/example.com/workspace').expect(200)).body as SiteWorkspace;
    expect(Object.keys(ws.entries)).toHaveLength(n);
    for (let i = 0; i < n; i++) expect(ws.entries[`key-${i}`]).toMatchObject({ value: i, by: `p${i}` });
  });

  it('parallel writes to one key: the latest `at` wins whatever the arrival order', async () => {
    const s = await startService();
    const order = [7, 2, 19, 0, 11, 5, 18, 3, 14, 9];
    await Promise.all(order.map((sec) => request(s.app).patch('/api/sites/example.com/workspace').send({ entries: { k: { value: sec, at: T(sec) } } }).expect(200)));
    const ws = (await request(s.app).get('/api/sites/example.com/workspace').expect(200)).body as SiteWorkspace;
    expect(ws.entries.k).toEqual({ value: 19, at: T(19) });
  });

  it('two processes (separate stores, same directory) do not lose each other’s writes', async () => {
    const root = path.join(tempDir(), 'sites');
    const a = new WorkspaceStore(root);
    const b = new WorkspaceStore(root);
    await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? a : b).patch('example.com', { entries: { [`k${i}`]: { value: i } } })));
    expect(Object.keys((await a.get('example.com')).entries)).toHaveLength(30);
  });

  it('waits for a held lock, and breaks one left by a crashed process', async () => {
    const root = path.join(tempDir(), 'sites');
    const store = new WorkspaceStore(root);
    const lock = path.join(root, 'example.com', '.lock');
    fs.mkdirSync(lock, { recursive: true });
    let done = false;
    const p = store.patch('example.com', { entries: { k: { value: 1 } } }).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 150));
    expect(done).toBe(false);
    fs.rmSync(lock, { recursive: true });
    await p;

    fs.mkdirSync(lock);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    await store.patch('example.com', { entries: { k2: { value: 2 } } });
    expect(Object.keys((await store.get('example.com')).entries).sort()).toEqual(['k', 'k2']);
    expect(fs.existsSync(lock)).toBe(false);
  });
});

describe('retention', () => {
  it('the job sweep removes old jobs and leaves site workspaces alone', async () => {
    const s = await startService({ retentionDays: 1 });
    const res = await request(s.app).post('/api/batches').send({ urls: 'site.example.com' }).expect(201);
    const jobId = (res.body as CreateBatchResponse).jobs[0].id;
    await waitForStatus(s, jobId, ['done']);
    await request(s.app).patch('/api/sites/example.com/workspace').send({ entries: { k: { value: 'team work' } } }).expect(200);

    // Age everything on disk, workspace included, well past retention.
    const old = new Date(Date.now() - 30 * 86_400_000);
    const sites = path.join(s.config.dataDir, 'sites');
    for (const p of [sites, path.join(sites, 'example.com'), path.join(sites, 'example.com', 'workspace.json')]) fs.utimesSync(p, old, old);

    const removed = await sweepRetention(s.store, 1, Date.now() + 30 * 86_400_000);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(s.store.get(jobId)).toBeUndefined();
    expect(((await request(s.app).get('/api/sites/example.com/workspace').expect(200)).body as SiteWorkspace).entries.k.value).toBe('team work');
  });
});
