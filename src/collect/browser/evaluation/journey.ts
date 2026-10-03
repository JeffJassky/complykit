import type { Page } from 'playwright';
import type { CaptureHandle } from './capture.js';

// The journey (plans/consent-design.md §2.3): land, dwell until activity
// settles, scroll in steps, open a listing page, a product page and the cart
// (never checkout, never submit forms), then one more same-origin navigation so
// page-exit beacons get flushed (see shim.ts). Some trackers only fire after a
// delay, a scroll or a second page — that's why the journey exists.

export interface JourneyOptions {
  /** Dwell on the landing page, ms. Default 10000. */
  dwellMs?: number;
  /** Dwell on each later page, ms. Default dwellMs / 2. */
  pageDwellMs?: number;
  /** Scroll steps per page. Default 4. */
  scrollSteps?: number;
  /** Explicit same-origin paths to visit after landing (overrides discovery). */
  paths?: string[];
  /** Max discovered pages after landing. Default 3 (listing, product, cart). */
  maxPages?: number;
  /** Per-navigation timeout, ms. Default 30000. */
  navTimeoutMs?: number;
}

export interface ResolvedJourney {
  dwellMs: number;
  pageDwellMs: number;
  scrollSteps: number;
  paths?: string[];
  maxPages: number;
  navTimeoutMs: number;
}

export function resolveJourney(j: JourneyOptions = {}): ResolvedJourney {
  const dwellMs = j.dwellMs ?? 10000;
  return {
    dwellMs,
    pageDwellMs: j.pageDwellMs ?? Math.round(dwellMs / 2),
    scrollSteps: j.scrollSteps ?? 4,
    paths: j.paths,
    maxPages: j.maxPages ?? 3,
    navTimeoutMs: j.navTimeoutMs ?? 30000,
  };
}

const NEVER = /(checkout|\/account|login|logout|sign[-_]?in|sign[-_]?out|register|\/wp-admin|\/admin|password|\/orders?\b|unsubscribe|mailto:|tel:|javascript:|\.(pdf|zip|jpg|png|gif|svg|mp4)(\?|$))/i;
const LISTING = /\/(collections?|categor(y|ies)|shop|catalog|c|department|products\/?$)(\/|$|\?)/i;
const PRODUCT = /\/(products?|p|item|dp|produkt|produit)\/[^/?#]+/i;
const CART = /\/(cart|basket|bag|warenkorb|panier)(\/|$|\?)/i;

/** Pick the journey's next pages from links on the current page. */
export async function discoverJourneyPages(page: Page, maxPages: number): Promise<string[]> {
  const links = (await page
    .evaluate(() => Array.from(document.querySelectorAll('a[href]')).map((a) => (a as HTMLAnchorElement).href))
    .catch(() => [])) as string[];
  let here: URL;
  try {
    here = new URL(page.url());
  } catch {
    return [];
  }
  const same = [...new Set(links)].filter((h) => {
    try {
      const u = new URL(h);
      return u.host === here.host && !NEVER.test(h) && u.pathname !== here.pathname;
    } catch {
      return false;
    }
  });
  const pick = (re: RegExp): string | undefined => same.find((h) => re.test(new URL(h).pathname));
  const picked = [pick(LISTING), pick(PRODUCT), pick(CART)].filter((x): x is string => Boolean(x));
  for (const h of same) {
    if (picked.length >= maxPages) break;
    if (!picked.includes(h)) picked.push(h);
  }
  return [...new Set(picked)].slice(0, maxPages);
}

export async function navigate(page: Page, cap: CaptureHandle, url: string, j: ResolvedJourney): Promise<void> {
  cap.push({ type: 'action', t: cap.now(), action: 'navigate', url, pageIndex: cap.pageIndex() });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: j.navTimeoutMs }).catch(() => {});
  await page.waitForLoadState('load', { timeout: Math.min(15000, j.navTimeoutMs) }).catch(() => {});
}

export async function dwell(page: Page, cap: CaptureHandle, ms: number): Promise<void> {
  if (ms <= 0) return;
  cap.push({ type: 'action', t: cap.now(), action: 'wait', detail: `${ms}ms`, pageIndex: cap.pageIndex() });
  await page.waitForTimeout(ms);
}

export async function scrollSteps(page: Page, cap: CaptureHandle, steps: number): Promise<void> {
  for (let i = 1; i <= steps; i++) {
    await page
      .evaluate((f) => window.scrollTo({ top: document.documentElement.scrollHeight * f, behavior: 'instant' as ScrollBehavior }), i / steps)
      .catch(() => {});
    cap.push({ type: 'action', t: cap.now(), action: 'scroll', detail: `${i}/${steps}`, pageIndex: cap.pageIndex() });
    await page.waitForTimeout(600);
  }
}

/** Visit the rest of the journey from the current (landing) page. */
export async function browse(page: Page, cap: CaptureHandle, j: ResolvedJourney, landingUrl: string): Promise<void> {
  await scrollSteps(page, cap, j.scrollSteps);
  const targets = j.paths?.length
    ? j.paths.map((p) => new URL(p, landingUrl).toString())
    : await discoverJourneyPages(page, j.maxPages);
  for (const url of targets) {
    await navigate(page, cap, url, j);
    await dwell(page, cap, j.pageDwellMs);
    await scrollSteps(page, cap, Math.max(1, Math.ceil(j.scrollSteps / 2)));
  }
}

/** One more same-origin navigation so the last page's exit beacons get flushed. */
export async function flush(page: Page, cap: CaptureHandle, landingUrl: string, j: ResolvedJourney): Promise<void> {
  await navigate(page, cap, landingUrl, j);
  await dwell(page, cap, Math.min(3000, j.pageDwellMs));
}
