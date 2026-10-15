// The banner beacon (ticket T2; plans/hosted-script.md "Event beacon", P4/P5/P8).
// Counters-only input for the host: what the banner did, never who saw it or
// where. Active only when config.analytics.endpoint is set; otherwise no
// listeners and no requests. Events queue in memory and leave in ONE
// text/plain POST per flush (pagehide / visibilitychange -> hidden) carrying
// the events not yet sent. No timers, no retries, no storage. The body has
// exactly {v, h, tv, r, ev}: no URL, referrer, title, UA, language, screen,
// timezone, id or input value is ever read here.

import { isNecessaryCategory, type ConsentToolConfig } from './config.js';
import type { ConsentStore } from './store.js';
import { TOOL_VERSION } from './version.js';
import type { UiAnalyticsEvent } from './ui/host.js';

type Ev = Record<string, unknown>;

let queue: Ev[] | undefined;
let shownAt: number | undefined;
let nonNecessary: string[] = [];

/** Called by the UI file (through uiHost.report); a no-op until the beacon is on. */
export function report(e: UiAnalyticsEvent): void {
  if (!queue) return;
  if (e.t === 'shown') {
    if (shownAt !== undefined) return;
    shownAt = Date.now();
    queue.push({ t: 'shown' });
  } else if (e.t === 'open') queue.push({ t: 'open', via: e.via });
  else {
    const on = nonNecessary.filter((id) => e.categories[id] === true);
    const a = on.length === nonNecessary.length ? 'accept' : on.length === 0 ? 'reject' : 'custom';
    const ev: Ev = { t: 'decide', a: e.action === 'save' ? a : e.action, via: e.via };
    if (shownAt !== undefined) ev.ms = Math.max(0, Date.now() - shownAt);
    if (e.action === 'save' && a === 'custom') ev.cats = Object.fromEntries(nonNecessary.map((id) => [id, e.categories[id] === true]));
    queue.push(ev);
  }
}

export function startEvents(config: ConsentToolConfig, store: ConsentStore): void {
  const endpoint = config.analytics?.endpoint;
  if (!endpoint || queue || typeof document === 'undefined') return;
  const st = store.state();
  nonNecessary = config.categories.map((c) => c.id).filter((id) => !isNecessaryCategory(id));
  queue = [{ t: 'load', d: st.status === 'chosen' ? 1 : 0, gpc: st.gpc ? 1 : 0 }];
  const flush = (): void => {
    if (!queue!.length) return;
    const body = JSON.stringify({ v: 1, h: config.hash, tv: TOOL_VERSION, r: store.state().regime, ev: queue });
    queue = [];
    try {
      if (navigator.sendBeacon?.(endpoint, body)) return;
    } catch {
      /* fall through to fetch */
    }
    try {
      void fetch(endpoint, { method: 'POST', body, headers: { 'content-type': 'text/plain' }, keepalive: true, credentials: 'omit', mode: 'cors' }).catch(() => {});
    } catch {
      /* analytics never break the page */
    }
  };
  addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}
