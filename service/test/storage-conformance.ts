// The storage contract's behavior, as suites any backend must pass
// (plans/do-hosting.md). storage-fs.test.ts and storage-cloud.test.ts run them.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { JobDetail, SiteWorkspace } from '../src/shared/api.js';
import type { ConsentRecord } from '../src/server/consent-records.js';
import { assertKey, type Blobs, type Storage } from '../src/server/storage/types.js';
import { WorkspaceError } from '../src/server/workspace.js';

const text = async (r: Readable | null) => {
  if (!r) return null;
  const chunks: Buffer[] = [];
  for await (const c of r) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks).toString('utf8');
};
const all = async <T>(it: AsyncIterable<T>) => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ck-storage-'));

export function blobSuite(name: string, make: () => Promise<{ blobs: Blobs; root: string; cleanup: () => Promise<void> }>) {
  describe(`${name}: blobs`, () => {
    const withBlobs = async (fn: (b: Blobs, root: string) => Promise<void>) => {
      const { blobs, root, cleanup } = await make();
      try {
        await fn(blobs, root);
      } finally {
        await cleanup();
      }
    };

    it('put / get / head / read round-trip; absent is null', () =>
      withBlobs(async (b, root) => {
        const k = `${root}jobs/a1b2c3/consent/x.json`;
        expect(await b.get(k)).toBeNull();
        expect(await b.head(k)).toBeNull();
        expect(await b.read(k)).toBeNull();
        await b.put(k, '{"a":1}', { contentType: 'application/json' });
        expect((await b.get(k))?.toString('utf8')).toBe('{"a":1}');
        expect(await text(await b.read(k))).toBe('{"a":1}');
        const h = await b.head(k);
        expect(h).toMatchObject({ key: k, size: 7 });
        expect(typeof h!.etag).toBe('string');
        expect(Number.isFinite(Date.parse(h!.modified))).toBe(true);
      }));

    it('put replaces; the etag changes with the content; streams and buffers both work as bodies', () =>
      withBlobs(async (b, root) => {
        const k = `${root}kb/queue.json`;
        await b.put(k, Buffer.from('one'));
        const e1 = (await b.head(k))!.etag;
        await b.put(k, Readable.from([Buffer.from('two'), Buffer.from('-and-more')]));
        expect((await b.get(k))?.toString()).toBe('two-and-more');
        expect((await b.head(k))!.etag).not.toBe(e1);
      }));

    it('list: everything under a prefix, sorted, with sizes; nothing outside it', () =>
      withBlobs(async (b, root) => {
        await b.put(`${root}jobs/j1/b.txt`, 'bb');
        await b.put(`${root}jobs/j1/a/deep/c.txt`, 'c');
        await b.put(`${root}jobs/j10/x.txt`, 'x'); // shares the string prefix "jobs/j1", not the key prefix "jobs/j1/"
        const got = await all(b.list(`${root}jobs/j1/`));
        expect(got.map((x) => [x.key, x.size])).toEqual([
          [`${root}jobs/j1/a/deep/c.txt`, 1],
          [`${root}jobs/j1/b.txt`, 2],
        ]);
        expect(await all(b.list(`${root}jobs/none/`))).toEqual([]);
      }));

    it('delete and deletePrefix; deleting the absent is fine', () =>
      withBlobs(async (b, root) => {
        await b.put(`${root}jobs/j2/a.txt`, 'a');
        await b.put(`${root}jobs/j2/sub/b.txt`, 'b');
        await b.put(`${root}jobs/j20/keep.txt`, 'k');
        await b.delete(`${root}jobs/j2/a.txt`);
        await b.delete(`${root}jobs/j2/never.txt`);
        expect(await b.get(`${root}jobs/j2/a.txt`)).toBeNull();
        expect(await b.deletePrefix(`${root}jobs/j2/`)).toBe(1);
        expect(await all(b.list(`${root}jobs/j2/`))).toEqual([]);
        expect((await b.get(`${root}jobs/j20/keep.txt`))?.toString()).toBe('k');
      }));

    it('upload a directory and download it back, with filters; binary content survives', () =>
      withBlobs(async (b, root) => {
        const src = tmpDir();
        const dst = tmpDir();
        try {
          fs.mkdirSync(path.join(src, 'evidence', 'tracking'), { recursive: true });
          fs.writeFileSync(path.join(src, 'tracking.json'), '{"t":1}');
          fs.writeFileSync(path.join(src, 'evidence', 'tracking', 'visit.har'), 'har');
          const bin = Buffer.from([0, 255, 1, 254, 10, 13]);
          fs.writeFileSync(path.join(src, 'shot.png'), bin);
          fs.writeFileSync(path.join(src, 'skip.tmp'), 'no');
          const prefix = `${root}jobs/j3/consent/.comply/runs/r1/`;
          expect(await b.upload(src, prefix, (rel) => !rel.endsWith('.tmp'))).toBe(3);
          expect((await b.get(`${prefix}evidence/tracking/visit.har`))?.toString()).toBe('har');
          expect(await b.head(`${prefix}skip.tmp`)).toBeNull();
          expect(await b.download(prefix, dst, (rel) => !rel.startsWith('evidence/'))).toBe(2);
          expect(fs.readFileSync(path.join(dst, 'tracking.json'), 'utf8')).toBe('{"t":1}');
          expect(fs.readFileSync(path.join(dst, 'shot.png')).equals(bin)).toBe(true);
          expect(fs.existsSync(path.join(dst, 'evidence'))).toBe(false);
        } finally {
          await fsp.rm(src, { recursive: true, force: true });
          await fsp.rm(dst, { recursive: true, force: true });
        }
      }));

    it('refuses keys that could escape their place', () =>
      withBlobs(async (b, root) => {
        for (const k of ['../x', `${root}jobs/../../etc/passwd`, '/abs', `${root}a//b`, `${root}a\\b`, `${root}a/./b`, '']) {
          await expect(b.put(k, 'x')).rejects.toThrow(/blob key/);
          await expect(b.get(k)).rejects.toThrow(/blob key/);
        }
        await expect(all(b.list(`${root}jobs/../`))).rejects.toThrow(/blob/);
        await expect(b.deletePrefix(`${root}jobs`)).rejects.toThrow(/prefix/);
      }));
  });
}

