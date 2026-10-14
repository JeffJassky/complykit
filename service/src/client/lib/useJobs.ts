import { useCallback, useEffect, useRef, useState } from 'react';
import type { JobSummary, JobsResponse } from '../../shared/api';
import { api } from './api';

export type Connection = 'connecting' | 'live' | 'reconnecting' | 'polling' | 'offline' | 'idle';

type Jobs = Record<string, JobSummary>;
type Transition = (prev: JobSummary, next: JobSummary) => void;

const POLL_MS = 5000;
const MAX_BACKOFF_MS = 30_000;
/** After this many consecutive stream failures, poll /api/jobs while still retrying the stream. */
const POLL_AFTER_FAILURES = 2;

/** Fired on window after this page starts a scan, so the feed re-reads and opens the stream. */
export const JOBS_CHANGED_EVENT = 'complykit:jobs-changed';

/** Call after creating jobs (a batch, a rescan): the feed may be idle with the stream closed. */
export function notifyJobsChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(JOBS_CHANGED_EVENT));
}

/** Is any job still queued or running? Only then does the page hold the live stream open. */
export function hasActiveJobs(jobs: Jobs): boolean {
  for (const id in jobs) if (jobs[id].status === 'queued' || jobs[id].status === 'running') return true;
  return false;
}

type Listenable = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
interface StreamLike {
  onopen: ((ev: Event) => unknown) | null;
  onerror: ((ev: Event) => unknown) | null;
  addEventListener(type: string, fn: (ev: Event) => void): void;
  close(): void;
}

export interface JobsFeedEnv {
  /** GET /api/jobs into state; resolves false when it failed. */
  refresh: () => Promise<boolean>;
  /** The jobs as of the latest refresh or event. */
  jobs: () => Jobs;
  upsert: (job: JobSummary) => void;
  remove: (id: string) => void;
  setConnection: (c: Connection) => void;
  onKb?: () => void;
  /** null: no EventSource here, so poll while jobs are active. */
  openStream: (() => StreamLike) | null;
  win: Listenable;
  doc: Listenable & { visibilityState: string };
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  random?: () => number;
}

/**
 * The jobs feed. The live stream (and the polling fallback) runs only while a
 * job is queued or running. When everything has settled it closes: an open
 * stream reconnects the moment the server's idle shutdown stops it, and that
 * request wakes the server again, so one forgotten tab kept it up for good
 * (seen 2026-10-14). While idle, the page re-reads once on focus, when it
 * becomes visible, and when it starts a scan (JOBS_CHANGED_EVENT); if that
 * finds an active job the stream opens again. Returns the stop function.
 */
