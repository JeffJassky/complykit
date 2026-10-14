import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CreateBatchResponse, JobDetail } from '../src/shared/api.js';
import { JobFiles } from '../src/server/job-files.js';
import { FsBlobs, walkLocal } from '../src/server/storage/fs-blobs.js';
import { mongoRecords } from '../src/server/storage/mongo.js';
import type { Blobs, Storage } from '../src/server/storage/types.js';
import { WorkspaceError } from '../src/server/workspace.js';
import { binaryParser, startService, stopAll, tempDir, waitForStatus } from './helpers.js';

// Review fixes for the cloud backend: what scratch may show, publish retries,
// and the ordered, recoverable commit of re-rendered files.

let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
}, 120_000);
afterAll(async () => {
  await mongo?.stop();
});
afterEach(stopAll);

/** FsBlobs whose uploads can be made to fail, and which records what each upload carried. */
class FlakyBlobs extends FsBlobs {
  failUploads = 0;
  uploaded: string[] = [];
  override async upload(localDir: string, prefix: string, filter?: (rel: string) => boolean): Promise<number> {
    if (this.failUploads > 0) {
      this.failUploads--;
      throw new Error('spaces down');
    }
    for (const rel of await walkLocal(localDir)) if (!filter || filter(rel)) this.uploaded.push(prefix + rel);
    return super.upload(localDir, prefix, filter);
  }
}

async function splitStorage(): Promise<{ storage: Storage; blobs: FlakyBlobs }> {
  const blobs = new FlakyBlobs(tempDir());
  const records = await mongoRecords({ url: mongo.getUri(), db: `ck_fix_${crypto.randomBytes(4).toString('hex')}` });
  return { blobs, storage: { kind: 'cloud', blobs, jobs: records.jobs, workspaces: records.workspaces, consentRecords: records.consentRecords, close: records.close } };
}

type S = Awaited<ReturnType<typeof startService>>;
async function scan(s: S, url: string): Promise<string> {
  const res = await request(s.app).post('/api/batches').send({ urls: url, quick: true }).expect(201);
  const id = (res.body as CreateBatchResponse).jobs[0].id;
  await waitForStatus(s, id, ['done']);
  await s.settled();
  return id;
}

function zipEntries(buf: Buffer): string[] {
  const names: string[] = [];
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) !== 0x06054b50) continue;
    let p = buf.readUInt32LE(i + 16);
    const count = buf.readUInt16LE(i + 10);
    for (let n = 0; n < count; n++) {
      const nameLen = buf.readUInt16LE(p + 28);
      names.push(buf.toString('utf8', p + 46, p + 46 + nameLen));
      p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    }
    break;
  }
  return names;
}

describe('scratch working state is never served or zipped', () => {
  it('raw gather/, previous/, kb-ingest/ and rerender/ files in scratch are 404 on /reports and absent from the zip', async () => {
    const { storage } = await splitStorage();
    const s = await startService({}, {}, { storage });
    const id = await scan(s, 'shop.example.com');
    const dir = path.join(s.config.dataDir, 'jobs', id);
    const stray = ['consent/gather/california/raw.json', 'previous/run1/tracking.json', 'kb-ingest/x.json', 'consent/rerender/workspace.json', 'consent/leftover.tmp'];
    for (const rel of stray) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), 'secret');
    }
    for (const rel of stray) await request(s.app).get(`/reports/${id}/${rel}`).expect(404);
    const zip = await request(s.app).get(`/api/jobs/${id}/download`).buffer(true).parse(binaryParser as Parameters<request.Test['parse']>[0]).expect(200);
    const names = zipEntries(zip.body as Buffer);
    expect(names.length).toBeGreaterThan(3);
    for (const n of names) expect(n).not.toMatch(/raw\.json|previous|kb-ingest|rerender|leftover/);
  });
});

