import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CreateBatchResponse, JobReportResponse, RerenderResponse } from '../src/shared/api.js';
import { FsBlobs } from '../src/server/storage/fs-blobs.js';
import { mongoRecords } from '../src/server/storage/mongo.js';
import type { Storage } from '../src/server/storage/types.js';
import { binaryParser, startService, stopAll, tempDir, waitForStatus } from './helpers.js';

// Phase 2 contract (plans/do-hosting.md, "Storage"): the host keeps nothing it
// needs on its own disk. Files live in Blobs, records in Mongo; DATA_DIR is
// scratch. Each test here wipes the scratch after a scan finishes and checks
// the job, its report, its zip, its history and a re-render still work.
//
// Blobs are FsBlobs on a directory OUTSIDE DATA_DIR (a stand-in for Spaces with
// the same interface), so any code that still reads DATA_DIR/jobs directly fails.
//
// createApp takes the storage as a third argument: createApp(config, runnerOptions, { storage }).

let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
}, 120_000);
afterAll(async () => {
  await mongo?.stop();
});
afterEach(stopAll);

async function splitStorage(): Promise<{ storage: Storage; blobDir: string }> {
  const blobDir = tempDir();
  const records = await mongoRecords({ url: mongo.getUri(), db: `ck_split_${crypto.randomBytes(4).toString('hex')}` });
  const storage: Storage = { kind: 'cloud', blobs: new FsBlobs(blobDir), jobs: records.jobs, workspaces: records.workspaces, consentRecords: records.consentRecords, configSnapshots: records.configSnapshots, close: records.close };
  return { storage, blobDir };
}

type S = Awaited<ReturnType<typeof startService>>;
const start = (storage: Storage, overrides: Parameters<typeof startService>[0] = {}) => startService({ ...overrides }, {}, { storage });

async function scan(s: S, url: string): Promise<string> {
  const res = await request(s.app).post('/api/batches').send({ urls: url, quick: true }).expect(201);
  const id = (res.body as CreateBatchResponse).jobs[0].id;
  await waitForStatus(s, id, ['done']);
  // The job is published once it is done; give the upload its moment.
  await s.settled();
  return id;
}

const wipeScratch = (s: S) => fsp.rm(path.join(s.config.dataDir, 'jobs'), { recursive: true, force: true });

function zipEntries(buf: Buffer): string[] {
  const names: string[] = [];
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) !== 0x06054b50) continue;
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

