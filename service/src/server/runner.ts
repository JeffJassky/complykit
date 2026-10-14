// The job queue and the check processes. FIFO, `concurrency` jobs at a time;
// each job runs consent (if enabled) then accessibility (if enabled) as
// complykit CLI child processes with cwd inside the job's directory.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { JobDetail, LawScanState } from '../shared/api.js';
import { LAWS, type Law } from '../shared/laws.js';
import { flyFleet, type Fleet, type WorkerHandle } from './fleet.js';
import { RegionLocks } from './region-lock.js';
import { DEFAULT_WORKER_REGION, WORKER_SECRET_HEADER, type AccessibilityRequest, type CollectRequest, type ConsentRequest, type MergeRequest } from './worker-protocol.js';
import { consentRunsFor, jobTimeoutFor, type ServiceConfig } from './config.js';
import { ConsentProgress, NdjsonTail, fraction } from './events.js';
import { RUN_ID_RE } from './job-files.js';
import { failStaleJobs } from './lifecycle.js';
import type { JobStore } from './store.js';
import type { WorkspaceStore } from './workspace.js';
import type { SiteWorkspace } from '../shared/api.js';

/** Why a running job is being stopped from the outside. */
type StopReason = 'cancelled' | 'stopped' | 'timeout';

interface Active {
  job: JobDetail;
  /** Every running CLI child (a multi-region job runs several at once). */
  children: Set<ChildProcess>;
  /** Aborted when the job is stopped, so remote collections wind down too. */
  abort: AbortController;
  reason?: StopReason;
  /** Resolves when the job's run loop has fully finished. */
  finished: Promise<void>;
  /** Starts the job's time limit (idempotent). With a fleet the clock starts once the job holds its region locks, not while it queues for them. */
  startClock: () => void;
}

/** How many trailing stderr lines go into a failure message. */
const STDERR_TAIL = 6;

/** Multi-region timing; the tests shrink these. */
export interface RunnerOptions {
  /** The regional worker fleet (default: Fly Machines when FLY_API_TOKEN, WORKER_IMAGE and WORKER_SECRET are set). */
  fleet?: Fleet;
  /** Between remote starts, so the sites' bot walls don't see every region at once (3 s). */
  staggerMs?: number;
  /** Worker poll interval (2 s). */
  remotePollMs?: number;
  /** One remote collection's cap (30 min). */
  remoteTimeoutMs?: number;
  /** Ingests a run directory (its tracking.json) into the host's knowledge base; saving it is the callee's business. Default: none. */
  ingestRun?: (dir: string) => Promise<void>;
  /** While a collected worker waits for the merge, the host pings it this often so its idle shutdown doesn't fire (60 s). */
  keepAliveMs?: number;
  /** Cap on waiting for one region's worker (45 min). */
  lockWaitMs?: number;
  /** Total time a shutdown may take before it gives up on the rest (12 s). */
  shutdownBoundMs?: number;
  /** Re-reads every stored job record, for the late recovery pass (after a rolling deploy two hosts briefly share one database). */
  reloadJobs?: () => Promise<JobDetail[]>;
  /** When the late recovery pass runs after boot (10 min). */
  lateRecoveryMs?: number;
}

const REMOTE_STAGGER_MS = 3_000;
const REMOTE_POLL_MS = 2_000;
const REMOTE_TIMEOUT_MS = 30 * 60_000;
/** Consecutive failed polls before a worker is given up on. */
const REMOTE_MAX_POLL_FAILURES = 8;
/** Workers self-stop after 3 idle minutes; a kept worker is pinged well inside that. */
const KEEP_ALIVE_MS = 60_000;
const LOCK_WAIT_MS = 45 * 60_000;
const SHUTDOWN_BOUND_MS = 12_000;
const LATE_RECOVERY_MS = 10 * 60_000;

/** The host lost the worker (8 failed polls). The worker may have finished all the same. */
class LostContact extends Error {}

interface Gathered {
  law: Law;
  /** Local collection: the run dir holding collection.json. */
  dir?: string;
  /** Fleet collection: the worker still holding the run (for the merge to pull), until `done()`. */
  worker?: { handle: WorkerHandle; jobId: string };
  error?: string;
}

/** Runs once: deletes the worker's job, releases the Machine, unlocks its region. Never throws. */
type Cleanup = () => Promise<void>;

export class Runner {
  private readonly queue: string[] = [];
  private readonly active = new Map<string, Active>();
  private accepting = true;

  constructor(
    private readonly store: JobStore,
    private readonly config: ServiceConfig,
    /** Called whenever a job reaches a terminal state (idle tracking; the to-do list after a consent scan). */
    private readonly onSettled: (job?: JobDetail) => void = () => {},
    /** Site workspaces (C3): a consent job applies its site's workspace and records itself as a run. */
    private readonly workspaces?: WorkspaceStore,
    private readonly options: RunnerOptions = {},
  ) {
    this.fleet = options.fleet ?? (config.flyApiToken && config.workerImage && config.workerSecret ? flyFleet({ app: config.workersApp, token: config.flyApiToken, image: config.workerImage, secret: config.workerSecret }) : undefined);
  }

  private readonly fleet?: Fleet;
  private readonly bootAt = Date.now();
  private shuttingDown = false;
  private lateTimer?: NodeJS.Timeout;
  /** Machines this process holds right now, and the worker jobs it posted to each: what a shutdown must stop. */
  private readonly held = new Map<WorkerHandle, Set<string>>();
  /** Per-region lock: a worker runs one job at a time, and this process may run several jobs (and Verify). */
  readonly regionLocks = new RegionLocks();

  /** The worker fleet, when one is configured: then every scan runs on it and the host runs none. */
  get workerFleet(): Fleet | undefined {
    return this.fleet;
  }

  /** The shared secret for host → worker calls. A fleet without one is a configuration error. */
  private secret(): string {
    if (!this.config.workerSecret) throw new Error('a worker fleet is configured but WORKER_SECRET is not set; the host cannot call its workers');
    return this.config.workerSecret;
  }

  /** What every host → worker call carries: the route to the Machine and the secret. */
  private workerHeaders(h: WorkerHandle): Record<string, string> {
    return { ...h.headers, [WORKER_SECRET_HEADER]: this.secret() };
  }

  get running(): number {
    return this.active.size;
  }
  get queued(): number {
    return this.queue.length;
  }
  isBusy(): boolean {
    return this.active.size > 0 || this.queue.length > 0;
  }

  enqueue(id: string): void {
    if (!this.accepting || this.queue.includes(id) || this.active.has(id)) return;
    this.queue.push(id);
    this.pump();
  }

