import type { BrowserContext, Page, Request, Response, CDPSession, Frame } from 'playwright';
import type {
  TimelineEvent,
  RequestEvent,
  CookieSnapshot,
  StorageSnapshot,
} from '../../../record/index.js';
import { SHIM_BINDING, SHIM_SOURCE, type ShimRecord } from './shim.js';

// Scenario capture (plans/consent-design.md §2.4). One handle per browser
// context = per scenario. Sources, and what each is for:
//
//   - Playwright CONTEXT request events: the complete request list — main page,
//     every frame (including cross-site and srcdoc frames), dedicated workers and
//     service workers (spiked 2026-10-02 against a multi-host fixture).
//   - A CDP session per page: initiator stacks, and auto-attached worker targets
//     so worker-originated requests are labelled as such (Playwright reports
//     them against the page's main frame).
//   - The attribution shim (shim.ts): insertion chains, script-written cookies
//     and storage, page-exit beacons.
//   - Response headers: Set-Cookie (which response set which cookie) and
//     server-timing (some platforms report the visitor region there).
//   - context.cookies() at the end: every cookie including HttpOnly.
//   - Per-frame storage at the end.
//
// Times are ms since the scenario started (machine clock — the page's Date.now()
// comes from the same clock).

const BODY_LIMIT = 8192;

/** Resolve with `fallback` if `p` hasn't settled in `ms` — page calls into busy
 *  ad frames can otherwise hang a scenario forever (seen on a news site). */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}
const WS_LIMIT = 1024;

interface CdpInitiator {
  type: string;
  urls: string[];
  worker?: boolean;
}

interface PendingRequest {
  event: RequestEvent;
  req: Request;
}

export interface CaptureOptions {
  /** Called for every shim record (driver code uses insert records for banners). */
  onShim?: (rec: ShimRecord) => void;
}

export interface CaptureHandle {
  readonly startEpoch: number;
  /** ms since start. */
  now(): number;
  /** Append a non-network event (action, banner, choice, readout, screenshot, note). */
  push(event: TimelineEvent): void;
  /** Current journey page index (increments on each top-level navigation). */
  pageIndex(): number;
  /** Visited top-level pages, in order. */
  pages(): Array<{ url: string; title?: string }>;
  /** Attach page-level observers to a page opened in this context. The newest
   *  `main` page is the one whose navigations define the journey's pages. */
  watchPage(page: Page, main?: boolean): Promise<void>;
  /** Finish: await pending header reads, snapshot cookies + storage + frames. */
  stop(pages: Page[]): Promise<{
    events: TimelineEvent[];
    cookies: CookieSnapshot[];
    storage: StorageSnapshot[];
    frames: Array<{ url: string; sandboxed?: boolean }>;
    notes: string[];
  }>;
}

function parseSetCookie(line: string): { name: string; domain?: string; maxAgeSec?: number; expires?: string; sameSite?: string } | null {
  const parts = line.split(';').map((p) => p.trim());
  const first = parts.shift();
  if (!first || !first.includes('=')) return null;
  const name = first.slice(0, first.indexOf('=')).trim();
  if (!name) return null;
  const out: { name: string; domain?: string; maxAgeSec?: number; expires?: string; sameSite?: string } = { name };
  for (const p of parts) {
    const [k, ...rest] = p.split('=');
    const v = rest.join('=');
    const key = k.trim().toLowerCase();
    if (key === 'domain') out.domain = v.trim();
    else if (key === 'max-age') out.maxAgeSec = Number(v);
    else if (key === 'expires') out.expires = v.trim();
    else if (key === 'samesite') out.sameSite = v.trim();
  }
  return out;
}

function parseCookieWrite(raw: string): { name: string; value: string; attributes?: string } | null {
  const semi = raw.indexOf(';');
  const pair = semi >= 0 ? raw.slice(0, semi) : raw;
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;
  return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), attributes: semi >= 0 ? raw.slice(semi + 1).trim() : undefined };
}

