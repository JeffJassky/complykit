import { AsyncLocalStorage } from 'node:async_hooks';

// Per-step timing inside one visit: where a scenario's minutes go (land,
// browse, flush, teardown, …). A step nested in another is keyed by its path
// ("browse.page.navigate"), so the top-level steps partition the visit and the
// nested ones explain them. Repeated steps aggregate (count, total, max) so the
// summary stays a few dozen rows however long the journey is.
//
// The current timer travels in AsyncLocalStorage: the helpers in journey.ts
// call step() without threading a timer through every signature, and outside a
// timed visit step() just runs the function.

/** One aggregated step in a visit's timing summary. `ms` is the total. */
export interface StepSummary {
  step: string;
  count: number;
  ms: number;
  maxMs: number;
  /** Still running when the summary was taken (e.g. the scenario hit its budget); ms includes the time so far. */
  open?: boolean;
}

interface Frame {
  timer: StepTimer;
  path: string;
}

const als = new AsyncLocalStorage<Frame>();

export interface StepTimerOptions {
  /** Receives one line per finished step (debug only). */
  trace?: (line: string) => void;
  /** Clock, ms. Default Date.now. */
  now?: () => number;
}

export function formatSeconds(ms: number): string {
  const s = ms / 1000;
  return s >= 10 ? `${Math.round(s)}s` : `${s.toFixed(1)}s`;
}

export class StepTimer {
  private readonly agg = new Map<string, { count: number; ms: number; maxMs: number }>();
  private readonly running = new Map<number, { step: string; since: number }>();
  private nextId = 0;
  private readonly now: () => number;

  constructor(private readonly opts: StepTimerOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** Run `fn` with this timer as the current one: step() calls inside it are recorded here. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    return als.run({ timer: this, path: '' }, fn);
  }

  /** Time `fn` as the step `key` (a full path). */
  async time<T>(key: string, fn: () => Promise<T>, detail?: string): Promise<T> {
    const id = this.nextId++;
    const since = this.now();
    this.running.set(id, { step: key, since });
    try {
      return await fn();
    } finally {
      this.running.delete(id);
      const ms = this.now() - since;
      this.record(key, ms);
      this.opts.trace?.(`step ${key}${detail ? ` ${detail}` : ''} ${formatSeconds(ms)}`);
    }
  }

  record(key: string, ms: number): void {
    const a = this.agg.get(key) ?? { count: 0, ms: 0, maxMs: 0 };
    a.count += 1;
    a.ms += ms;
    a.maxMs = Math.max(a.maxMs, ms);
    this.agg.set(key, a);
  }

  /** Every step, slowest total first; steps still running are included (open) with their time so far. */
  summary(): StepSummary[] {
    const out = new Map<string, StepSummary>();
    for (const [step, a] of this.agg) out.set(step, { step, count: a.count, ms: Math.round(a.ms), maxMs: Math.round(a.maxMs) });
    const t = this.now();
    for (const r of this.running.values()) {
      const ms = Math.round(t - r.since);
      const s = out.get(r.step) ?? { step: r.step, count: 0, ms: 0, maxMs: 0 };
      s.count += 1;
      s.ms += ms;
      s.maxMs = Math.max(s.maxMs, ms);
      s.open = true;
      out.set(r.step, s);
    }
    return [...out.values()].sort((a, b) => b.ms - a.ms || a.step.localeCompare(b.step));
  }
}

/** The `n` slowest top-level steps, e.g. "browse 180s, flush 40s, land 20s" ("+" = still running). */
export function topSteps(summary: StepSummary[], n = 3): string {
  return summary
    .filter((s) => !s.step.includes('.') && s.ms > 0)
    .slice(0, n)
    .map((s) => `${s.step} ${formatSeconds(s.ms)}${s.open ? '+' : ''}`)
    .join(', ');
}

/** Time `fn` as a step nested under the current one (no-op outside a timed visit). */
export function step<T>(name: string, fn: () => Promise<T>, detail?: string): Promise<T> {
  const f = als.getStore();
  if (!f) return fn();
  const key = f.path ? `${f.path}.${name}` : name;
  return f.timer.time(key, () => als.run({ timer: f.timer, path: key }, fn), detail);
}

/** A URL's path for trace details (no query: it can carry markers). */
export function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.slice(0, 80);
  }
}
