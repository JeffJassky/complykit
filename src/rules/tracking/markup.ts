import type {
  Timeline,
  MarkupElement,
  MarkupFinding,
  MarkupSection,
  MarkupVerdict,
  NotTestedItem,
  PartyInventoryItem,
} from '../../record/index.js';
import { DEFAULT_KB, inlineRegExp, lookupEntry, registrableDomain, hostOf, type KnowledgeBase, type KnowledgeEntry } from '../../registry/index.js';

// Static markup inspection → the `markup` section of the tracking record
// (plans/client-consent-design.md §3 #1–#2, §5 item 2). Pure: runs over the
// parsed elements collectors put in each timeline (record/markup.ts) and the
// knowledge base. For every tracker tag written into a page's served HTML it
// says how it is written — and so whether a consent tool can hold it back:
//
//   gateable  an executable <script> (src or inline snippet)
//   leak      <img>/<iframe>/preload·prefetch·stylesheet <link>/<noscript>
//             content — fetched by the browser itself, no gate possible
//   hint      dns-prefetch / preconnect
//   held      already switched off in markup (type="text/plain", data-src)
//
// A script whose code is a data: URL (an optimizer's form of an inline snippet)
// is matched like an inline body; the finding carries `dataUrl` (never the
// payload) and the tag ids its body names. A script a performance plugin
// delays (`optimizer`) is gateable: the plugin runs it for every visitor.
//
// Nothing here says "no markup trackers": pages not inspected are listed, and
// parties the network evidence attributes to markup that inspection did not
// find are listed as unexplained.

/** Categories that are never a tracker by themselves — a tag for them is not reported. */
const INFRA = new Set(['cdn', 'necessary', 'payments']);
const EXCERPT = 80;

function excerpt(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > EXCERPT ? `${one.slice(0, EXCERPT)}…` : one;
}

function verdictOf(el: MarkupElement): MarkupVerdict | undefined {
  if (el.context === 'template' || el.loads === 'inert') return undefined;
  // A script inside <noscript> never runs: scripting on, it is text; off, scripts don't run.
  if (el.kind === 'script' && el.context === 'noscript') return undefined;
  switch (el.loads) {
    case 'executes':
      return 'gateable';
    case 'fetches':
      return 'leak';
    case 'connects':
      return 'hint';
    case 'held':
      return 'held';
    default:
      return undefined;
  }
}

interface Match {
  partyId: string;
  entry?: KnowledgeEntry;
  label: string;
  matchedBy: MarkupFinding['matchedBy'];
  match: string;
}

const reportable = (e: KnowledgeEntry): boolean => !e.categories.every((c) => INFRA.has(c));

/** Which parties one element belongs to. Pure; exported for tests. */
export function matchMarkupElement(
  el: MarkupElement,
  kb: KnowledgeBase,
  site: { registrableDomain: string },
  cname: Map<string, string> = new Map(),
): Match[] {
  const out: Match[] = [];
  const add = (m: Match): void => {
    if (!out.some((x) => x.partyId === m.partyId)) out.push(m);
  };
  if (el.url) {
    const host = hostOf(el.url);
    let pathname = '/';
    try {
      pathname = new URL(el.url).pathname;
    } catch {
      /* keep '/' */
    }
    const domain = registrableDomain(host);
    const target = domain === site.registrableDomain ? cname.get(host) : host;
    if (target) {
      const entry = lookupEntry(kb, target, pathname);
      if (entry) {
        if (reportable(entry)) add({ partyId: entry.id, entry, label: entry.vendor, matchedBy: 'host', match: target === host ? host : `${host} → ${target}` });
      } else {
        const d = registrableDomain(target);
        add({ partyId: `unknown:${d}`, label: d, matchedBy: 'host', match: target === host ? host : `${host} → ${target}` });
      }
    }
    return out;
  }
  if (el.body === undefined && !el.ids.length && !el.hosts.length) return out;
  // Inline: the vendor's own snippet shape first (strongest), then loader URLs, then tag ids.
  const text = el.body ?? '';
  const idText = el.ids.join(' ');
  for (const entry of kb.entries) {
    if (!entry.match.inline?.length || !reportable(entry)) continue;
    for (const src of entry.match.inline) {
      const re = inlineRegExp(src); // shared with the GTM parser (one signature source)
      if (!re) continue;
      // Ids were read from the whole body, so they still match when `body` was truncated.
      const inBody = re.exec(text);
      const inIds = inBody ? null : re.exec(idText);
      if (inBody || inIds) {
        add({ partyId: entry.id, entry, label: entry.vendor, matchedBy: inBody ? 'inline-pattern' : 'inline-id', match: excerpt((inBody ?? inIds)![0]) });
        break;
      }
    }
  }
  for (const host of el.hosts) {
    if (registrableDomain(host) === site.registrableDomain) continue;
    const entry = lookupEntry(kb, host, '/');
    if (entry && reportable(entry)) add({ partyId: entry.id, entry, label: entry.vendor, matchedBy: 'inline-host', match: host });
  }
  return out;
}

/** First-party hosts whose DNS points at a known tracking vendor (CNAME cloaking). */
function cnameMap(tl: Timeline, kb: KnowledgeBase): Map<string, string> {
  const map = new Map<string, string>();
  const siteDomain = tl.snapshot.site.registrableDomain;
  for (const d of tl.snapshot.dns ?? []) {
    if (d.host === tl.snapshot.site.host) continue;
    for (const raw of d.cname) {
      const target = raw.replace(/\.$/, '');
      if (registrableDomain(target) === siteDomain) continue;
      const entry = lookupEntry(kb, target, '/');
      if (entry && reportable(entry)) {
        map.set(d.host, target);
        break;
      }
    }
  }
  return map;
}

