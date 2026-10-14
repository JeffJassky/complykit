import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobSummary } from '../../shared/api';
import { JOBS_CHANGED_EVENT, hasActiveJobs, startJobsFeed, type Connection } from './useJobs';

// The jobs feed holds the live stream open only while a job is moving: an open
// stream reconnects after the server's idle shutdown and wakes it (2026-10-14).

const job = (id: string, status: JobSummary['status']): JobSummary => ({ id, status }) as JobSummary;

class FakeStream {
  onopen: ((ev: Event) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  closed = false;
  private handlers = new Map<string, Array<(ev: Event) => void>>();
  addEventListener(type: string, fn: (ev: Event) => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: unknown) {
    for (const fn of this.handlers.get(type) ?? []) fn(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
  open() {
    this.onopen?.(new Event('open'));
  }
  fail() {
    this.onerror?.(new Event('error'));
  }
}

function setup(initial: JobSummary[], opts: { noEventSource?: boolean } = {}) {
  let server: JobSummary[] = initial;
  let jobs: Record<string, JobSummary> = {};
  let failRefresh = false;
  const streams: FakeStream[] = [];
  const connection: Connection[] = [];
  const refresh = vi.fn(async () => {
    if (failRefresh) return false;
    jobs = Object.fromEntries(server.map((j) => [j.id, j]));
    return true;
  });
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const onKb = vi.fn();
  const stop = startJobsFeed({
    refresh,
    jobs: () => jobs,
    upsert: (j) => (jobs = { ...jobs, [j.id]: j }),
    remove: (id) => {
      const next = { ...jobs };
      delete next[id];
      jobs = next;
    },
    setConnection: (c) => connection.push(c),
    onKb,
    openStream: opts.noEventSource
      ? null
      : () => {
          const s = new FakeStream();
          streams.push(s);
          return s;
        },
    win,
    doc,
    random: () => 0.5,
  });
  return {
    stop,
    streams,
    connection,
    refresh,
    onKb,
    win,
    doc,
    setServer: (next: JobSummary[]) => (server = next),
    failNextRefreshes: (v: boolean) => (failRefresh = v),
    last: () => connection[connection.length - 1],
  };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('hasActiveJobs', () => {
  it('is true only for a queued or running job', () => {
    expect(hasActiveJobs({})).toBe(false);
    expect(hasActiveJobs({ a: job('a', 'done'), b: job('b', 'failed'), c: job('c', 'cancelled') })).toBe(false);
    expect(hasActiveJobs({ a: job('a', 'done'), b: job('b', 'queued') })).toBe(true);
    expect(hasActiveJobs({ a: job('a', 'running') })).toBe(true);
  });
});

describe('the jobs feed (stream only while a scan is moving)', () => {
  it('nothing running at load: no stream, connection idle, and no requests while left open', async () => {
    const f = setup([job('a', 'done')]);
    await flush();
    expect(f.streams).toHaveLength(0);
    expect(f.last()).toBe('idle');
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(f.refresh).toHaveBeenCalledTimes(1);
    expect(f.streams).toHaveLength(0);
    f.stop();
  });

  it('a running job opens the stream; when the last job finishes the stream closes and nothing reconnects', async () => {
    const f = setup([job('a', 'running')]);
    await flush();
    expect(f.streams).toHaveLength(1);
    f.streams[0].open();
    await flush();
    expect(f.last()).toBe('live');
    f.streams[0].emit('job', job('a', 'done'));
    expect(f.streams[0].closed).toBe(true);
    expect(f.last()).toBe('idle');
    // The server's idle shutdown would drop the connection here; nothing must come back for it.
    f.streams[0].fail();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(f.streams).toHaveLength(1);
    expect(f.refresh).toHaveBeenCalledTimes(2); // load + the resync on open
    f.stop();
  });

  it('stays open while any job is still moving', async () => {
    const f = setup([job('a', 'running'), job('b', 'queued')]);
    await flush();
    f.streams[0].open();
    await flush();
    f.streams[0].emit('job', job('a', 'done'));
    expect(f.streams[0].closed).toBe(false);
    f.streams[0].emit('job', job('b', 'running'));
    expect(f.streams[0].closed).toBe(false);
    f.streams[0].emit('removed', { id: 'b' });
    expect(f.streams[0].closed).toBe(true);
    expect(f.last()).toBe('idle');
    f.stop();
  });

  it('starting a scan (JOBS_CHANGED_EVENT) re-reads and opens the stream', async () => {
    const f = setup([]);
    await flush();
    expect(f.streams).toHaveLength(0);
    f.setServer([job('n', 'queued')]);
    f.win.dispatchEvent(new Event(JOBS_CHANGED_EVENT));
    await flush();
    expect(f.refresh).toHaveBeenCalledTimes(2);
    expect(f.streams).toHaveLength(1);
    f.stop();
  });

  it('while idle, focus and becoming visible re-read once (and call onKb); hidden does nothing', async () => {
    const f = setup([job('a', 'done')]);
    await flush();
    f.win.dispatchEvent(new Event('focus'));
    await flush();
    expect(f.refresh).toHaveBeenCalledTimes(2);
    expect(f.onKb).toHaveBeenCalledTimes(1);
    f.doc.visibilityState = 'hidden';
    f.doc.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(f.refresh).toHaveBeenCalledTimes(2);
    f.doc.visibilityState = 'visible';
    f.doc.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(f.refresh).toHaveBeenCalledTimes(3);
    expect(f.streams).toHaveLength(0);
    f.stop();
  });

  it('a job started elsewhere is picked up on focus', async () => {
    const f = setup([job('a', 'done')]);
    await flush();
    f.setServer([job('a', 'done'), job('b', 'running')]);
    f.win.dispatchEvent(new Event('focus'));
    await flush();
    expect(f.streams).toHaveLength(1);
    f.stop();
  });

  it('a dropped stream retries with backoff while a job is moving, but not once everything has settled', async () => {
    const f = setup([job('a', 'running')]);
    await flush();
    f.streams[0].open();
    await flush();
    f.streams[0].fail();
    expect(f.last()).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.streams).toHaveLength(2);
    // The job finished while the stream was down; the reconnect's resync sees it and closes.
    f.setServer([job('a', 'done')]);
    f.streams[1].open();
    await flush();
    expect(f.streams[1].closed).toBe(true);
    expect(f.last()).toBe('idle');
    // The server's idle shutdown drops it: no retry, no polling.
    f.streams[1].fail();
    const calls = f.refresh.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(f.streams).toHaveLength(2);
    expect(f.refresh.mock.calls.length).toBe(calls);
    f.stop();
  });

  it('without EventSource it polls only while a job is moving', async () => {
    const f = setup([job('a', 'running')], { noEventSource: true });
    await flush();
    expect(f.last()).toBe('polling');
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.refresh).toHaveBeenCalledTimes(2);
    f.setServer([job('a', 'done')]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.last()).toBe('idle');
    const calls = f.refresh.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(f.refresh.mock.calls.length).toBe(calls);
    f.stop();
  });

  it('a failed load with nothing known reports offline, not idle', async () => {
    const f = setup([]);
    f.failNextRefreshes(true);
    f.win.dispatchEvent(new Event('focus'));
    await flush();
    expect(f.last()).toBe('offline');
    f.stop();
  });

  it('stop closes the stream and removes the listeners', async () => {
    const f = setup([job('a', 'running')]);
    await flush();
    f.stop();
    expect(f.streams[0].closed).toBe(true);
    f.win.dispatchEvent(new Event('focus'));
    f.win.dispatchEvent(new Event(JOBS_CHANGED_EVENT));
    await flush();
    expect(f.refresh).toHaveBeenCalledTimes(1);
  });
});
