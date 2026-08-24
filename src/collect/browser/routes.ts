import type { Page } from 'playwright';
import { settle } from './settle.js';
import { structuralFingerprint } from './fingerprint.js';

// Route discovery: routers give the shape, crawling gives the instances
// (README). For a repo-less public target we have no router, so M2 uses sitemap
// + a same-origin link crawl to gather instances to scan. A repo-emitted route
// manifest (the LLM-shaped task) supersedes this when a repo is configured.

export interface RouteDiscoveryOptions {
  sitemap?: boolean;
  crawl?: { maxPages: number; sameOrigin: boolean };
  include?: string[];
  exclude?: string[];
  cap?: number; // hard cap on returned instances
  sample?: number; // max instances kept per layout fingerprint; default 3
  // Extra URLs to seed the frontier with (subject to include/exclude). CLI
  // targeting uses this so `--routes /deep/page` is reachable even when every
  // intermediate page is filtered out of the crawl.
  seeds?: string[];
  trace?: TraceFn; // per-navigation visibility; default no-op
  // Single-visit measurement hook: called once per KEPT page, while it is loaded
  // in `page` at the crawl cell, so the caller can measure it inline instead of
  // revisiting it in a second pass. The page it's handed is already settled.
  onKeep?: (page: Page, url: string, fingerprint: string) => Promise<void>;
  // Called before each crawl navigation, so the caller can reset the page to a
  // consistent state (e.g. viewport × scheme) — an onKeep may leave it elsewhere.
  prepareVisit?: (page: Page) => Promise<void>;
}

// A single line of crawl/scan narration. Kept dependency-free (just a string
// sink) so the CLI, a test, or a host can decide where it goes.
export type TraceFn = (line: string) => void;
const noopTrace: TraceFn = () => {};

export interface RouteDiscovery {
  urls: string[];
  sitemapUsed: boolean;
  crawledPages: number;
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function normalize(u: string): string {
  try {
    const url = new URL(u);
    url.hash = '';
    return url.toString();
  } catch {
    return u;
  }
}

// Route "template": the path with ID-like segments masked, so /topics/<hexid>
// and /topics/<otherhexid> share a pattern. The backstop cap that fingerprinting
// alone can't provide — 100 detail pages that each render slightly different
// content get 100 fingerprints, but ONE route pattern, so a per-pattern cap
// still bounds them. Deliberately conservative: only mask segments that clearly
// look like identifiers (all-digits, 24-hex mongo id, uuid, or long hex), never
// ordinary slugs like `chatgpt` or `settings` (those are separated by layout
// fingerprint instead).
function routePattern(u: string): string {
  let pathname: string;
  try {
    pathname = new URL(u).pathname;
  } catch {
    return u;
  }
  const idish = (s: string): boolean =>
    /^\d+$/.test(s) ||
    /^[0-9a-f]{24}$/i.test(s) || // mongo ObjectId
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) || // uuid
    /^[0-9a-f]{16,}$/i.test(s); // long hex
  return (
    pathname
      .split('/')
      .map((seg) => (idish(seg) ? ':id' : seg))
      .join('/') || '/'
  );
}