describe('split storage: the host disk is scratch', () => {
  it('a finished job is published: record in the record store, files in blobs, scratch cleared', async () => {
    const { storage, blobDir } = await splitStorage();
    const s = await start(storage);
    const id = await scan(s, 'shop.example.com');
    const job = s.store.get(id)!;
    const runId = job.result!.consent!.runId!;

    expect((await storage.jobs.loadAll()).find((j) => j.id === id)).toMatchObject({ id, status: 'done' });
    expect(fs.existsSync(path.join(blobDir, 'jobs', id, 'consent', '.comply', 'runs', runId, 'owner-report.json'))).toBe(true);
    expect(fs.existsSync(path.join(blobDir, 'jobs', id, 'consent', '.comply', 'runs', runId, 'evidence', 'tracking', 'local', 'do-nothing', 'visit.har'))).toBe(true);
    // Records are not files: no job.json in blobs.
    expect(fs.existsSync(path.join(blobDir, 'jobs', id, 'job.json'))).toBe(false);
    // Scratch holds nothing for a published job.
    expect(fs.existsSync(path.join(s.config.dataDir, 'jobs', id, 'consent'))).toBe(false);
  });

  it('with the scratch wiped: report page, report files, zip, history and a re-render all work', async () => {
    const { storage } = await splitStorage();
    const s = await start(storage);
    const first = await scan(s, 'shop.example.com');
    const id = await scan(s, 'www.example.com');
    await wipeScratch(s);

    const page = (await request(s.app).get(`/api/jobs/${id}/report`).expect(200)).body as JobReportResponse;
    expect(page.report).not.toBeNull();
    expect(page.history.map((h) => h.jobId)).toEqual([id, first]);
    expect(page.firstScan).toMatchObject({ jobId: first });
    expect(typeof page.firstScan?.score === 'number' || page.firstScan?.score === undefined).toBe(true);

    const job = s.store.get(id)!;
    const html = await request(s.app).get(job.result!.consent!.reportUrl).expect(200);
    expect(html.headers['content-type']).toMatch(/text\/html/);
    expect(html.text).toContain('Consent report for');
    expect(html.text).toContain('id="ck-service"'); // the workspace config is still injected
    expect(html.headers['cache-control']).toBe('no-store'); // the injected config changes without the file changing
    expect(html.headers.etag).toBeUndefined();
    await request(s.app).get(job.result!.consent!.reportUrl.replace('consent-report.html', 'evidence/note.txt')).expect(200);
    await request(s.app).get(`/reports/${id}/nope.html`).expect(404);

    const zip = await request(s.app).get(`/api/jobs/${id}/download`).buffer(true).parse(binaryParser as Parameters<request.Test['parse']>[0]).expect(200);
    const names = zipEntries(zip.body as Buffer);
    expect(names.some((n) => n.endsWith('/job.json'))).toBe(true);
    expect(names.some((n) => n.endsWith('/consent/evidence/tracking/local/do-nothing/visit.har'))).toBe(true);
    expect(names.some((n) => n.endsWith('/consent/consent-report.html'))).toBe(true);

    await request(s.app).patch('/api/sites/example.com/workspace').send({ entries: { 'class:tool-abc': { value: { category: 'analytics', categoryChosen: true } } } }).expect(200);
    const rr = (await request(s.app).post(`/api/jobs/${id}/rerender`).send({}).expect(200)).body as RerenderResponse;
    expect(rr).toMatchObject({ ok: true, classifications: 1 });
    // The re-rendered report is what blobs now serve (and the scratch used for it is gone again).
    const after = (await request(s.app).get(job.result!.consent!.reportUrl).expect(200)).text;
    expect(after).toContain('Re-rendered');
    expect(after).toContain('class:tool-abc');
    expect((await request(s.app).get(rr.previousReportUrl).expect(200)).text).toBe(html.text);
    expect(fs.existsSync(path.join(s.config.dataDir, 'jobs', id, 'consent', '.comply'))).toBe(false);
  });

  it('a restarted host on a fresh disk sees every job and serves its report', async () => {
    const { storage } = await splitStorage();
    const s1 = await start(storage);
    const id = await scan(s1, 'shop.example.com');
    await s1.stop(200);
    const s2 = await start(storage); // new DATA_DIR (testConfig makes a fresh temp dir)
    expect(s2.store.get(id)).toMatchObject({ status: 'done' });
    await request(s2.app).get(s2.store.get(id)!.result!.consent!.reportUrl).expect(200);
    expect(((await request(s2.app).get(`/api/jobs/${id}/report`).expect(200)).body as JobReportResponse).report).not.toBeNull();
  });

  it('deleting a job removes its record and every blob under it', async () => {
    const { storage, blobDir } = await splitStorage();
    const s = await start(storage);
    const id = await scan(s, 'shop.example.com');
    await request(s.app).delete(`/api/jobs/${id}`).expect(204);
    expect((await storage.jobs.loadAll()).some((j) => j.id === id)).toBe(false);
    expect(fs.existsSync(path.join(blobDir, 'jobs', id))).toBe(false);
  });

  it('workspaces and consent records live in the record store, not on disk', async () => {
    const { storage } = await splitStorage();
    const s = await start(storage);
    await request(s.app).patch('/api/sites/example.com/workspace').send({ entries: { 'class:x': { value: 'analytics' } } }).expect(200);
    expect((await storage.workspaces.read('example.com'))?.ws.entries['class:x']?.value).toBe('analytics');
    expect(fs.existsSync(path.join(s.config.dataDir, 'sites', 'example.com', 'workspace.json'))).toBe(false);

    const ORIGIN = 'https://www.example-shop.test';
    const record = { id: 'k3j9x0aa81QmZp72fD', at: new Date().toISOString(), categories: { analytics: true }, configHash: 'sha256:ab12cd34', toolVersion: '0.1.0', regime: 'opt-in' };
    await request(s.app).post('/api/consent-records').set('Origin', ORIGIN).send(record).expect(204);
    expect(await storage.consentRecords.exists('example-shop.test')).toBe(true);
    expect(fs.existsSync(path.join(s.config.dataDir, 'sites', 'example-shop.test'))).toBe(false);
    const exp = await request(s.app).get('/api/sites/example-shop.test/consent-records?format=jsonl').expect(200);
    expect(exp.text).toContain('k3j9x0aa81QmZp72fD');
  });

  it('the knowledge base is restored from blobs on start and saved back after a change', async () => {
    const { storage } = await splitStorage();
    await storage.blobs.put('kb/queue.json', '{"version":1,"items":[]}');
    const s = await start(storage);
    expect(fs.readFileSync(path.join(s.config.kbDir, 'queue.json'), 'utf8')).toBe('{"version":1,"items":[]}');
    // After anything that changes the KB directory, the host uploads it (Service.saveKb is what routes call).
    fs.writeFileSync(path.join(s.config.kbDir, 'entry.json'), '{"e":1}');
    await s.saveKb();
    expect((await storage.blobs.get('kb/entry.json'))?.toString()).toBe('{"e":1}');
  });
});

describe('fs storage (the default) is unchanged', () => {
  it('jobs, reports and workspaces stay under DATA_DIR exactly as before', async () => {
    const s = await startService();
    const id = await scan(s, 'shop.example.com');
    expect(fs.existsSync(path.join(s.config.dataDir, 'jobs', id, 'job.json'))).toBe(true);
    const runId = s.store.get(id)!.result!.consent!.runId!;
    expect(fs.existsSync(path.join(s.config.dataDir, 'jobs', id, 'consent', '.comply', 'runs', runId, 'owner-report.json'))).toBe(true);
    await request(s.app).patch('/api/sites/example.com/workspace').send({ entries: { 'class:x': { value: 'analytics' } } }).expect(200);
    expect(fs.existsSync(path.join(s.config.dataDir, 'sites', 'example.com', 'workspace.json'))).toBe(true);
  });
});
