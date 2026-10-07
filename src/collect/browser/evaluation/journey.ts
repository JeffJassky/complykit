import type { Page } from 'playwright';
import type { CaptureHandle } from './capture.js';
import { step, pathOf } from './steps.js';

// The journey (plans/consent-design.md §2.3): land, dwell until activity
// settles, scroll in steps, open a listing page, a product page and the cart
// (never checkout, never submit forms), then one more same-origin navigation so
// page-exit beacons get flushed (see shim.ts). Some trackers only fire after a
// delay, a scroll or a second page — that's why the journey exists.
//
// The one form the journey does submit is the site's search box (a GET form),
// with the evaluation's text marker: page titles and search terms are what
// analytics tags carry to third parties on a results page. When there is no
// usable search the step records itself as not tested — never as a pass.

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
  await step(
    'navigate',
    async () => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: j.navTimeoutMs }).catch(() => {});
      await page.waitForLoadState('load', { timeout: Math.min(15000, j.navTimeoutMs) }).catch(() => {});
    },
    pathOf(url),
  );
}

export async function dwell(page: Page, cap: CaptureHandle, ms: number): Promise<void> {
  if (ms <= 0) return;
  cap.push({ type: 'action', t: cap.now(), action: 'wait', detail: `${ms}ms`, pageIndex: cap.pageIndex() });
  await step('dwell', () => page.waitForTimeout(ms));
}

export async function scrollSteps(page: Page, cap: CaptureHandle, steps: number): Promise<void> {
  if (steps > 0) await step('scroll', () => scrollStepsUntimed(page, cap, steps));
}

async function scrollStepsUntimed(page: Page, cap: CaptureHandle, steps: number): Promise<void> {
  for (let i = 1; i <= steps; i++) {
    await page
      .evaluate((f) => window.scrollTo({ top: document.documentElement.scrollHeight * f, behavior: 'instant' as ScrollBehavior }), i / steps)
      .catch(() => {});
    cap.push({ type: 'action', t: cap.now(), action: 'scroll', detail: `${i}/${steps}`, pageIndex: cap.pageIndex() });
    await page.waitForTimeout(600);
  }
}

/** Per-scenario state for the journey's site-search step (it runs at most once). */
export interface SearchStep {
  /** The marker text to search for (the one the `search-term` field kind detects). */
  term: string;
  /** Receives the not-tested note when the step cannot run. */
  note: (reason: string) => void;
  done?: boolean;
}

const SEARCH_NOT_FOUND = 'site search: no usable search input was found on the landing page — search terms and page titles sent from a results page were not tested';

/** Tag the most likely visible, non-email search input and say whether its form is safe (GET) to submit. */
async function findSearchInput(page: Page): Promise<'found' | 'none' | 'post'> {
  return page
    .evaluate(() => {
      const visible = (el: Element): boolean => {
        const b = (el as HTMLElement).getBoundingClientRect();
        const cs = getComputedStyle(el as HTMLElement);
        return b.width > 0 && b.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
      };
      const text = (i: HTMLInputElement): string => `${i.id} ${i.placeholder} ${i.getAttribute('aria-label') ?? ''}`;
      const usable = (i: HTMLInputElement): boolean => (i.type === 'text' || i.type === 'search' || i.type === '') && !i.disabled && !i.readOnly && visible(i);
      const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input')).filter(usable);
      const tiers: Array<(i: HTMLInputElement) => boolean> = [
        (i) => Boolean(i.closest('[role="search"]')),
        (i) => i.type === 'search',
        (i) => Boolean(i.closest('form[action*="/search" i]')),
        (i) => /^(q|s|query|search|keyword)s?$/i.test(i.name),
        (i) => /search/i.test(text(i)),
      ];
      let hit: HTMLInputElement | undefined;
      for (const t of tiers) {
        hit = inputs.find(t);
        if (hit) break;
      }
      if (!hit) return 'none';
      const form = hit.form;
      if (form && (form.method || 'get').toLowerCase() !== 'get') return 'post';
      hit.setAttribute('data-complykit-marker', 'journey-search');
      return 'found';
    })
    .catch(() => 'none' as const);
}

