// One-shot migration (plans/do-hosting.md, "Migration and cutover"): copy a
// DATA_DIR (the Fly volume, pulled to this machine) into the cloud backend.
//
//   DATA_BACKEND=cloud MONGO_URL=… MONGO_CA="$(cat ca.pem)" SPACES_ENDPOINT=… SPACES_BUCKET=… SPACES_KEY=… SPACES_SECRET=… \
//     npx tsx scripts/migrate-to-cloud.ts <dataDir> [--dry-run]
//
// Idempotent: a blob already there with the same size is skipped; a job record
// is replaced; a workspace is replaced (the source is the authority until
// cutover); a site's consent records missing in the cloud (by id) are appended, so an
// interrupted copy is completed and none is appended twice. Raw collections (gather/) and scratch
// (rerender/, previous/) are never copied. Running jobs are refused: stop scans first.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAX_FILE_BYTES } from '../src/server/consent-records.js';
import { loadConfig } from '../src/server/config.js';
import { cloudStorage, fsStorage, type Storage } from '../src/server/storage/index.js';
import type { ConsentRecord } from '../src/server/consent-records.js';

const SKIP_DIR = /(^|\/)(gather|rerender|previous)\//;

/** Append the source records whose ids the destination lacks (an interrupted copy is completed; a finished one is left alone). Returns how many. */
export async function copyMissingRecords(src: Pick<Storage, 'consentRecords'>, dst: Pick<Storage, 'consentRecords'>, domain: string, dry = false): Promise<number> {
  const have = new Set<string>();
  for await (const r of dst.consentRecords.records(domain)) have.add(r.id);
  const records: ConsentRecord[] = [];
  for await (const r of src.consentRecords.records(domain)) if (!have.has(r.id)) records.push(r);
  if (!dry) for (const r of records) await dst.consentRecords.append(domain, r);
  return records.length;
}

async function main(): Promise<void> {
  const [dataDir, ...rest] = process.argv.slice(2);
  const dry = rest.includes('--dry-run');
  if (!dataDir || !fs.existsSync(path.join(dataDir, 'jobs'))) throw new Error('usage: migrate-to-cloud.ts <dataDir with jobs/> [--dry-run]');
  const config = loadConfig(process.env);
  if (config.dataBackend !== 'cloud' || !config.cloud) throw new Error('set DATA_BACKEND=cloud and the cloud settings');

  const src = fsStorage(path.resolve(dataDir));
  const dst: Storage = await cloudStorage(config.cloud, { consentMaxBytes: 2 * MAX_FILE_BYTES }); // the fs cap lets one record past MAX_FILE_BYTES; Mongo would refuse it (507) and abort the copy
  const n = { jobs: 0, blobs: 0, skipped: 0, bytes: 0, workspaces: 0, consentSites: 0, consentRecords: 0, kb: 0 };
  try {
    const jobs = await src.jobs.loadAll();
    const running = jobs.filter((j) => j.status === 'queued' || j.status === 'running');
    if (running.length) throw new Error(`jobs still queued/running: ${running.map((j) => j.id).join(', ')} — let them finish or cancel them first`);

    for (const job of jobs) {
      for await (const b of src.blobs.list(`jobs/${job.id}/`)) {
        const rel = b.key.slice(`jobs/${job.id}/`.length);
        if (rel === 'job.json' || SKIP_DIR.test(rel) || rel.endsWith('.tmp')) continue;
        // A finished job's live per-law reports are superseded by the merged report; a failed one keeps them.
        if (job.status === 'done' && rel.startsWith('consent/live/')) continue;
        const there = await dst.blobs.head(b.key);
        if (there && there.size === b.size) {
          n.skipped++;
          continue;
        }
        if (!dry) await dst.blobs.put(b.key, (await src.blobs.read(b.key))!);
        n.blobs++;
        n.bytes += b.size;
      }
      if (!dry) await dst.jobs.put(job);
      n.jobs++;
      console.log(`job ${job.id} ${job.host} ${job.status}: ${n.blobs} blobs so far (${(n.bytes / 1e6).toFixed(0)} MB)`);
    }

    for (const domain of await src.workspaces.domains()) {
      const w = await src.workspaces.read(domain);
      if (!w) continue;
      // Until cutover the source is the authority: replace what an earlier run copied.
      const there = await dst.workspaces.read(domain);
      if (!dry && (await dst.workspaces.write(domain, w.ws, there?.rev)) === null) throw new Error(`workspace ${domain} changed in the cloud during the copy; run again`);
      n.workspaces++;
    }

    const sites = path.join(dataDir, 'sites');
    for (const domain of fs.existsSync(sites) ? fs.readdirSync(sites) : []) {
      if (!fs.existsSync(path.join(sites, domain, 'consent-records.jsonl'))) continue;
      const copied = await copyMissingRecords(src, dst, domain, dry);
      if (!copied) {
        console.log(`consent records ${domain}: already in the cloud, left alone`);
        continue;
      }
      n.consentSites++;
      n.consentRecords += copied;
    }

    for await (const b of src.blobs.list('kb/')) {
      if (b.key.endsWith('.tmp') || b.key.includes('/.lock')) continue;
      if (!dry) await dst.blobs.put(b.key, (await src.blobs.read(b.key))!);
      n.kb++;
    }

    // Read back: every job's record is there.
    if (!dry) {
      const ids = new Set((await dst.jobs.loadAll()).map((j) => j.id));
      const missing = jobs.filter((j) => !ids.has(j.id));
      if (missing.length) throw new Error(`records missing after copy: ${missing.map((j) => j.id).join(', ')}`);
    }
    console.log(`${dry ? 'DRY RUN — would copy' : 'copied'}: ${JSON.stringify(n)}`);
  } finally {
    await src.close();
    await dst.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
