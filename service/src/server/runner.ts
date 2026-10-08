// The job queue and the check processes. FIFO, `concurrency` jobs at a time;
// each job runs consent (if enabled) then accessibility (if enabled) as
// complykit CLI child processes with cwd inside the job's directory.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { JobDetail } from '../shared/api.js';
import { LAWS, type Law } from '../shared/laws.js';
import { flyFleet, type Fleet, type WorkerHandle } from './fleet.js';
import { WORKER_SECRET_HEADER } from './worker.js';
import { consentRunsFor, jobTimeoutFor, type ServiceConfig } from './config.js';
import { ConsentProgress, NdjsonTail, fraction } from './events.js';
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
}

const REMOTE_STAGGER_MS = 3_000;
const REMOTE_POLL_MS = 2_000;
const REMOTE_TIMEOUT_MS = 30 * 60_000;
/** Consecutive failed polls before a worker is given up on. */
const REMOTE_MAX_POLL_FAILURES = 8;

interface Gathered {
  law: Law;
  /** The run dir holding collection.json. */
  dir?: string;
  error?: string;
}

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
  /** Per-region lock: a worker runs one collection at a time, and this process may run several jobs. */
  private readonly regionTails = new Map<string, Promise<void>>();
  private readonly regionHolders = new Map<string, number>();

  /** Waits for the region's worker to be free (or the signal to abort); returns the unlock function. */
  private async lockRegion(region: string, signal: AbortSignal, onWait: () => void): Promise<() => void> {
    const prev = this.regionTails.get(region) ?? Promise.resolve();
    const contended = (this.regionHolders.get(region) ?? 0) > 0;
    this.regionHolders.set(region, (this.regionHolders.get(region) ?? 0) + 1);
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    // The next waiter queues behind this one even if this one gives up early.
    this.regionTails.set(region, prev.then(() => gate));
    let unlocked = false;
    const unlock = () => {
      if (unlocked) return;
      unlocked = true;
      open();
      const n = (this.regionHolders.get(region) ?? 1) - 1;
      if (n <= 0) {
        this.regionHolders.delete(region);
        this.regionTails.delete(region);
      } else this.regionHolders.set(region, n);
    };
    if (contended) onWait();
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const done = () => {
        signal.removeEventListener('abort', done);
        resolve();
      };
      signal.addEventListener('abort', done, { once: true });
      void prev.then(done);
    });
    if (signal.aborted) {
      unlock();
      throw new Error('cancelled');
    }
    return unlock;
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

  /** Stop accepting, kill every running job ("server stopped"), wait for them.
   *  Queued jobs stay queued on disk and are picked up again after a restart. */
  async shutdown(killGraceMs = this.config.killGraceMs): Promise<void> {
    this.accepting = false;
    this.queue.length = 0;
    const all = [...this.active.values()];
    for (const a of all) this.stop(a, 'stopped', killGraceMs);
    await Promise.all(all.map((a) => a.finished));
  }

  private pump(): void {
    while (this.accepting && this.active.size < this.config.concurrency && this.queue.length) {
      const id = this.queue.shift()!;
      const job = this.store.get(id);
      if (!job || job.status !== 'queued') continue;
      const a: Active = { job, children: new Set(), abort: new AbortController(), finished: Promise.resolve() };
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
    const timeout = setTimeout(() => this.stop(a, 'timeout'), timeoutMs);
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


  /**
   * A consent job with laws: one collection per law (the local law in a child
   * process, the others on regional workers), all in parallel, then one merge
   * on this machine that runs the rules over everything and writes the report.
   */
  private async runConsentLaws(a: Active, extraUnits: number): Promise<void> {
    const { job } = a;
    const laws = LAWS.filter((l) => job.laws!.includes(l.id));
    const dir = path.join(this.store.jobDir(job.id), 'consent');
    const gatherRoot = path.join(dir, 'gather');
    await fsp.rm(gatherRoot, { recursive: true, force: true });
    await fsp.mkdir(gatherRoot, { recursive: true });
    const eventsFile = path.join(dir, 'events.ndjson');
    await fsp.rm(eventsFile, { force: true });

    const mapper = new ConsentProgress(job, extraUnits, laws.map((l) => l.locationId));
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
    const site = await this.siteArgs(job, dir);
    const quiet = process.env.COMPLYKIT_DEBUG ? [] : ['--quiet'];
    const appendLine = (line: string) => fs.appendFileSync(eventsFile, line.endsWith('\n') ? line : line + '\n');
    tail.start();
    try {
      this.store.appendLog(job, [`[consent] scanning under ${laws.map((l) => l.label).join(', ')} (authorized ${job.authorizedAt ?? 'at submission'})`]);
      const remote = laws.filter((l) => !l.local);
      const gathered = await Promise.all(
        laws.map((law) => (law.local ? this.collectLocal(a, law, gatherRoot, quiet, appendLine) : this.collectRemote(a, law, gatherRoot, appendLine, remote.indexOf(law) * (this.options.staggerMs ?? REMOTE_STAGGER_MS)))),
      );
      if (a.reason) throw new Error(a.reason);

      const failed = gathered.filter((g) => !g.dir);
      for (const g of failed) this.store.appendLog(job, [`[consent] ${g.law.label} (${g.law.locationId}) could not be scanned: ${g.error}`]);
      const ok = gathered.filter((g) => g.dir);
      if (!ok.length) throw new Error(`no law could be scanned: ${failed.map((g) => `${g.law.label}: ${g.error}`).join('; ')}`);

      job.progress.phase = 'analyzing';
      job.progress.current = 'combining the regions';
      this.store.update(job);
      merging = true;
      const failedArgs = failed.flatMap((g) => ['--failed', `${g.law.locationId}=${g.error}`]);
      const args = ['consent', '--merge', ok.map((g) => g.dir).join(','), '--url', job.url, '--cwd', dir, '--events', eventsFile, ...quiet, ...failedArgs, ...site.args];
      const res = await this.step(a, 'consent', args, dir);
      await tail.stop();
      if (a.reason) throw new Error(a.reason);
      if (mapper.error) throw new Error(withTail(`consent check failed: ${mapper.error}`, res.stderr));
      if (res.code !== 0) throw new Error(withTail(`consent merge exited with ${exitText(res)}`, res.stderr));
      if (!mapper.done) throw new Error(withTail('consent merge exited without a result', res.stderr));
      if (site.domain) await this.recordRun(job, site.domain, mapper.done);
    } finally {
      await tail.stop(); // idempotent enough: clears the timer, one last read
      // The raw collections hold unredacted request bodies and cookie values: never kept.
      await fsp.rm(gatherRoot, { recursive: true, force: true });
    }
  }

  /** The law this machine scans from: a collect-only child, its events forwarded into the job's. */
  private async collectLocal(a: Active, law: Law, gatherRoot: string, quiet: string[], appendLine: (l: string) => void): Promise<Gathered> {
    const { job } = a;
    const cwd = path.join(gatherRoot, law.id);
    const events = path.join(gatherRoot, `${law.id}.events.ndjson`);
    const fwd = new NdjsonTail(events, (ev) => appendLine(JSON.stringify(ev)), this.config.pollMs);
    try {
      await fsp.mkdir(cwd, { recursive: true });
      fwd.start();
      const args = ['consent', '--collect-only', '--url', job.url, '--locations', law.locationId, '--cwd', cwd, '--events', events, ...quiet, '--runs', String(consentRunsFor(job, this.config)), ...(job.quick ? ['--quick'] : [])];
      const res = await this.step(a, `collect:${law.id}`, args, cwd);
      await fwd.stop();
      if (a.reason) return { law, error: a.reason };
      if (res.code !== 0) return { law, error: oneLine(withTail(`collection exited with ${exitText(res)}`, res.stderr)) };
      const runs = path.join(cwd, '.comply', 'runs');
      const dirs = (await fsp.readdir(runs, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory() && fs.existsSync(path.join(runs, e.name, 'collection.json')));
      if (dirs.length !== 1) return { law, error: 'collection left no run directory with collection.json' };
      return { law, dir: path.join(runs, dirs[0].name) };
    } catch (err) {
      return { law, error: (err as Error).message };
    } finally {
      await fwd.stop().catch(() => undefined);
    }
  }

  /** A law collected on its region's worker: acquire, collect, follow its events, fetch the run, clean up. */
  private async collectRemote(a: Active, law: Law, gatherRoot: string, appendLine: (l: string) => void, delayMs: number): Promise<Gathered> {
    const { job } = a;
    const signal = a.abort.signal;
    const workerJob = `${job.id}-${law.id}`;
    const headers = { [WORKER_SECRET_HEADER]: this.config.workerSecret ?? '' };
    let handle: WorkerHandle | undefined;
    let posted = false;
    let interrupted = false;
    let unlock: (() => void) | undefined;
    const url = (p: string) => `${handle!.baseUrl}/internal/jobs/${workerJob}${p}`;
    const check = () => {
      if (signal.aborted) throw new Error(a.reason ?? 'cancelled');
    };
    try {
      if (!this.fleet) throw new Error('multi-region scanning is not configured on this server');
      await sleepAbortable(delayMs, signal);
      check();
      unlock = await this.lockRegion(law.flyRegion, signal, () => this.store.appendLog(job, [`[collect:${law.id}] waiting for the ${law.flyRegion} worker (another scan is using it)`]));
      check();
      this.store.appendLog(job, [`[collect:${law.id}] starting the worker in ${law.flyRegion}`]);
      handle = await this.fleet.acquire(law.flyRegion);
      check();
      const post = await fetch(`${handle.baseUrl}/internal/collect`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ jobId: workerJob, url: job.url, locationId: law.locationId, quick: job.quick, runs: consentRunsFor(job, this.config) }),
        signal,
      });
      if (!post.ok) throw new Error(`worker refused the collection: HTTP ${post.status} ${(await post.text().catch(() => '')).slice(0, 200)}`.trim());
      posted = true;
      this.store.appendLog(job, [`[collect:${law.id}] collecting from ${law.flyRegion}`]);

      // Follow the worker's events into the job's, until it settles.
      const pollMs = this.options.remotePollMs ?? REMOTE_POLL_MS;
      const deadline = Date.now() + (this.options.remoteTimeoutMs ?? REMOTE_TIMEOUT_MS);
      let seen = 0;
      const pull = async () => {
        const res = await fetch(url(`/events?from=${seen}`), { headers, signal });
        if (!res.ok) throw new Error(`events: HTTP ${res.status}`);
        const lines = (await res.text()).split('\n').filter((l) => l.trim());
        for (const l of lines) appendLine(l);
        seen += lines.length;
      };
      let failures = 0;
      for (;;) {
        check();
        let st: { state: string; error?: string } | undefined;
        try {
          await pull();
          const res = await fetch(url(''), { headers, signal });
          if (!res.ok) throw new Error(`state: HTTP ${res.status}`);
          st = (await res.json()) as { state: string; error?: string };
          if (st.state !== 'running') await pull();
          failures = 0;
        } catch (err) {
          check();
          if (++failures >= REMOTE_MAX_POLL_FAILURES) throw new Error(`lost contact with the worker: ${(err as Error).message}`);
        }
        if (st && st.state !== 'running') {
          if (st.state === 'collected') break;
          throw new Error(oneLine(st.error ?? `worker ended ${st.state}`));
        }
        if (Date.now() > deadline) {
          interrupted = true;
          throw new Error(`timed out after ${Math.round((this.options.remoteTimeoutMs ?? REMOTE_TIMEOUT_MS) / 60_000)} minutes`);
        }
        await sleepAbortable(pollMs, signal);
      }

      // Fetch the run and unpack it where the merge will read it.
      const dest = path.join(gatherRoot, law.id);
      await fsp.mkdir(dest, { recursive: true });
      const tarFile = path.join(gatherRoot, `${law.id}.tar`);
      const res = await fetch(url('/run.tar'), { headers, signal });
      if (!res.ok || !res.body) throw new Error(`run.tar: HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), fs.createWriteStream(tarFile));
      await untar(tarFile, dest);
      await fsp.rm(tarFile, { force: true });
      if (!fs.existsSync(path.join(dest, 'collection.json'))) throw new Error('the worker\'s run had no collection.json');
      return { law, dir: dest };
    } catch (err) {
      interrupted ||= signal.aborted;
      const message = signal.aborted ? (a.reason ?? 'cancelled') : (err as Error).message;
      return { law, error: law.local ? message : `worker in ${law.flyRegion} failed: ${message}` };
    } finally {
      if (handle && posted) {
        const quick = { headers, signal: AbortSignal.timeout(10_000) };
        if (interrupted) await fetch(url('/cancel'), { method: 'POST', ...quick }).catch(() => undefined);
        await fetch(url(''), { method: 'DELETE', headers, signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
      }
      if (handle) await this.fleet!.release(handle).catch(() => undefined);
      unlock?.();
    }
  }

  /**
   * The site workspace for this job's domain, written into the job directory and
   * passed as --workspace, plus the previous run of the site (--previous) when
   * its job directory is still on disk. A workspace that can't be read doesn't
   * stop the scan (a scan never needs it to judge the site); the log says so and
   * the report then asks again what the team had classified.
   */
  private async siteArgs(job: JobDetail, dir: string): Promise<{ domain?: string; args: string[] }> {
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
    const file = path.join(dir, 'workspace.json');
    await fsp.writeFile(file, JSON.stringify(ws, null, 2) + '\n');
    const args = ['--workspace', file];
    // Newest first: the latest earlier run whose evaluation is still on disk.
    for (const r of [...ws.runs].reverse()) {
      if (!r.jobId || r.jobId === job.id) continue;
      const runDir = path.join(this.store.jobDir(r.jobId), 'consent', '.comply', 'runs', r.id);
      if (fs.existsSync(path.join(runDir, 'tracking.json'))) {
        args.push('--previous', runDir);
        break;
      }
    }
    const classified = Object.keys(ws.entries).filter((k) => k.startsWith('class:') && ws.entries[k].value !== null).length;
    this.store.appendLog(job, [`[consent] site workspace ${domain}: ${classified} classification(s), ${ws.runs.length} earlier run(s)${args.includes('--previous') ? '' : '; no earlier run on disk to compare with'}`]);
    return { domain, args };
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
    await fsp.mkdir(dir, { recursive: true });
    p.phase = 'accessibility';
    p.current = 'accessibility scan';
    p.total = Math.max(p.total, p.done + 1);
    p.fraction = fraction(p.done, p.total);
    this.store.update(job);

    const scan = await this.step(a, 'accessibility', ['scan', '--url', job.url, '--cwd', dir, '--quiet', '--max-pages', '15'], dir);
    if (a.reason) throw new Error(a.reason);
    if (scan.code !== 0) throw new Error(withTail(`accessibility scan exited with ${exitText(scan)}`, scan.stderr));

    p.current = 'accessibility report';
    this.store.update(job);
    const out = path.join(dir, 'report.html');
    const rep = await this.step(a, 'accessibility', ['report', '--format', 'html', '--out', out, '--cwd', dir], dir);
    if (a.reason) throw new Error(a.reason);
    if (rep.code !== 0) throw new Error(withTail(`accessibility report exited with ${exitText(rep)}`, rep.stderr));

    // `report --format html` also writes report.json; take the run id and defect count from it.
    let runId: string | undefined;
    let findings: number | undefined;
    try {
      const doc = JSON.parse(await fsp.readFile(path.join(dir, 'report.json'), 'utf8')) as { run?: { id?: string }; counts?: { defects?: number } };
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

/** `tar -xf file -C dest` (system tar). */
function untar(file: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xf', file, '-C', dest], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr!.on('data', (c: Buffer) => (err += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`could not unpack the worker's run: tar exited with code ${code} ${oneLine(err)}`.trim()))));
  });
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
