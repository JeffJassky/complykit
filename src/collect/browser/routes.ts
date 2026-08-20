import type { Page } from 'playwright';

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
}

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

async function crawl(page: Page, baseUrl: string, maxPages: number, sameOriginOnly: boolean): Promise<{ urls: string[]; visited: number }> {
  const queue = [normalize(baseUrl)];
  const seen = new Set(queue);
  const found: string[] = [];
  let visited = 0;
  while (queue.length && visited < maxPages) {
    const url = queue.shift()!;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 });
      visited++;
      found.push(url);
      const hrefs = (await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href]')).map((a) => (a as HTMLAnchorElement).href),
      )) as string[];
      for (const href of hrefs) {
        const n = normalize(href);
        if (seen.has(n)) continue;
        if (sameOriginOnly && !sameOrigin(n, baseUrl)) continue;
        if (!/^https?:/.test(n)) continue;
        seen.add(n);
        queue.push(n);
      }
    } catch {
      // Unreachable page — skip; the scan records the gap when it tries to scan.
    }
  }
  return { urls: found, visited };
}

export async function discoverRoutes(
  page: Page,
  baseUrl: string,
  opts: RouteDiscoveryOptions = {},
): Promise<RouteDiscovery> {
  const cap = opts.cap ?? 25;
  const urls = new Set<string>();
  let sitemapUsed = false;
  let crawledPages = 0;

  if (opts.sitemap !== false) {
    const sm = await fromSitemap(baseUrl);
    if (sm.length) {
      sitemapUsed = true;
      for (const u of sm) urls.add(normalize(u));
    }
  }

  if (opts.crawl && urls.size < cap) {
    const { urls: crawled, visited } = await crawl(
      page,
      baseUrl,
      Math.min(opts.crawl.maxPages, cap),
      opts.crawl.sameOrigin,
    );
    crawledPages = visited;
    for (const u of crawled) urls.add(u);
  }

  // Always include the entry URL.
  urls.add(normalize(baseUrl));

  let list = [...urls];
  if (opts.include?.length) list = list.filter((u) => opts.include!.some((i) => u.includes(i)));
  if (opts.exclude?.length) list = list.filter((u) => !opts.exclude!.some((x) => u.includes(x)));
  return { urls: list.slice(0, cap), sitemapUsed, crawledPages };
}