describe('assertKey', () => {
  it('accepts report paths and refuses traversal', () => {
    expect(() => assertKey('jobs/mv8ci3ht8335f148/consent/.comply/runs/2026-10-14T16-59-11.932Z/owner-report.json')).not.toThrow();
    expect(() => assertKey('kb/')).toThrow();
    expect(() => assertKey('kb/', { prefix: true })).not.toThrow();
    expect(() => assertKey('a/../b')).toThrow();
  });
});

// --- records ------------------------------------------------------------------------

const job = (id: string, over: Partial<JobDetail> = {}): JobDetail =>
  ({
    id, batchId: 'b', url: 'https://shop.example/', host: 'shop.example', checks: ['consent'], quick: true, slowRepeat: false, status: 'done', createdAt: '2026-10-14T10:00:00.000Z',
    progress: { fraction: 1, done: 1, total: 1, phase: 'done' }, metrics: { requests: 0, thirdPartyRequests: 0, parties: 0, cookies: 0, scenarios: [] }, log: ['a', 'b'], ...over,
  }) as JobDetail;
const ws = (domain: string, entries: SiteWorkspace['entries'] = {}): SiteWorkspace => ({ version: 1, domain, entries, runs: [] });
const rec = (id: string, receivedAt: string): ConsentRecord => ({ id, at: receivedAt, receivedAt, categories: { analytics: true }, configHash: 'h', toolVersion: '1', regime: 'opt-in' });

export interface RecordHarness {
  storage: Storage;
  cleanup: () => Promise<void>;
  /** Make the stored workspace for `domain` unreadable (a broken file / document). */
  corruptWorkspace: (domain: string) => Promise<void>;
}

