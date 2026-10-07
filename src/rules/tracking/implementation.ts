import type {
  ContainerTag,
  ImplementationClass,
  ImplementationEvidence,
  MarkupSection,
  PartyImplementation,
  PartyInventoryItem,
  TagContainer,
  Timeline,
} from '../../record/index.js';
import { hostOf, platformLoaderOf, registrableDomain, type PlatformName } from '../../registry/index.js';

// One implementation class per party (plans/client-consent-design.md §3, the
// seven ways a tracker gets onto a page), with the evidence that decided it.
// Pure: reads the inventory item and the evaluation's markup findings (A1),
// parsed containers (A2), platform fingerprint (A5), CNAMEs, and first-party
// collect endpoints. The class answers "where does the owner have to make the
// change for this tracker to be controllable" — so when several apply, the one
// that decides control wins and the rest are listed in `alsoSeen`.
//
// Precedence (first rule that has evidence wins):
//
//  1. markup-leak   — an <img>/<iframe>/preload/<noscript> tag for the party in
//                     the served HTML, or a first request the scan traced to one.
//                     Wins over everything: the browser fetches it before any
//                     script runs, so no consent tool, container setting or
//                     platform bridge stops it. Whatever else loads the party,
//                     this copy keeps firing until it is removed from the HTML.
//                     (A GTM-loaded pixel that also ships a <noscript> image is a
//                     markup leak for control purposes.)
//  2. cname         — reached through a first-party subdomain CNAME'd to it. The
//                     script that calls it can be gated, but the cookies it sets
//                     are first-party and survive; the fix is DNS, not a tag. After
//                     the leak because the leak needs no script at all.
//  3–6. the controllable paths, ranked first by how the evidence was obtained —
//                     observed  (the scan saw the party's request come that way:
//                                PartySource + loadedBy)
//                   > static    (a tag in the HTML, or a tag in a parsed GTM
//                                container mapped to the party)
//                   > inherited (injected by another party's script whose own
//                                load could not be traced; that party's path is
//                                used — a pure markup leak passes on only through
//                                a frame: what loads inside an <iframe> in the
//                                HTML is as ungated as the iframe)
//                     Loaders are followed past loadedBy through each script's
//                     own initiator chain (scriptIndex), so a gtag.js that GTM
//                     injected counts as GTM, and a script whose root is a
//                     <script> in the page counts as direct (observed).
//                     A Google tag (gtag.js?id=G-/AW-/GT-/DC-) is not a class
//                     of its own: it has no per-tag consent requirement (only
//                     GTM has one), so a party it loaded keeps the class of the
//                     path gtag.js came by, and the parsed Google tag adds
//                     container-tag evidence (its destination for the party, or
//                     the settings that send to it — Google signals, Ads link).
//                     and within the same strength:
//     gtm               — a tag manager in the load chain is the nearest decision
//     other-tag-manager   point: the tag fires when the container's tag fires,
//                         whatever loaded the container (a platform-injected GTM
//                         container still decides through its tags). GTM before
//                         other managers only because the container is readable.
//     platform          — Shopify/Wix/Squarespace/WordPress-plugin injection: a
//                         rewrite of the HTML does not reach it; only the
//                         platform's consent API does. The platform's OWN parties
//                         (Shopify's cookies and CDN scripts on a Shopify store)
//                         count as observed platform evidence: what the platform
//                         writes into the page is not the owner's markup.
//     direct-script     — a <script> in the HTML (or the site's own code): the
//                         owner rewrites it to type="text/plain". Last among the
//                         controllable paths because the markup findings already
//                         carry this copy into the generated tag list; when a
//                         party is BOTH in the HTML and in a container, the path
//                         the scan saw fire wins and the other is in alsoSeen.
//  7. server-side-suspected — a first-party collect endpoint (/g/collect, /tr,
//                     /collect with GA parameters, on the site's own domain) or a
//                     server-container URL in a GTM tag. An inference, never seen
//                     reaching the vendor, so it decides the class only when no
//                     direct path explains the party (typically: a _ga cookie and
//                     a first-party /g/collect, nothing sent to Google); otherwise
//                     it is listed in alsoSeen so the report can say "server-side
//                     forwarding is possible and cannot be verified".
//  8. unknown       — nothing above. Fail closed: the evidence list says why.
//
// `markup` findings with verdict 'hint' (dns-prefetch / preconnect) load nothing
// and are not an implementation; 'held' (already type="text/plain") is a direct
// script the owner has already switched off.

