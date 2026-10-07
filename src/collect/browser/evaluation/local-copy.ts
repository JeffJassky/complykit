import fs from 'node:fs';
import type { BrowserContext, Route } from 'playwright';
import type { LocalCopyRecord } from '../../../record/index.js';

// Local-copy mode (plans/client-consent-design.md §7, ticket D11). The scanner
// applies an owner's change set to the site INSIDE ITS OWN BROWSER — route
// interception on the site's documents — so the loop (scan → config + change
// list → install → rescan) can be proven without touching the live site:
//
//   head          inserted first in <head> (the generated snippet: config
//                 element + the tool's script tag);
//   replace       exact-string or regex replacements on every document the
//                 site's origin serves (the change list's tag rewrites, leaks
//                 to remove);
//   serve         same-origin paths answered from local files (the tool's
//                 core + UI file at the snippet's path);
//   resources     third-party resources rewritten in flight (a tag-manager
//                 container with the owner's consent settings simulated).
//
// Only documents from `origin` are rewritten; everything else passes through.
// A document that cannot be read is served as it came and counted. Every
// replacement reports how many documents it matched: a "Now" markup that never
// matched is the first thing to check (0 applied = nothing changed). Nothing
// here decides anything: the record carries the counts, the report says the
// run was a local copy, and the pipeline marks it as not evidence about the
// live site. This is a TEST MODE: it never installs, publishes or writes to
// the site.

export interface LocalCopyReplacement {
  label: string;
  /** Exact text to replace (every occurrence). */
  from?: string;
  /** Or a regular expression (source, flags) — for markup that spans lines or varies per page. */
  pattern?: { source: string; flags?: string };
  to: string;
}

export interface LocalCopyResource {
  /** The resource URL (query included); matched on origin + path, and on every query parameter the spec names. */
  url: string;
  /** Returns the rewritten body, or undefined (with a note) to leave it as served. */
  transform(source: string): { source?: string; note?: string };
}

export interface LocalCopy {
  file: string;
  origin: string;
  head?: string;
  replace: LocalCopyReplacement[];
  serve: Record<string, { file: string; contentType: string }>;
  resources: LocalCopyResource[];
  /** Mutable tallies, filled while the scan runs; `record()` turns them into the evaluation's LocalCopyRecord. */
  stats: LocalCopyStats;
}

export interface LocalCopyStats {
  documents: { rewritten: number; unreadable: number };
  /** First few distinct failure messages (a document or resource served as-is because the rewrite threw). */
  errors: string[];
  replacements: Map<string, number>;
  served: Map<string, number>;
  resources: Map<string, { status: 'rewritten' | 'unchanged' | 'not-seen'; note?: string }>;
}

export function newLocalCopyStats(lc: Pick<LocalCopy, 'replace' | 'serve' | 'resources'>): LocalCopyStats {
  return {
    documents: { rewritten: 0, unreadable: 0 },
    errors: [],
    replacements: new Map(lc.replace.map((r) => [r.label, 0])),
    served: new Map(Object.keys(lc.serve).map((p) => [p, 0])),
    resources: new Map(lc.resources.map((r) => [r.url, { status: 'not-seen' as const }])),
  };
}

export function localCopyRecord(lc: LocalCopy): LocalCopyRecord {
  return {
    file: lc.file,
    origin: lc.origin,
    head: Boolean(lc.head),
    documents: { ...lc.stats.documents },
    errors: [...lc.stats.errors],
    replacements: [...lc.stats.replacements].map(([label, applied]) => ({ label, applied })),
    served: [...lc.stats.served].map(([path, requests]) => ({ path, requests })),
    resources: [...lc.stats.resources].map(([url, r]) => ({ url, status: r.status, ...(r.note ? { note: r.note } : {}) })),
  };
}

