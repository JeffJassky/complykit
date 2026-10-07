import { KnowledgeEntry, type KnowledgeEntryInput, type PartyCategory } from './schema.js';
import { SEED_ENTRIES } from './entries.js';
import { hostMatches } from './domains.js';

// The knowledge base (plans/consent-design.md §4): vendor entries + lookup.
// Pure data and functions; versioned. A site may layer overrides on top (the
// same chat widget is a requested service on one site and marketing on another)
// and extra entries (confirmed research results kept outside this public repo).

export * from './schema.js';
export * from './domains.js';
export * from './signatures.js';
import { entriesMatchingInline } from './signatures.js';

/** Bump on any entry change; stamped into every evaluation. */
export const KB_VERSION = '0.1.5';

export const KB_ENTRIES: KnowledgeEntry[] = SEED_ENTRIES.map((e) => KnowledgeEntry.parse(e));

export interface KnowledgeBase {
  version: string;
  entries: KnowledgeEntry[];
}

export interface SiteOverride {
  /** Entry id to override. */
  id: string;
  categories?: PartyCategory[];
  note?: string;
}

/** Build a KB: the seed set, plus extra entries (placed FIRST — a confirmed
 *  local entry beats a seed proposal, and REPLACES a seed with the same id),
 *  plus per-site category overrides. */
export function buildKnowledgeBase(opts: { extra?: KnowledgeEntryInput[]; overrides?: SiteOverride[] } = {}): KnowledgeBase {
  const extra = (opts.extra ?? []).map((e) => KnowledgeEntry.parse(e));
  const byId = new Map<string, SiteOverride>((opts.overrides ?? []).map((o) => [o.id, o]));
  const extraIds = new Set(extra.map((e) => e.id));
  const entries = [...extra, ...KB_ENTRIES.filter((e) => !extraIds.has(e.id))].map((e) => {
    const o = byId.get(e.id);
    if (!o) return e;
    return { ...e, categories: o.categories ?? e.categories, notes: [e.notes, o.note ? `site override: ${o.note}` : undefined].filter(Boolean).join(' ') || undefined };
  });
  const suffix = extra.length || byId.size ? `+local.${extra.length}.${byId.size}` : '';
  return { version: `${KB_VERSION}${suffix}`, entries };
}

export const DEFAULT_KB: KnowledgeBase = { version: KB_VERSION, entries: KB_ENTRIES };

/** Every KB entry id whose install signature (`match.inline`) appears in `text`. */
export function matchVendorSignatures(text: string, kb: KnowledgeBase = DEFAULT_KB): string[] {
  return entriesMatchingInline(kb, text).map((e) => e.id);
}

const pathRegexCache = new Map<string, RegExp>();
function pathRe(src: string): RegExp {
  let re = pathRegexCache.get(src);
  if (!re) {
    re = new RegExp(src);
    pathRegexCache.set(src, re);
  }
  return re;
}

/** The first entry matching a request host (+ path). */
export function lookupEntry(kb: KnowledgeBase, host: string, pathname = '/'): KnowledgeEntry | undefined {
  for (const e of kb.entries) {
    if (!e.match.hosts.some((h) => hostMatches(host, h))) continue;
    if (e.match.path && !pathRe(e.match.path).test(pathname)) continue;
    return e;
  }
  return undefined;
}

/** An entry whose declared stores name this cookie/storage key. */
export function lookupStore(kb: KnowledgeBase, key: string): KnowledgeEntry | undefined {
  for (const e of kb.entries) {
    if (e.stores.some((s) => pathRe(s.name).test(key))) return e;
  }
  return undefined;
}

/** 'confirmed' when a human confirmed it; 'seed' for an unconfirmed proposal. */
export function entryStatus(e: KnowledgeEntry): 'confirmed' | 'proposed' {
  return e.provenance.confirmedBy ? 'confirmed' : 'proposed';
}
