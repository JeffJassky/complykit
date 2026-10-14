// Job store: the in-memory index of every job plus its stored record
// (storage.jobs: DATA_DIR/jobs/<id>/job.json with the fs backend, a Mongo
// document with the cloud backend). The job's files are JobFiles' business:
// DATA_DIR/jobs/<id> is the job's scratch directory (where running work
// happens), and finished files live in blobs (job-files.ts).

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CheckKind, JobDetail, JobSummary } from '../shared/api.js';
import { siteDomain } from './domains.js';
import { JobFiles } from './job-files.js';
import { fsStorage } from './storage/fs.js';
import type { JobRecords, Storage } from './storage/types.js';
import type { LawId } from '../shared/laws.js';

export const LOG_LIMIT = 200;

/** Job ids are generated here and validated before touching the filesystem. */
const ID_RE = /^[a-z0-9]{6,40}$/;
export function isJobId(id: string): boolean {
  return ID_RE.test(id);
}

/** Time-sortable, filesystem-safe id: base36 millis + random hex. */
export function newId(): string {
  return Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

export function toSummary(job: JobDetail): JobSummary {
  // Everything except the log, which only GET /api/jobs/:id returns.
  const { log: _log, ...summary } = job;
  let site: string | undefined;
  try {
    site = siteDomain(new URL(job.url).hostname);
  } catch {
    /* no usable URL: no site */
  }
  return site ? { ...summary, site } : summary;
}

export interface StoreEvents {
  change: [job: JobDetail];
  removed: [id: string];
}

export class JobStore extends EventEmitter<StoreEvents> {
  private readonly jobs = new Map<string, JobDetail>();
  /** Per-job write coalescing: one write in flight, at most one queued. */
  private readonly writing = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();
  readonly jobsDir: string;
  private readonly records: JobRecords;
  /** Where this store's jobs' files are: scratch under DATA_DIR/jobs, finished files in blobs. */
  readonly files: JobFiles;

  /** Waits between attempts at a failed record write (5 attempts over ~30 s by default). */
  private readonly retryMs: number[];

  constructor(dataDir: string, storage: Storage = fsStorage(dataDir), retryMs: number[] = [2000, 4000, 8000, 16000]) {
    super();
    this.retryMs = retryMs;
    this.jobsDir = path.join(dataDir, 'jobs');
    this.records = storage.jobs;
    this.files = new JobFiles(storage, this.jobsDir);
  }

  jobDir(id: string): string {
    return path.join(this.jobsDir, id);
  }

  /** Read every stored job record. Unreadable ones are skipped (and logged by the storage). */
  async load(): Promise<JobDetail[]> {
    fs.mkdirSync(this.jobsDir, { recursive: true });
    for (const job of await this.records.loadAll()) {
      job.log ??= [];
      job.slowRepeat ??= false; // jobs from before the option
      this.jobs.set(job.id, job);
    }
    return this.list();
  }

  get(id: string): JobDetail | undefined {
    return this.jobs.get(id);
  }

  /** Newest first. */
  list(): JobDetail[] {
    return [...this.jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id.localeCompare(a.id)));
  }

  create(input: { batchId: string; url: string; checks: CheckKind[]; quick: boolean; slowRepeat?: boolean; laws?: LawId[]; authorizedAt?: string }): JobDetail {
    const id = newId();
    const job: JobDetail = {
      id,
      batchId: input.batchId,
      url: input.url,
      host: new URL(input.url).hostname,
      checks: input.checks,
      quick: input.quick,
      // A quick scan is always one pass; the repeat only applies to the consent check.
      slowRepeat: Boolean(input.slowRepeat) && !input.quick && input.checks.includes('consent'),
      ...(input.laws?.length && input.checks.includes('consent') ? { laws: input.laws, ...(input.authorizedAt ? { authorizedAt: input.authorizedAt } : {}) } : {}),
      status: 'queued',
      createdAt: new Date().toISOString(),
      progress: { fraction: 0, done: 0, total: 0, phase: 'queued' },
      metrics: { requests: 0, thirdPartyRequests: 0, parties: 0, cookies: 0, scenarios: [] },
      log: [],
    };
    fs.mkdirSync(this.jobDir(id), { recursive: true });
    this.jobs.set(id, job);
    this.update(job);
    return job;
  }

  /** Call after mutating a job: persists (coalesced) and notifies listeners. */
  update(job: JobDetail): void {
    if (!this.jobs.has(job.id)) return; // deleted meanwhile
    this.emit('change', job);
    void this.persist(job.id);
  }

  appendLog(job: JobDetail, lines: string[]): void {
    job.log.push(...lines);
    if (job.log.length > LOG_LIMIT) job.log.splice(0, job.log.length - LOG_LIMIT);
    // Log lines alone don't notify the stream (summaries don't carry the log);
    // they ride along with the next persist.
    void this.persist(job.id);
  }

  async remove(id: string): Promise<void> {
    if (!this.jobs.delete(id)) return;
    await this.writing.get(id)?.catch(() => undefined);
    await this.records.remove(id);
    await this.files.removeAll(id);
    this.emit('removed', id);
  }

  /** Resolves when every pending write has hit the disk. */
  async flush(): Promise<void> {
    while (this.writing.size) await Promise.allSettled([...this.writing.values()]);
  }

  private persist(id: string): Promise<void> {
    const inFlight = this.writing.get(id);
    if (inFlight) {
      this.dirty.add(id);
      return inFlight;
    }
    const run = (async () => {
      await Promise.resolve(); // let writing.set() below happen first
      let failures = 0;
      do {
        this.dirty.delete(id);
        const job = this.jobs.get(id);
        if (!job) break;
        try {
          await this.records.put(job);
          failures = 0;
        } catch (err) {
          if (!this.jobs.has(id)) break;
          failures++;
          if (failures <= this.retryMs.length) {
            // Keep the job dirty so the loop writes again: a final status (done + runId) must not be lost to a blip.
            console.warn(`[store] failed to persist ${id} (attempt ${failures}, retrying): ${(err as Error).message}`);
            this.dirty.add(id);
            await new Promise((r) => setTimeout(r, this.retryMs[failures - 1]));
          } else {
            console.error(`[store] gave up persisting job ${id} after ${failures} attempts: ${(err as Error).message}`);
            failures = 0; // the next change starts afresh
          }
        }
      } while (this.dirty.has(id));
      // Same synchronous step as the final dirty check, so a persist() call
      // can't slip in between "nothing left to write" and "no write in flight".
      this.writing.delete(id);
    })();
    this.writing.set(id, run);
    return run;
  }
}
