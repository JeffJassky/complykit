import { useCallback, useEffect, useRef, useState } from 'react';
import type { SiteWorkspace, SitesResponse } from '../../shared/api';
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

/** How often an open, visible page re-reads the site (its checklist can change elsewhere: the report, the API, another tab). */
export const LIVE_REFRESH_MS = 30_000;

type Listenable = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/**
 * Re-read on window focus, when the page becomes visible again, and every
 * `intervalMs` while it is visible: a Verify or a "made this change" done in the
 * report (or through the API) shows up here without a reload. Returns the stop
 * function. Pure over the passed window/document so it is testable without a DOM.
 */
export function startLiveRefresh(
  refresh: () => unknown,
  env: { win: Listenable; doc: Listenable & { visibilityState: string }; setInterval?: typeof setInterval; clearInterval?: typeof clearInterval },
  intervalMs = LIVE_REFRESH_MS,
): () => void {
  const { win, doc } = env;
  const set = env.setInterval ?? setInterval;
  const clear = env.clearInterval ?? clearInterval;
  const visible = () => doc.visibilityState !== 'hidden';
  const onFocus = () => void refresh();
  const onVisibility = () => {
    if (visible()) void refresh();
  };
  win.addEventListener('focus', onFocus);
  doc.addEventListener('visibilitychange', onVisibility);
  const timer = set(() => {
    if (visible()) void refresh();
  }, intervalMs);
  return () => {
    win.removeEventListener('focus', onFocus);
    doc.removeEventListener('visibilitychange', onVisibility);
    clear(timer);
  };
}

/** startLiveRefresh for a component's lifetime; always calls the latest `refresh`. */
export function useLiveRefresh(refresh: () => unknown, intervalMs = LIVE_REFRESH_MS): void {
  const ref = useRef(refresh);
  ref.current = refresh;
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    return startLiveRefresh(() => ref.current(), { win: window, doc: document }, intervalMs);
  }, [intervalMs]);
}
