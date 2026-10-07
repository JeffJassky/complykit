import { useCallback, useEffect, useRef, useState } from 'react';
import type { JobReportResponse } from '../../shared/api';
import { api } from './api';

/** While something is moving (scan, list being made, report updating): poll this often. */
export const ACTIVE_POLL_MS = 2000;
/** Otherwise: still re-read now and then (a Verify or a classification from another tab). */
export const IDLE_POLL_MS = 15_000;

/** Is anything on the report page still changing on its own? */
export function isMoving(r: JobReportResponse | null): boolean {
  if (!r) return true;
  return r.job.status === 'queued' || r.job.status === 'running' || r.todo.state === 'preparing' || r.updating;
}

/**
 * GET /api/jobs/:id/report, polled: every 2 s while the scan runs (or the list
 * is being made, or the report re-renders), every 15 s otherwise, and at once
 * when the tab comes back into view. Newest response wins.
 */
export function useJobReport(jobId: string) {
  const [data, setData] = useState<JobReportResponse | null>(null);
  const [error, setError] = useState<{ message: string; status?: number } | null>(null);
  const seq = useRef(0);
  const dataRef = useRef<JobReportResponse | null>(null);

  const refresh = useCallback(async () => {
    const n = ++seq.current;
    try {
      const next = await api.jobReport(jobId);
      if (n !== seq.current) return;
      dataRef.current = next;
      setData(next);
      setError(null);
    } catch (err) {
      if (n === seq.current) setError({ message: err instanceof Error ? err.message : String(err), status: (err as { status?: number }).status });
    }
  }, [jobId]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    dataRef.current = null;
    setData(null);
    setError(null);
    const loop = async () => {
      if (stopped) return;
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') await refresh();
      if (stopped) return;
      timer = setTimeout(loop, isMoving(dataRef.current) ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    };
    void loop();
    const onVisible = () => {
      if (document.visibilityState !== 'hidden') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [refresh]);

  return { data, error, refresh };
}

/**
 * Re-renders after classifications, coalesced: `request()` waits `delayMs` for
 * more decisions, then runs once; a request while one runs queues exactly one
 * more after it. No "Update report" button — this is what replaces it.
 */
export function createRerenderQueue(run: () => Promise<void>, opts: { delayMs?: number; onState?: (s: 'idle' | 'scheduled' | 'running') => void; onError?: (err: unknown) => void } = {}) {
  const delay = opts.delayMs ?? 800;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let again = false;
  const state = (s: 'idle' | 'scheduled' | 'running') => opts.onState?.(s);
  const fire = async (): Promise<void> => {
    timer = undefined;
    if (running) {
      again = true;
      return;
    }
    running = true;
    state('running');
    try {
      await run();
    } catch (err) {
      opts.onError?.(err);
    } finally {
      running = false;
    }
    if (again) {
      again = false;
      return fire();
    }
    state(timer ? 'scheduled' : 'idle');
  };
  return {
    request(): void {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void fire(), delay);
      if (!running) state('scheduled');
    },
    cancel(): void {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
