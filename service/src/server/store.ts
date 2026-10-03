// Job store: the in-memory index of every job plus its on-disk twin at
// DATA_DIR/jobs/<id>/job.json. No database — the job directory IS the record,
// and it also holds the check outputs that /reports serves and the zip packs.

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { CheckKind, JobDetail, JobSummary } from '../shared/api.js';

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
  return summary;
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

  constructor(dataDir: string) {
    super();
    this.jobsDir = path.join(dataDir, 'jobs');
  }

  jobDir(id: string): string {
    return path.join(this.jobsDir, id);
  }

  /** Read every job.json from disk. Unreadable dirs are skipped (and logged). */
  async load(): Promise<JobDetail[]> {
    await fsp.mkdir(this.jobsDir, { recursive: true });
    for (const name of await fsp.readdir(this.jobsDir)) {
      if (!isJobId(name)) continue;
      try {
        const job = JSON.parse(await fsp.readFile(path.join(this.jobsDir, name, 'job.json'), 'utf8')) as JobDetail;
        if (job.id !== name) continue;
        job.log ??= [];
        this.jobs.set(job.id, job);
      } catch (err) {
        console.warn(`[store] skipping ${name}: ${(err as Error).message}`);
      }
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

  create(input: { batchId: string; url: string; checks: CheckKind[]; quick: boolean }): JobDetail {
    const id = newId();
    const job: JobDetail = {
      id,
      batchId: input.batchId,
      url: input.url,
      host: new URL(input.url).hostname,
      checks: input.checks,
      quick: input.quick,
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
    await fsp.rm(this.jobDir(id), { recursive: true, force: true });
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
      do {
        this.dirty.delete(id);
        const job = this.jobs.get(id);
        if (!job) break;
        // Atomic replace: a crash mid-write leaves the previous job.json intact.
        const file = path.join(this.jobDir(id), 'job.json');
        const tmp = `${file}.${process.pid}.tmp`;
        try {
          await fsp.mkdir(this.jobDir(id), { recursive: true });
          await fsp.writeFile(tmp, JSON.stringify(job, null, 2));
          await fsp.rename(tmp, file);
        } catch (err) {
          if (this.jobs.has(id)) console.error(`[store] failed to persist ${id}: ${(err as Error).message}`);
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