/** Stack URLs from a CDP initiator: call frames, then async parents. */
function cdpChain(initiator: { url?: string; stack?: unknown } | undefined): string[] {
  const urls: string[] = [];
  type Stack = { callFrames?: Array<{ url?: string }>; parent?: Stack };
  let stack = initiator?.stack as Stack | undefined;
  let depth = 0;
  while (stack && depth < 12) {
    for (const f of stack.callFrames ?? []) if (f.url && !urls.includes(f.url)) urls.push(f.url);
    stack = stack.parent;
    depth++;
  }
  if (!urls.length && initiator?.url) urls.push(initiator.url);
  return urls;
}

export async function startCapture(context: BrowserContext, opts: CaptureOptions = {}): Promise<CaptureHandle> {
  const startEpoch = Date.now();
  const now = (): number => Date.now() - startEpoch;
  const events: TimelineEvent[] = [];
  const pending: PendingRequest[] = [];
  const byRequest = new Map<Request, RequestEvent>();
  const headerReads: Promise<void>[] = [];
  const shimRecords: ShimRecord[] = [];
  const cdpByUrl = new Map<string, CdpInitiator[]>();
  const workerUrls = new Set<string>();
  // URLs the PAGE-level CDP session saw. A request Playwright attributes to the
  // page that the page session never saw came from a dedicated worker whose
  // own session attached too late to see it (a race under load).
  const pageSessionUrls = new Set<string>();
  let cdpAvailable = false;
  const cdpSessions: CDPSession[] = [];
  const notes: string[] = [];
  const pageList: Array<{ url: string; title?: string }> = [];
  let pageIdx = 0;
  let navigations = 0;
  let mainPage: Page | undefined;
  let seq = 0;

  await context.exposeBinding(SHIM_BINDING, (_source, rec: ShimRecord) => {
    if (!rec || typeof rec !== 'object') return;
    shimRecords.push(rec);
    opts.onShim?.(rec);
  });
  await context.addInitScript(SHIM_SOURCE);

  const frameOrigin = (req: Request): { origin: RequestEvent['origin']; frameUrl?: string } => {
    if (req.serviceWorker()) return { origin: 'service-worker' };
    let frame: Frame | undefined;
    try {
      frame = req.frame();
    } catch {
      return { origin: 'worker' };
    }
    const page = frame.page();
    const isMain = frame === page.mainFrame();
    return { origin: isMain ? 'page' : 'frame', frameUrl: isMain ? undefined : frame.url() };
  };

  context.on('request', (req) => {
    const { origin, frameUrl } = frameOrigin(req);
    let postData: string | undefined;
    try {
      const buf = req.postDataBuffer();
      if (buf) postData = buf.subarray(0, BODY_LIMIT).toString('utf8');
    } catch {
      /* no body */
    }
    const event: RequestEvent = {
      type: 'request',
      t: now(),
      id: `r${++seq}`,
      url: req.url(),
      method: req.method(),
      resourceType: req.resourceType(),
      origin,
      frameUrl,
      pageUrl: mainPage?.url() ?? '',
      pageIndex: pageIdx,
      initiator: { type: 'other', chain: [] },
      postData,
      setCookies: [],
    };
    events.push(event);
    pending.push({ event, req });
    byRequest.set(req, event);
  });

  const onResponse = (res: Response): void => {
    const event = byRequest.get(res.request());
    if (!event) return;
    event.status = res.status();
    headerReads.push(
      res
        .headersArray()
        .then((headers) => {
          for (const h of headers) {
            const name = h.name.toLowerCase();
            if (name === 'set-cookie') {
              for (const line of h.value.split('\n')) {
                const c = parseSetCookie(line);
                if (c) event.setCookies.push(c);
              }
            } else if (name === 'server-timing' && event.resourceType === 'document') {
              event.responseHeaders = { ...(event.responseHeaders ?? {}), 'server-timing': h.value.slice(0, 2000) };
            }
          }
        })
        .catch(() => {
          /* response gone */
        }),
    );
  };
  context.on('response', onResponse);
  context.on('requestfailed', (req) => {
    const event = byRequest.get(req);
    if (event) event.failure = req.failure()?.errorText ?? 'failed';
  });

  const attachCdp = async (page: Page): Promise<void> => {
    let cdp: CDPSession;
    try {
      cdp = await context.newCDPSession(page);
    } catch {
      notes.push('initiator stacks unavailable (not Chromium)');
      return;
    }
    cdpSessions.push(cdp);
    const record = (url: string, init: CdpInitiator): void => {
      const list = cdpByUrl.get(url) ?? [];
      list.push(init);
      cdpByUrl.set(url, list);
    };
    cdpAvailable = true;
    cdp.on('Network.requestWillBeSent', (e: { request: { url: string }; initiator?: { type?: string; url?: string; stack?: unknown } }) => {
      pageSessionUrls.add(e.request.url);
      record(e.request.url, { type: e.initiator?.type ?? 'other', urls: cdpChain(e.initiator) });
    });
    // Workers are attached paused (waitForDebuggerOnStart, workers only via
    // the filter) so Network.enable lands before their first request — without
    // it a worker's opening fetch raced the attach and was labelled "page".
    cdp.on('Target.attachedToTarget', (e: { sessionId: string; targetInfo: { type: string; url: string }; waitingForDebugger?: boolean }) => {
      const send = (id: number, method: string): Promise<unknown> =>
        cdp.send('Target.sendMessageToTarget', { sessionId: e.sessionId, message: JSON.stringify({ id, method }) }).catch(() => undefined);
      if (e.targetInfo.type === 'worker' || e.targetInfo.type === 'shared_worker' || e.targetInfo.type === 'service_worker') {
        void send(1, 'Network.enable').then(() => (e.waitingForDebugger ? send(2, 'Runtime.runIfWaitingForDebugger') : undefined));
      } else if (e.waitingForDebugger) {
        void send(2, 'Runtime.runIfWaitingForDebugger');
      }
    });
    cdp.on('Target.receivedMessageFromTarget', (e: { message: string }) => {
      try {
        const m = JSON.parse(e.message) as { method?: string; params?: { request?: { url: string }; initiator?: { type?: string; url?: string; stack?: unknown } } };
        if (m.method === 'Network.requestWillBeSent' && m.params?.request) {
          workerUrls.add(m.params.request.url);
          record(m.params.request.url, { type: m.params.initiator?.type ?? 'script', urls: cdpChain(m.params.initiator), worker: true });
        }
      } catch {
        /* ignore */
      }
    });
    try {
      await cdp.send('Network.enable');
      await cdp
        .send('Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: false,
          filter: [{ type: 'worker' }, { type: 'shared_worker' }, { type: 'service_worker' }, { type: 'iframe', exclude: true }, { type: 'page', exclude: true }],
        })
        .catch(() => cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: false }));
    } catch {
      notes.push('could not enable CDP network/auto-attach; worker attribution partial');
    }
  };

  const watchPage = async (page: Page, main: boolean): Promise<void> => {
    if (main || !mainPage) mainPage = page;
    await attachCdp(page);
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame() || page !== mainPage) return;
      if (navigations > 0) pageIdx++;
      navigations++;
      pageList.push({ url: frame.url() });
    });
    page.on('load', () => {
      if (page !== mainPage) return;
      page
        .title()
        .then((title) => {
          const last = pageList[pageList.length - 1];
          if (last && !last.title) last.title = title;
        })
        .catch(() => {});
    });
    page.on('websocket', (ws) => {
      events.push({ type: 'websocket', t: now(), url: ws.url(), direction: 'open', pageIndex: pageIdx });
      ws.on('framesent', (f) => {
        const payload = typeof f.payload === 'string' ? f.payload : f.payload.toString('utf8');
        events.push({ type: 'websocket', t: now(), url: ws.url(), direction: 'sent', payload: payload.slice(0, WS_LIMIT), pageIndex: pageIdx });
      });
    });
  };

  const stop: CaptureHandle['stop'] = async (pages) => {
    await withTimeout(Promise.allSettled(headerReads), 5000, []);

    // 1. Initiators: zip CDP records onto requests by URL, in arrival order.
    const cursor = new Map<string, number>();
    for (const { event } of pending) {
      const list = cdpByUrl.get(event.url);
      const i = cursor.get(event.url) ?? 0;
      const hit = list?.[i];
      if (hit) {
        cursor.set(event.url, i + 1);
        event.initiator = { type: hit.type, chain: hit.urls };
        if (hit.worker && event.origin === 'page') event.origin = 'worker';
      } else if (event.origin === 'page' && (workerUrls.has(event.url) || (cdpAvailable && !pageSessionUrls.has(event.url)))) {
        event.origin = 'worker';
        if (!workerUrls.has(event.url)) event.initiator = { type: 'worker (inferred)', chain: [] };
      }
    }

    // 2. Shim attribution: the inserting script for elements, the setter stack
    //    for image pixels; then extend chains through script-inserted scripts.
    const insertedBy = new Map<string, string[]>(); // element URL -> inserting chain
    const insertTag = new Map<string, string>();
    for (const r of shimRecords) {
      if ((r.kind === 'insert' || r.kind === 'img-src') && r.url && !insertedBy.has(r.url)) {
        insertedBy.set(r.url, r.chain ?? []);
        insertTag.set(r.url, r.tag ?? 'img');
      }
    }
    const callStackOf = new Map<string, string[]>(); // url -> fetch/xhr/beacon stack
    for (const r of shimRecords) {
      if ((r.kind === 'fetch' || r.kind === 'xhr' || r.kind === 'beacon') && r.url && !callStackOf.has(r.url)) callStackOf.set(r.url, r.chain ?? []);
    }
    const extend = (chain: string[]): string[] => {
      const out = [...chain];
      let frontier = [...chain];
      for (let depth = 0; depth < 6 && frontier.length; depth++) {
        const next: string[] = [];
        for (const u of frontier) {
          for (const p of insertedBy.get(u) ?? []) {
            if (!out.includes(p)) {
              out.push(p);
              next.push(p);
            }
          }
        }
        frontier = next;
      }
      return out;
    };
    for (const { event } of pending) {
      const shimChain = insertedBy.get(event.url);
      const tag = insertTag.get(event.url);
      // A JS-made element beats a CDP "parser" attribution to the document.
      if (shimChain && shimChain.length && (event.initiator.type === 'parser' || event.initiator.type === 'other' || !event.initiator.chain.length)) {
        event.initiator = { type: 'script', chain: shimChain, element: tag };
      } else if (tag) {
        event.initiator = { ...event.initiator, element: tag };
      }
      const stack = callStackOf.get(event.url);
      if (stack && stack.length && !event.initiator.chain.length) event.initiator = { type: 'script', chain: stack, element: event.initiator.element };
      event.initiator = { ...event.initiator, chain: extend(event.initiator.chain) };
    }

    // 3. Exit beacons the browser's events missed: shim exit records whose URL
    //    never appeared as a request.
    const seenUrls = new Set(pending.map((p) => p.event.url));
    const exitSeen = new Set<string>();
    for (const r of shimRecords) {
      if (!r.exiting || !r.url) continue;
      if (r.kind !== 'beacon' && r.kind !== 'fetch' && r.kind !== 'img-src' && r.kind !== 'insert') continue;
      const key = `${r.kind}|${r.url}|${r.t}`;
      if (exitSeen.has(key) || seenUrls.has(r.url)) continue;
      exitSeen.add(key);
      events.push({
        type: 'request',
        t: r.t - startEpoch,
        id: `x${++seq}`,
        url: r.url,
        method: r.kind === 'beacon' || r.body ? 'POST' : 'GET',
        resourceType: r.kind === 'beacon' ? 'ping' : r.kind === 'fetch' ? 'fetch' : 'image',
        origin: 'exit-beacon',
        frameUrl: r.top ? undefined : r.frame,
        pageUrl: r.frame,
        pageIndex: Math.max(0, pageIdxAt(r.t - startEpoch)),
        initiator: { type: 'script', chain: extend(r.chain ?? []) },
        postData: r.body,
        setCookies: [],
      });
    }

    // 4. Script-written cookies and storage, attributed.
    for (const r of shimRecords) {
      if (r.kind === 'cookie' && r.raw) {
        const c = parseCookieWrite(r.raw);
        if (c) events.push({ type: 'cookie-write', t: r.t - startEpoch, name: c.name, value: c.value, attributes: c.attributes, frameUrl: r.frame, chain: extend(r.chain ?? []), pageIndex: pageIdxAt(r.t - startEpoch) });
      } else if (r.kind === 'storage' && r.key !== undefined && r.area) {
        events.push({ type: 'storage-write', t: r.t - startEpoch, area: r.area, key: r.key, value: r.value ?? '', frameUrl: r.frame, chain: extend(r.chain ?? []), pageIndex: pageIdxAt(r.t - startEpoch) });
      }
    }

    // 5. End-of-visit state: every cookie (HttpOnly included), storage in every frame.
    const cookies: CookieSnapshot[] = (await withTimeout(context.cookies(), 5000, [])).map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
    }));
    const storage: StorageSnapshot[] = [];
    const frames: Array<{ url: string; sandboxed?: boolean }> = [];
    const seenOrigins = new Set<string>();
    for (const page of pages) {
      if (page.isClosed()) continue;
      if (process.env.COMPLYKIT_DEBUG) process.stdout.write(`    debug: ${page.frames().length} frames\n`);
      for (const frame of page.frames()) {
        let sandboxed: boolean | undefined;
        if (frame !== page.mainFrame()) {
          sandboxed = await withTimeout(
            frame.frameElement().then(async (el) => (await el.getAttribute('sandbox')) !== null || undefined),
            2000,
            undefined,
          );
          frames.push({ url: frame.url(), sandboxed });
        }
        try {
          const res = (await withTimeout(frame.evaluate(async () => {
            const out: Array<{ origin: string; area: 'local' | 'session' | 'indexeddb'; key: string; value?: string }> = [];
            const origin = location.origin;
            try {
              for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i) ?? '';
                out.push({ origin, area: 'local', key: k, value: (localStorage.getItem(k) ?? '').slice(0, 2048) });
              }
            } catch {
              /* blocked */
            }
            try {
              for (let i = 0; i < sessionStorage.length; i++) {
                const k = sessionStorage.key(i) ?? '';
                if (k === '__ck_exit') continue;
                out.push({ origin, area: 'session', key: k, value: (sessionStorage.getItem(k) ?? '').slice(0, 2048) });
              }
            } catch {
              /* blocked */
            }
            try {
              const dbs = indexedDB.databases ? await indexedDB.databases() : [];
              for (const d of dbs) if (d.name) out.push({ origin, area: 'indexeddb', key: d.name });
            } catch {
              /* blocked */
            }
            return out;
          }), 3000, [] as StorageSnapshot[])) as StorageSnapshot[];
          for (const s of res) {
            const k = `${s.origin}|${s.area}|${s.key}`;
            if (seenOrigins.has(k)) continue;
            seenOrigins.add(k);
            storage.push(s);
          }
        } catch {
          /* cross-origin frame gone, or about:blank */
        }
      }
    }

    for (const cdp of cdpSessions) await withTimeout(cdp.detach(), 2000, undefined);
    events.sort((a, b) => a.t - b.t);
    return { events, cookies, storage, frames, notes };
  };

  // Page index at time t (for shim records that arrive after the fact).
  const navTimes: number[] = [];
  const pageIdxAt = (t: number): number => {
    let idx = 0;
    for (let i = 1; i < navTimes.length; i++) if (navTimes[i] <= t) idx = i;
    return idx;
  };
  return {
    startEpoch,
    now,
    push: (e) => events.push(e),
    pageIndex: () => pageIdx,
    pages: () => pageList,
    watchPage: async (page, main = true) => {
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame() && page === mainPage) navTimes.push(now());
      });
      await watchPage(page, main);
    },
    stop,
  };
}