  /**
   * Cancel a queued or running job. Resolves once any child process is gone,
   * so the caller can safely delete the job directory afterwards.
   * Returns false when the job wasn't queued or running.
   */
  async cancel(id: string): Promise<boolean> {
    const qi = this.queue.indexOf(id);
    if (qi >= 0) {
      this.queue.splice(qi, 1);
      const job = this.store.get(id);
      if (job) {
        job.status = 'cancelled';
        job.finishedAt = new Date().toISOString();
        job.progress.current = undefined;
        this.store.update(job);
      }
      this.onSettled();
      return true;
    }
    const a = this.active.get(id);
    if (!a) return false;
    this.stop(a, 'cancelled');
    await a.finished;
    return true;
  }

  /**
   * After boot, once the queue is recovered and before it is re-enqueued: nothing
   * legitimately runs on a worker for a host that just started, but an earlier host's
   * jobs may still be running there (the next POST would answer 409 busy). Stop every
   * worker Machine, best effort; then schedule the late recovery pass.
   */
  async afterBoot(): Promise<void> {
    if (this.fleet) {
      try {
        await this.fleet.stopAll(30_000);
        console.log('[boot] stopped any worker Machines an earlier host left running');
      } catch (err) {
        console.warn(`[boot] could not stop leftover workers: ${(err as Error).message}`);
      }
    }
    const reload = this.options.reloadJobs;
    if (reload) {
      this.lateTimer = setTimeout(() => void this.lateRecovery(reload), this.options.lateRecoveryMs ?? LATE_RECOVERY_MS);
      this.lateTimer.unref();
    }
  }

