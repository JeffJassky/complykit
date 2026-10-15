import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConsentStatsResponse, SiteWorkspace, SitesResponse } from '../../shared/api';
import { api } from './api';

/** One fetch with newest-wins ordering (same shape as useKb). */
function useFetched<T>(load: () => Promise<T>, key: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const refresh = useCallback(async () => {
    const n = ++seq.current;
    try {
      const next = await load();
      if (n !== seq.current) return;
      setData(next);
      setError(null);
    } catch (err) {
      if (n === seq.current) setError(err instanceof Error ? err.message : String(err));
    }
  }, [load]);
  useEffect(() => {
    setData(null);
    void refresh();
    // `key` identifies what is being loaded; a different key starts clean.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { data, error, refresh };
}

export const useSites = () => useFetched<SitesResponse>(api.sites, 'sites');

export function useSiteWorkspace(domain: string) {
  const load = useCallback(() => api.siteWorkspace(domain), [domain]);
  return useFetched<SiteWorkspace>(load, domain);
}

/** Banner stats for a site (last 30 days). A failure is the hook's `error`; the panel says so without breaking the page. */
export function useSiteStats(domain: string) {
  const load = useCallback(() => api.siteStats(domain, 30), [domain]);
  return useFetched<ConsentStatsResponse>(load, `stats:${domain}`);
}

type Listenable = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/**
 * Re-read on window focus and when the page becomes visible again: a Verify or a
 * "made this change" done in the report (or through the API) shows up here
 * without a reload. No timer: a page left open on a screen would keep the
 * server from its idle shutdown. Returns the stop function. Pure over the passed
 * window/document so it is testable without a DOM.
 */
export function startLiveRefresh(refresh: () => unknown, env: { win: Listenable; doc: Listenable & { visibilityState: string } }): () => void {
  const { win, doc } = env;
  const onFocus = () => void refresh();
  const onVisibility = () => {
    if (doc.visibilityState !== 'hidden') void refresh();
  };
  win.addEventListener('focus', onFocus);
  doc.addEventListener('visibilitychange', onVisibility);
  return () => {
    win.removeEventListener('focus', onFocus);
    doc.removeEventListener('visibilitychange', onVisibility);
  };
}

/** startLiveRefresh for a component's lifetime; always calls the latest `refresh`. */
export function useLiveRefresh(refresh: () => unknown): void {
  const ref = useRef(refresh);
  ref.current = refresh;
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    return startLiveRefresh(() => ref.current(), { win: window, doc: document });
  }, []);
}
