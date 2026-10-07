// Two pieces: tailing the consent CLI's --events file (NDJSON, appended while
// the run progresses), and folding those events into the job's progress,
// metrics, and result as the API contract shapes them.

import fsp from 'node:fs/promises';
import type { JobDetail, JobResult } from '../shared/api.js';

// --- Event shapes written by `complykit consent --events` ---------------------

type ScenarioStatus = 'tested' | 'not-tested' | 'not-applicable';

export type ConsentEvent =
  | { type: 'start'; at: string; runId: string; url: string; locations: string[] }
  | { type: 'location'; at: string; location: string; verdict: string; observed?: string; scenarios: string[]; note?: string }
  | { type: 'scenario-start'; at: string; location: string; scenario: string }
  | {
      type: 'scenario-done';
      at: string;
      location: string;
      scenario: string;
      status: ScenarioStatus;
      reason?: string;
      requests: number;
      thirdPartyRequests: number;
      parties: number;
      cookies: number;
      durationMs: number;
      banner?: string;
    }
  | {
      type: 'done';
      at: string;
      runId: string;
      runDir: string;
      report: string;
      /** The owner's change list beside the report (B2); absent from older CLIs. */
      changeList?: string;
      findings: number;
      totals: NonNullable<JobResult['consent']>['totals'];
      parties: number;
      unrecognized: number;
    }
  | { type: 'error'; at: string; message: string };

// --- Tail ---------------------------------------------------------------------

/**
 * Polls a growing NDJSON file and hands each complete line to `onEvent`. Reads
 * only new bytes; a trailing partial line is held until its newline arrives.
 * The file may not exist yet (the CLI creates it when the run starts).
 */
export class NdjsonTail {
  private offset = 0;
  private partial = '';
  private timer?: NodeJS.Timeout;
  private reading?: Promise<void>;

  constructor(
    private readonly file: string,
    private readonly onEvent: (ev: ConsentEvent) => void,
    private readonly pollMs = 500,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.poll(), this.pollMs);
  }

  /** Stop polling after one last read (call once the writer has exited). */
  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.poll();
    // A writer that died mid-line leaves a fragment; try it as a final line.
    if (this.partial.trim()) this.emitLine(this.partial);
    this.partial = '';
  }

  private poll(): Promise<void> {
    // Serialize reads: overlapping polls would interleave offsets.
    this.reading ??= this.read().finally(() => (this.reading = undefined));
    return this.reading;
  }

  private async read(): Promise<void> {
    let fh: fsp.FileHandle;
    try {
      fh = await fsp.open(this.file, 'r');
    } catch {
      return; // not created yet
    }
    try {
      const { size } = await fh.stat();
      if (size < this.offset) {
        this.offset = 0; // truncated/replaced: start over
        this.partial = '';
      }
      if (size === this.offset) return;
      const buf = Buffer.alloc(size - this.offset);
      const { bytesRead } = await fh.read(buf, 0, buf.length, this.offset);
      this.offset += bytesRead;
      const text = this.partial + buf.subarray(0, bytesRead).toString('utf8');
      const lines = text.split('\n');
      this.partial = lines.pop() ?? '';
      for (const line of lines) this.emitLine(line);
    } finally {
      await fh.close();
    }
  }

  private emitLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const ev = JSON.parse(trimmed) as ConsentEvent;
      if (ev && typeof ev === 'object' && typeof ev.type === 'string') this.onEvent(ev);
    } catch {
      /* not JSON (or a torn line) — ignore */
    }
  }
}

// --- Mapping events → job -----------------------------------------------------

/**
 * Folds consent events into one job. Holds the counters the contract doesn't
 * expose (planned scenarios, locations seen) so `progress` can be derived.
 * `extraUnits` is the work after consent (1 when accessibility is enabled).
 */