  /**
   * A rolling deploy briefly runs two hosts on one database: this one failed the old host's
   * running jobs at boot, the old host's later writes flipped them back, and an old host that
   * was then killed leaves them `running` for good. Jobs this process doesn't own, that began
   * before it booted and are still running or queued, are failed.
   */
  async lateRecovery(reload: () => Promise<JobDetail[]> = this.options.reloadJobs!): Promise<string[]> {
    try {
      const failed = failStaleJobs(this.store, await reload(), { bootAt: this.bootAt, owns: (id) => this.active.has(id) || this.queue.includes(id) });
      if (failed.length) console.log(`[recovery] failed ${failed.length} job(s) left running by an earlier host: ${failed.join(', ')}`);
      return failed;
    } catch (err) {
      console.warn(`[recovery] late pass failed: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Stop accepting and stop every running job ("server stopped"). Bounded: a platform
   * signal gives seconds, and a SIGKILL must leave jobs failed and Machines stopping,
   * not running. So, in order: persist each running job as failed; kill local children;
   * POST /stop to every held Machine (no waiting for it to land); best-effort cancel and
   * delete the worker jobs. Queued jobs stay queued on disk and are picked up after a restart.
   */
  async shutdown(killGraceMs = this.config.killGraceMs): Promise<void> {
    this.accepting = false;
    this.shuttingDown = true;
    clearTimeout(this.lateTimer);
    this.queue.length = 0;
    const all = [...this.active.values()];
    const work = (async () => {
      for (const a of all) {
        a.reason ??= 'stopped';
        const job = a.job;
        if (a.reason === 'stopped' && job.status === 'running') {
          job.status = 'failed';
          job.error = 'server stopped';
          job.finishedAt = new Date().toISOString();
          job.progress.current = undefined;
          this.store.update(job);
        }
      }
      await this.store.flush().catch(() => undefined);
      for (const a of all) this.stop(a, 'stopped', killGraceMs);
      const held = [...this.held];
      await Promise.all(held.map(([h]) => this.fleet!.halt(h, 5_000).catch(() => undefined)));
      await Promise.all(held.flatMap(([h, jobs]) => [...jobs].map((j) => this.endWorkerJob(h, j, true, 2_000))));
      await Promise.all(all.map((a) => a.finished));
    })();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([work, new Promise<void>((r) => (timer = setTimeout(r, this.options.shutdownBoundMs ?? SHUTDOWN_BOUND_MS)))]);
    clearTimeout(timer);
  }

  private pump(): void {
    while (this.accepting && this.active.size < this.config.concurrency && this.queue.length) {
      const id = this.queue.shift()!;
      const job = this.store.get(id);
      if (!job || job.status !== 'queued') continue;
      const a: Active = { job, children: new Set(), abort: new AbortController(), finished: Promise.resolve(), startClock: () => {} };
      this.active.set(id, a);
      a.finished = this.run(a).finally(() => {
        this.active.delete(id);
        this.onSettled(job);
        this.pump();
      });
    }
  }

  private stop(a: Active, reason: StopReason, graceMs = this.config.killGraceMs): void {
    a.reason ??= reason;
    for (const child of a.children) killTree(child, graceMs);
    a.abort.abort();
  }

  private async run(a: Active): Promise<void> {
    const { job } = a;
    const consent = job.checks.includes('consent');
    const a11y = job.checks.includes('accessibility');
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.error = undefined;
    job.progress = consent
      ? { fraction: 0, done: 0, total: 0, phase: 'verifying-location', current: 'starting browser' }
      : { fraction: 0, done: 0, total: 1, phase: 'accessibility', current: 'accessibility scan' };
    this.store.update(job);

    // One pass gets the base cap; each slowed repeat adds SLOW_REPEAT_TIMEOUT_FACTOR times it.
    const timeoutMs = jobTimeoutFor(this.config, consent ? consentRunsFor(job, this.config) : 1);
    let timeout: NodeJS.Timeout | undefined;
    a.startClock = () => {
      timeout ??= setTimeout(() => this.stop(a, 'timeout'), timeoutMs);
    };
    // With a fleet the clock starts when the job holds its region locks: waiting behind another scan is not the job's time.
    if (!this.fleet) a.startClock();
    try {
      if (consent) await this.runConsent(a, a11y ? 1 : 0);
      if (a11y) await this.runAccessibility(a);
      job.status = 'done';
      job.progress = { ...job.progress, phase: 'finished', fraction: 1, current: undefined };
    } catch (err) {
      job.progress.current = undefined;
      if (a.reason === 'cancelled') {
        job.status = 'cancelled';
      } else {
        job.status = 'failed';
        job.error =
          a.reason === 'stopped'
            ? 'server stopped'
            : a.reason === 'timeout'
              ? `timed out after ${Math.round(timeoutMs / 60_000)} minutes`
              : (err as Error).message;
      }
    } finally {
      clearTimeout(timeout);
    }
    job.finishedAt = new Date().toISOString();
    // Partial output (evidence of a failed run) is still downloadable.
    job.result = { ...job.result, downloadUrl: `/api/jobs/${job.id}/download` };
    this.store.update(job);
  }

  private async runConsent(a: Active, extraUnits: number): Promise<void> {
    const { job } = a;
    if (job.laws?.length) return this.runConsentLaws(a, extraUnits);
    if (this.fleet) return this.runConsentOnWorker(a, extraUnits);
    const dir = path.join(this.store.jobDir(job.id), 'consent');
    await fsp.mkdir(dir, { recursive: true });
    const eventsFile = path.join(dir, 'events.ndjson');
    await fsp.rm(eventsFile, { force: true });

    const mapper = new ConsentProgress(job, extraUnits);
    const tail = new NdjsonTail(
      eventsFile,
      (ev) => {
        if (mapper.apply(ev)) this.store.update(job);
      },
      this.config.pollMs,
    );
    const site = await this.siteArgs(job, dir);
    tail.start();
    // COMPLYKIT_DEBUG drops --quiet so the CLI's per-visit stage trace lands in the job log.
    const args = ['consent', '--url', job.url, '--cwd', dir, '--events', eventsFile, ...(process.env.COMPLYKIT_DEBUG ? [] : ['--quiet']), '--runs', String(consentRunsFor(job, this.config)), ...(job.quick ? ['--quick'] : []), ...site.args];
    let res: StepResult;
    try {
      res = await this.step(a, 'consent', args, dir);
    } finally {
      await tail.stop();
    }
    if (a.reason) throw new Error(a.reason);
    if (mapper.error) throw new Error(withTail(`consent check failed: ${mapper.error}`, res.stderr));
    if (res.code !== 0) throw new Error(withTail(`consent check exited with ${exitText(res)}`, res.stderr));
    if (!mapper.done) throw new Error(withTail('consent check exited without a result', res.stderr));
    if (site.domain) await this.recordRun(job, site.domain, mapper.done);
  }

  /** A consent job without laws, with a fleet: one worker in the default region scans, publishes the finished run to blobs, and the host relays its events. */
  private async runConsentOnWorker(a: Active, extraUnits: number): Promise<void> {
    const { job } = a;
    const dir = path.join(this.store.jobDir(job.id), 'consent');
    await fsp.mkdir(dir, { recursive: true });
    const eventsFile = path.join(dir, 'events.ndjson');
    await fsp.rm(eventsFile, { force: true });
    const mapper = new ConsentProgress(job, extraUnits);
    const tail = new NdjsonTail(
      eventsFile,
      (ev) => {
        if (mapper.apply(ev)) this.store.update(job);
      },
      this.config.pollMs,
    );
    const appendLine = (line: string) => fs.appendFileSync(eventsFile, line.endsWith('\n') ? line : line + '\n');
    const site = await this.siteArgs(job, dir, true);
    const workerJob = `${job.id}-consent`;
    const kb = this.kbPrefix();
    const body: ConsentRequest = {
      jobId: workerJob,
      url: job.url,
      quick: job.quick,
      runs: consentRunsFor(job, this.config),
      ...(site.workspace ? { workspace: site.workspace } : {}),
      ...(site.previous ? { previous: site.previous } : {}),
      ...(kb ? { kb } : {}),
      publish: { prefix: `jobs/${job.id}/consent/` },
    };
    tail.start();
    try {
      await this.runOnWorker(a, { region: DEFAULT_WORKER_REGION, route: 'consent', workerJob, tag: 'consent', body, appendLine });
    } finally {
      await tail.stop();
    }
    if (a.reason) throw new Error(a.reason);
    if (mapper.error) throw new Error(`consent check failed: ${mapper.error}`);
    if (!mapper.done) throw new Error('consent check ended without a result');
    if (site.domain) await this.recordRun(job, site.domain, mapper.done);
    await this.ingestWorkerRun(job, mapper.done.runId);
  }

  /**
   * A consent job with laws: one collection per law, all in parallel, then one
   * merge that runs the rules over everything and writes the report.
   *
   * Without a fleet (local development) the `local` law collects in a child
   * process, the others fail ("not configured"), and the merge is a child too.
   * With a fleet the host runs none of it: every law collects on a worker in its
   * region, the first law that collected also merges (pulling the others' runs
   * over the private network) and publishes the finished run to blobs. The
   * workers are held until the merge is over, then every job is deleted and
   * every Machine released.
   */
  private async runConsentLaws(a: Active, extraUnits: number): Promise<void> {
    const { job } = a;
    const laws = LAWS.filter((l) => job.laws!.includes(l.id));
    const fleet = this.fleet;
    const dir = path.join(this.store.jobDir(job.id), 'consent');
    const gatherRoot = path.join(dir, 'gather');
    await fsp.rm(gatherRoot, { recursive: true, force: true });
    // Raw collections exist on this machine only without a fleet.
    if (!fleet) await fsp.mkdir(gatherRoot, { recursive: true });
    await fsp.mkdir(dir, { recursive: true });
    const eventsFile = path.join(dir, 'events.ndjson');
    await fsp.rm(eventsFile, { force: true });

    const liveRoot = path.join(dir, 'live');
    await fsp.rm(liveRoot, { recursive: true, force: true });
    await fsp.mkdir(liveRoot, { recursive: true });
    const live = new LiveFiles(liveRoot);
    const mapper = new ConsentProgress(job, extraUnits, laws);
    // The runner's states for what events cannot carry (a worker starting, a law failing): persisted and broadcast like an event.
    const setLaw: SetLaw = (law, patch) => {
      if (mapper.setLaw(law.id, patch)) this.store.update(job);
    };
    let merged = false;
    // A collector's `error` is that law's failure (the merge says so with --failed); only the merge's counts for the job.
    let merging = false;
    const tail = new NdjsonTail(
      eventsFile,
      (ev) => {
        if (ev.type === 'error' && !merging) return;
        if (mapper.apply(ev)) this.store.update(job);
      },
      this.config.pollMs,
    );
    const site = await this.siteArgs(job, dir, !!fleet);
    const quiet = process.env.COMPLYKIT_DEBUG ? [] : ['--quiet'];
    const appendLine = (line: string) => fs.appendFileSync(eventsFile, line.endsWith('\n') ? line : line + '\n');
    // Worker jobs and Machines to clean up however this ends.
    const cleanups: Cleanup[] = [];
    // Region locks, all taken up front.
    const unlocks = new Map<string, () => void>();
    const mergeOn: { handle?: WorkerHandle; jobId?: string; interrupted: { interrupted: boolean } } = { interrupted: { interrupted: false } };
    tail.start();
    try {
      this.store.appendLog(job, [`[consent] scanning under ${laws.map((l) => l.label).join(', ')} (authorized ${job.authorizedAt ?? 'at submission'})`]);
      const onWorker = (l: Law) => !!fleet || !l.local;
      const remote = laws.filter(onWorker);
      // Every region this job needs, in catalog order (`laws` is), before any collection starts: two jobs that took
      // regions law by law could each hold one the other waits for, and both would wait for ever.
      if (fleet) {
        for (const law of remote) {
          if (unlocks.has(law.flyRegion)) continue;
          unlocks.set(law.flyRegion, await this.regionLocks.lock(law.flyRegion, a.abort.signal, () => this.store.appendLog(job, [`[collect:${law.id}] waiting for the ${law.flyRegion} worker (another scan is using it)`]), this.options.lockWaitMs ?? LOCK_WAIT_MS));
        }
        if (a.reason) throw new Error(a.reason);
      }
      a.startClock();
      const gathered = await Promise.all(
        laws.map((law) => (onWorker(law) ? this.collectRemote(a, law, appendLine, remote.indexOf(law) * (this.options.staggerMs ?? REMOTE_STAGGER_MS), setLaw, live, cleanups, unlocks.get(law.flyRegion)) : this.collectLocal(a, law, gatherRoot, quiet, appendLine, setLaw, live))),
      );
      if (a.reason) throw new Error(a.reason);

      const failed = gathered.filter((g) => !g.dir && !g.worker);
      for (const g of failed) this.store.appendLog(job, [`[consent] ${g.law.label} (${g.law.locationId}) could not be scanned: ${g.error}`]);
      const ok = gathered.filter((g) => g.dir || g.worker);
      if (!ok.length) throw new Error(`no law could be scanned: ${failed.map((g) => `${g.law.label}: ${g.error}`).join('; ')}`);

      job.progress.phase = 'analyzing';
      job.progress.current = 'combining the regions';
      this.store.update(job);
      merging = true;
      let res: StepResult | undefined;
      if (fleet) {
        try {
          await this.mergeOnWorker(a, ok, failed, site, appendLine, mergeOn);
        } catch (err) {
          // The worker may have finished and published before the host lost it: look before failing the job.
          if (!(err instanceof LostContact) || a.reason) throw err;
          await tail.stop();
          if (!(await this.adoptPublishedRun(a, mapper))) throw err;
          this.store.appendLog(job, ['[merge] lost contact with the merge worker, but it had published the finished run; finishing from the published files']);
        }
        await tail.stop();
      } else {
        const failedArgs = failed.flatMap((g) => ['--failed', `${g.law.locationId}=${g.error}`]);
        const args = ['consent', '--merge', ok.map((g) => g.dir).join(','), '--url', job.url, '--cwd', dir, '--events', eventsFile, ...quiet, ...failedArgs, ...site.args];
        res = await this.step(a, 'consent', args, dir);
        await tail.stop();
      }
      if (a.reason) throw new Error(a.reason);
      if (mapper.error) throw new Error(withTail(`consent check failed: ${mapper.error}`, res?.stderr ?? []));
      if (res && res.code !== 0) throw new Error(withTail(`consent merge exited with ${exitText(res)}`, res.stderr));
      if (!mapper.done) throw new Error(withTail('consent merge exited without a result', res?.stderr ?? []));
      merged = true;
      if (site.domain) await this.recordRun(job, site.domain, mapper.done);
      await this.ingestWorkerRun(job, mapper.done.runId, fleet !== undefined);
    } finally {
      await tail.stop(); // idempotent enough: clears the timer, one last read
      await live.settled();
      // The raw collections hold unredacted request bodies and cookie values: never kept.
      await fsp.rm(gatherRoot, { recursive: true, force: true });
      // The live reports are superseded by the merged report; after a failed or cancelled job they stay (the page shows what was collected).
      if (merged) await fsp.rm(liveRoot, { recursive: true, force: true });
      // The merge job first (on its worker), then every collection, Machine and region lock.
      if (mergeOn.handle && mergeOn.jobId) await this.endWorkerJob(mergeOn.handle, mergeOn.jobId, mergeOn.interrupted.interrupted || a.abort.signal.aborted);
      await Promise.all(cleanups.map((c) => c()));
      // Locks of laws that never started a worker (an abort while taking them); idempotent for the rest.
      for (const u of unlocks.values()) u();
    }
  }

  /**
   * The merge worker was lost after publishing? Looks in blobs for this job's run (`jobs/<id>/consent/.comply/runs/<run>/tracking.json`).
   * When the relayed events carry no `done` (the last pull failed), one is made from the published report so the job can finish as done.
   */
  private async adoptPublishedRun(a: Active, mapper: ConsentProgress): Promise<boolean> {
    const { job } = a;
    const blobs = this.store.files.blobs;
    const base = `jobs/${job.id}/consent/.comply/runs/`;
    try {
      let runId = mapper.done?.runId;
      if (runId) {
        if (!(await blobs.head(`${base}${runId}/tracking.json`))) return false;
      } else {
        for await (const info of blobs.list(base)) {
          const m = /^([^/]+)\/tracking\.json$/.exec(info.key.slice(base.length));
          if (m && RUN_ID_RE.test(m[1])) runId = m[1];
        }
        if (!runId) return false;
      }
      if (!mapper.done) {
        let totals: NonNullable<ConsentProgress['done']>['totals'] = { violation: 0, 'needs-review': 0, exposure: 0, practice: 0 } as NonNullable<ConsentProgress['done']>['totals'];
        try {
          const report = JSON.parse((await blobs.get(`${base}${runId}/consent-report.json`))?.toString('utf8') ?? '') as { totals?: typeof totals };
          if (report.totals && typeof report.totals === 'object') totals = { ...totals, ...report.totals };
        } catch {
          /* the run is there; its counts are not */
        }
        const findings = Object.values(totals).reduce((n: number, v) => n + (typeof v === 'number' ? v : 0), 0);
        mapper.apply({ type: 'done', at: new Date().toISOString(), runId, runDir: '', report: '', findings, totals, parties: 0, unrecognized: 0 });
      }
      return !!mapper.done;
    } catch {
      return false;
    }
  }

  /** `POST /internal/merge` on the first collected law's worker; relays its events; returns when it is done (throws when it is not). */
  private async mergeOnWorker(
    a: Active,
    ok: Gathered[],
    failed: Gathered[],
    site: SiteInputs,
    appendLine: (l: string) => void,
    mergeOn: { handle?: WorkerHandle; jobId?: string; interrupted: { interrupted: boolean } },
  ): Promise<void> {
    const { job } = a;
    const first = ok[0].worker!;
    const workerJob = `${job.id}-merge`;
    const kb = this.kbPrefix();
    const body: MergeRequest = {
      jobId: workerJob,
      url: job.url,
      sources: ok.map((g) => ({ law: g.law.id, locationId: g.law.locationId, tarUrl: `${g.worker!.handle.privateUrl}/internal/jobs/${g.worker!.jobId}/run.tar` })),
      failed: failed.map((g) => ({ locationId: g.law.locationId, error: oneLine(g.error ?? 'failed').slice(0, 1000) })),
      ...(site.workspace ? { workspace: site.workspace } : {}),
      ...(site.previous ? { previous: site.previous } : {}),
      ...(kb ? { kb } : {}),
      publish: { prefix: `jobs/${job.id}/consent/` },
    };
    this.store.appendLog(job, [`[merge] merging ${ok.length} collection(s) on the ${first.handle.region} worker`]);
    try {
      await this.postJob(a, first.handle, 'merge', body);
      this.held.get(first.handle)?.add(workerJob);
      mergeOn.handle = first.handle;
      mergeOn.jobId = workerJob;
      await this.followJob(a, first.handle, workerJob, { ok: 'done', appendLine, ctl: mergeOn.interrupted });
    } catch (err) {
      mergeOn.interrupted.interrupted ||= a.abort.signal.aborted;
      if (a.abort.signal.aborted) throw new Error(a.reason ?? 'cancelled');
      const message = `merge on the ${first.handle.region} worker failed: ${(err as Error).message}`;
      throw err instanceof LostContact ? new LostContact(message) : new Error(message);
    }
  }

  /** The law this machine scans from: a collect-only child, its events forwarded into the job's. */
  private async collectLocal(a: Active, law: Law, gatherRoot: string, quiet: string[], appendLine: (l: string) => void, setLaw: SetLaw, live: LiveFiles): Promise<Gathered> {
    const { job } = a;
    const cwd = path.join(gatherRoot, law.id);
    const events = path.join(gatherRoot, `${law.id}.events.ndjson`);
    const fwd = new NdjsonTail(
      events,
      (ev) => {
        appendLine(JSON.stringify(ev));
        if (ev.type === 'live') live.copy(law.id, ev.file);
      },
      this.config.pollMs,
    );
    const failed = (error: string): Gathered => {
      if (!a.reason) setLaw(law, { state: 'failed', error });
      return { law, error };
    };
    try {
      await fsp.mkdir(cwd, { recursive: true });
      setLaw(law, { state: 'starting' });
      fwd.start();
      const args = ['consent', '--collect-only', '--url', job.url, '--locations', law.locationId, '--cwd', cwd, '--events', events, ...quiet, '--runs', String(consentRunsFor(job, this.config)), ...(job.quick ? ['--quick'] : [])];
      const res = await this.step(a, `collect:${law.id}`, args, cwd);
      await fwd.stop();
      if (a.reason) return { law, error: a.reason };
      if (res.code !== 0) return failed(oneLine(withTail(`collection exited with ${exitText(res)}`, res.stderr)));
      const runs = path.join(cwd, '.comply', 'runs');
      const dirs = (await fsp.readdir(runs, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory() && fs.existsSync(path.join(runs, e.name, 'collection.json')));
      if (dirs.length !== 1) return failed('collection left no run directory with collection.json');
      return { law, dir: path.join(runs, dirs[0].name) };
    } catch (err) {
      return failed((err as Error).message);
    } finally {
      await fwd.stop().catch(() => undefined);
    }
  }

  /**
   * A law collected on its region's worker: acquire, collect, follow its events.
   * On success the worker is KEPT (its run.tar is what the merge pulls); its
   * cleanup is pushed to `cleanups` and the caller runs it after the merge.
   * On failure everything is cleaned up here.
   */
  private async collectRemote(a: Active, law: Law, appendLine: (l: string) => void, delayMs: number, setLaw: SetLaw, live: LiveFiles, cleanups: Cleanup[], unlock: (() => void) | undefined): Promise<Gathered> {
    const { job } = a;
    const signal = a.abort.signal;
    const workerJob = `${job.id}-${law.id}`;
    let handle: WorkerHandle | undefined;
    let posted = false;
    let kept = false;
    const ctl = { interrupted: false };
    const check = () => {
      if (signal.aborted) throw new Error(a.reason ?? 'cancelled');
    };
    try {
      if (!this.fleet) throw new Error('multi-region scanning is not configured on this server');
      await sleepAbortable(delayMs, signal);
      check();
      this.store.appendLog(job, [`[collect:${law.id}] starting the worker in ${law.flyRegion}`]);
      setLaw(law, { state: 'starting' });
      handle = await this.fleet.acquire(law.flyRegion);
      this.held.set(handle, new Set());
      check();
      const body: CollectRequest = { jobId: workerJob, url: job.url, locationId: law.locationId, quick: job.quick, runs: consentRunsFor(job, this.config) };
      await this.postJob(a, handle, 'collect', body);
      posted = true;
      this.held.get(handle)?.add(workerJob);
      this.store.appendLog(job, [`[collect:${law.id}] collecting from ${law.flyRegion}`]);

      // The worker's owner report, fetched on each `live` event: one fetch in flight; a live event meanwhile asks for one more after it. Errors (404 included) are ignored.
      const h = handle;
      let fetching = false;
      let again = false;
      const liveReport = () => {
        if (fetching) {
          again = true;
          return;
        }
        fetching = true;
        const p = (async () => {
          do {
            again = false;
            try {
              const r = await fetch(`${h.baseUrl}/internal/jobs/${workerJob}/report`, { headers: this.workerHeaders(h), signal });
              if (r.ok) await live.put(law.id, Buffer.from(await r.arrayBuffer()));
            } catch {
              /* the next live event retries */
            }
          } while (again && !signal.aborted);
        })().finally(() => (fetching = false));
        live.track(p);
      };
      await this.followJob(a, handle, workerJob, {
        ok: 'collected',
        appendLine,
        onLine: (l) => {
          if (isLiveLine(l)) liveReport();
        },
        ctl,
      });
      kept = true;
      // The run stays on the worker for the merge; nothing is fetched here. Until the merge is over the worker is pinged, or its idle shutdown would take the run with it.
      cleanups.push(this.closer(handle, workerJob, unlock, this.keepAlive(handle, workerJob)));
      return { law, worker: { handle, jobId: workerJob } };
    } catch (err) {
      ctl.interrupted ||= signal.aborted;
      const message = signal.aborted ? (a.reason ?? 'cancelled') : (err as Error).message;
      const error = `worker in ${law.flyRegion} failed: ${message}`;
      if (!a.reason) setLaw(law, { state: 'failed', error });
      return { law, error };
    } finally {
      if (!kept) await this.endWorker(handle, posted ? workerJob : undefined, ctl.interrupted, unlock);
    }
  }

  // --- worker plumbing (shared by collections, merge, single-location consent, accessibility) -----------

  /** POST a job-style request to a worker. */
  private async postJob(a: Active, handle: WorkerHandle, route: 'collect' | 'merge' | 'consent' | 'accessibility', body: CollectRequest | MergeRequest | ConsentRequest | AccessibilityRequest): Promise<void> {
    const post = await fetch(`${handle.baseUrl}/internal/${route}`, {
      method: 'POST',
      headers: { ...this.workerHeaders(handle), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: a.abort.signal,
    });
    if (!post.ok) throw new Error(`worker refused the ${route}: HTTP ${post.status} ${(await post.text().catch(() => '')).slice(0, 200)}`.trim());
  }

  /**
   * Follow a worker's job into this one's: its events are appended (and handed to
   * `onLine`) and its state polled until it settles. Resolves when the state is
   * `ok`; throws for any other end, a lost worker, the timeout (`ctl.interrupted`
   * is then set so the caller cancels it) or an abort.
   */
  private async followJob(a: Active, handle: WorkerHandle, workerJob: string, o: { ok: 'collected' | 'done'; appendLine?: (l: string) => void; onLine?: (l: string) => void; ctl: { interrupted: boolean } }): Promise<void> {
    const signal = a.abort.signal;
    const headers = this.workerHeaders(handle);
    const url = (p: string) => `${handle.baseUrl}/internal/jobs/${workerJob}${p}`;
    const pollMs = this.options.remotePollMs ?? REMOTE_POLL_MS;
    const timeoutMs = this.options.remoteTimeoutMs ?? REMOTE_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    let seen = 0;
    const pull = async () => {
      if (!o.appendLine) return;
      const res = await fetch(url(`/events?from=${seen}`), { headers, signal });
      if (!res.ok) throw new Error(`events: HTTP ${res.status}`);
      const lines = (await res.text()).split('\n').filter((l) => l.trim());
      for (const l of lines) {
        o.appendLine(l);
        o.onLine?.(l);
      }
      seen += lines.length;
    };
    let failures = 0;
    for (;;) {
      if (signal.aborted) throw new Error(a.reason ?? 'cancelled');
      let st: { state: string; error?: string } | undefined;
      try {
        await pull();
        const res = await fetch(url(''), { headers, signal });
        if (!res.ok) throw new Error(`state: HTTP ${res.status}`);
        st = (await res.json()) as { state: string; error?: string };
        if (st.state !== 'running') await pull();
        failures = 0;
      } catch (err) {
        if (signal.aborted) throw new Error(a.reason ?? 'cancelled');
        if (++failures >= REMOTE_MAX_POLL_FAILURES) throw new LostContact(`lost contact with the worker: ${(err as Error).message}`);
      }
      if (st && st.state !== 'running') {
        if (st.state === o.ok) return;
        throw new Error(oneLine(st.error ?? `worker ended ${st.state}`));
      }
      if (Date.now() > deadline) {
        o.ctl.interrupted = true;
        throw new Error(`timed out after ${Math.round(timeoutMs / 60_000)} minutes`);
      }
      await sleepAbortable(pollMs, signal);
    }
  }

  /** Cancel (when asked) and delete a job on its worker. Best effort. */
  private async endWorkerJob(handle: WorkerHandle, workerJob: string, cancel: boolean, timeoutMs = 10_000): Promise<void> {
    try {
      const headers = this.workerHeaders(handle);
      const base = `${handle.baseUrl}/internal/jobs/${workerJob}`;
      if (cancel) await fetch(`${base}/cancel`, { method: 'POST', headers, signal: AbortSignal.timeout(timeoutMs) }).catch(() => undefined);
      await fetch(base, { method: 'DELETE', headers, signal: AbortSignal.timeout(timeoutMs) }).catch(() => undefined);
    } catch {
      /* best effort */
    }
  }

  /** Delete the worker's job (if one was posted), release the Machine, unlock the region. Never throws. */
  private async endWorker(handle: WorkerHandle | undefined, workerJob: string | undefined, cancel: boolean, unlock: (() => void) | undefined): Promise<void> {
    try {
      // A shutdown has already stopped every held Machine and has no time to wait for more.
      if (!this.shuttingDown) {
        if (handle && workerJob) await this.endWorkerJob(handle, workerJob, cancel);
        if (handle) await this.fleet!.release(handle).catch(() => undefined);
      }
    } finally {
      if (handle) this.held.delete(handle);
      unlock?.();
    }
  }

  /** A once-only cleanup for a worker that finished its collection and waits for the merge. */
  private closer(handle: WorkerHandle, workerJob: string, unlock: (() => void) | undefined, stopPing: () => void): Cleanup {
    let p: Promise<void> | undefined;
    return () => {
      stopPing();
      return (p ??= this.endWorker(handle, workerJob, false, unlock));
    };
  }

  /** Pings a kept worker until released: any request counts as activity, so its idle shutdown (3 min) cannot take the run before the merge pulls it. */
  private keepAlive(handle: WorkerHandle, workerJob: string): () => void {
    const timer = setInterval(() => {
      fetch(`${handle.baseUrl}/internal/jobs/${workerJob}`, { headers: this.workerHeaders(handle), signal: AbortSignal.timeout(10_000) })
        .then((r) => r.body?.cancel())
        .catch(() => undefined);
    }, this.options.keepAliveMs ?? KEEP_ALIVE_MS);
    timer.unref();
    return () => clearInterval(timer);
  }

  /** Acquire a region's worker, run one job on it to `done` (events relayed when `appendLine` is given), then delete the job and release the Machine. */
  private async runOnWorker(
    a: Active,
    spec: { region: string; route: 'consent' | 'accessibility'; workerJob: string; tag: string; body: ConsentRequest | AccessibilityRequest; appendLine?: (l: string) => void },
  ): Promise<void> {
    const { job } = a;
    const signal = a.abort.signal;
    let handle: WorkerHandle | undefined;
    let posted = false;
    let unlock: (() => void) | undefined;
    const ctl = { interrupted: false };
    try {
      if (!this.fleet) throw new Error('no worker fleet is configured on this server');
      this.secret();
      unlock = await this.regionLocks.lock(spec.region, signal, () => this.store.appendLog(job, [`[${spec.tag}] waiting for the ${spec.region} worker (another scan is using it)`]), this.options.lockWaitMs ?? LOCK_WAIT_MS);
      if (signal.aborted) throw new Error(a.reason ?? 'cancelled');
      a.startClock();
      this.store.appendLog(job, [`[${spec.tag}] starting the worker in ${spec.region}`]);
      handle = await this.fleet.acquire(spec.region);
      this.held.set(handle, new Set());
      if (signal.aborted) throw new Error(a.reason ?? 'cancelled');
      await this.postJob(a, handle, spec.route, spec.body);
      posted = true;
      this.held.get(handle)?.add(spec.workerJob);
      this.store.appendLog(job, [`[${spec.tag}] running on the ${spec.region} worker`]);
      await this.followJob(a, handle, spec.workerJob, { ok: 'done', appendLine: spec.appendLine, ctl });
    } catch (err) {
      ctl.interrupted ||= signal.aborted;
      if (signal.aborted) throw new Error(a.reason ?? 'cancelled');
      throw new Error(`worker in ${spec.region} failed: ${(err as Error).message}`);
    } finally {
      await this.endWorker(handle, posted ? spec.workerJob : undefined, ctl.interrupted, unlock);
    }
  }

  /** The blob prefix of the knowledge base the workers read, when the host's KB is in blobs. */
  private kbPrefix(): string | undefined {
    if (!this.store.files.local) return 'kb/'; // cloud: KbSync mirrors config.kbDir to kb/
    // fs: blobs are rooted at DATA_DIR, where the KB lives by default.
    return path.resolve(this.config.kbDir) === path.join(path.resolve(this.config.dataDir), 'kb') ? 'kb/' : undefined;
  }

  /**
   * The site workspace for this job's domain, written into the job directory and
   * passed as --workspace, plus the previous run of the site (--previous) when
   * its evaluation is still stored. A workspace that can't be read doesn't
   * stop the scan (a scan never needs it to judge the site); the log says so and
   * the report then asks again what the team had classified.
   */
  private async siteArgs(job: JobDetail, dir: string, remote = false): Promise<SiteInputs> {
    if (!this.workspaces) return { args: [] };
    let domain: string | undefined;
    let ws: SiteWorkspace;
    try {
      domain = this.workspaces.domain(new URL(job.url).hostname);
      ws = await this.workspaces.get(domain);
    } catch (err) {
      this.store.appendLog(job, [`[consent] site workspace not applied: ${(err as Error).message}`]);
      return { domain, args: [] };
    }
    const out: SiteInputs = { domain, args: [] };
    if (remote) {
      // A worker runs the CLI: it gets the workspace in the request and the previous run as a blob prefix.
      out.workspace = ws;
      out.previous = await this.previousPrefix(job, ws);
    } else {
      const file = path.join(dir, 'workspace.json');
      await fsp.writeFile(file, JSON.stringify(ws, null, 2) + '\n');
      out.args.push('--workspace', file);
      // Newest first: the latest earlier run whose evaluation is still on disk.
      for (const r of [...ws.runs].reverse()) {
        if (!r.jobId || r.jobId === job.id) continue;
        // With the cloud backend this downloads that run's evaluation into this job's scratch (removed when the job is published).
        const runDir = await this.store.files.previousRunDir(job.id, r.jobId, r.id);
        if (runDir) {
          out.args.push('--previous', runDir);
          break;
        }
      }
    }
    const classified = Object.keys(ws.entries).filter((k) => k.startsWith('class:') && ws.entries[k].value !== null).length;
    const hasPrevious = remote ? !!out.previous : out.args.includes('--previous');
    this.store.appendLog(job, [`[consent] site workspace ${domain}: ${classified} classification(s), ${ws.runs.length} earlier run(s)${hasPrevious ? '' : '; no earlier run on disk to compare with'}`]);
    return out;
  }

  /** The blob prefix of the site's latest earlier run whose evaluation (tracking.json) is stored, for a worker's `--previous`. */
  private async previousPrefix(job: JobDetail, ws: SiteWorkspace): Promise<string | undefined> {
    for (const r of [...ws.runs].reverse()) {
      if (!r.jobId || r.jobId === job.id) continue;
      const prefix = `jobs/${r.jobId}/consent/.comply/runs/${r.id}/`;
      try {
        if (await this.store.files.blobs.head(`${prefix}tracking.json`)) return prefix;
      } catch {
        /* not a usable key: that run has no evaluation to compare with */
      }
    }
    return undefined;
  }

  /**
   * The CLI ran on a worker against a throwaway copy of the KB, so the host's
   * queue never saw this run's unrecognized parties: fetch the run's evaluation
   * (tracking.json) from blobs and `kb ingest` it here. A failure is logged and
   * never fails the job.
   */
  private async ingestWorkerRun(job: JobDetail, runId: string, onWorker = true): Promise<void> {
    if (!onWorker || !this.options.ingestRun) return;
    const tmp = path.join(this.store.jobDir(job.id), 'kb-ingest');
    try {
      await fsp.rm(tmp, { recursive: true, force: true });
      await fsp.mkdir(tmp, { recursive: true });
      const n = await this.store.files.blobs.download(`jobs/${job.id}/consent/.comply/runs/${runId}/`, tmp, (rel) => rel === 'tracking.json');
      if (!n) throw new Error('the run has no tracking.json in blobs');
      await this.options.ingestRun(tmp);
    } catch (err) {
      this.store.appendLog(job, [`[consent] could not add this run to the knowledge base: ${(err as Error).message}`]);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** A finished consent job appends itself to its site's runs. */
  private async recordRun(job: JobDetail, domain: string, done: NonNullable<ConsentProgress['done']>): Promise<void> {
    try {
      await this.workspaces!.patch(domain, {
        runs: [{ id: done.runId, at: done.at, jobId: job.id, url: job.url, meta: { findings: done.findings, totals: done.totals, parties: done.parties, unrecognized: done.unrecognized } }],
      });
    } catch (err) {
      this.store.appendLog(job, [`[consent] could not record this run in the site workspace: ${(err as Error).message}`]);
    }
  }

  private async runAccessibility(a: Active): Promise<void> {
    const { job } = a;
    const p = job.progress;
    // Its own cwd: `report` renders the newest run in that cwd.
    const dir = path.join(this.store.jobDir(job.id), 'accessibility');
    p.phase = 'accessibility';
    p.current = 'accessibility scan';
    p.total = Math.max(p.total, p.done + 1);
    p.fraction = fraction(p.done, p.total);
    this.store.update(job);

    if (this.fleet) {
      // A worker scans and publishes the report to blobs; nothing is written here.
      const body: AccessibilityRequest = { jobId: `${job.id}-accessibility`, url: job.url, publish: { prefix: `jobs/${job.id}/accessibility/` } };
      await this.runOnWorker(a, { region: DEFAULT_WORKER_REGION, route: 'accessibility', workerJob: body.jobId, tag: 'accessibility', body });
    } else {
      await fsp.mkdir(dir, { recursive: true });
      const scan = await this.step(a, 'accessibility', ['scan', '--url', job.url, '--cwd', dir, '--quiet', '--max-pages', '15'], dir);
      if (a.reason) throw new Error(a.reason);
      if (scan.code !== 0) throw new Error(withTail(`accessibility scan exited with ${exitText(scan)}`, scan.stderr));

      p.current = 'accessibility report';
      this.store.update(job);
      const out = path.join(dir, 'report.html');
      const rep = await this.step(a, 'accessibility', ['report', '--format', 'html', '--out', out, '--cwd', dir], dir);
      if (a.reason) throw new Error(a.reason);
      if (rep.code !== 0) throw new Error(withTail(`accessibility report exited with ${exitText(rep)}`, rep.stderr));
    }

    // `report --format html` also writes report.json; take the run id and defect count from it (from blobs when a worker made it).
    let runId: string | undefined;
    let findings: number | undefined;
    try {
      const text = this.fleet ? (await this.store.files.blobs.get(`jobs/${job.id}/accessibility/report.json`))?.toString('utf8') : await fsp.readFile(path.join(dir, 'report.json'), 'utf8');
      const doc = JSON.parse(text ?? '') as { run?: { id?: string }; counts?: { defects?: number } };
      runId = doc.run?.id;
      findings = doc.counts?.defects;
    } catch {
      /* the HTML is what matters */
    }
    p.done++;
    p.fraction = fraction(p.done, p.total);
    job.result = {
      ...(job.result ?? { downloadUrl: `/api/jobs/${job.id}/download` }),
      accessibility: { ...(runId ? { runId } : {}), ...(findings !== undefined ? { findings } : {}), reportUrl: `/reports/${job.id}/accessibility/report.html` },
    };
    this.store.update(job);
  }

  /** Run one CLI invocation, streaming its output into the job log. */
  private step(a: Active, label: string, args: string[], cwd: string): Promise<StepResult> {
    if (a.reason) return Promise.resolve({ code: null, signal: null, stderr: [] });
    const { job } = a;
    this.store.appendLog(job, [`[${label}] $ complykit ${args.map(shellQuote).join(' ')}`]);
    const stderr: string[] = [];
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(this.config.cliPath)) {
        reject(new Error(`complykit CLI not found at ${this.config.cliPath} (build complykit or set COMPLYKIT_CLI)`));
        return;
      }
      // detached → its own process group, so a kill reaches Chromium too.
      // COMPLYKIT_KB_DIR: consent recognizes the confirmed entries and feeds
      // its unrecognized parties into the same queue the KB routes manage.
      const env = { ...process.env, COMPLYKIT_KB_DIR: this.config.kbDir };
      const child = spawn(process.execPath, [this.config.cliPath, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      a.children.add(child);
      const lines = (stream: NodeJS.ReadableStream, tag: string, keep?: string[]) => {
        let rest = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk: string) => {
          const parts = (rest + chunk).split(/\r?\n/);
          rest = parts.pop() ?? '';
          const out = parts.filter((l) => l.trim());
          if (!out.length) return;
          keep?.push(...out);
          if (keep && keep.length > 50) keep.splice(0, keep.length - 50);
          this.store.appendLog(job, out.map((l) => `[${tag}] ${l}`));
        });
        stream.on('end', () => {
          if (!rest.trim()) return;
          keep?.push(rest);
          this.store.appendLog(job, [`[${tag}] ${rest}`]);
        });
      };
      lines(child.stdout!, label);
      lines(child.stderr!, `${label}:err`, stderr);
      child.on('error', (err) => {
        a.children.delete(child);
        reject(err);
      });
      child.on('close', (code, signal) => {
        a.children.delete(child);
        resolve({ code, signal, stderr });
      });
    });
  }
}

interface StepResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string[];
}

/** SIGTERM the child's process group, then SIGKILL after `graceMs`. */
function killTree(child: ChildProcess, graceMs: number): void {
  const signal = (sig: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        /* already gone */
      }
    }
  };
  signal('SIGTERM');
  const t = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signal('SIGKILL');
  }, graceMs);
  t.unref();
  child.once('close', () => clearTimeout(t));
}

function exitText(r: StepResult): string {
  return r.signal ? `signal ${r.signal}` : `code ${r.code}`;
}

function withTail(message: string, stderr: string[]): string {
  const tail = stderr.slice(-STDERR_TAIL).join('\n').trim();
  return tail ? `${message}\n${tail}` : message;
}

/** What a consent job takes from its site's workspace: CLI arguments (local) or request fields (a worker). */
interface SiteInputs {
  domain?: string;
  args: string[];
  workspace?: SiteWorkspace;
  /** Blob prefix of the previous run's directory. */
  previous?: string;
}

type SetLaw = (law: Law, patch: { state?: LawScanState; error?: string }) => void;

function isLiveLine(line: string): boolean {
  try {
    return (JSON.parse(line) as { type?: unknown }).type === 'live';
  } catch {
    return false;
  }
}

/** <jobDir>/consent/live/<lawId>.json: each law's latest owner report while it scans. Written whole (tmp + rename), never half. */
class LiveFiles {
  private readonly pending = new Set<Promise<unknown>>();
  private seq = 0;

  constructor(private readonly dir: string) {}

  track(p: Promise<unknown>): void {
    const q = p.catch(() => undefined);
    this.pending.add(q);
    void q.then(() => this.pending.delete(q));
  }

  async put(id: string, body: Buffer): Promise<void> {
    const file = path.join(this.dir, `${id}.json`);
    const tmp = `${file}.${++this.seq}.tmp`;
    await fsp.writeFile(tmp, body);
    await fsp.rename(tmp, file);
  }

  /** Copy the collector's own report file in (fire and forget; a vanished source is ignored). */
  copy(id: string, src: string): void {
    this.track(
      fsp
        .readFile(src)
        .then((body) => this.put(id, body))
        .catch(() => undefined),
    );
  }

  async settled(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
