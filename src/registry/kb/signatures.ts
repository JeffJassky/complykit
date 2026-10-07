import { hostMatches } from './domains.js';
import type { KnowledgeEntry } from './schema.js';

// Structural: the KB (kb/index.ts) imports this file, so this file cannot import the KB type.
type EntrySet = { entries: KnowledgeEntry[] };

// Vendor install signatures over SCRIPT TEXT (plans/client-consent-design.md §3
// #1, #3): the snippet a vendor hands out (`fbq(`, `ttq.load(`, `_hjSettings`)
// and the loader URLs it fetches. They live on the KB entries as
// `match.inline` — ONE source for every reader of script bodies: the static
// markup inspector (A1) over inline <script> content and the GTM container
// parser (A2) over Custom HTML tags and sandboxed-template code. A signature
// says "this text installs that vendor"; it never says what the vendor does.
// This file only compiles and runs them.

const safeCache = new Map<string, RegExp | null>();
/** A compiled `match.inline` pattern; null for a bad pattern (a local entry must not crash a run). Case-sensitive. */
export function inlineRegExp(src: string): RegExp | null {
  if (!safeCache.has(src)) {
    try {
      safeCache.set(src, new RegExp(src));
    } catch {
      safeCache.set(src, null);
    }
  }
  return safeCache.get(src) ?? null;
}

/**
 * Every entry whose `match.inline` pattern appears in `text`, in entry order —
 * except Google entries go last: a page-level snippet often carries several
 * Google ids at once, and a specific vendor should be named before them.
 */
export function entriesMatchingInline(kb: EntrySet, text: string): KnowledgeEntry[] {
  if (!text) return [];
  const hits = kb.entries.filter((e) => e.match.inline?.some((src) => inlineRegExp(src)?.test(text)));
  const google = (e: KnowledgeEntry): boolean => e.id.startsWith('google.');
  return [...hits.filter((e) => !google(e)), ...hits.filter(google)];
}

const URL_HOST = /https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?=[/?#"'\s\\)]|$)/gi;

/** Distinct lower-cased hosts named by absolute URLs in `text`. */
export function hostsInText(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(URL_HOST)) out.add(m[1].toLowerCase());
  return [...out];
}

/**
 * The KB entries a script body points at: by install signature (`match.inline`)
 * first, then by any absolute URL whose host an entry claims. Signature hits come
 * first because they name the product; a host hit names only the owner's domain.
 */
export function entriesForText(kb: EntrySet, text: string): KnowledgeEntry[] {
  const seen = new Set<string>();
  const out: KnowledgeEntry[] = [];
  const push = (e: KnowledgeEntry | undefined): void => {
    if (e && !seen.has(e.id)) {
      seen.add(e.id);
      out.push(e);
    }
  };
  for (const e of entriesMatchingInline(kb, text)) push(e);
  for (const host of hostsInText(text)) {
    push(kb.entries.find((e) => e.match.hosts.some((h) => hostMatches(host, h)) && !e.match.path));
  }
  return out;
}