export class ConsentProgress {
  private planned = 0;
  private locations: string[] = [];
  private locationsSeen = 0;
  done?: Extract<ConsentEvent, { type: 'done' }>;
  error?: string;

  constructor(
    private readonly job: JobDetail,
    private readonly extraUnits: number,
  ) {}

  /** Returns true when the job changed (so the caller persists + broadcasts). */
  apply(ev: ConsentEvent): boolean {
    const { job } = this;
    const p = job.progress;
    const m = job.metrics;
    switch (ev.type) {
      case 'start':
        this.locations = ev.locations ?? [];
        p.phase = 'verifying-location';
        p.current = this.locations.length ? `verifying ${this.locations.join(', ')}` : undefined;
        break;
      case 'location': {
        this.locationsSeen++;
        this.planned += ev.scenarios?.length ?? 0;
        m.location = { id: ev.location, verdict: ev.verdict, ...(ev.observed ? { observed: ev.observed } : {}) };
        p.total = this.planned + this.extraUnits;
        if (ev.scenarios?.length) {
          p.phase = 'scenarios';
          p.current = `${ev.location} · ${ev.verdict}`;
        } else {
          // Unverified location: nothing will run there. Say why.
          p.current = `${ev.location}: ${ev.verdict}${ev.note ? ` — ${ev.note}` : ''}`;
          if (this.allPlannedDone()) p.phase = 'analyzing';
        }
        break;
      }
      case 'scenario-start':
        p.phase = 'scenarios';
        p.current = `${ev.location} · ${ev.scenario}`;
        m.scenarios.push({ location: ev.location, scenario: ev.scenario, status: 'running' });
        break;
      case 'scenario-done': {
        let entry = findLast(m.scenarios, (s) => s.location === ev.location && s.scenario === ev.scenario && s.status === 'running');
        if (!entry) {
          entry = { location: ev.location, scenario: ev.scenario, status: 'running' };
          m.scenarios.push(entry);
        }
        entry.status = ev.status;
        if (ev.reason) entry.reason = ev.reason;
        entry.durationMs = ev.durationMs;
        p.done++;
        m.requests += ev.requests ?? 0;
        m.thirdPartyRequests += ev.thirdPartyRequests ?? 0;
        m.parties = Math.max(m.parties, ev.parties ?? 0);
        m.cookies = Math.max(m.cookies, ev.cookies ?? 0);
        if (ev.banner) m.banner = ev.banner;
        if (this.allPlannedDone()) {
          p.phase = 'analyzing';
          p.current = 'analyzing evidence';
        }
        break;
      }
      case 'done':
        this.done = ev;
        p.current = undefined;
        job.result = {
          ...(job.result ?? { downloadUrl: `/api/jobs/${job.id}/download` }),
          consent: {
            runId: ev.runId,
            findings: ev.findings,
            totals: ev.totals,
            parties: ev.parties,
            unrecognized: ev.unrecognized,
            // The run's real location under the job dir; /reports serves it as-is
            // so the report's run-relative evidence links keep working.
            reportUrl: `/reports/${job.id}/consent/.comply/runs/${encodeURIComponent(ev.runId)}/consent-report.html`,
            // Written beside the report by the CLI (it is not passed --out, so both sit in the run dir).
            ...(ev.changeList ? { changeListUrl: `/reports/${job.id}/consent/.comply/runs/${encodeURIComponent(ev.runId)}/change-list.md` } : {}),
          },
        };
        break;
      case 'error':
        this.error = ev.message;
        break;
      default:
        return false;
    }
    p.fraction = fraction(p.done, p.total);
    return true;
  }

  private allPlannedDone(): boolean {
    return this.locationsSeen >= this.locations.length && this.job.progress.done >= this.planned;
  }
}

export function fraction(done: number, total: number): number {
  return total > 0 ? Math.min(1, done / total) : 0;
}

function findLast<T>(arr: T[], pred: (x: T) => boolean): T | undefined {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return arr[i];
  return undefined;
}
