// A job's files, and where they are (plans/do-hosting.md, "Storage").
//
// Two places, one rule:
//
//   scratch  DATA_DIR/jobs/<id>/…   where running work happens (the CLI's cwd).
//   blobs    jobs/<id>/…            the finished, redacted files (Spaces, or any Blobs).
//
// A job's scratch becomes blobs when the job reaches a final state (publish),
// and is deleted after that (cloud only). With the fs backend the blobs root IS
// DATA_DIR, so scratch and blob are the same place and publish, stage and clean
// are no-ops: that is today's behavior, byte for byte.
//
// Reads follow the job's state: a running job's files are in scratch; a
// finished job's are in blobs, with scratch as the fallback for the window
// between "status=done" and "publish finished" (and for a publish that failed).
// job.json is a record (storage.jobs), never a blob.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { JobDetail } from '../shared/api.js';
import { walkLocal } from './storage/fs-blobs.js';
import type { BlobInfo, Blobs, Storage } from './storage/types.js';

export const FINAL_STATUSES: JobDetail['status'][] = ['done', 'failed', 'cancelled'];
export const isFinal = (job: Pick<JobDetail, 'status'>): boolean => FINAL_STATUSES.includes(job.status);

/** The run directory name the CLI makes (a timestamp). */
export const RUN_ID_RE = /^[0-9TZ:.-]{10,40}$/;