describe('publish retries', () => {
  const job = (id: string): Pick<JobDetail, 'id' | 'status'> => ({ id, status: 'done' });
  function setup() {
    const blobs = new FlakyBlobs(tempDir());
    const jobsDir = tempDir();
    const files = new JobFiles({ kind: 'cloud', blobs }, jobsDir, 1, 20);
    const scratch = files.scratchDir('job1');
    fs.mkdirSync(path.join(scratch, 'consent'), { recursive: true });
    fs.writeFileSync(path.join(scratch, 'consent', 'a.json'), '{}');
    return { blobs, files, scratch };
  }

  it('a job whose publish failed twice is published on the next wait()', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { blobs, files, scratch } = setup();
    blobs.failUploads = 2;
    files.publish(job('job1'));
    await files.settled();
    expect(await blobs.head('jobs/job1/consent/a.json')).toBeNull(); // both attempts failed
    await files.wait('job1'); // retries the failed publish
    expect(await blobs.head('jobs/job1/consent/a.json')).not.toBeNull();
    expect(fs.existsSync(scratch)).toBe(false);
  });

  it('shutdown (settled) tries a failed publish once more', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { blobs, files } = setup();
    blobs.failUploads = 2;
    files.publish(job('job1'));
    await files.settled();
    await files.settled();
    expect(await blobs.head('jobs/job1/consent/a.json')).not.toBeNull();
  });

  it('the periodic retry publishes without any read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { blobs, files } = setup();
    blobs.failUploads = 2;
    files.publish(job('job1'));
    await vi.waitFor(async () => expect(await blobs.head('jobs/job1/consent/a.json')).not.toBeNull(), { timeout: 2000 });
  });
});

describe('commit of re-rendered files', () => {
  it('uploads one file at a time in the order given, with a retry; a persistent failure keeps the scratch and says commitFailed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const blobs = new FlakyBlobs(tempDir());
    const files = new JobFiles({ kind: 'cloud', blobs }, tempDir(), 1);
    const scratch = files.scratchDir('job1');
    fs.mkdirSync(path.join(scratch, 'consent'), { recursive: true });
    for (const f of ['a', 'b', 'c']) fs.writeFileSync(path.join(scratch, 'consent', `${f}.json`), f);
    const j = { id: 'job1', status: 'done' as const };
    await files.commit(j, ['consent/c.json', 'consent/a.json', 'consent/b.json']);
    expect(blobs.uploaded).toEqual(['jobs/job1/consent/c.json', 'jobs/job1/consent/a.json', 'jobs/job1/consent/b.json']);

    blobs.failUploads = 1; // first attempt fails, the retry passes
    await files.commit(j, ['consent/a.json']);
    blobs.failUploads = 5;
    const err = await files.commit(j, ['consent/a.json']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceError);
    expect((err as WorkspaceError).extra).toEqual({ commitFailed: true });
    await files.clean('job1');
    expect(fs.existsSync(path.join(scratch, 'consent', 'a.json'))).toBe(true); // kept
  });

  it('a re-render uploads previous copies first and owner-report.json last; a failing upload answers commitFailed and keeps the new files', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { storage, blobs } = await splitStorage();
    const s = await startService({}, {}, { storage });
    const id = await scan(s, 'shop.example.com');
    const runId = s.store.get(id)!.result!.consent!.runId!;
    blobs.uploaded = [];
    await request(s.app).post(`/api/jobs/${id}/rerender`).send({}).expect(200);
    const order = blobs.uploaded.map((k) => k.split('/').pop()!);
    expect(order.at(-1)).toBe('owner-report.json');
    expect(order.indexOf('consent-report.html')).toBeGreaterThan(order.indexOf('consent-report.json'));
    expect(order.findIndex((n) => /\.prev\./.test(n))).toBe(0);
    expect(order.lastIndexOf('consent-report.prev.html')).toBeLessThan(order.indexOf('consent-report.json'));

    blobs.failUploads = 50;
    const bad = await request(s.app).post(`/api/jobs/${id}/rerender`).send({}).expect(500);
    expect(bad.body.commitFailed).toBe(true);
    const run = path.join(s.config.dataDir, 'jobs', id, 'consent', '.comply', 'runs', runId);
    expect(fs.existsSync(path.join(run, 'consent-report.html'))).toBe(true);
    // The retry: the next read of the job publishes the kept scratch and the blobs catch up.
    blobs.failUploads = 0;
    await s.store.files.wait(id);
    expect(fs.existsSync(path.join(s.config.dataDir, 'jobs', id))).toBe(false);
  });

  it('consent-config uploads complykit-config.json last, and a failing upload answers commitFailed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { storage, blobs } = await splitStorage();
    const s = await startService({}, {}, { storage });
    const id = await scan(s, 'shop.example.com');
    blobs.uploaded = [];
    await request(s.app).post(`/api/jobs/${id}/consent-config`).send({}).expect(200);
    const cfg = blobs.uploaded.filter((k) => k.includes('/consent-config/')).map((k) => k.split('/').pop());
    expect(cfg.at(-1)).toBe('complykit-config.json');
    blobs.failUploads = 50;
    const bad = await request(s.app).post(`/api/jobs/${id}/consent-config`).send({}).expect(500);
    expect(bad.body.commitFailed).toBe(true);
  });
});
