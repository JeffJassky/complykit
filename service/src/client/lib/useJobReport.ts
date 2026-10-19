import { useCallback, useEffect, useRef, useState } from 'react';
import type { JobReportResponse } from '../../shared/api';
import { api } from './api';

/** While something is moving (scan, list being made, report updating): poll this often. */
export const ACTIVE_POLL_MS = 2000;

/** Is anything on the report page still changing on its own? */
export function isMoving(r: JobReportResponse | null): boolean {
  if (!r) return true;
  return r.job.status === 'queued' || r.job.status === 'running' || r.todo.state === 'preparing' || r.updating;
}

/**
 * GET /api/jobs/:id/report, polled every 2 s while the scan runs (or the list
 * is being made, or the report re-renders). Once nothing is moving it stops
 * polling and re-reads only on focus or when the tab comes back into view (a
 * Verify or a classification from another tab): a timer on a settled report
 * would keep the server from its idle shutdown. Newest response wins.
 */
export function useJobReport(jobId: string) {
  // Set by the poll effect: starts the loop again when a refresh found something moving (a classification the server is re-rendering).
  const wake = useRef<(() => void) | undefined>(undefined);
  const [data, setData] = useState<JobReportResponse | null>(null);
  const [error, setError] = useState<{ message: string; status?: number } | null>(null);
  const seq = useRef(0);
  const dataRef = useRef<JobReportResponse | null>(null);

  const read = useCallback(async () => {
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
  const refresh = useCallback(async () => {
    await read();
    wake.current?.();
  }, [read]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // True from a loop's start until it settles without scheduling another: at most one loop at a time.
    let polling = false;
    dataRef.current = null;
    setData(null);
    setError(null);
    const loop = async () => {
      if (stopped) return;
      polling = true;
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') await read();
      if (stopped) return;
      timer = isMoving(dataRef.current) ? setTimeout(loop, ACTIVE_POLL_MS) : undefined;
      polling = !!timer;
    };
    wake.current = () => {
      if (!stopped && !polling && isMoving(dataRef.current)) void loop();
    };
    void loop();
    const onVisible = () => {
      if (document.visibilityState === 'hidden') return;
      // Moving: re-read now, the loop keeps polling. Settled: one loop pass, which polls again only if something started moving.
      if (polling) void read();
      else void loop();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      stopped = true;
      wake.current = undefined;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [read]);

  return { data, error, refresh };
}