/** What publish leaves behind: working directories, temp files, the record. */
function publishable(rel: string): boolean {
  if (rel === 'job.json' || rel.endsWith('.tmp') || rel.split('/').some((s) => s.startsWith('.ckblob-'))) return false;
  if (!/^(consent|accessibility)\//.test(rel)) return false;
  return !/^consent\/(gather|rerender)\//.test(rel);
}

/** The CLI's `report` and `consent-config` read the evaluation, findings and (inlined) screenshots; HARs are the bulk and are never read. */
const notHar = (rel: string): boolean => !rel.endsWith('.har');

export interface FileInfo {
  size: number;
  etag: string;
}

export class JobFiles {
  readonly blobs: Blobs;
  /** fs backend: scratch and blobs are the same directory tree. */
  readonly local: boolean;
  private readonly publishing = new Map<string, Promise<void>>();
  /** Jobs whose publish failed: their scratch is the only copy and must be kept. */
  private readonly unpublished = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    storage: Pick<Storage, 'kind' | 'blobs'>,
    readonly jobsDir: string,
    private readonly retryMs = 250,
  ) {
    this.blobs = storage.blobs;
    this.local = storage.kind === 'fs';
  }

  scratchDir(id: string): string {
    return path.join(this.jobsDir, id);
  }

  key(id: string, rel: string): string {
    return `jobs/${id}/${rel}`;
  }

  // --- publish ----------------------------------------------------------------------

  /** Upload a finished job's files and clear its scratch. Tracked: `wait` and `settled` see it. A failure is logged, never fatal. */
  publish(job: JobDetail): void {
    if (this.local || !isFinal(job) || this.publishing.has(job.id)) return;
    const p = this.doPublish(job)
      .catch((err) => console.error(`[publish] ${job.id}: ${(err as Error).message}`))
      .finally(() => this.publishing.delete(job.id));
    this.publishing.set(job.id, p);
  }

  /** Resolves when this job's publish (if any) is done. */
  async wait(id: string): Promise<void> {
    await this.publishing.get(id);
  }

  /** Publishes in flight. */
  pending(): number {
    return this.publishing.size;
  }

  async settled(): Promise<void> {
    while (this.publishing.size) await Promise.allSettled([...this.publishing.values()]);
  }

  private async doPublish(job: JobDetail): Promise<void> {
    const dir = this.scratchDir(job.id);
    if (!fs.existsSync(dir)) return;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.blobs.upload(dir, `jobs/${job.id}/`, publishable);
        this.unpublished.delete(job.id);
        await fsp.rm(dir, { recursive: true, force: true });
        return;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, this.retryMs));
      }
    }
    // Keep the scratch: reads fall back to it, and a later restart of nothing will lose it, but deleting would lose the only copy.
    this.unpublished.add(job.id);
    throw new Error(`could not upload the job's files (kept on local disk): ${(lastErr as Error).message}`);
  }

  // --- reads (blobs for a finished job, scratch for a running one) ---------------------

  private blobFirst(job: Pick<JobDetail, 'status'>): boolean {
    return !this.local && isFinal(job);
  }

  private scratchPath(id: string, rel: string): string {
    return path.join(this.scratchDir(id), ...rel.split('/'));
  }

  async head(job: Pick<JobDetail, 'id' | 'status'>, rel: string): Promise<BlobInfo | null> {
    if (this.local || this.blobFirst(job)) {
      const b = await this.blobs.head(this.key(job.id, rel));
      if (b || this.local) return b;
    }
    try {
      const st = await fsp.stat(this.scratchPath(job.id, rel));
      if (!st.isFile()) return null;
      return { key: this.key(job.id, rel), size: st.size, etag: `${st.size}-${Math.round(st.mtimeMs * 1000)}`, modified: st.mtime.toISOString() };
    } catch {
      return null;
    }
  }

  async get(job: Pick<JobDetail, 'id' | 'status'>, rel: string): Promise<Buffer | null> {
    if (this.local || this.blobFirst(job)) {
      const b = await this.blobs.get(this.key(job.id, rel));
      if (b || this.local) return b;
    }
    return fsp.readFile(this.scratchPath(job.id, rel)).catch(() => null);
  }

  async read(job: Pick<JobDetail, 'id' | 'status'>, rel: string): Promise<Readable | null> {
    if (this.local || this.blobFirst(job)) {
      const s = await this.blobs.read(this.key(job.id, rel));
      if (s || this.local) return s;
    }
    const file = this.scratchPath(job.id, rel);
    try {
      if (!(await fsp.stat(file)).isFile()) return null;
    } catch {
      return null;
    }
    return fs.createReadStream(file);
  }

  /** Every file of the job as '/'-separated paths relative to the job (job.json is a record and not among them). */
  async list(job: Pick<JobDetail, 'id' | 'status'>): Promise<string[]> {
    const prefix = `jobs/${job.id}/`;
    const out = new Set<string>();
    if (this.local || this.blobFirst(job)) for await (const b of this.blobs.list(prefix)) out.add(b.key.slice(prefix.length));
    if (!this.local) for (const rel of await walkLocal(this.scratchDir(job.id)).catch(() => [])) out.add(rel);
    out.delete('job.json');
    return [...out].sort();
  }

  // --- host-side CLI work (re-render, consent-config, --previous) ------------------------

  /** One at a time (cloud only; the fs backend works in place and runs freely): staged work is memory-heavy, ~1 GB on the largest site. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.local) return fn();
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Download the run's evaluation into the job's scratch (no HARs). A no-op when scratch is the blob store, or already holds the job. */
  async stage(job: Pick<JobDetail, 'id'>): Promise<void> {
    if (this.local || this.unpublished.has(job.id)) return;
    await this.blobs.download(`jobs/${job.id}/consent/`, path.join(this.scratchDir(job.id), 'consent'), notHar);
  }

  /**
   * The directory of an earlier run's evaluation, for `--previous`: undefined when that run has none.
   * Cloud: downloaded (no evidence) into the CONSUMER job's own scratch, so nothing here is shared with that run's job.
   */
  async previousRunDir(consumerId: string, jobId: string, runId: string): Promise<string | undefined> {
    const rel = `consent/.comply/runs/${runId}`;
    if (this.local) {
      const dir = this.scratchPath(jobId, rel);
      return fs.existsSync(path.join(dir, 'tracking.json')) ? dir : undefined;
    }
    let has: BlobInfo | null = null;
    try {
      has = await this.blobs.head(this.key(jobId, `${rel}/tracking.json`));
    } catch {
      return undefined; // not a usable key
    }
    if (!has) return undefined;
    const dest = path.join(this.scratchDir(consumerId), 'previous', runId);
    await this.blobs.download(`jobs/${jobId}/${rel}/`, dest, (r) => !r.startsWith('evidence/'));
    return fs.existsSync(path.join(dest, 'tracking.json')) ? dest : undefined;
  }

  /** Put these scratch files (paths relative to the job) into blobs. A no-op for the fs backend. */
  async commit(jobId: string, rels: string[]): Promise<void> {
    if (this.local || !rels.length) return;
    const want = new Set(rels);
    await this.blobs.upload(this.scratchDir(jobId), `jobs/${jobId}/`, (r) => want.has(r));
  }

  /** Delete the job's staged scratch (cloud only; never a job whose publish failed). */
  async clean(jobId: string): Promise<void> {
    if (this.local || this.unpublished.has(jobId)) return;
    await fsp.rm(this.scratchDir(jobId), { recursive: true, force: true });
  }

  // --- delete ------------------------------------------------------------------------

  /** Every file of the job, in blobs and in scratch. Waits for an in-flight publish first, so nothing is re-uploaded after. */
  async removeAll(id: string): Promise<void> {
    await this.wait(id);
    await this.blobs.deletePrefix(`jobs/${id}/`);
    await fsp.rm(this.scratchDir(id), { recursive: true, force: true });
    this.unpublished.delete(id);
  }
}
