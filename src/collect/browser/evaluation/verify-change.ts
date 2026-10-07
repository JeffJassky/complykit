import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser, BrowserContextOptions, Page, Request } from 'playwright';
import type { LocationSpec, SpotCheckObservation } from '../../../record/index.js';
import { contextOptionsFor } from './location.js';
import { fetchContainers } from './containers.js';
import { CK, readComplykit } from './complykit.js';

// The fetching half of the guided remediation flow's Verify (plans/remediation-flow.md
// §5, ticket R4). ONE thing per Verify, never a scan:
//
//   fetchHtml       the served HTML of one page — the bytes of the top-level
//                   navigation response, not the rendered DOM (A1's rule) —
//                   through a real browser context with the scans' settings
//                   (same browser, locale defaults, viewport). The visit stops at
//                   the response: no dwell, no interaction.
//   fetchContainer  one published tag-manager container, fetched the way the
//                   scan fetches containers (containers.ts).
//   spotCheck       one page, two fresh contexts: land, reject through
//                   complykit's own tool by its exact hooks (or its API), record
//                   every request; then land again and accept. Emits the
//                   SpotCheckObservation the pure judge (rules/remediation/verify.ts)
//                   decides on. Without complykit's tool on the page nothing is
//                   clicked: the observation says so and the judge says
//                   cannot-verify. No autoconsent, no text heuristics: Verify is
//                   about the tool the owner installed.
//
// Nothing here decides pass or fail.

const NAV_TIMEOUT_MS = 15000;
const BODY_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 8 * 1024 * 1024;
const VIEWPORT = { width: 1280, height: 800 };

export interface VerifyBrowserOptions {
  /** Extra Chromium args (tests map *.test hosts to a local server). */
  launchArgs?: string[];
  /** Where the visit comes from (default: this machine, as a scan's 'local' location). */
  location?: LocationSpec;
}

export type FetchedText =
  | { ok: true; text: string; status: number; url: string; via: 'navigation' | 'refetch' | 'request'; headers?: Record<string, string> }
  /** `text` / `headers`: what an error response carried (a bot challenge answers 403 / 503 with its own page). */
  | { ok: false; error: string; status?: number; url: string; text?: string; headers?: Record<string, string> };

export interface SpotCheckRun extends SpotCheckObservation {
  /** How each choice was made (or why not), for the owner. */
  notes: string[];
  /** Set when the landing was a bot challenge (by `SpotCheckOptions.challenge`): nothing was driven. */
  challenge?: unknown;
}

export interface SpotCheckOptions {
  /** How long to wait for complykit's banner after the load (default 8000). */
  bannerWaitMs?: number;
  /** Quiet time after a choice for its requests to land (default 2500). */
  settleMs?: number;
  /** Is the landing document a bot challenge? (The pure detector, passed in: collectors import no rule.) Truthy stops the check. */
  challenge?: (html: string, headers: Record<string, string>, status: number) => unknown;
}