/**
 * Type the marker into the site's search box, submit it and wait for the
 * results page. Returns false (after noting why) when it could not be done.
 */
export async function searchStep(page: Page, cap: CaptureHandle, search: SearchStep, j: ResolvedJourney): Promise<boolean> {
  if (search.done) return false;
  return step('search', () => searchStepUntimed(page, cap, search, j));
}

async function searchStepUntimed(page: Page, cap: CaptureHandle, search: SearchStep, j: ResolvedJourney): Promise<boolean> {
  search.done = true;
  let found = await findSearchInput(page);
  if (found === 'none') {
    // Many themes hide the box behind a search icon: open it (or follow it to a search page) once and look again.
    const toggle = page
      .locator('a[href="/search"], a[href^="/search?"], button[aria-label*="search" i], summary[aria-label*="search" i], [role="button"][aria-label*="search" i]')
      .first();
    if (await toggle.isVisible({ timeout: 500 }).catch(() => false)) {
      cap.push({ type: 'action', t: cap.now(), action: 'click', detail: 'open site search', pageIndex: cap.pageIndex() });
      await toggle.click({ timeout: 3000 }).catch(() => {});
      await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(800);
      found = await findSearchInput(page);
    }
  }
  if (found === 'post') {
    search.note('site search: the search form submits by POST, which the journey does not do — search terms and page titles sent from a results page were not tested');
    return false;
  }
  if (found !== 'found') {
    search.note(SEARCH_NOT_FOUND);
    return false;
  }
  const sel = '[data-complykit-marker="journey-search"]';
  const before = page.url();
  await page.click(sel, { timeout: 3000 }).catch(() => {});
  cap.push({ type: 'action', t: cap.now(), action: 'type', detail: 'search marker', pageIndex: cap.pageIndex() });
  await page.type(sel, search.term, { delay: 40 }).catch(() => {});
  cap.push({ type: 'action', t: cap.now(), action: 'key', detail: 'Enter (submit search)', pageIndex: cap.pageIndex() });
  await Promise.all([
    page.waitForURL((u) => u.href !== before, { timeout: 8000, waitUntil: 'domcontentloaded' }).catch(() => {}),
    page.keyboard.press('Enter').catch(() => {}),
  ]);
  await page.waitForLoadState('load', { timeout: Math.min(15000, j.navTimeoutMs) }).catch(() => {});
  await dwell(page, cap, j.pageDwellMs);
  await scrollSteps(page, cap, 1);
  return true;
}

/** Visit the rest of the journey from the current (landing) page. */
export async function browse(page: Page, cap: CaptureHandle, j: ResolvedJourney, landingUrl: string, search?: SearchStep): Promise<void> {
  await step('browse', async () => {
    await scrollSteps(page, cap, j.scrollSteps);
    const targets = j.paths?.length
      ? j.paths.map((p) => new URL(p, landingUrl).toString())
      : await step('discover', () => discoverJourneyPages(page, j.maxPages));
    if (search && !search.done) await searchStep(page, cap, search, j);
    let n = 0;
    for (const url of targets) {
      await step(
        'page',
        async () => {
          await navigate(page, cap, url, j);
          await dwell(page, cap, j.pageDwellMs);
          await scrollSteps(page, cap, Math.max(1, Math.ceil(j.scrollSteps / 2)));
        },
        `${++n} ${pathOf(url)}`,
      );
    }
  });
}

/** One more same-origin navigation so the last page's exit beacons get flushed. */
export async function flush(page: Page, cap: CaptureHandle, landingUrl: string, j: ResolvedJourney): Promise<void> {
  await step('flush', async () => {
    await navigate(page, cap, landingUrl, j);
    await dwell(page, cap, Math.min(3000, j.pageDwellMs));
  });
}
