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
import { WorkspaceError } from './workspace.js';

export const FINAL_STATUSES: JobDetail['status'][] = ['done', 'failed', 'cancelled'];
export const isFinal = (job: Pick<JobDetail, 'status'>): boolean => FINAL_STATUSES.includes(job.status);

/** The run directory name the CLI makes (a timestamp). */
export const RUN_ID_RE = /^[0-9TZ:.-]{10,40}$/;

/**
 * The one rule for which scratch files may leave the host: published to blobs, served under /reports, listed,
 * zipped. Scratch also holds working state that must never be shown: the raw unredacted collections
 * (consent/gather/), the re-render scratch (consent/rerender/), another job's evaluation fetched for
 * --previous (previous/), KB ingest files (kb-ingest/), the record, and temp files.
 */
export function publishable(rel: string): boolean {
  if (rel === 'job.json' || rel.endsWith('.tmp') || rel.split('/').some((s) => s.startsWith('.ckblob-'))) return false;
  if (/^(previous|kb-ingest)(\/|$)/.test(rel)) return false;
  if (!/^(consent|accessibility)\//.test(rel)) return false;
  return !/^consent\/(gather|rerender)(\/|$)/.test(rel);
}

/** The CLI's `report` and `consent-config` read the evaluation, findings and (inlined) screenshots; HARs are the bulk and are never read. */
const notHar = (rel: string): boolean => !rel.endsWith('.har');

/** How often a job whose publish failed is tried again. */
const UNPUBLISHED_RETRY_MS = 5 * 60_000;

export interface FileInfo {
  size: number;
  etag: string;
}

export class JobFiles {
  readonly blobs: Blobs;
  /** fs backend: scratch and blobs are the same directory tree. */
  readonly local: boolean;
  private readonly publishing = new Map<string, Promise<void>>();
  /** Jobs whose publish (or a commit) failed: their scratch is the only copy and must be kept. They are retried on later reads, every UNPUBLISHED_RETRY_MS, and at shutdown. */
  private readonly unpublished = new Map<string, Pick<JobDetail, 'id' | 'status'>>();
  private retryTimer?: NodeJS.Timeout;
  /** Staged host-side work in progress: the periodic retry leaves scratch alone meanwhile (a successful publish deletes it). */
  private exclusiveRunning = 0;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    storage: Pick<Storage, 'kind' | 'blobs'>,
    readonly jobsDir: string,
    private readonly retryMs = 250,
    private readonly unpublishedRetryMs = UNPUBLISHED_RETRY_MS,
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
  publish(job: Pick<JobDetail, 'id' | 'status'>): void {
    if (this.local || !isFinal(job) || this.publishing.has(job.id)) return;
    const p = this.doPublish(job)
      .catch((err) => console.error(`[publish] ${job.id}: ${(err as Error).message}`))
      .finally(() => this.publishing.delete(job.id));
    this.publishing.set(job.id, p);
  }

  /** Resolves when this job's publish (if any) is done; a job whose publish failed earlier is tried again first. */
  async wait(id: string): Promise<void> {
    this.retryUnpublished(id);
    await this.publishing.get(id);
  }

  /** Start a new publish for the job(s) whose last one failed (all, or just `only`). */
  private retryUnpublished(only?: string): void {
    for (const [id, job] of this.unpublished) if (only === undefined || only === id) this.publish(job);
  }

  private keepScratch(job: Pick<JobDetail, 'id' | 'status'>): void {
    this.unpublished.set(job.id, job);
    if (this.retryTimer) return;
    this.retryTimer = setInterval(() => {
      if (!this.unpublished.size) {
        clearInterval(this.retryTimer);
        this.retryTimer = undefined;
        return;
      }
      if (!this.exclusiveRunning) this.retryUnpublished();
    }, this.unpublishedRetryMs);
    this.retryTimer.unref();
  }

  /** Publishes in flight. */
  pending(): number {
    return this.publishing.size;
  }

  async settled(): Promise<void> {
    this.retryUnpublished();
    while (this.publishing.size) await Promise.allSettled([...this.publishing.values()]);
  }

  private async doPublish(job: Pick<JobDetail, 'id' | 'status'>): Promise<void> {
    const dir = this.scratchDir(job.id);
    if (!fs.existsSync(dir)) {
      this.unpublished.delete(job.id); // nothing left to lose
      return;
    }
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
    this.keepScratch(job);
    throw new Error(`could not upload the job's files (kept on local disk): ${(lastErr as Error).message}`);
  }

  // --- reads (blobs for a finished job, scratch for a running one) ---------------------

  private blobFirst(job: Pick<JobDetail, 'status'>): boolean {
    return !this.local && isFinal(job);
  }

  private scratchPath(id: string, rel: string): string {
    return path.join(this.scratchDir(id), ...rel.split('/'));
  }

  /** May a scratch file be shown? Never working state (publishable), and for a finished job only while its scratch is the only (or an unfinished) copy. */
  private scratchReadable(job: Pick<JobDetail, 'id' | 'status'>, rel: string): boolean {
    return publishable(rel) && (!isFinal(job) || this.publishing.has(job.id) || this.unpublished.has(job.id));
  }

  async head(job: Pick<JobDetail, 'id' | 'status'>, rel: string): Promise<BlobInfo | null> {
    if (this.local || this.blobFirst(job)) {
      const b = await this.blobs.head(this.key(job.id, rel));
      if (b || this.local) return b;
    }
    if (!this.scratchReadable(job, rel)) return null;
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
    if (!this.scratchReadable(job, rel)) return null;
    return fsp.readFile(this.scratchPath(job.id, rel)).catch(() => null);
  }

  async read(job: Pick<JobDetail, 'id' | 'status'>, rel: string): Promise<Readable | null> {
    if (this.local || this.blobFirst(job)) {
      const s = await this.blobs.read(this.key(job.id, rel));
      if (s || this.local) return s;
    }
    if (!this.scratchReadable(job, rel)) return null;
    const file = this.scratchPath(job.id, rel);
    try {
      if (!(await fsp.stat(file)).isFile()) return null;
    } catch {
      return null;
    }
    return fs.createReadStream(file);
  }

  /** Every file of the job as '/'-separated paths relative to the job (job.json is a record and not among them). A finished job's list is blobs only, unless its scratch is still the fuller copy (publish running or failed). */
  async list(job: Pick<JobDetail, 'id' | 'status'>): Promise<string[]> {
    const prefix = `jobs/${job.id}/`;
    const out = new Set<string>();
    if (this.local || this.blobFirst(job)) for await (const b of this.blobs.list(prefix)) out.add(b.key.slice(prefix.length));
    if (!this.local && this.scratchReadable(job, 'consent/x')) for (const rel of await walkLocal(this.scratchDir(job.id)).catch(() => [])) if (publishable(rel)) out.add(rel);
    out.delete('job.json');
    return [...out].sort();
  }

  // --- host-side CLI work (re-render, consent-config, --previous) ------------------------

  /** One at a time (cloud only; the fs backend works in place and runs freely): staged work is memory-heavy, ~1 GB on the largest site. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.local) return fn();
    const counted = async (): Promise<T> => {
      this.exclusiveRunning++;
      try {
        return await fn();
      } finally {
        this.exclusiveRunning--;
      }
    };
    const run = this.tail.then(counted, counted);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Download the run's evaluation into the job's scratch (no HARs). A no-op when scratch is the blob store, or already holds the job. */
  async stage(job: Pick<JobDetail, 'id'>): Promise<void> {
    if (this.local) return;
    await this.wait(job.id); // a failed publish gets another go; if it still fails the scratch is the only copy
    if (this.unpublished.has(job.id)) return;
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

  /**
   * Put these scratch files (paths relative to the job) into blobs, one at a time in the order given, so a
   * failure leaves blobs with a prefix of the new generation, never a mix chosen by upload timing (callers
   * order the files so the one readers open first comes last). One retry of the whole list; if that fails too
   * the scratch is kept (it holds the only copy of the new files; `unpublished` also gets the job re-published
   * later) and the error says `commitFailed: true`. A no-op for the fs backend.
   */
  async commit(job: Pick<JobDetail, 'id' | 'status'>, rels: string[]): Promise<void> {
    const jobId = job.id;
    if (this.local || !rels.length) return;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        for (const rel of rels) await this.blobs.upload(this.scratchDir(jobId), `jobs/${jobId}/`, (r) => r === rel);
        return;
      } catch (err) {
        lastErr = err;
        if (attempt === 0) await new Promise((r) => setTimeout(r, this.retryMs));
      }
    }
    this.keepScratch(job);
    console.error(`[commit] ${jobId}: could not upload ${rels.length} file(s), scratch kept: ${(lastErr as Error).message}`);
    throw new WorkspaceError(500, `could not store the updated files (kept on the host, will be retried): ${(lastErr as Error).message}`, { commitFailed: true });
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
