// The job queue and the check processes. FIFO, `concurrency` jobs at a time;
// each job runs consent (if enabled) then accessibility (if enabled) as
// complykit CLI child processes with cwd inside the job's directory.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { JobDetail } from '../shared/api.js';
import type { ServiceConfig } from './config.js';
import { ConsentProgress, NdjsonTail, fraction } from './events.js';
import type { JobStore } from './store.js';

/** Why a running job is being stopped from the outside. */
type StopReason = 'cancelled' | 'stopped' | 'timeout';

interface Active {
  job: JobDetail;
  child?: ChildProcess;
  reason?: StopReason;
  /** Resolves when the job's run loop has fully finished. */
  finished: Promise<void>;
}

/** How many trailing stderr lines go into a failure message. */
const STDERR_TAIL = 6;

export class Runner {
  private readonly queue: string[] = [];
  private readonly active = new Map<string, Active>();
  private accepting = true;

  constructor(
    private readonly store: JobStore,
    private readonly config: ServiceConfig,
    /** Called whenever a job reaches a terminal state (idle tracking). */
    private readonly onSettled: () => void = () => {},
  ) {}

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
      const a: Active = { job, finished: Promise.resolve() };
      this.active.set(id, a);
      a.finished = this.run(a).finally(() => {
        this.active.delete(id);
        this.onSettled();
        this.pump();
      });
    }
  }

  private stop(a: Active, reason: StopReason, graceMs = this.config.killGraceMs): void {
    a.reason ??= reason;
    if (a.child) killTree(a.child, graceMs);
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

    const timeout = setTimeout(() => this.stop(a, 'timeout'), this.config.jobTimeoutMs);
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
              ? `timed out after ${Math.round(this.config.jobTimeoutMs / 60_000)} minutes`
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
    tail.start();
    const args = ['consent', '--url', job.url, '--cwd', dir, '--events', eventsFile, '--quiet', ...(job.quick ? ['--quick'] : [])];
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
      const child = spawn(process.execPath, [this.config.cliPath, ...args], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      a.child = child;
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
        a.child = undefined;
        reject(err);
      });
      child.on('close', (code, signal) => {
        a.child = undefined;
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

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
