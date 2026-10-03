import { useCallback, useEffect, useRef, useState } from 'react';
import type { JobSummary, JobsResponse } from '../../shared/api';
import { api } from './api';

export type Connection = 'connecting' | 'live' | 'reconnecting' | 'polling' | 'offline';

type Jobs = Record<string, JobSummary>;
type Transition = (prev: JobSummary, next: JobSummary) => void;

const POLL_MS = 5000;
const MAX_BACKOFF_MS = 30_000;
/** After this many consecutive stream failures, poll /api/jobs while still retrying the stream. */
const POLL_AFTER_FAILURES = 2;

/**
 * Jobs state: initial GET /api/jobs, then live updates from /api/stream (`job`
 * upserts, `removed` deletes). The stream reconnects with exponential backoff;
 * while it is down the hook polls /api/jobs every 5s. `onTransition` fires when
 * a job already known to the page changes status. `onKb` fires on the stream's
 * `kb` event (the knowledge base changed) and on every (re)connect, since
 * changes may have been missed while disconnected.
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
    let disposed = false;
    let es: EventSource | null = null;
    let failures = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;

    const stopPolling = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = undefined;
    };
    const startPolling = () => {
      if (pollTimer) return;
      pollTimer = setInterval(async () => {
        const ok = await refresh();
        if (!disposed && !es) setConnection(ok ? 'polling' : 'offline');
      }, POLL_MS);
    };

    const connect = () => {
      if (disposed) return;
      if (typeof EventSource === 'undefined') {
        setConnection('polling');
        startPolling();
        return;
      }
      es = new EventSource('/api/stream');
      es.onopen = () => {
        failures = 0;
        stopPolling();
        setConnection('live');
        void refresh(); // resync anything missed while disconnected
        kbRef.current?.();
      };
      es.addEventListener('kb', () => kbRef.current?.());
      es.addEventListener('job', (e) => {
        try {
          upsert(JSON.parse((e as MessageEvent<string>).data) as JobSummary);
        } catch {
          /* ignore malformed event */
        }
      });
      es.addEventListener('removed', (e) => {
        try {
          remove((JSON.parse((e as MessageEvent<string>).data) as { id: string }).id);
        } catch {
          /* ignore malformed event */
        }
      });
      es.onerror = () => {
        es?.close();
        es = null;
        if (disposed) return;
        failures++;
        if (failures >= POLL_AFTER_FAILURES) {
          setConnection('polling');
          startPolling();
        } else {
          setConnection('reconnecting');
        }
        const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (failures - 1)) * (0.8 + Math.random() * 0.4);
        retryTimer = setTimeout(connect, delay);
      };
    };

    void refresh().then(connect);
    return () => {
      disposed = true;
      es?.close();
      if (retryTimer) clearTimeout(retryTimer);
      stopPolling();
    };
  }, [refresh, upsert, remove]);

  return { jobs, server, loaded, loadError, connection, upsert, remove, refresh };
}