export interface VerifyBrowser {
  readonly version: string;
  fetchHtml(url: string): Promise<FetchedText>;
  fetchContainer(url: string): Promise<FetchedText>;
  spotCheck(url: string, opts?: SpotCheckOptions): Promise<SpotCheckRun>;
  close(): Promise<void>;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message.split('\n')[0].slice(0, 160) : String(err);
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
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

const isHtml = (type: string | undefined): boolean => !type || /html|xml/i.test(type);

/** Launch the browser the scans use (COMPLYKIT_BROWSER_CHANNEL=chrome drives an installed Chrome). */
export async function openVerifyBrowser(opts: VerifyBrowserOptions = {}): Promise<VerifyBrowser> {
  const { chromium } = await import('playwright');
  const channel = process.env.COMPLYKIT_BROWSER_CHANNEL || undefined;
  const browser: Browser = await chromium.launch({ headless: process.env.COMPLYKIT_HEADED !== '1', args: opts.launchArgs ?? [], ...(channel ? { channel } : {}) });
  const location: LocationSpec = opts.location ?? { id: 'local', label: 'This machine' };
  const contextOptions = (): BrowserContextOptions => ({ ...contextOptionsFor(location), viewport: VIEWPORT, deviceScaleFactor: 1 });

  return {
    version: browser.version(),

    async fetchHtml(url) {
      const context = await browser.newContext(contextOptions());
      try {
        const page = await context.newPage();
        // Only the document itself: no script, image or frame of the page is fetched, so
        // a Verify sends nothing to the site's vendors (and counts as no visit in them).
        await page.route('**/*', (route) => (route.request().isNavigationRequest() && route.request().frame() === page.mainFrame() ? route.continue() : route.abort('blockedbyclient')));
        let navError: string | undefined;
        // 'commit': the response is in; the page's own scripts are not waited for.
        const res = await page.goto(url, { waitUntil: 'commit', timeout: NAV_TIMEOUT_MS }).catch((e: unknown) => {
          navError = msg(e);
          return null;
        });
        if (res) {
          const status = res.status();
          const type = (await res.allHeaders().catch(() => ({}) as Record<string, string>))['content-type'];
          const headers = await res.allHeaders().catch(() => ({}) as Record<string, string>);
          if (!isHtml(type)) return { ok: false, status, url: res.url(), error: `not HTML (${type})`, headers };
          const buf = await withTimeout(res.body().then((b) => b as Buffer | undefined), BODY_TIMEOUT_MS, undefined);
          if (buf && buf.length > MAX_HTML_BYTES) return { ok: false, status, url: res.url(), error: `HTML larger than ${MAX_HTML_BYTES} bytes`, headers };
          // An error page keeps its body: the caller looks for a bot challenge in it first.
          if (status >= 400) return { ok: false, status, url: res.url(), error: `HTTP ${status}`, headers, ...(buf ? { text: buf.toString('utf8') } : {}) };
          if (buf) return { ok: true, text: buf.toString('utf8'), status, url: res.url(), via: 'navigation', headers };
        }
        // The navigation body could not be read: the same context fetches it again (A1's fallback).
        const again = await context.request.get(url, { timeout: NAV_TIMEOUT_MS, failOnStatusCode: false }).catch((e: unknown) => {
          navError = `${navError ? `${navError}; ` : ''}re-fetch failed: ${msg(e)}`;
          return null;
        });
        if (!again) return { ok: false, url, error: navError ?? 'no response' };
        const status = again.status();
        const headers = again.headers();
        if (!isHtml(headers['content-type'])) return { ok: false, status, url: again.url(), error: `not HTML (${headers['content-type']})`, headers };
        const body = await again.body();
        if (body.length > MAX_HTML_BYTES) return { ok: false, status, url: again.url(), error: `HTML larger than ${MAX_HTML_BYTES} bytes`, headers };
        if (status >= 400) return { ok: false, status, url: again.url(), error: `HTTP ${status}`, headers, text: body.toString('utf8') };
        return { ok: true, text: body.toString('utf8'), status, url: again.url(), via: 'refetch', headers };
      } finally {
        await context.close().catch(() => {});
      }
    },

    async fetchContainer(url) {
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        return { ok: false, url, error: 'not a URL' };
      }
      const id = u.searchParams.get('id')?.trim().toUpperCase() || 'container';
      const kind = u.pathname.endsWith('/gtm.js') ? 'gtm' : 'gtag';
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'complykit-verify-'));
      try {
        const [c] = await fetchContainers(browser, new Map([[location.id, location]]), [{ id, kind, url, locationId: location.id, seenOn: [] }], { evidenceDir: tmp, evidenceRel: 'containers', timeoutMs: NAV_TIMEOUT_MS, max: 1 });
        if (!c) return { ok: false, url, error: 'not fetched' };
        if (c.status !== 'ok' || c.source === undefined) return { ok: false, url, status: c.httpStatus, error: (c.error ?? 'not fetched').split('\n')[0] };
        return { ok: true, text: c.source, status: c.httpStatus ?? 200, url, via: 'request' };
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },

    async spotCheck(url, opts = {}) {
      const bannerWaitMs = opts.bannerWaitMs ?? 8000;
      const settleMs = opts.settleMs ?? 2500;
      const notes: string[] = [];
      const phases: SpotCheckObservation['phases'] = [];
      let toolPresent = true;
      for (const scenario of ['reject', 'accept'] as const) {
        // A fresh profile per phase: the accept visit must not inherit the reject.
        const context = await browser.newContext({ ...contextOptions(), serviceWorkers: 'block' });
        const requests: Array<{ url: string }> = [];
        context.on('request', (r: Request) => {
          requests.push({ url: r.url() });
        });
        try {
          const page = await context.newPage();
          let landedRes: Awaited<ReturnType<Page['goto']>> = null;
          const landed = await page
            .goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS })
            .then((r) => {
              landedRes = r;
              return true;
            })
            .catch((e: unknown) => {
              notes.push(`${scenario}: the page did not finish loading (${msg(e)})`);
              return false;
            });
          // A bot challenge instead of the page: nothing on it is the site's, so nothing is driven.
          const lr = landedRes as Awaited<ReturnType<Page['goto']>>;
          if (opts.challenge && lr) {
            const headers = await lr.allHeaders().catch(() => ({}) as Record<string, string>);
            const body = await withTimeout(lr.body().then((b) => b as Buffer | undefined), BODY_TIMEOUT_MS, undefined);
            const html = body ? body.toString('utf8') : await page.content().catch(() => '');
            const challenge = opts.challenge(html, headers, lr.status());
            if (challenge) {
              notes.push(`${scenario}: the landing was a bot challenge`);
              phases.push({ scenario, choiceMade: false, requests: [...requests], stores: [] });
              return { page: url, phases, notes, challenge };
            }
          }
          await page.waitForSelector(CK.banner, { state: 'visible', timeout: landed ? bannerWaitMs : 2000 }).catch(() => {});
          const snap = await readComplykit(page);
          if (!snap?.present) {
            toolPresent = false;
            notes.push(`${scenario}: complykit’s consent tool is not on ${url} (no ComplyKit global, config element or consent cookie)`);
            phases.push({ scenario, choiceMade: false, requests: [...requests], stores: [] });
            break; // nothing to drive: the second visit would add nothing
          }
          const mark = requests.length;
          const choice = await makeChoice(page, scenario);
          notes.push(`${scenario}: ${choice.method}${choice.ok ? '' : ' — the choice was not made'}`);
          await page.waitForLoadState('networkidle', { timeout: settleMs + 2000 }).catch(() => {});
          await page.waitForTimeout(settleMs);
          const stores = (await context.cookies().catch(() => [])).map((c) => ({ kind: 'cookie', name: c.name, host: c.domain.replace(/^\./, '') }));
          // Reject: the whole visit counts (a vendor that fired on load was not held either).
          // Accept: what ran after the choice.
          phases.push({ scenario, choiceMade: choice.ok, requests: scenario === 'reject' ? [...requests] : requests.slice(mark), stores });
        } finally {
          await context.close().catch(() => {});
        }
      }
      return { page: url, toolPresent, phases, notes };
    },

    async close() {
      await browser.close().catch(() => {});
    },
  };
}

interface ToolState {
  status?: string;
  categories?: Record<string, boolean>;
}

const readState = (page: Page): Promise<ToolState | null> =>
  page
    .evaluate(() => {
      const ck = (window as unknown as { ComplyKit?: { get?: () => unknown } }).ComplyKit;
      try {
        const s = typeof ck?.get === 'function' ? (ck.get() as { status?: unknown; categories?: unknown } | null) : null;
        return s ? { status: typeof s.status === 'string' ? s.status : undefined, categories: (s.categories ?? {}) as Record<string, boolean> } : null;
      } catch {
        return null;
      }
    })
    .catch(() => null);

/** The stored state reflects the choice: chosen, and every optional category off (reject) / some on (accept). */
function confirms(choice: 'accept' | 'reject', s: ToolState | null): boolean {
  if (!s || s.status !== 'chosen') return false;
  const optional = Object.entries(s.categories ?? {}).filter(([id]) => id !== 'necessary');
  return choice === 'reject' ? optional.every(([, v]) => v === false) : optional.some(([, v]) => v === true);
}

async function settledState(page: Page, choice: 'accept' | 'reject', budgetMs = 3000): Promise<boolean> {
  for (const until = Date.now() + budgetMs; ; ) {
    if (confirms(choice, await readState(page))) return true;
    if (Date.now() >= until) return false;
    await page.waitForTimeout(250);
  }
}

/** Reject / accept through complykit's exact banner hooks; reject falls back to ComplyKit.withdraw(). */
async function makeChoice(page: Page, choice: 'accept' | 'reject'): Promise<{ ok: boolean; method: string }> {
  const sel = choice === 'accept' ? CK.accept : CK.reject;
  const clicked = await page
    .click(sel, { timeout: 4000 })
    .then(() => true)
    .catch(() => false);
  if (clicked) {
    if (await settledState(page, choice)) return { ok: true, method: `complykit:click(banner ${choice})` };
    if (choice === 'accept') return { ok: false, method: 'complykit:click(banner accept) — the stored state did not change' };
  }
  if (choice === 'accept') return { ok: false, method: 'complykit:accept button not clickable (the banner did not show: a stored choice, or the UI file did not load)' };
  // Reject has a documented API: ComplyKit.withdraw() denies every optional category.
  const viaApi = await page
    .evaluate(() => {
      const ck = (window as unknown as { ComplyKit?: { withdraw?: () => unknown } }).ComplyKit;
      if (typeof ck?.withdraw !== 'function') return false;
      ck.withdraw();
      return true;
    })
    .catch(() => false);
  if (!viaApi) return { ok: false, method: clicked ? 'complykit:click(banner reject) — the stored state did not change' : 'complykit:reject button not clickable and no ComplyKit.withdraw()' };
  await page.waitForLoadState('load', { timeout: NAV_TIMEOUT_MS }).catch(() => {});
  return (await settledState(page, 'reject')) ? { ok: true, method: 'complykit:api(withdraw)' } : { ok: false, method: 'complykit:api(withdraw) — the stored state did not change' };
}