export function recordSuite(name: string, make: (opts: { consentMaxBytes?: number }) => Promise<RecordHarness>) {
  describe(`${name}: records`, () => {
    const withStorage = async (fn: (s: Storage, h: RecordHarness) => Promise<void>, opts: { consentMaxBytes?: number } = {}) => {
      const h = await make(opts);
      try {
        await fn(h.storage, h);
      } finally {
        await h.storage.close();
        await h.cleanup();
      }
    };

    it('jobs: put / loadAll round-trip deep-equal; put replaces; remove; absent is fine', () =>
      withStorage(async ({ jobs }) => {
        expect(await jobs.loadAll()).toEqual([]);
        const a = job('aaaaaa1');
        const b = job('bbbbbb2', { status: 'running', log: [] });
        await jobs.put(a);
        await jobs.put(b);
        const sorted = (l: JobDetail[]) => [...l].sort((x, y) => x.id.localeCompare(y.id));
        expect(sorted(await jobs.loadAll())).toEqual([a, b]);
        const a2 = job('aaaaaa1', { status: 'failed', log: ['a', 'b', 'c'] });
        await jobs.put(a2);
        expect(sorted(await jobs.loadAll())).toEqual([a2, b]);
        await jobs.remove('aaaaaa1');
        await jobs.remove('never000');
        expect(await jobs.loadAll()).toEqual([b]);
      }));

    it('jobs: a field set to undefined is absent when reloaded (a cleared error does not come back as null)', () =>
      withStorage(async ({ jobs }) => {
        await jobs.put(job('cccccc3', { status: 'failed', error: 'boom' }));
        await jobs.put(job('cccccc3', { status: 'done', error: undefined }));
        const [got] = await jobs.loadAll();
        expect(got.status).toBe('done');
        expect('error' in got).toBe(false);
      }));

    it('workspaces: read none; first write needs rev undefined; stale revs lose', () =>
      withStorage(async ({ workspaces }) => {
        expect(await workspaces.read('shop.example')).toBeUndefined();
        expect(await workspaces.write('shop.example', ws('shop.example'), 'bogus')).toBeNull();
        const r1 = await workspaces.write('shop.example', ws('shop.example'), undefined);
        expect(typeof r1).toBe('string');
        expect(await workspaces.write('shop.example', ws('shop.example'), undefined)).toBeNull();
        const got = await workspaces.read('shop.example');
        expect(got).toEqual({ ws: ws('shop.example'), rev: r1 });
        const next = ws('shop.example', { k: { value: 1, at: '2026-10-14T10:00:00.000Z' } });
        const r2 = await workspaces.write('shop.example', next, r1!);
        expect(typeof r2).toBe('string');
        expect(r2).not.toBe(r1);
        expect(await workspaces.write('shop.example', ws('shop.example'), r1!)).toBeNull();
        expect(await workspaces.read('shop.example')).toEqual({ ws: next, rev: r2 });
        await workspaces.write('other.example', ws('other.example'), undefined);
        expect((await workspaces.domains()).sort()).toEqual(['other.example', 'shop.example']);
      }));

    it('workspaces: concurrent writers from the same rev — exactly one wins', () =>
      withStorage(async ({ workspaces }) => {
        const r0 = await workspaces.write('race.example', ws('race.example'), undefined);
        const results = await Promise.all(
          Array.from({ length: 8 }, (_, i) => workspaces.write('race.example', ws('race.example', { [`k${i}`]: { value: i, at: '2026-10-14T10:00:00.000Z' } }), r0!)),
        );
        expect(results.filter((r) => r !== null)).toHaveLength(1);
        const first = await Promise.all(Array.from({ length: 6 }, () => workspaces.write('fresh.example', ws('fresh.example'), undefined)));
        expect(first.filter((r) => r !== null)).toHaveLength(1);
      }));

    it('workspaces: an unreadable one is a 500, never empty; bad domains are 400', () =>
      withStorage(async ({ workspaces }, h) => {
        await h.corruptWorkspace('broken.example');
        await expect(workspaces.read('broken.example')).rejects.toMatchObject({ status: 500 });
        await expect(workspaces.read('../etc')).rejects.toMatchObject({ status: 400 });
        await expect(workspaces.write('not a domain', ws('x.example'), undefined)).rejects.toMatchObject({ status: 400 });
      }));

    it('consent records: append order, dedupe by id, exists', () =>
      withStorage(async ({ consentRecords }) => {
        const d = 'shop.example';
        expect(await consentRecords.exists(d)).toBe(false);
        expect(await all(consentRecords.records(d))).toEqual([]);
        const t = '2026-10-14T10:00:00.000Z';
        await consentRecords.append(d, rec('id-aaaaaaaaaaaaaaaa', t));
        await consentRecords.append(d, rec('id-bbbbbbbbbbbbbbbb', t));
        await consentRecords.append(d, { ...rec('id-aaaaaaaaaaaaaaaa', t), regime: 'dupe' });
        await consentRecords.append(d, rec('id-cccccccccccccccc', t));
        expect(await consentRecords.exists(d)).toBe(true);
        expect(await consentRecords.exists('other.example')).toBe(false);
        expect((await all(consentRecords.records(d))).map((r) => [r.id, r.regime])).toEqual([
          ['id-aaaaaaaaaaaaaaaa', 'opt-in'],
          ['id-bbbbbbbbbbbbbbbb', 'opt-in'],
          ['id-cccccccccccccccc', 'opt-in'],
        ]);
        await expect(consentRecords.append('not a domain', rec('id-dddddddddddddddd', t))).rejects.toMatchObject({ status: 400 });
      }));

    it('consent records: concurrent appends all land', () =>
      withStorage(async ({ consentRecords }) => {
        await Promise.all(Array.from({ length: 20 }, (_, i) => consentRecords.append('busy.example', rec(`id-${String(i).padStart(16, '0')}`, '2026-10-14T10:00:00.000Z'))));
        expect(await all(consentRecords.records('busy.example'))).toHaveLength(20);
      }));

    it('consent records: prune drops records older than the cutoff in every site', () =>
      withStorage(async ({ consentRecords }) => {
        await consentRecords.append('a.example', rec('id-old0000000000001', '2020-01-01T00:00:00.000Z'));
        await consentRecords.append('a.example', rec('id-new0000000000001', '2026-10-01T00:00:00.000Z'));
        await consentRecords.append('b.example', rec('id-old0000000000002', '2021-01-01T00:00:00.000Z'));
        await consentRecords.append('b.example', { ...rec('id-odd0000000000001', '2021-01-01T00:00:00.000Z'), receivedAt: 'not a date' });
        expect(await consentRecords.prune(Date.parse('2025-01-01T00:00:00.000Z'))).toBe(2);
        expect((await all(consentRecords.records('a.example'))).map((r) => r.id)).toEqual(['id-new0000000000001']);
        expect((await all(consentRecords.records('b.example'))).map((r) => r.id)).toEqual(['id-odd0000000000001']);
        expect(await consentRecords.prune(Date.parse('2025-01-01T00:00:00.000Z'))).toBe(0);
      }));

    it('consent records: a site at the size limit gets a 507; pruning frees room', () =>
      withStorage(
        async ({ consentRecords }) => {
          const d = 'full.example';
          const old = (id: string) => rec(id, '2020-01-01T00:00:00.000Z');
          let n = 0;
          for (;;) {
            try {
              await consentRecords.append(d, old(`id-${String(n).padStart(16, '0')}`));
              n++;
            } catch (err) {
              expect(err).toMatchObject({ status: 507 });
              break;
            }
            if (n > 100) throw new Error('the limit never kicked in');
          }
          expect(n).toBeGreaterThan(0);
          expect(await consentRecords.prune(Date.parse('2025-01-01T00:00:00.000Z'))).toBe(n);
          await consentRecords.append(d, old('id-after0000000000'));
        },
        { consentMaxBytes: 1500 },
      ));

    it('config snapshots: put once, get by hash; the first firstServed wins; unknown is undefined', () =>
      withStorage(async ({ configSnapshots }) => {
        const hash = 'a'.repeat(64);
        expect(await configSnapshots.get(hash)).toBeUndefined();
        const first = { hash, domain: 'shop.example', config: { layout: 'bar', hash }, firstServed: '2026-10-14T10:00:00.000Z' };
        await configSnapshots.put(first);
        await configSnapshots.put({ ...first, firstServed: '2026-10-15T10:00:00.000Z', config: { other: true } });
        expect(await configSnapshots.get(hash)).toEqual(first);
        expect(await configSnapshots.get('b'.repeat(64))).toBeUndefined();
      }));

    it('consent stats: add accumulates per (domain, day, hash); read filters by domain and day range', () =>
      withStorage(async ({ consentStats }) => {
        const h1 = 'a'.repeat(64);
        const h2 = 'b'.repeat(64);
        const byKey = (l: Array<{ day: string; hash: string }>) => [...l].sort((x, y) => (x.day + x.hash).localeCompare(y.day + y.hash));
        expect(await consentStats.read('shop.example', '2026-10-01', '2026-10-31')).toEqual([]);
        await consentStats.add([
          { domain: 'shop.example', day: '2026-10-14', hash: h1, n: { load: 1, 'geo:US-CA:load': 1 } },
          { domain: 'shop.example', day: '2026-10-14', hash: h2, n: { shown: 2 } },
          { domain: 'other.example', day: '2026-10-14', hash: h1, n: { load: 9 } },
        ]);
        await consentStats.add([
          { domain: 'shop.example', day: '2026-10-14', hash: h1, n: { load: 2, 'decide:accept:banner': 1 } },
          { domain: 'shop.example', day: '2026-10-16', hash: h1, n: { load: 5 } },
        ]);
        expect(byKey(await consentStats.read('shop.example', '2026-10-01', '2026-10-31'))).toEqual([
          { domain: 'shop.example', day: '2026-10-14', hash: h1, n: { load: 3, 'geo:US-CA:load': 1, 'decide:accept:banner': 1 } },
          { domain: 'shop.example', day: '2026-10-14', hash: h2, n: { shown: 2 } },
          { domain: 'shop.example', day: '2026-10-16', hash: h1, n: { load: 5 } },
        ]);
        expect((await consentStats.read('shop.example', '2026-10-15', '2026-10-16')).map((d) => d.day)).toEqual(['2026-10-16']);
        expect((await consentStats.read('other.example', '2026-10-14', '2026-10-14')).map((d) => d.n)).toEqual([{ load: 9 }]);
        // concurrent adds do not lose counts
        await Promise.all(Array.from({ length: 10 }, () => consentStats.add([{ domain: 'shop.example', day: '2026-10-20', hash: h1, n: { load: 1 } }])));
        expect((await consentStats.read('shop.example', '2026-10-20', '2026-10-20'))[0].n).toEqual({ load: 10 });
      }));
  });
}