function stripHash(u: string): string {
  const i = u.indexOf('#');
  return i < 0 ? u : u.slice(0, i);
}

export interface MarkupBuild {
  section: MarkupSection;
  notTested: NotTestedItem[];
}

/**
 * Build the markup section from every timeline that carried a markup capture.
 * Undefined when none did (inspection did not run — not "nothing found").
 * `inventory`, when given, is cross-checked: a party the network evidence
 * attributes to markup with no tag found here is listed as unexplained.
 */
export function buildMarkupSection(timelines: Timeline[], kb: KnowledgeBase = DEFAULT_KB, inventory: PartyInventoryItem[] = []): MarkupBuild | undefined {
  const withMarkup = timelines.filter((t) => Array.isArray(t.snapshot.markup));
  if (!withMarkup.length) return undefined;

  const pages = new Map<string, MarkupSection['pages'][number]>();
  const findings = new Map<string, MarkupFinding>();
  const tagsOf = new Map<string, Set<string>>(); // finding key → distinct tags on its first page

  for (const tl of withMarkup) {
    const loc = tl.location.id;
    const cname = cnameMap(tl, kb);
    for (const p of tl.snapshot.markup ?? []) {
      const url = stripHash(p.url);
      let page = pages.get(url);
      if (!page) {
        page = { url, status: p.status, via: p.via, reason: p.reason, locations: [], elements: 0, bytes: p.bytes };
        pages.set(url, page);
      }
      if (p.status === 'inspected' && page.status !== 'inspected') {
        Object.assign(page, { status: 'inspected', via: p.via, reason: undefined, bytes: p.bytes });
      }
      if (!page.locations.includes(loc)) page.locations.push(loc);
      if (p.status !== 'inspected') continue;
      page.elements = Math.max(page.elements, p.elements.length);

      for (const el of p.elements) {
        const verdict = verdictOf(el);
        if (!verdict) continue;
        for (const m of matchMarkupElement(el, kb, tl.snapshot.site, cname)) {
          const inline = !el.url;
          // Same tag on several pages / locations / scenarios → one finding.
          // Inline snippets are keyed by what matched, not by their body (bodies
          // carry per-response nonces and tokens).
          // An unrecognized host is folded to one row per element kind: a CDN
          // with forty images is one fact ("<img> from x, 40 tags"), not forty.
          // Inline snippets with the same matched text but different tag ids
          // (two gtag('config') snippets) are different tags.
          const what = !m.entry ? 'any' : inline ? `inline:${m.match}${el.ids.length ? `|${el.ids.join(',')}` : ''}` : el.url;
          const key = [m.partyId, el.kind, el.context, verdict, what].join('|');
          const existing = findings.get(key);
          const tag = `${el.line}|${el.url ?? m.match}`;
          if (existing) {
            if (el.documentWrite) existing.documentWrite = true;
            if (existing.page === url) tagsOf.get(key)!.add(tag);
            if (!existing.locations.includes(loc)) existing.locations.push(loc);
            if (existing.page !== url && !existing.alsoOn.includes(url)) existing.alsoOn.push(url);
            continue;
          }
          findings.set(key, {
            partyId: m.partyId,
            label: m.label,
            recognized: Boolean(m.entry),
            verdict,
            trigger: verdict === 'leak' || verdict === 'hint' ? (el.context === 'noscript' ? 'javascript-disabled' : 'page-load') : undefined,
            kind: el.kind,
            context: el.context === 'noscript' ? 'noscript' : 'document',
            page: url,
            line: el.line,
            url: el.url,
            inline,
            attributes: el.attributes,
            matchedBy: m.matchedBy,
            match: m.match,
            ...(el.documentWrite ? { documentWrite: true } : {}),
            ...(inline && el.ids.length ? { ids: [...el.ids] } : {}),
            ...(el.dataUrl ? { dataUrl: { attribute: el.dataUrl.attribute, mediaType: el.dataUrl.mediaType, encoding: el.dataUrl.encoding } } : {}),
            ...(el.optimizer ? { optimizer: el.optimizer } : {}),
            locations: [loc],
            alsoOn: [],
            occurrences: 1,
          });
          tagsOf.set(key, new Set([tag]));
        }
      }
    }
  }

  for (const [key, f] of findings) f.occurrences = tagsOf.get(key)?.size ?? 1;

  const rank: Record<MarkupVerdict, number> = { leak: 0, gateable: 1, hint: 2, held: 3 };
  const list = [...findings.values()].sort(
    (a, b) => Number(b.recognized) - Number(a.recognized) || rank[a.verdict] - rank[b.verdict] || a.label.localeCompare(b.label) || a.line - b.line,
  );

  const found = new Set(list.map((f) => f.partyId));
  const unexplained: MarkupSection['unexplained'] = [];
  for (const p of inventory) {
    const src = p.sources.find((s) => s === 'markup' || s === 'markup-leak');
    if (!src || found.has(p.partyId)) continue;
    unexplained.push({
      partyId: p.partyId,
      source: src,
      reason: 'the network evidence says the page HTML loaded it, but no matching tag was found in the served HTML that was inspected — a page variant, a tag on an uninspected page, or a gap in matching; needs a look',
    });
  }

  const notTested: NotTestedItem[] = [...pages.values()]
    .filter((p) => p.status !== 'inspected')
    .map((p) => ({ scope: 'page' as const, id: p.url, reason: `served HTML not inspected for markup trackers${p.reason ? `: ${p.reason}` : ''}` }));

  return { section: { pages: [...pages.values()], findings: list, unexplained }, notTested };
}