export function startJobsFeed(env: JobsFeedEnv): () => void {
  const setT = env.setTimeout ?? setTimeout;
  const clearT = env.clearTimeout ?? clearTimeout;
  const setI = env.setInterval ?? setInterval;
  const clearI = env.clearInterval ?? clearInterval;
  const random = env.random ?? Math.random;

  let disposed = false;
  let es: StreamLike | null = null;
  let failures = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  const stopPolling = () => {
    if (pollTimer) clearI(pollTimer);
    pollTimer = undefined;
  };
  const stopRetry = () => {
    if (retryTimer) clearT(retryTimer);
    retryTimer = undefined;
  };
  const closeStream = () => {
    es?.close();
    es = null;
  };

  /** Open or close the stream to match whether anything is moving. */
  const reconcile = (ok = true) => {
    if (disposed) return;
    if (hasActiveJobs(env.jobs())) {
      if (!es && !retryTimer && !pollTimer) connect();
      return;
    }
    closeStream();
    stopRetry();
    stopPolling();
    failures = 0;
    env.setConnection(ok ? 'idle' : 'offline');
  };

  const startPolling = () => {
    if (pollTimer) return;
    pollTimer = setI(async () => {
      const ok = await env.refresh();
      if (disposed || es) return;
      if (!hasActiveJobs(env.jobs())) return reconcile(ok);
      env.setConnection(ok ? 'polling' : 'offline');
    }, POLL_MS);
  };

  const connect = () => {
    if (disposed) return;
    if (!env.openStream) {
      env.setConnection('polling');
      startPolling();
      return;
    }
    const s = env.openStream();
    es = s;
    s.onopen = () => {
      failures = 0;
      stopPolling();
      env.setConnection('live');
      env.onKb?.();
      // Resync anything missed while disconnected; close again if it all settled meanwhile.
      void env.refresh().then((ok) => reconcile(ok));
    };
    s.addEventListener('kb', () => env.onKb?.());
    s.addEventListener('job', (e) => {
      try {
        env.upsert(JSON.parse((e as MessageEvent<string>).data) as JobSummary);
      } catch {
        return; // ignore malformed event
      }
      reconcile();
    });
    s.addEventListener('removed', (e) => {
      try {
        env.remove((JSON.parse((e as MessageEvent<string>).data) as { id: string }).id);
      } catch {
        return; // ignore malformed event
      }
      reconcile();
    });
    s.onerror = () => {
      if (es !== s) return;
      closeStream();
      if (disposed) return;
      failures++;
      if (failures >= POLL_AFTER_FAILURES) {
        env.setConnection('polling');
        startPolling();
      } else {
        env.setConnection('reconnecting');
      }
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (failures - 1)) * (0.8 + random() * 0.4);
      retryTimer = setT(() => {
        retryTimer = undefined;
        // Retry only while something is still moving; an idle page stays closed.
        if (hasActiveJobs(env.jobs())) connect();
        else reconcile();
      }, delay);
    };
  };

  /** One re-read when a person is back (or just started a scan); opens the stream if a job is moving. */
  const wake = () => {
    if (disposed || es) return;
    env.onKb?.(); // KB changes may have been missed while closed
    void env.refresh().then((ok) => reconcile(ok));
  };
  const onVisibility = () => {
    if (env.doc.visibilityState !== 'hidden') wake();
  };
  env.win.addEventListener('focus', wake);
  env.win.addEventListener(JOBS_CHANGED_EVENT, wake);
  env.doc.addEventListener('visibilitychange', onVisibility);

  void env.refresh().then((ok) => reconcile(ok));

  return () => {
    disposed = true;
    closeStream();
    stopRetry();
    stopPolling();
    env.win.removeEventListener('focus', wake);
    env.win.removeEventListener(JOBS_CHANGED_EVENT, wake);
    env.doc.removeEventListener('visibilitychange', onVisibility);
  };
}

/**
 * Jobs state: GET /api/jobs, then live updates from /api/stream (`job` upserts,
 * `removed` deletes) while any job is queued or running — see startJobsFeed for
 * why the stream closes once everything settles. The stream reconnects with
 * exponential backoff; while it is down the hook polls /api/jobs every 5s.
 * `onTransition` fires when a job already known to the page changes status.
 * `onKb` fires on the stream's `kb` event (the knowledge base changed) and on
 * every (re)connect or wake, since changes may have been missed meanwhile.
 */
export function useJobs(onTransition?: Transition, onKb?: () => void) {
  const [jobs, setJobs] = useState<Jobs>({});
  const [server, setServer] = useState<JobsResponse['server'] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');

  const jobsRef = useRef<Jobs>({});
  const transitionRef = useRef(onTransition);
  transitionRef.current = onTransition;
  const kbRef = useRef(onKb);
  kbRef.current = onKb;

  const commit = useCallback((next: Jobs) => {
    const prev = jobsRef.current;
    jobsRef.current = next;
    setJobs(next);
    const cb = transitionRef.current;
    if (!cb) return;
    for (const id in next) {
      const before = prev[id];
      if (before && before.status !== next[id].status) cb(before, next[id]);
    }
  }, []);

  const upsert = useCallback((job: JobSummary) => commit({ ...jobsRef.current, [job.id]: job }), [commit]);
  const remove = useCallback((id: string) => {
    if (!(id in jobsRef.current)) return;
    const next = { ...jobsRef.current };
    delete next[id];
    commit(next);
  }, [commit]);

  const refresh = useCallback(async () => {
    try {
      const data = await api.jobs();
      const next: Jobs = {};
      for (const j of data.jobs) next[j.id] = j;
      commit(next);
      setServer(data.server);
      setLoadError(null);
      return true;
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setLoaded(true);
    }
  }, [commit]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    return startJobsFeed({
      refresh,
      jobs: () => jobsRef.current,
      upsert,
      remove,
      setConnection,
      onKb: () => kbRef.current?.(),
      openStream: typeof EventSource === 'undefined' ? null : () => new EventSource('/api/stream'),
      win: window,
      doc: document,
    });
  }, [refresh, upsert, remove]);

  return { jobs, server, loaded, loadError, connection, upsert, remove, refresh };
}