export interface CollectEndpoint {
  partyId: string;
  /** host + path, query keys only. */
  sample: string;
  host: string;
  pattern: string; // what matched ('/g/collect', 'server_container_url', …)
  via: 'request' | 'container';
  containerId?: string;
  tagId?: number;
}

export interface ImplementationInput {
  site: { host: string; registrableDomain: string };
  markup?: MarkupSection;
  containers?: TagContainer[];
  platform?: { name: PlatformName };
  /** First-party collect endpoints (see firstPartyCollectEndpoints). */
  endpoints?: CollectEndpoint[];
  /** partyId → first-party hosts CNAME'd to it, with the target when known. */
  cnames?: Record<string, Array<{ host: string; target?: string }>>;
  /** How each script was itself loaded (see scriptIndex) — traces loaders past loadedBy. */
  scripts?: ScriptIndex;
}

/** Tag managers other than GTM, recognised by their loader URL (§3 #4). */
export const OTHER_TAG_MANAGERS: Array<{ name: string; url: RegExp }> = [
  { name: 'Tealium iQ', url: /^https?:\/\/([^/]+\.)?(tiqcdn\.com|tealiumiq\.com)\//i },
  { name: 'Adobe Experience Platform Tags (Launch)', url: /^https?:\/\/([^/]+\.)?adobedtm\.com\//i },
  { name: 'Segment', url: /^https?:\/\/cdn\.segment\.(com|io)\/(analytics\.js|analytics-next|next-integrations|v1\/projects)/i },
  { name: 'Ensighten', url: /^https?:\/\/([^/]+\.)?ensighten\.com\//i },
];

/** A GTM container script: gtm.js?id=GTM-…, on Google's host or proxied first-party. */
export function isGtmContainerUrl(url: string): boolean {
  return /[?&]id=GTM-[A-Z0-9]+/i.test(url) || /^https?:\/\/[^/]+(\/[^?#]*)?\/gtm\.js(\?|#|$)/i.test(url);
}

/** The Google tag id a gtag.js URL loads (`gtag/js?id=G-…` / AW- / GT- / DC-), on Google's host or proxied. */
export function googleTagIdOf(url: string): string | undefined {
  const m = /\/gtag\/js\?(?:[^#]*&)?id=((?:G|AW|GT|DC)-[A-Z0-9]+)/i.exec(url);
  return m ? m[1].toUpperCase() : undefined;
}

/** Google tag settings that send to a party beyond its own destination, by setting template. */
export const GOOGLE_TAG_SETTINGS_FOR: Record<string, string[]> = {
  // Google signals: GA4 sends to doubleclick.net for cross-device / ads features.
  __ogt_google_signals: ['google.ads.doubleclick', 'google.analytics'],
  __ccd_ga_ads_link: ['google.ads.ccm', 'google.ads.doubleclick', 'google.analytics'],
  // '*' = every party the tag has a destination for. Automatic user-provided
  // data collection: hashed email / phone / address from forms.
  __ogt_1p_data_v2: ['*'],
  __ogt_dma: ['*'],
};

/** Is this Google tag setting switched on in the parsed values? (Unknown shapes count as on: fail closed.) */
export function googleTagSettingOn(t: Pick<ContainerTag, 'template' | 'settings'>): boolean {
  const s = t.settings ?? {};
  switch (t.template) {
    case '__ogt_google_signals':
      return s.googleSignals === undefined || String(s.googleSignals).toUpperCase() !== 'DISABLED';
    case '__ogt_1p_data_v2':
      return s.isAutoEnabled !== false && s.isEnabled !== false;
    case '__ogt_dma':
      return s.dmaDefault === undefined || String(s.dmaDefault).toUpperCase() === 'GRANTED';
    default:
      return true;
  }
}

export function otherTagManagerOf(url: string): string | undefined {
  return OTHER_TAG_MANAGERS.find((m) => m.url.test(url))?.name;
}

/** Classes that stay uncontrollable whatever else applies — ranked above every other. */
const UNCONTROLLABLE: ImplementationClass[] = ['markup-leak', 'cname'];
/** Controllable paths, in tie-break order within one evidence strength. */
const CONTROLLABLE: ImplementationClass[] = ['gtm', 'other-tag-manager', 'platform', 'direct-script'];
type Strength = 0 | 1 | 2; // observed | static | inherited

interface Candidate {
  ev: ImplementationEvidence;
  strength: Strength;
}

function rankOf(c: Candidate): number {
  const u = UNCONTROLLABLE.indexOf(c.ev.class);
  if (u >= 0) return u;
  const k = CONTROLLABLE.indexOf(c.ev.class);
  if (k >= 0) return 10 + c.strength * 10 + k;
  return c.ev.class === 'server-side-suspected' ? 100 : 200;
}

const MAX_CONTAINER_TAGS = 5;

/**
 * Classify every party in the inventory. Returns partyId → implementation.
 * Parties injected by another party's script inherit that party's path (memoized,
 * cycle-safe).
 */
export function classifyImplementations(inventory: PartyInventoryItem[], input: ImplementationInput): Map<string, PartyImplementation> {
  const out = new Map<string, PartyImplementation>();
  const inProgress = new Set<string>();
  const byId = new Map(inventory.map((p) => [p.partyId, p]));

  const partyOfUrl = (url: string): PartyInventoryItem | undefined => {
    const host = hostOf(url);
    if (!host) return undefined;
    const domain = registrableDomain(host);
    return inventory.find((p) => p.hosts.includes(host)) ?? inventory.find((p) => p.domain === domain && !p.partyId.startsWith('unknown:')) ?? inventory.find((p) => p.domain === domain);
  };

  const classify = (p: PartyInventoryItem): PartyImplementation => {
    const done = out.get(p.partyId);
    if (done) return done;
    if (inProgress.has(p.partyId)) return { class: 'unknown', evidence: [], alsoSeen: [] };
    inProgress.add(p.partyId);
    const result = decide(candidatesFor(p, input, (url) => {
      const loader = partyOfUrl(url);
      if (!loader || loader.partyId === p.partyId || !byId.has(loader.partyId)) return undefined;
      const r = classify(loader);
      return { party: loader, impl: r };
    }));
    inProgress.delete(p.partyId);
    out.set(p.partyId, result);
    return result;
  };

  for (const p of inventory) classify(p);
  return out;
}

/** Classify one party (no inheritance through other parties' scripts). */
export function classifyImplementation(party: PartyInventoryItem, input: ImplementationInput): PartyImplementation {
  return decide(candidatesFor(party, input, () => undefined));
}

type LoaderLookup = (url: string) => { party: PartyInventoryItem; impl: PartyImplementation } | undefined;

function candidatesFor(p: PartyInventoryItem, input: ImplementationInput, loaderParty: LoaderLookup): { candidates: Candidate[]; why: string[] } {
  const c: Candidate[] = [];
  const why: string[] = [];
  const add = (ev: ImplementationEvidence, strength?: Strength): void => {
    c.push({ ev, strength: strength ?? (ev.observed ? 0 : 1) });
  };
  const siteDomain = input.site.registrableDomain;

  // Static markup (A1).
  for (const f of input.markup?.findings ?? []) {
    if (f.partyId !== p.partyId || f.verdict === 'hint') continue;
    const where = `${f.kind === 'script' && f.inline ? 'inline <script>' : `<${f.kind}>`}${f.context === 'noscript' ? ' in <noscript>' : ''}`;
    if (f.verdict === 'leak') {
      add({ class: 'markup-leak', kind: 'markup', observed: false, verdict: f.verdict, page: f.page, line: f.line, url: f.url,
        note: `${where} in the served HTML (line ${f.line})${f.trigger === 'javascript-disabled' ? ' — fires for visitors without JavaScript' : ' — fetched by the browser before any script runs'}` });
    } else {
      add({ class: 'direct-script', kind: 'markup', observed: false, verdict: f.verdict, page: f.page, line: f.line, url: f.url,
        note: `${where} in the served HTML (line ${f.line})${f.verdict === 'held' ? ' — already held back (type="text/plain" / data-src)' : ''}` });
    }
  }

  // Parsed GTM containers (A2): tags mapped to this party.
  for (const ct of input.containers ?? []) {
    if (ct.kind !== 'gtm' || ct.status !== 'parsed') continue;
    const tags = ct.tags.filter((t) => t.partyId === p.partyId && t.kind === 'tag' && !t.paused);
    for (const t of tags.slice(0, MAX_CONTAINER_TAGS)) {
      add({ class: 'gtm', kind: 'container-tag', observed: false, containerId: ct.id, tagId: t.tagId,
        note: `${ct.id} tag ${t.tagId} (${t.templateLabel}), consent: ${t.consent.status}` });
    }
    if (tags.length > MAX_CONTAINER_TAGS) {
      add({ class: 'gtm', kind: 'container-tag', observed: false, containerId: ct.id, note: `${ct.id}: ${tags.length - MAX_CONTAINER_TAGS} more tags for this party` });
    }
  }

  // CNAME (#6).
  const cn = input.cnames?.[p.partyId] ?? [];
  for (const x of cn) {
    add({ class: 'cname', kind: 'cname', observed: true, host: x.host, target: x.target,
      note: `${x.host} is a CNAME${x.target ? ` to ${x.target}` : ''} — cookies it sets are first-party` });
  }
  if (!cn.length && p.sources.includes('first-party-proxy')) {
    add({ class: 'cname', kind: 'source', observed: true, note: 'reached through a first-party subdomain whose DNS points at the vendor' });
  }

  // Observed load path: PartySource + loadedBy.
  if (p.sources.includes('markup-leak')) {
    add({ class: 'markup-leak', kind: 'source', observed: true, url: p.loadedBy.find((u) => /^https?:/i.test(u)),
      note: 'first request traced to a non-script element in the page (image / iframe / preload)' });
  }
  if (p.sources.includes('markup')) {
    const page = p.loadedBy.find((u) => registrableDomain(hostOf(u)) === siteDomain);
    add({ class: 'direct-script', kind: 'source', observed: true, url: page, note: `first request traced to a <script> written in the page${page ? ` (${page})` : ''}` });
  }

  // The load chain, extended through each loader's own initiator chain (a
  // gtag.js that GTM loaded names only gtag.js in loadedBy).
  const traced = p.sources.includes('injected') || p.sources.includes('platform') ? traceLoaders(p.loadedBy, input.scripts) : { urls: p.loadedBy };
  const gtmLoader = traced.urls.find(isGtmContainerUrl);
  const otmLoader = traced.urls.find((u) => otherTagManagerOf(u));
  const via = (u: string): string => (p.loadedBy.includes(u) ? '' : `, which loaded ${p.loadedBy[0]}`);
  if (gtmLoader) add({ class: 'gtm', kind: 'loader', observed: true, url: gtmLoader, note: `loaded by the GTM container ${gtmLoader}${via(gtmLoader)}` });
  if (otmLoader) add({ class: 'other-tag-manager', kind: 'loader', observed: true, url: otmLoader, note: `loaded by ${otherTagManagerOf(otmLoader)} (${otmLoader})${via(otmLoader)}` });
  // Google tag containers (gtag.js?id=G-/AW-/GT-/DC-, A2) on the load chain: the
  // destination(s) mapped to this party, or — when none is — the tag settings
  // that send to it (Google signals → doubleclick.net, the Google Ads link).
  // The Google tag is NOT a class of its own: it has no per-tag "require
  // consent" setting (that exists only in GTM), so its controls are Consent Mode
  // in the snippet, holding the snippet, and its admin settings. The evidence
  // takes the class of the path the gtag.js script itself arrived by — GTM when
  // a GTM container injected it, direct-script when it is a <script> written in
  // the page — and only then; otherwise the load path decides alone.
  const gtagClass: ImplementationClass | undefined = gtmLoader ? 'gtm' : traced.fromPage?.kind === 'script' ? 'direct-script' : undefined;
  for (const ct of gtagClass ? input.containers ?? [] : []) {
    if (ct.kind !== 'gtag' || ct.status !== 'parsed') continue;
    const loader = traced.urls.find((u) => googleTagIdOf(u) === ct.id.toUpperCase());
    if (!loader) continue;
    const dests = ct.tags.filter((t) => t.kind === 'tag' && t.partyId === p.partyId && !t.paused);
    for (const t of dests.slice(0, MAX_CONTAINER_TAGS)) {
      add({ class: gtagClass!, kind: 'container-tag', observed: false, containerId: ct.id, tagId: t.tagId, url: loader,
        note: `Google tag ${ct.id} destination ${t.identifiers[0] ?? `tag ${t.tagId}`} (${t.templateLabel}), consent: ${t.consent.status}` });
    }
    if (!dests.length) {
      const settings = ct.tags.filter((t) => t.kind === 'setting' && GOOGLE_TAG_SETTINGS_FOR[t.template]?.includes(p.partyId) && googleTagSettingOn(t));
      add({ class: gtagClass!, kind: 'container-tag', observed: false, containerId: ct.id, url: loader,
        note: settings.length
          ? `Google tag ${ct.id} loaded it with no destination of its own: sent by the tag’s settings (${[...new Set(settings.map((t) => t.templateLabel))].join(', ')})`
          : `Google tag ${ct.id} loaded it; no destination or setting in the parsed tag names it` });
    }
  }
  const platformLoader = traced.urls.find((u) => platformLoaderOf(u, input.platform));
  if (p.sources.includes('platform') || platformLoader) {
    const pl = platformLoader ?? p.loadedBy[0];
    const name = pl ? platformLoaderOf(pl, input.platform) : undefined;
    add({ class: 'platform', kind: pl ? 'loader' : 'source', observed: true, url: pl,
      note: `injected by ${name ? `the ${name} platform` : 'a platform sandbox / worker'}${pl ? ` (${pl})` : ''}` });
  }
  // The platform's own parties (Shopify's cookies and CDN on a Shopify store):
  // whatever loads them, only the platform controls them.
  const pname = input.platform?.name;
  if (pname && (p.partyId.startsWith(`${pname}.`) || p.owner?.toLowerCase().includes(pname))) {
    // Ranked with observed paths: a platform's own script written into the page
    // is markup the platform generates, not markup the owner can rewrite.
    add({ class: 'platform', kind: 'source', observed: false, note: `the ${pname} platform’s own ${p.seenIn.every((s) => s.requests === 0) ? 'cookies / storage' : 'service'}` }, 0);
  }

  // Injected by a script that is neither a tag manager nor the platform.
  if (p.sources.includes('injected') && !gtmLoader && !otmLoader && !platformLoader) {
    let placed = false;
    if (traced.fromPage) {
      const r = traced.fromPage;
      if (r.kind === 'frame') {
        add({ class: 'markup-leak', kind: 'loader', observed: true, url: r.url, note: `loaded inside ${r.url}, an <iframe> written in the page — fetched before any script runs` });
      } else {
        add({ class: 'direct-script', kind: 'loader', observed: true, url: r.url,
          note: r.url === p.loadedBy[0] ? `injected by ${r.url}, a <script> written in the page` : `injected by ${p.loadedBy[0]}, which traces back to ${r.url}, a <script> written in the page` });
      }
      placed = true;
    }
    for (const url of placed ? [] : p.loadedBy) {
      if (!/^https?:/i.test(url)) continue;
      if (registrableDomain(hostOf(url)) === siteDomain) {
        add({ class: 'direct-script', kind: 'loader', observed: true, url, note: `injected by the site’s own script ${url}` });
        placed = true;
        break;
      }
      // Another party's script: use that party's own path (inferred).
      const lp = loaderParty(url);
      let path = lp ? loadPathOf(lp.impl) : undefined;
      // A party's leak is about an element, not this script: pass it on only
      // when the loader URL is itself a frame document.
      if (path === 'markup-leak' && input.scripts?.byUrl[url]?.resourceType !== 'document') path = undefined;
      if (lp && path) {
        add({ class: path, kind: 'loader', observed: false, url,
          note: `injected by ${lp.party.label} (${url}), which is ${path === 'direct-script' ? 'a script in the HTML' : path === 'markup-leak' ? 'an element the browser fetches itself (iframe / image in the HTML)' : path}` }, 2);
        placed = true;
        break;
      }
    }
    if (!placed) why.push(p.loadedBy.length ? `injected by ${p.loadedBy[0]}, whose own origin could not be traced` : 'injected by a script the scan could not identify');
  }

  // Server-side forwarding (#7) — an inference.
  for (const e of input.endpoints ?? []) {
    if (e.partyId !== p.partyId) continue;
    add({ class: 'server-side-suspected', kind: 'endpoint', observed: false, url: e.sample, containerId: e.containerId, tagId: e.tagId,
      note: e.via === 'container'
        ? `${e.containerId} tag ${e.tagId} sends to a first-party server container (${e.host}) — forwarding cannot be verified from the browser`
        : `first-party collect endpoint ${e.sample} — server-side forwarding is possible and cannot be verified from the browser` });
  }

  if (!c.length) {
    if (p.sources.includes('unknown') || !p.sources.length) {
      why.push(p.seenIn.every((s) => s.requests === 0) ? 'no request to trace: seen only through what it stored (a known cookie / storage name)' : 'its first request had no initiator the scan could trace');
    }
  }
  return { candidates: c, why };
}

/** The path a party's script arrived by — what a party it injects inherits. A
 *  controllable path when it has one (a pixel with a <noscript> leak still loaded
 *  its script some gateable way); a pure markup leak (an iframe in the HTML) passes
 *  the leak on to whatever loads inside it. CNAME and server-side do not pass on. */
function loadPathOf(impl: PartyImplementation): ImplementationClass | undefined {
  if (CONTROLLABLE.includes(impl.class)) return impl.class;
  const controllable = impl.alsoSeen.find((k) => CONTROLLABLE.includes(k));
  if (controllable) return controllable;
  return impl.class === 'markup-leak' ? 'markup-leak' : undefined;
}

// --- Script chains ---------------------------------------------------------------

/** How each script / frame URL was itself requested, from the timelines. */
export interface ScriptIndex {
  byUrl: Record<string, { initiator: string; chain: string[]; resourceType: string }>;
  pages: string[]; // document URLs (pages and frames), hash stripped
}

const stripHash = (u: string): string => u.replace(/#.*$/, '');

export function scriptIndex(timelines: Timeline[]): ScriptIndex {
  const byUrl: ScriptIndex['byUrl'] = {};
  const pages = new Set<string>();
  for (const tl of timelines) {
    for (const pg of tl.snapshot.pages) pages.add(stripHash(pg.url));
    for (const e of tl.events) {
      if (e.type !== 'request' || byUrl[e.url]) continue;
      if (e.resourceType !== 'script' && e.resourceType !== 'document') continue;
      byUrl[e.url] = { initiator: e.initiator.type, chain: e.initiator.chain.filter((u) => /^https?:\/\//i.test(u)), resourceType: e.resourceType };
    }
  }
  return { byUrl, pages: [...pages] };
}

/** Walk loaders back through their own initiator chains (≤ 4 levels): every URL
 *  passed, and the first element written in a page that started it all. */
function traceLoaders(start: string[], idx: ScriptIndex | undefined): { urls: string[]; fromPage?: { url: string; kind: 'script' | 'frame' } } {
  const urls: string[] = [];
  if (!idx) return { urls: [...start] };
  const pages = new Set(idx.pages);
  let fromPage: { url: string; kind: 'script' | 'frame' } | undefined;
  let level = start.filter((u) => /^https?:/i.test(u) && !pages.has(stripHash(u)));
  for (let depth = 0; depth < 5 && level.length; depth++) {
    const next: string[] = [];
    for (const u of level) {
      if (urls.includes(u)) continue;
      urls.push(u);
      const rec = idx.byUrl[u];
      if (!rec) continue;
      const kind = rec.resourceType === 'document' ? 'frame' : 'script';
      if (!rec.chain.length && /^(parser|other|preload)$/.test(rec.initiator)) fromPage ??= { url: u, kind };
      for (const c of rec.chain) {
        if (pages.has(stripHash(c))) fromPage ??= { url: u, kind };
        else next.push(c);
      }
    }
    level = next;
  }
  for (const u of start) if (!urls.includes(u)) urls.push(u);
  return { urls, fromPage };
}

function decide({ candidates, why }: { candidates: Candidate[]; why: string[] }): PartyImplementation {
  if (!candidates.length) {
    return {
      class: 'unknown',
      evidence: [{ class: 'unknown', kind: 'none', observed: false, note: why[0] ?? 'no markup tag, container tag, loader, CNAME or endpoint ties it to a load path' }],
      alsoSeen: [],
    };
  }
  const sorted = [...candidates].sort((a, b) => rankOf(a) - rankOf(b));
  const winner = sorted[0].ev.class;
  const alsoSeen: ImplementationClass[] = [];
  for (const x of sorted) if (x.ev.class !== winner && !alsoSeen.includes(x.ev.class)) alsoSeen.push(x.ev.class);
  return {
    class: winner,
    evidence: [...sorted.filter((x) => x.ev.class === winner), ...sorted.filter((x) => x.ev.class !== winner)].map((x) => x.ev),
    alsoSeen,
  };
}

// --- First-party collect endpoints (#7) -------------------------------------------

/** Endpoint shapes vendors' server-side setups expose on the site's own domain. */
const ENDPOINTS: Array<{ partyId: string; pattern: string; path: RegExp; params: (q: Set<string>) => boolean }> = [
  // GA4 / Universal Analytics hits proxied through a server container (sGTM).
  { partyId: 'google.analytics', pattern: '/g/collect', path: /\/(g|j|r|mp)\/collect\/?$/i, params: () => true },
  { partyId: 'google.analytics', pattern: '/collect', path: /\/collect\/?$/i, params: (q) => q.has('tid') || (q.has('v') && (q.has('cid') || q.has('en'))) },
  // Meta Pixel events through a first-party gateway / Conversions API proxy.
  { partyId: 'meta.pixel', pattern: '/tr', path: /\/tr\/?$/i, params: (q) => q.has('id') && q.has('ev') },
];

function paramKeys(url: URL, body?: string): Set<string> {
  const keys = new Set(url.searchParams.keys());
  if (body && body.length < 20000) {
    for (const line of body.split(/[\r\n]+/)) {
      try {
        for (const k of new URLSearchParams(line).keys()) keys.add(k);
      } catch {
        /* not form-encoded */
      }
    }
  }
  return keys;
}

/**
 * First-party collect endpoints seen in the timelines (requests to the site's own
 * registrable domain matching a vendor collect shape), plus server-container URLs
 * configured in parsed GTM tags. Pure; deduplicated by party + host + path.
 */
export function firstPartyCollectEndpoints(timelines: Timeline[], containers: TagContainer[] = []): CollectEndpoint[] {
  const out = new Map<string, CollectEndpoint>();
  for (const tl of timelines) {
    const siteDomain = tl.snapshot.site.registrableDomain;
    for (const e of tl.events) {
      if (e.type !== 'request') continue;
      let u: URL;
      try {
        u = new URL(e.url);
      } catch {
        continue;
      }
      if (registrableDomain(u.hostname) !== siteDomain) continue;
      const keys = paramKeys(u, e.postData);
      for (const ep of ENDPOINTS) {
        if (!ep.path.test(u.pathname) || !ep.params(keys)) continue;
        const sample = `${u.hostname}${u.pathname}${keys.size ? `?${[...keys].slice(0, 8).join('&')}` : ''}`;
        const key = `${ep.partyId}|${u.hostname}|${u.pathname}`;
        if (!out.has(key)) out.set(key, { partyId: ep.partyId, sample, host: u.hostname, pattern: ep.pattern, via: 'request' });
        break;
      }
    }
  }
  // Server-container URLs in GTM tag settings (GA4 / Google tag: server_container_url, transport_url).
  const domains = new Set(timelines.map((tl) => tl.snapshot.site.registrableDomain));
  for (const ct of containers) {
    if (ct.status !== 'parsed') continue;
    for (const t of ct.tags) {
      for (const [k, v] of Object.entries(t.settings ?? {})) {
        if (typeof v !== 'string' || !/server.?container|transport.?url/i.test(k)) continue;
        const host = hostOf(v);
        if (!host || !domains.has(registrableDomain(host))) continue;
        const partyId = t.partyId ?? 'google.analytics';
        const key = `${partyId}|${host}|container`;
        if (!out.has(key)) out.set(key, { partyId, sample: v.split('?')[0], host, pattern: k, via: 'container', containerId: ct.id, tagId: t.tagId });
      }
    }
  }
  return [...out.values()];
}
