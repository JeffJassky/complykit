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