const HEAD_OPEN = /<head(?:\s[^>]*)?>/i;
const CHARSET_NEXT = /^\s*<meta\s+(?:charset=|http-equiv=["']?content-type)[^>]*>/i;

/**
 * Apply the head insertion and the replacements to one document. Pure. The
 * head content goes right after `<head>` — after a `<meta charset>` that
 * immediately follows it, so the charset stays within the first bytes.
 */
export function rewriteDocument(html: string, lc: Pick<LocalCopy, 'head' | 'replace'>, applied?: Map<string, number>): { html: string; headInserted: boolean } {
  let out = html;
  let headInserted = false;
  if (lc.head) {
    const m = HEAD_OPEN.exec(out);
    if (m) {
      let at = m.index + m[0].length;
      const cs = CHARSET_NEXT.exec(out.slice(at));
      if (cs) at += cs[0].length;
      out = out.slice(0, at) + '\n' + lc.head + '\n' + out.slice(at);
      headInserted = true;
    }
  }
  for (const r of lc.replace) {
    let n = 0;
    if (r.pattern) {
      const flags = r.pattern.flags ?? '';
      const re = new RegExp(r.pattern.source, flags.includes('g') ? flags : flags + 'g');
      out = out.replace(re, () => {
        n++;
        return r.to;
      });
    } else if (r.from) {
      const parts = out.split(r.from);
      n = parts.length - 1;
      if (n) out = parts.join(r.to);
    }
    if (n && applied) applied.set(r.label, (applied.get(r.label) ?? 0) + 1);
  }
  return { html: out, headInserted };
}

/** The resource spec matching a request URL: same origin + path, and every query parameter the spec names has the same value. */
export function resourceFor(lc: Pick<LocalCopy, 'resources'>, url: string): LocalCopyResource | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  for (const r of lc.resources) {
    let s: URL;
    try {
      s = new URL(r.url);
    } catch {
      continue;
    }
    if (s.origin !== u.origin || s.pathname !== u.pathname) continue;
    let ok = true;
    for (const [k, v] of s.searchParams) if (u.searchParams.get(k) !== v) ok = false;
    if (ok) return r;
  }
  return undefined;
}

/** Apply a resource transform and tally it (shared by the route and the container fetcher). */
export function transformResource(lc: LocalCopy, url: string, source: string): string {
  const r = resourceFor(lc, url);
  if (!r) return source;
  const cur = lc.stats.resources.get(r.url);
  if (cur?.status === 'rewritten') {
    // Already rewritten once this run; apply again (another context) without re-tallying.
    return r.transform(source).source ?? source;
  }
  const t = r.transform(source);
  lc.stats.resources.set(r.url, t.source !== undefined ? { status: 'rewritten', ...(t.note ? { note: t.note } : {}) } : { status: 'unchanged', note: t.note ?? 'left as served' });
  return t.source ?? source;
}

function noteError(lc: LocalCopy, what: string, err: unknown): void {
  const m = `${what}: ${err instanceof Error ? err.message.split('\n')[0].slice(0, 160) : String(err)}`;
  if (lc.stats.errors.length < 5 && !lc.stats.errors.includes(m)) lc.stats.errors.push(m);
}

function isHtml(headers: Record<string, string>): boolean {
  const ct = headers['content-type'];
  return !ct || /html/i.test(ct);
}

/**
 * Register the interception on a context. Documents from the site's origin are
 * fetched, rewritten and fulfilled; served paths are answered from disk;
 * matching resources are fetched and transformed. Anything that fails is
 * passed through as served (and, for documents, counted as unreadable).
 */
export async function installLocalCopy(context: BrowserContext, lc: LocalCopy): Promise<void> {
  const servedPaths = new Set(Object.keys(lc.serve));
  await context.route(
    (u) => {
      if (u.origin === lc.origin) return true;
      return Boolean(resourceFor(lc, u.href));
    },
    async (route: Route) => {
      const req = route.request();
      const url = req.url();
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        return route.fallback();
      }
      // 1. Local files at the tool's path.
      if (u.origin === lc.origin && servedPaths.has(u.pathname)) {
        const s = lc.serve[u.pathname];
        lc.stats.served.set(u.pathname, (lc.stats.served.get(u.pathname) ?? 0) + 1);
        try {
          return await route.fulfill({ status: 200, contentType: s.contentType, body: fs.readFileSync(s.file), headers: { 'cache-control': 'no-store' } });
        } catch (err) {
          noteError(lc, `serve ${u.pathname}`, err);
          return route.fallback();
        }
      }
      // 2. The site's documents (top-level and same-origin frames alike).
      if (u.origin === lc.origin && req.resourceType() === 'document' && req.method() === 'GET') {
        try {
          const res = await route.fetch();
          const headers = res.headers();
          if (res.status() >= 300 || !isHtml(headers)) return route.fulfill({ response: res });
          const body = (await res.body()).toString('utf8');
          const { html } = rewriteDocument(body, lc, lc.stats.replacements);
          lc.stats.documents.rewritten++;
          // A rewritten body has a new length; the encoding is what we decoded.
          const { 'content-length': _len, 'content-encoding': _enc, ...rest } = headers;
          return route.fulfill({ response: res, body: html, headers: { ...rest, 'content-type': headers['content-type'] ?? 'text/html; charset=utf-8' } });
        } catch (err) {
          lc.stats.documents.unreadable++;
          noteError(lc, `document ${u.pathname}`, err);
          return route.fallback();
        }
      }
      // 3. Third-party resources rewritten in flight.
      if (u.origin !== lc.origin && resourceFor(lc, url)) {
        try {
          const res = await route.fetch();
          if (res.status() !== 200) return route.fulfill({ response: res });
          const body = (await res.body()).toString('utf8');
          const next = transformResource(lc, url, body);
          const { 'content-length': _len, 'content-encoding': _enc, ...rest } = res.headers();
          return route.fulfill({ response: res, body: next, headers: rest });
        } catch (err) {
          noteError(lc, `resource ${u.host}${u.pathname}`, err);
          return route.fallback();
        }
      }
      return route.fallback();
    },
  );
}
