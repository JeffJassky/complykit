// Two pieces: tailing the consent CLI's --events file (NDJSON, appended while
// the run progresses), and folding those events into the job's progress,
// metrics, and result as the API contract shapes them.

import fsp from 'node:fs/promises';
import type { JobDetail, JobResult, LawScanProgress } from '../shared/api.js';
import type { Law, LawId } from '../shared/laws.js';

// --- Event shapes written by `complykit consent --events` ---------------------

type ScenarioStatus = 'tested' | 'not-tested' | 'not-applicable';

export type ConsentEvent =
  | { type: 'start'; at: string; runId: string; url: string; locations: string[] }
  /** `runs`: visits per scenario (absent from older CLIs = 1); the location plans scenarios x runs steps. */
  | { type: 'location'; at: string; location: string; verdict: string; observed?: string; scenarios: string[]; runs?: number; note?: string }
  /** `run`: set only on a slowed-connection repeat (2..runs); absent = the first visit. */
  | { type: 'scenario-start'; at: string; location: string; scenario: string; run?: number }
  | {
      type: 'scenario-done';
      at: string;
      location: string;
      scenario: string;
      run?: number;
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
  /** A collect-only run finished: its collection.json is in runDir. */
  | { type: 'collected'; at: string; runId: string; runDir: string; locations: string[] }
  | { type: 'error'; at: string; message: string }
  /** The owner report (owner-report.json) was rewritten: after each visit (live), and once more when the run is written (final). GET /api/jobs/:id/report reads it. */
  | { type: 'live'; at: string; file: string; stage: 'live' | 'final'; visitsDone: number; visitsTotal: number };

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
    // A read already in flight may have sized the file before the writer's last
    // append; let it finish, then read once more so nothing written is missed.
    await this.reading;
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
  private locations: string[];
  private locationsSeen = 0;
  /** Visits per scenario, by location (from its `location` event). */
  private runsAt = new Map<string, number>();
  done?: Extract<ConsentEvent, { type: 'done' }>;
  error?: string;

  constructor(
    private readonly job: JobDetail,
    private readonly extraUnits: number,
    /** The laws a multi-law job scans under, in catalog order; known before the collectors announce themselves. */
    laws: readonly Law[] = [],
  ) {
    this.locations = laws.map((l) => l.locationId);
    // The one place job.metrics.laws is written (plans/per-law-report-contract.md, B1).
    if (laws.length) {
      job.metrics.laws = laws.map((l) => ({ id: l.id, locationId: l.locationId, region: l.flyRegion, local: !!l.local, state: 'waiting', visitsDone: 0, visitsTotal: 0 }));
    }
  }

  private lawAt(location: string): LawScanProgress | undefined {
    return this.job.metrics.laws?.find((l) => l.locationId === location);
  }

  /**
   * Set a law's state for what events cannot say (a worker starting, a law failing).
   * `failed` is terminal. Returns true when something changed.
   */
  setLaw(id: LawId, patch: Partial<Pick<LawScanProgress, 'state' | 'error'>>): boolean {
    const law = this.job.metrics.laws?.find((l) => l.id === id);
    if (!law || law.state === 'failed') return false;
    let changed = false;
    if (patch.state !== undefined && patch.state !== law.state) {
      law.state = patch.state;
      changed = true;
    }
    if (patch.error !== undefined && patch.error !== law.error) {
      law.error = patch.error;
      changed = true;
    }
    return changed;
  }

  /** Returns true when the job changed (so the caller persists + broadcasts). */
  apply(ev: ConsentEvent): boolean {
    const { job } = this;
    const p = job.progress;
    const m = job.metrics;
    switch (ev.type) {
      case 'start':
        // Several collectors (multi-region) each announce their own location; a merge announces them all again.
        for (const l of ev.locations ?? []) if (!this.locations.includes(l)) this.locations.push(l);
        // Once scenarios are planned a later start (the merge's) must not move the phase back.
        if (this.planned === 0) {
          p.phase = 'verifying-location';
          p.current = this.locations.length ? `verifying ${this.locations.join(', ')}` : undefined;
        }
        for (const l of ev.locations ?? []) {
          const law = this.lawAt(l);
          if (law && (law.state === 'waiting' || law.state === 'starting')) law.state = 'verifying';
        }
        break;
      case 'location': {
        this.locationsSeen++;
        const runs = Math.max(1, Math.floor(Number(ev.runs) || 1));
        this.runsAt.set(ev.location, runs);
        this.planned += (ev.scenarios?.length ?? 0) * runs;
        // The visit order of the CLI (concurrency 1): each scenario, then its repeats.
        if (ev.scenarios?.length) {
          m.planned ??= [];
          for (const scenario of ev.scenarios) {
            for (let run = 1; run <= runs; run++) m.planned.push({ location: ev.location, scenario, ...(run > 1 ? { run } : {}) });
          }
        }
        m.location = { id: ev.location, verdict: ev.verdict, ...(ev.observed ? { observed: ev.observed } : {}) };
        const lawHere = this.lawAt(ev.location);
        if (lawHere && lawHere.state !== 'failed') {
          lawHere.verdict = ev.verdict;
          if (ev.observed) lawHere.observed = ev.observed;
          if (ev.scenarios?.length) {
            lawHere.state = 'scanning';
            lawHere.visitsTotal = ev.scenarios.length * runs;
          } else {
            lawHere.state = 'failed';
            lawHere.error = ev.verdict + (ev.note ? ` — ${ev.note}` : '');
          }
        }
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
        p.current = `${ev.location} · ${ev.scenario}${this.repeatLabel(ev.location, ev.run)}`;
        m.scenarios.push({ location: ev.location, scenario: ev.scenario, ...(isRepeat(ev.run) ? { run: ev.run } : {}), status: 'running' });
        {
          const law = this.lawAt(ev.location);
          if (law && law.state !== 'failed') {
            law.current = { scenario: ev.scenario, ...(isRepeat(ev.run) ? { run: ev.run } : {}) };
            if (law.state === 'verifying') law.state = 'scanning';
          }
        }
        break;
      case 'scenario-done': {
        const run = isRepeat(ev.run) ? ev.run : undefined;
        let entry = findLast(m.scenarios, (s) => s.location === ev.location && s.scenario === ev.scenario && s.run === run && s.status === 'running');
        if (!entry) {
          entry = { location: ev.location, scenario: ev.scenario, ...(run ? { run } : {}), status: 'running' };
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
        {
          const law = this.lawAt(ev.location);
          if (law && law.state !== 'failed') {
            law.visitsDone++;
            law.current = undefined;
            if (ev.banner) law.banner = ev.banner;
          }
        }
        if (this.allPlannedDone()) {
          p.phase = 'analyzing';
          p.current = 'analyzing evidence';
        }
        break;
      }
      case 'collected':
        for (const l of ev.locations ?? []) {
          const law = this.lawAt(l);
          if (law && law.state !== 'failed') law.state = 'collected';
        }
        break;
      case 'done':
        this.done = ev;
        p.current = undefined;
        for (const law of m.laws ?? []) if (law.state === 'collected') law.state = 'done';
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

  /** " (slow-connection repeat)" for run 2 of 2; numbered when a location plans more repeats. */
  private repeatLabel(location: string, run: number | undefined): string {
    if (!isRepeat(run)) return '';
    const repeats = (this.runsAt.get(location) ?? run) - 1;
    return repeats > 1 ? ` (slow-connection repeat ${run - 1} of ${repeats})` : ' (slow-connection repeat)';
  }

  private allPlannedDone(): boolean {
    return this.locationsSeen >= this.locations.length && this.job.progress.done >= this.planned;
  }
}

export function fraction(done: number, total: number): number {
  return total > 0 ? Math.min(1, done / total) : 0;
}

function isRepeat(run: number | undefined): run is number {
  return typeof run === 'number' && run > 1;
}

function findLast<T>(arr: T[], pred: (x: T) => boolean): T | undefined {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return arr[i];
  return undefined;
}