async function fromSitemap(baseUrl: string): Promise<string[]> {
  const origin = new URL(baseUrl).origin;
  try {
    const res = await fetch(`${origin}/sitemap.xml`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const xml = await res.text();
    return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
  } catch {
    return [];
  }
}

// include/exclude are plain substring tests (documented). Applied at ENQUEUE
// time so an excluded route is never even visited — not just dropped from the
// scan set after we already paid to crawl it (and its children).
function passesFilter(url: string, include?: string[], exclude?: string[]): boolean {
  if (include?.length && !include.some((i) => url.includes(i))) return false;
  if (exclude?.length && exclude.some((x) => url.includes(x))) return false;
  return true;
}

interface CrawlOptions {
  include?: string[];
  exclude?: string[];
  seeds?: string[]; // sitemap URLs to visit alongside the crawl frontier
  onKeep?: (page: Page, url: string, fingerprint: string) => Promise<void>;
  prepareVisit?: (page: Page) => Promise<void>;
}

interface CrawlOutcome {
  kept: string[];
  crawledPages: number;
  distinctLayouts: number;
  dropped: number;
}

// The single-visit crawl. Loads each frontier URL ONCE; fingerprints it, expands
// its links, and decides sampling GREEDILY (keep the first `sample` per layout /
// route pattern in crawl order — identical to the old batch decision, since the
// order is the same). A kept page is measured inline via `onKeep` on that same
// load, so nothing is visited twice for discovery + measurement.
async function crawl(
  page: Page,
  baseUrl: string,
  maxPages: number,
  cap: number,
  sample: number,
  sameOriginOnly: boolean,
  trace: TraceFn,
  opts: CrawlOptions,
): Promise<CrawlOutcome> {
  const entry = normalize(baseUrl);
  const queue = [entry];
  const seen = new Set(queue);
  for (const s of opts.seeds ?? []) {
    const n = normalize(s);
    if (!seen.has(n) && passesFilter(n, opts.include, opts.exclude)) {
      seen.add(n);
      queue.push(n);
    }
  }

  // Sampling state (greedy). Sentinels = "couldn't fingerprint" — never collapse
  // those by layout; the route-pattern cap still bounds them.
  const SENTINELS = new Set(['unknown', 'empty']);
  const perLayout = new Map<string, number>();
  const perPattern = new Map<string, number>();
  const landedSeen = new Set<string>();
  const kept: string[] = [];
  let crawledPages = 0;
  let dropped = 0;

  while (queue.length && crawledPages < maxPages && kept.length < cap) {
    const url = queue.shift()!;
    try {
      if (opts.prepareVisit) await opts.prepareVisit(page);
      trace(`crawl → ${url}`);
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 });
      // A client-rendered SPA has an empty <div id="app"> at domcontentloaded —
      // its <a href> nav only exists after the framework mounts. Settle first,
      // or the crawl scrapes zero links and discovers only the entry URL.
      const { timedOut } = await settle(page, { timeoutMs: 8000 });
      await page.waitForTimeout(500);
      crawledPages++;
      const landed = page.url(); // post-redirect (server 30x AND client-side)
      const nLanded = normalize(landed);
      if (landedSeen.has(nLanded)) {
        trace(`  landed ${landed} — already visited, skip`);
        continue;
      }
      landedSeen.add(nLanded);

      const fingerprint = await structuralFingerprint(page);
      const hrefs = (await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href]')).map((a) => (a as HTMLAnchorElement).href),
      )) as string[];
      let queued = 0;
      for (const href of hrefs) {
        const n = normalize(href);
        if (seen.has(n)) continue;
        if (sameOriginOnly && !sameOrigin(n, baseUrl)) continue;
        if (!/^https?:/.test(n)) continue;
        seen.add(n);
        if (!passesFilter(n, opts.include, opts.exclude)) continue; // excluded → never visit
        queue.push(n);
        queued++;
      }
      const redirected = nLanded !== normalize(url);
      trace(
        `  landed ${landed}${redirected ? ' (redirected)' : ''}` +
          ` · http ${resp?.status() ?? '?'}${timedOut ? ' · settle timed out' : ''}` +
          ` · layout ${fingerprint.slice(0, 8)}` +
          ` · ${hrefs.length} anchor(s), ${queued} new · queue ${queue.length}`,
      );

      // Keep decision (greedy sampling). Entry is always kept.
      const isEntry = nLanded === entry || normalize(url) === entry;
      const pat = routePattern(landed);
      let keep = true;
      let why = '';
      if (!isEntry) {
        const layoutSeen = SENTINELS.has(fingerprint) ? 0 : perLayout.get(fingerprint) ?? 0;
        const patternSeen = perPattern.get(pat) ?? 0;
        if (layoutSeen >= sample || patternSeen >= sample) {
          keep = false;
          why = layoutSeen >= sample ? `layout ${fingerprint.slice(0, 8)}` : `pattern ${pat}`;
        }
      }

      if (keep) {
        if (!isEntry) {
          if (!SENTINELS.has(fingerprint)) perLayout.set(fingerprint, (perLayout.get(fingerprint) ?? 0) + 1);
          perPattern.set(pat, (perPattern.get(pat) ?? 0) + 1);
        }
        kept.push(landed);
        // Measure it NOW, on this very load (single-visit).
        if (opts.onKeep) await opts.onKeep(page, landed, fingerprint);
      } else {
        dropped++;
        trace(`  sample cap: skip ${landed} (${why} already has ${sample})`);
      }
    } catch (err) {
      trace(`  FAILED ${url}: ${err instanceof Error ? err.message.split('\n')[0] : 'error'}`);
    }
  }
  return { kept, crawledPages, distinctLayouts: perLayout.size, dropped };
}

export async function discoverRoutes(
  page: Page,
  baseUrl: string,
  opts: RouteDiscoveryOptions = {},
): Promise<RouteDiscovery> {
  const cap = opts.cap ?? 25;
  const sample = Math.max(1, opts.sample ?? 3);
  const trace = opts.trace ?? noopTrace;

  let sitemapUsed = false;
  const seeds: string[] = [...(opts.seeds ?? [])];
  if (opts.sitemap !== false) {
    const sm = await fromSitemap(baseUrl);
    if (sm.length) {
      sitemapUsed = true;
      seeds.push(...sm);
      trace(`sitemap: ${sm.length} url(s) from ${new URL(baseUrl).origin}/sitemap.xml — seeding crawl`);
    }
  }

  const maxPages = opts.crawl ? Math.min(opts.crawl.maxPages, cap) : 1;
  const sameOrigin = opts.crawl?.sameOrigin ?? true;
  const outcome = await crawl(page, baseUrl, maxPages, cap, sample, sameOrigin, trace, {
    include: opts.include,
    exclude: opts.exclude,
    seeds,
    onKeep: opts.onKeep,
    prepareVisit: opts.prepareVisit,
  });

  trace(
    `discovery: ${outcome.crawledPages} page(s) crawled, ${outcome.distinctLayouts} distinct layout(s), ` +
      `${outcome.dropped} dropped by sample=${sample}, scanning ${outcome.kept.length}`,
  );
  return { urls: outcome.kept.slice(0, cap), sitemapUsed, crawledPages: outcome.crawledPages };
}
