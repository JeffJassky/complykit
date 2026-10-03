import { useCallback, useEffect, useRef, useState } from 'react';
import type { KbResponse } from '../../shared/api';
import { api } from './api';

/**
 * GET /api/kb, refetched whenever `version` changes (the stream's `kb` event
 * bumps it) and after the page's own mutations via `refresh`. Responses that
 * arrive out of order are dropped, so the newest request always wins.
 */
export function useKb(version: number) {
  const [data, setData] = useState<KbResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const n = ++seq.current;
    try {
      const next = await api.kb();
      if (n !== seq.current) return;
      setData(next);
      setError(null);
    } catch (err) {
      if (n === seq.current) setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [version, refresh]);

  return { data, error, refresh };
}

const REVIEWER_KEY = 'complykit.reviewer';

function readReviewer(): string {
  try {
    return window.localStorage.getItem(REVIEWER_KEY) ?? '';
  } catch {
    return ''; // storage blocked (private window, policy)
  }
}

/** The reviewer's name, remembered in this browser. Required to confirm or reject. */
export function useReviewer(): [string, (name: string) => void] {
  const [name, setName] = useState(readReviewer);
  const update = useCallback((next: string) => {
    setName(next);
    try {
      if (next.trim()) window.localStorage.setItem(REVIEWER_KEY, next);
      else window.localStorage.removeItem(REVIEWER_KEY);
    } catch {
      /* not remembered — still works for this visit */
    }
  }, []);
  return [name, update];
}

/** Copy text; falls back to a hidden textarea where the async API is missing
 *  or refused (non-secure context). Resolves false when both fail. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}
