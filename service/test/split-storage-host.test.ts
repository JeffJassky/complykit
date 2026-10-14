import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ConsentConfigResponse, CreateBatchResponse } from '../src/shared/api.js';
import { FsBlobs } from '../src/server/storage/fs-blobs.js';
import { mongoRecords } from '../src/server/storage/mongo.js';
import type { Blobs, Storage } from '../src/server/storage/types.js';
import { startService, stopAll, tempDir, waitForStatus } from './helpers.js';

// Host-side behavior with the cloud shape (records in Mongo, files in blobs outside DATA_DIR) beyond the
// contract in split-storage.test.ts: --previous staging, consent-config, a failing publish, caching headers.

let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
}, 120_000);
afterAll(async () => {
  await mongo?.stop();
});
afterEach(stopAll);

async function split(wrap: (b: Blobs) => Blobs = (b) => b): Promise<{ storage: Storage; blobDir: string }> {
  const blobDir = tempDir();
  const records = await mongoRecords({ url: mongo.getUri(), db: `ck_host_${crypto.randomBytes(4).toString('hex')}` });
  return { blobDir, storage: { kind: 'cloud', blobs: wrap(new FsBlobs(blobDir)), jobs: records.jobs, workspaces: records.workspaces, consentRecords: records.consentRecords, close: records.close } };
}

type S = Awaited<ReturnType<typeof startService>>;
async function scan(s: S, url: string): Promise<string> {
  const res = await request(s.app).post('/api/batches').send({ urls: url, quick: true }).expect(201);
  const id = (res.body as CreateBatchResponse).jobs[0].id;
  await waitForStatus(s, id, ['done']);
  await s.settled();
  return id;
}

describe('split storage on the host', () => {
  it('a rescan compares with the previous run, staged into its own scratch and gone after', async () => {
    const { storage } = await split();
    const s = await startService({}, {}, { storage });
    const first = await scan(s, 'shop.example.com');
    await new Promise((r) => setTimeout(r, 5));
    const second = await scan(s, 'www.example.com');
    const cmd = s.store.get(second)!.log.find((l) => l.includes('$ complykit consent'))!;
    const runId = s.store.get(first)!.result!.consent!.runId!;
    expect(cmd).toContain(`--previous ${path.join(s.config.dataDir, 'jobs', second, 'previous', runId)}`);
    expect(fs.existsSync(path.join(s.config.dataDir, 'jobs', second))).toBe(false);
    expect(fs.existsSync(path.join(s.config.dataDir, 'jobs', first))).toBe(false);
  });

  it('consent-config runs in scratch and its files are served from blobs', async () => {
    const { storage, blobDir } = await split();
    const s = await startService({}, {}, { storage });
    const id = await scan(s, 'shop.example.com');
    const body = (await request(s.app).post(`/api/jobs/${id}/consent-config`).send({ by: 'Ann' }).expect(200)).body as ConsentConfigResponse;
    expect(fs.existsSync(path.join(blobDir, 'jobs', id, 'consent', 'consent-config', 'complykit-config.json'))).toBe(true);
    expect((await request(s.app).get(body.files.snippet).expect(200)).text).toContain('complykit-config');
    expect(fs.existsSync(path.join(s.config.dataDir, 'jobs', id))).toBe(false);
  });

  it('a failed upload is retried once; a job whose upload keeps failing stays done and keeps serving from scratch', async () => {
    let failures = 1;
    const flaky = (b: Blobs): Blobs => {
      const upload = b.upload.bind(b);
      return Object.assign(Object.create(b) as Blobs, { upload: (...a: Parameters<Blobs['upload']>) => (failures-- > 0 ? Promise.reject(new Error('spaces down')) : upload(...a)) });
    };
    const { storage, blobDir } = await split(flaky);
    const s = await startService({}, {}, { storage });
    const id = await scan(s, 'shop.example.com');
    expect(s.store.get(id)!.status).toBe('done');
    expect(fs.existsSync(path.join(blobDir, 'jobs', id, 'consent'))).toBe(true); // the retry went through

    failures = 99;
    const id2 = await scan(s, 'www.example.com');
    expect(s.store.get(id2)!.status).toBe('done');
    expect(fs.existsSync(path.join(blobDir, 'jobs', id2))).toBe(false);
    expect(fs.existsSync(path.join(s.config.dataDir, 'jobs', id2, 'consent'))).toBe(true); // kept: the only copy
    await request(s.app).get(s.store.get(id2)!.result!.consent!.reportUrl).expect(200); // served from scratch meanwhile
  });

  it('a failed job publishes its partial files; report files carry an ETag and answer 304', async () => {
    const { storage, blobDir } = await split();
    const s = await startService({}, {}, { storage });
    const id = await scan(s, 'shop.example.com');
    const url = s.store.get(id)!.result!.consent!.reportUrl.replace('consent-report.html', 'evidence/note.txt');
    const first = await request(s.app).get(url).expect(200);
    expect(first.headers.etag).toBeTruthy();
    await request(s.app).get(url).set('If-None-Match', first.headers.etag as string).expect(304);

    const res = await request(s.app).post('/api/batches').send({ urls: 'fail.example.com', quick: true }).expect(201);
    const failed = (res.body as CreateBatchResponse).jobs[0].id;
    await waitForStatus(s, failed, ['failed']);
    await s.settled();
    expect(fs.existsSync(path.join(s.config.dataDir, 'jobs', failed, 'consent'))).toBe(false);
    expect(fs.existsSync(path.join(blobDir, 'jobs', failed, 'job.json'))).toBe(false);
    await request(s.app).get(`/reports/${failed}/job.json`).expect(404);
  });

  it('refuses paths that leave the job', async () => {
    const { storage } = await split();
    const s = await startService({}, {}, { storage });
    const id = await scan(s, 'shop.example.com');
    for (const p of [`/reports/${id}/../../x`, `/reports/${id}/..%2F..%2Fx`, `/reports/${id}/%2e%2e/x`, `/reports/${id}/consent//x`, `/reports/${id}/consent/`]) {
      expect([403, 404], p).toContain((await request(s.app).get(p)).status);
    }
  });
});
