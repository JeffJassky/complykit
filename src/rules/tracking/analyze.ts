import {
  Timeline,
  type Artifact,
  type ChoiceEvent,
  type RequestEvent,
  type ScreenshotEvent,
  type OptOutWalkEvent,
  type PartySource,
} from '../../record/index.js';
import {
  DEFAULT_KB,
  lookupEntry,
  lookupStore,
  registrableDomain,
  domainLabel,
  hostOf,
  classifyPlatform,
  platformLoaderOf,
  type PlatformName,
  type KnowledgeBase,
  type KnowledgeEntry,
  type PartyCategory,
} from '../../registry/index.js';
import { parseFields, classifyFields, findMarkers, type FieldKind, type MarkerHit, type MarkerSet } from './fields.js';
import { decodeConsent, type DecodedConsent } from './decoders.js';

// From timeline to facts (plans/consent-design.md §2.6 steps 1–4): identify
// every outside party (recognized through the knowledge base, or described by
// what it did), place each request in its consent phase, classify what it sent,
// decode what the vendor was told, attribute what it stored, and explain why it
// wasn't held back. Pure; memoized per artifact list so the location rules
// share one analysis.

export type Phase =
  | 'no-banner' // no banner seen, nothing clicked
  | 'before-banner' // the banner exists but hadn't appeared yet
  | 'before-choice' // banner showing, no choice made
  | 'after-accept'
  | 'after-reject'
  | 'after-dismiss'
  | 'after-partial'
  | 'after-withdraw'
  | 'after-opt-out-link';

/** Phases in which nothing has been consented to. */
export const UNCONSENTED: ReadonlySet<Phase> = new Set<Phase>(['no-banner', 'before-banner', 'before-choice', 'after-reject', 'after-dismiss', 'after-withdraw', 'after-opt-out-link']);
/** Before the visitor did anything at all. */
export const PRE_INTERACTION: ReadonlySet<Phase> = new Set<Phase>(['no-banner', 'before-banner', 'before-choice']);

/** Withdraw / revoking-reject grace (D10 follow-up, #52, #57): how long after the choice step's start a send on that page is still the vendor's queued data, ms. */
export const WITHDRAW_GRACE_MS = 1000;
/** The behavior-observation phase key withdraw-grace requests are counted under (summed by no rule; see summarizeBehavior). */
export const WITHDRAW_GRACE_PHASE = 'withdraw-grace';
/** #57: the same grace for a reject that revoked a granted state, for a vendor active before it. */
export const REJECT_GRACE_PHASE = 'reject-grace';
/** The grace key of each revoking choice's phase (summed by no rule; consumers note it). */
export const GRACE_PHASE_OF: Readonly<Partial<Record<Phase, string>>> = { 'after-withdraw': WITHDRAW_GRACE_PHASE, 'after-reject': REJECT_GRACE_PHASE };

/** Grace requests (data and loads) recorded for these phases' revoking choices. */
export function graceCount(facts: { dataRequestPhases: Record<string, number>; loadRequestsByPhase?: Record<string, number> }, phases: readonly string[]): number {
  let n = 0;
  for (const key of new Set(phases.map((ph) => GRACE_PHASE_OF[ph as Phase]).filter((k): k is string => Boolean(k)))) n += (facts.dataRequestPhases[key] ?? 0) + (facts.loadRequestsByPhase?.[key] ?? 0);
  return n;
}

export const PHASE_LABEL: Record<Phase, string> = {
  'no-banner': 'with no banner shown and no choice made',
  'before-banner': 'before the banner appeared',
  'before-choice': 'while the banner was showing, before any choice',
  'after-accept': 'after accepting',
  'after-reject': 'after rejecting',
  'after-dismiss': 'after closing the banner without choosing',
  'after-partial': 'after accepting analytics only',
  'after-withdraw': 'after withdrawing consent',
  'after-opt-out-link': 'after opting out through the site’s link',
};

export interface PartyRequest {
  id: string;
  t: number;
  url: string;
  method: string;
  resourceType: string;
  origin: RequestEvent['origin'] | 'websocket';
  phase: Phase;
  pageIndex: number;
  pageUrl: string;
  kinds: FieldKind[];
  ids: Array<{ value: string; storedAs: string }>;
  markers: MarkerHit[];
  decoded?: DecodedConsent;
  initiatorType: string;
  chain: string[];
  element?: string;
  dataBearing: boolean;
}

export interface PartyStore {
  name: string;
  kind: 'cookie' | 'local' | 'session' | 'indexeddb';
  lifetimeDays: number | null; // null = no expiry (storage) ; 0 = session cookie
  setBy: 'header' | 'script' | 'known-name';
  setByUrl?: string;
  t?: number;
  phase?: Phase;
  writePhases?: Phase[];
  /** Every write: when, on which page, in which phase — so a write at the instant of a choice can be told from one after it. */
  writes?: Array<{ t: number; pageIndex: number; phase: Phase }>;
}

export interface PartyFacts {
  partyId: string;
  label: string;
  owner?: string;
  domain: string;
  hosts: Set<string>;
  entry?: KnowledgeEntry;
  recognized: boolean;
  categories: Array<PartyCategory | 'unknown'>;
  requests: PartyRequest[];
  stores: PartyStore[];
  source: PartySource;
  loadedBy: string[];
  cnameOf?: string;
  trackerSignals: string[];
  behavesLikeTracker: boolean;
}

export interface TimelineAnalysis {
  timeline: Timeline;
  locationId: string;
  scenario: Timeline['snapshot']['scenario'];
  verified: boolean;
  jurisdictions: string[];
  date: string; // YYYY-MM-DD, for effective-date checks
  gpc: boolean;
  bannerShownT?: number;
  choices: ChoiceEvent[];
  parties: Map<string, PartyFacts>;
  screenshots: ScreenshotEvent[];
  walk?: OptOutWalkEvent;
  gpcAck?: { found: boolean; text?: string; via?: string };
  withdrawal?: { attempted: boolean; ok: boolean; entryPoint: boolean; t: number; method: string };
  site: { url: string; host: string; registrableDomain: string };
}

const DATA_KINDS: ReadonlySet<FieldKind> = new Set<FieldKind>(['page-address', 'page-title', 'browser-id', 'click-id', 'form-input', 'search-term', 'hashed-email', 'event-name', 'identifier']);

/** Parse the consent-timeline artifacts into validated timelines (invalid ones skipped). */
export function parseTimelines(artifacts: Artifact[]): Timeline[] {
  const out: Timeline[] = [];
  for (const a of artifacts) {
    if (a.kind !== 'consent-timeline') continue;
    const parsed = Timeline.safeParse({ location: a.location, verification: a.verification, events: a.events, snapshot: a.snapshot });
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export function phaseAt(t: number, bannerShownT: number | undefined, choices: ChoiceEvent[]): Phase {
  let last: ChoiceEvent | undefined;
  for (const c of choices) if (c.ok && c.t <= t) last = c;
  if (last) return `after-${last.choice}` as Phase;
  if (bannerShownT === undefined) return 'no-banner';
  return t < bannerShownT ? 'before-banner' : 'before-choice';
}

function stripHash(u: string): string {
  return u.replace(/#.*$/, '');
}

export function analyzeTimeline(timeline: Timeline, kb: KnowledgeBase = DEFAULT_KB): TimelineAnalysis {
  const { events, snapshot, verification } = timeline;
  const site = snapshot.site;
  const siteDomain = site.registrableDomain;
  const banner = events.find((e) => e.type === 'banner' && e.state === 'shown');
  const bannerShownT = banner?.t;
  const choices = events.filter((e): e is ChoiceEvent => e.type === 'choice').sort((a, b) => a.t - b.t);
  const markers: MarkerSet | undefined = snapshot.markers;
  const startEpoch = Date.parse(snapshot.startedAt) / 1000;
  const docUrls = new Set<string>([...snapshot.pages.map((p) => stripHash(p.url)), ...snapshot.frames.map((f) => stripHash(f.url))]);
  const sandboxed = new Set(snapshot.frames.filter((f) => f.sandboxed).map((f) => f.url));
  const platform = classifyPlatform(snapshot.platformSignals);

  // CNAME cloaking: a first-party subdomain whose DNS points at a TRACKING
  // vendor. The site's own host is the first party by definition, and CNAMEs to
  // hosting/CDN platforms (Shopify custom domains → shops.myshopify.com) are not
  // cloaking — only a target the knowledge base knows as non-infrastructure is.
  const cname = new Map<string, string>();
  for (const d of snapshot.dns) {
    if (d.host === site.host) continue;
    for (const raw of d.cname) {
      const target = raw.replace(/\.$/, '');
      if (registrableDomain(target) === siteDomain) continue;
      const entry = lookupEntry(kb, target, '/');
      if (entry && !entry.categories.every((c) => c === 'cdn' || c === 'necessary' || c === 'payments')) {
        cname.set(d.host, target);
        break;
      }
    }
  }

  // Values stored on the device → where they live (for "sends an ID it stores").
  const deviceValues = new Map<string, string>();
  for (const c of snapshot.cookies) if (c.value.length >= 8) deviceValues.set(c.value, `cookie ${c.name}`);
  for (const s of snapshot.storage) if (s.value && s.value.length >= 8 && s.value.length < 512) deviceValues.set(s.value, `${s.area} ${s.key}`);
  for (const e of events) {
    if (e.type === 'cookie-write' && e.value.length >= 8) deviceValues.set(e.value, `cookie ${e.name}`);
    if (e.type === 'storage-write' && e.value.length >= 8 && e.value.length < 512) deviceValues.set(e.value, `${e.area} ${e.key}`);
  }
  const firstPartyCookieNames = new Set(snapshot.cookies.filter((c) => registrableDomain(c.domain.replace(/^\./, '')) === siteDomain).map((c) => c.name));

  const titleAt = (pageIndex: number): string | undefined => snapshot.pages[pageIndex]?.title;
  const parties = new Map<string, PartyFacts>();

  const partyFor = (host: string, pathname: string): { id: string; entry?: KnowledgeEntry; domain: string; cnameOf?: string } | null => {
    const domain = registrableDomain(host);
    let effectiveHost = host;
    let cnameOf: string | undefined;
    if (domain === siteDomain) {
      const target = cname.get(host);
      if (!target) return null; // first party
      effectiveHost = target;
      cnameOf = host;
    }
    const entry = lookupEntry(kb, effectiveHost, pathname);
    const effDomain = registrableDomain(effectiveHost);
    return { id: entry ? entry.id : `unknown:${effDomain}`, entry, domain: effDomain, cnameOf };
  };

  const ensure = (p: { id: string; entry?: KnowledgeEntry; domain: string; cnameOf?: string }, host: string): PartyFacts => {
    let f = parties.get(p.id);
    if (!f) {
      f = {
        partyId: p.id,
        label: p.entry?.vendor ?? domainLabel(p.domain),
        owner: p.entry?.owner,
        domain: p.domain,
        hosts: new Set(),
        entry: p.entry,
        recognized: Boolean(p.entry),
        categories: p.entry ? [...p.entry.categories] : ['unknown'],
        requests: [],
        stores: [],
        source: 'unknown',
        loadedBy: [],
        cnameOf: p.cnameOf,
        trackerSignals: [],
        behavesLikeTracker: false,
      };
      parties.set(p.id, f);
    }
    f.hosts.add(host);
    return f;
  };

  // 1. Requests (and websocket sends) → parties.
  const allRequests = events.filter((e): e is RequestEvent => e.type === 'request');
  for (const e of allRequests) {
    let u: URL;
    try {
      u = new URL(e.url);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(u.protocol)) continue;
    const p = partyFor(u.hostname, u.pathname);
    if (!p) continue;
    const f = ensure(p, u.hostname);
    const fields = parseFields(e.url, e.postData);
    const pageUrl = e.pageUrl || snapshot.pages[e.pageIndex]?.url || site.url;
    const cls = classifyFields(fields, { pageUrl, pageTitle: titleAt(e.pageIndex), deviceValues, markers });
    const rawHits = findMarkers([e.url, e.postData], markers);
    const markerHits = [...cls.markers];
    for (const h of rawHits) if (!markerHits.some((m) => m.marker === h.marker && m.form === h.form)) markerHits.push(h);
    // The scan's landing URL carries the fake click IDs, so every tracker that
    // receives the page address "receives" them too. Count a click ID only when
    // it travels as its own value, not inside a copy of the page URL.
    if (markers) {
      const own = (id: string): boolean => fields.some((f) => f.value.includes(id) && !f.value.includes(site.host));
      for (let i = markerHits.length - 1; i >= 0; i--) {
        const h = markerHits[i];
        if (h.marker === 'click-id' && h.name && !own(markers.clickIds[h.name])) markerHits.splice(i, 1);
      }
      for (const k of [...cls.kinds]) if (k === 'click-id' && !markerHits.some((m) => m.marker === 'click-id')) cls.kinds.delete(k);
    }
    for (const m of markerHits) {
      if (m.marker === 'click-id') cls.kinds.add('click-id');
      else if (m.form === 'sha256' || m.form === 'md5' || m.form === 'sha1') cls.kinds.add('hashed-email');
      else if (m.marker === 'search-text') cls.kinds.add('search-term');
      else cls.kinds.add('form-input');
    }
    const kinds = [...cls.kinds];
    const dataBearing = kinds.some((k) => DATA_KINDS.has(k)) || e.resourceType === 'ping' || e.origin === 'exit-beacon' || Boolean(e.postData);
    f.requests.push({
      id: e.id,
      t: e.t,
      url: e.url,
      method: e.method,
      resourceType: e.resourceType,
      origin: e.frameUrl && sandboxed.has(e.frameUrl) ? 'frame' : e.origin,
      phase: phaseAt(e.t, bannerShownT, choices),
      pageIndex: e.pageIndex,
      pageUrl,
      kinds,
      ids: cls.ids,
      markers: markerHits,
      decoded: decodeConsent(f.entry?.decoder, fields),
      initiatorType: e.initiator.type,
      chain: e.initiator.chain,
      element: e.initiator.element,
      dataBearing,
    });
    // Set-Cookie on this party's responses.
    for (const c of e.setCookies) {
      // A Set-Cookie that expires the cookie is a deletion, not a write (E4).
      if ((c.maxAgeSec !== undefined && c.maxAgeSec <= 0) || (c.maxAgeSec === undefined && c.expires && Date.parse(c.expires) / 1000 <= startEpoch + e.t / 1000 + 1)) continue;
      const lifetimeDays = c.maxAgeSec !== undefined ? c.maxAgeSec / 86400 : c.expires ? Math.max(0, (Date.parse(c.expires) / 1000 - startEpoch) / 86400) : 0;
      const previous = f.stores.find(s=>s.name===c.name&&s.kind==='cookie');
      const write = { t: e.t, pageIndex: e.pageIndex ?? 0, phase: phaseAt(e.t, bannerShownT, choices) };
      if (previous) {
        previous.writePhases = [...new Set([...(previous.writePhases ?? (previous.phase ? [previous.phase] : [])), write.phase])];
        previous.writes = [...(previous.writes ?? []), write];
      }
      if (!previous) {
        f.stores.push({ name: c.name, kind: 'cookie', lifetimeDays: Math.round(lifetimeDays), setBy: 'header', setByUrl: e.url, t: e.t, phase: write.phase, writes: [write] });
      }
    }
  }
  for (const e of events) {
    if (e.type !== 'websocket' || e.direction !== 'sent') continue;
    let u: URL;
    try {
      u = new URL(e.url);
    } catch {
      continue;
    }
    const p = partyFor(u.hostname, u.pathname);
    if (!p) continue;
    const f = ensure(p, u.hostname);
    const fields = parseFields(e.url, e.payload);
    const pageUrl = snapshot.pages[e.pageIndex]?.url ?? site.url;
    const cls = classifyFields(fields, { pageUrl, pageTitle: titleAt(e.pageIndex), deviceValues, markers });
    const hits = findMarkers([e.payload], markers);
    f.requests.push({
      id: `ws${e.t}`,
      t: e.t,
      url: e.url,
      method: 'WS',
      resourceType: 'websocket',
      origin: 'websocket',
      phase: phaseAt(e.t, bannerShownT, choices),
      pageIndex: e.pageIndex,
      pageUrl,
      kinds: [...cls.kinds, ...(hits.some((h) => h.marker !== 'click-id') ? (['form-input'] as FieldKind[]) : [])],
      ids: cls.ids,
      markers: [...cls.markers, ...hits],
      initiatorType: 'websocket',
      chain: [],
      dataBearing: true,
    });
  }

  // 2. Script-written cookies/storage → the party whose script wrote them.
  const writerParty = (chain: string[]): PartyFacts | undefined => {
    for (const url of chain) {
      const host = hostOf(url);
      if (!host) continue;
      let path = '/';
      try {
        path = new URL(url).pathname;
      } catch {
        /* keep */
      }
      const p = partyFor(host, path);
      if (p) return ensure(p, host);
      return undefined; // nearest writer is first-party code
    }
    return undefined;
  };
  const cookieExpiry = new Map(snapshot.cookies.map((c) => [c.name, c.expires]));
  // A name the knowledge base assigns to a vendor belongs to that vendor, whichever
  // script wrote it: gtag.js writes _ga and _gcl_au, but they are Google Analytics'
  // and Google Ads' identifiers, and listing them under the tag loader as well put
  // the same cookie on two rows (storyfolder.com, 2026-10-08). The writing script
  // decides only for names the knowledge base does not know.
  const storeOwner = (name: string, chain: string[]) => {
    const entry = lookupStore(kb, name);
    return entry ? ensure({ id: entry.id, entry, domain: entry.match.hosts[0] }, entry.match.hosts[0]) : writerParty(chain);
  };
  for (const e of events) {
    if (e.type === 'cookie-write') {
      // Expiring a cookie (Max-Age<=0, or an expiry at or before the write) deletes
      // it: a consent tool's withdrawal cleanup or a vendor dropping its id after a
      // refusal is not the vendor storing anything (E4: counted as "storage writes
      // after rejecting", which turned held vendors red).
      if (isCookieDeletion(e.attributes, startEpoch + e.t / 1000)) continue;
      const f = storeOwner(e.name, e.chain);
      if (!f) continue;
      const previous = f.stores.find(s=>s.name===e.name&&s.kind==='cookie');
      const write = { t: e.t, pageIndex: e.pageIndex ?? 0, phase: phaseAt(e.t, bannerShownT, choices) };
      if(previous){previous.writePhases=[...new Set([...(previous.writePhases??(previous.phase?[previous.phase]:[])),write.phase])];previous.writes=[...(previous.writes??[]),write];continue;}
      const exp = cookieExpiry.get(e.name);
      const maxAge = /max-age=(\d+)/i.exec(e.attributes ?? '')?.[1];
      const lifetimeDays = exp !== undefined && exp > 0 ? (exp - startEpoch) / 86400 : maxAge ? Number(maxAge) / 86400 : 0;
      f.stores.push({ name: e.name, kind: 'cookie', lifetimeDays: Math.round(lifetimeDays), setBy: 'script', setByUrl: e.chain[0], t: e.t, phase: write.phase, writes: [write] });
    } else if (e.type === 'storage-write') {
      const f = storeOwner(e.key, e.chain);
      if (!f) continue;
      const previous = f.stores.find(s=>s.name===e.key&&s.kind===e.area);
      const write = { t: e.t, pageIndex: e.pageIndex ?? 0, phase: phaseAt(e.t, bannerShownT, choices) };
      if(previous){previous.writePhases=[...new Set([...(previous.writePhases??(previous.phase?[previous.phase]:[])),write.phase])];previous.writes=[...(previous.writes??[]),write];continue;}
      f.stores.push({ name: e.key, kind: e.area, lifetimeDays: e.area === 'local' ? null : 0, setBy: 'script', setByUrl: e.chain[0], t: e.t, phase: write.phase, writes: [write] });
    }
  }
  // One owner per cookie in the jar: GCL_AW_P on .googleadservices.com is Google Ads'
  // by name and also matched the Ads party's domain, so it was listed twice.
  const cookieClaimed = (name: string) => [...parties.values()].some((p) => p.stores.some((s) => s.name === name && s.kind === 'cookie'));
  // Known first-party cookie names (e.g. _ga, _fbp) the shim didn't see written.
  for (const c of snapshot.cookies) {
    const entry = lookupStore(kb, c.name);
    if (!entry) continue;
    if (cookieClaimed(c.name)) continue;
    const f = parties.get(entry.id) ?? ensure({ id: entry.id, entry, domain: entry.match.hosts[0] }, entry.match.hosts[0]);
    f.stores.push({ name: c.name, kind: 'cookie', lifetimeDays: c.expires > 0 ? Math.round((c.expires - startEpoch) / 86400) : 0, setBy: 'known-name' });
  }
  // Third-party cookies in the jar, by domain.
  for (const c of snapshot.cookies) {
    const d = registrableDomain(c.domain.replace(/^\./, ''));
    if (d === siteDomain) continue;
    const f = [...parties.values()].find((p) => p.domain === d);
    if (!f || cookieClaimed(c.name)) continue;
    f.stores.push({ name: c.name, kind: 'cookie', lifetimeDays: c.expires > 0 ? Math.round((c.expires - startEpoch) / 86400) : 0, setBy: 'header' });
  }

  // 3. Why each party wasn't held back.
  const byUrl = new Map<string, RequestEvent>();
  for (const e of allRequests) if (!byUrl.has(e.url)) byUrl.set(e.url, e);
  const byId = new Map(allRequests.map((e) => [e.id, e]));
  const pageDocs = new Set(snapshot.pages.map((p) => stripHash(p.url)));
  const redirectOrigin = (id: string | undefined): RequestEvent | undefined => {
    const e = id ? byId.get(id) : undefined;
    return e ? redirectOriginOf(e, byId, allRequests) : undefined;
  };
  for (const f of parties.values()) {
    const first = [...f.requests].sort((a, b) => a.t - b.t)[0];
    const { source, loadedBy } = f.cnameOf
      ? { source: 'first-party-proxy' as PartySource, loadedBy: [] }
      : first
        ? explainSource(first, f, { byUrl, docUrls, pageDocs, sandboxed, platform, siteDomain, redirectOrigin })
        : { source: 'unknown' as PartySource, loadedBy: [] };
    f.source = source;
    f.loadedBy = loadedBy;
    f.trackerSignals = trackerSignals(f, firstPartyCookieNames);
    const s = new Set(f.trackerSignals);
    f.behavesLikeTracker = ((s.has('sends-stored-id') || s.has('repeats-id-across-pages')) && s.has('sends-page-address')) || s.has('receives-typed-input') || s.has('receives-first-party-cookie');
  }

  const walk = [...events].reverse().find((e): e is OptOutWalkEvent => e.type === 'opt-out-walk');
  const ack = events.find((e) => e.type === 'consent-readout' && e.label === 'gpc-acknowledgement');
  const withdrawEvent = choices.find((c) => c.choice === 'withdraw') ?? (events.find((e) => e.type === 'choice' && e.choice === 'withdraw') as ChoiceEvent | undefined);
  return {
    timeline,
    locationId: timeline.location.id,
    scenario: snapshot.scenario,
    verified: verification.verdict === 'verified',
    jurisdictions: verification.verdict === 'verified' ? verification.jurisdictions : [],
    date: snapshot.startedAt.slice(0, 10),
    gpc: snapshot.gpc,
    bannerShownT,
    choices,
    parties,
    screenshots: events.filter((e): e is ScreenshotEvent => e.type === 'screenshot'),
    walk,
    gpcAck: ack?.type === 'consent-readout' ? (ack.data as { found: boolean; text?: string; via?: string }) : undefined,
    withdrawal: withdrawEvent
      ? { attempted: true, ok: withdrawEvent.ok, entryPoint: !/^reopen:none/.test(withdrawEvent.method), t: withdrawEvent.t, method: withdrawEvent.method }
      : undefined,
    site,
  };
}

/**
 * The request a redirect hop continues. The browser reports a hop (c.gif → a
 * partner's cookie sync → back) with no initiator of its own, which is also
 * what an element in the HTML can look like — so a hop must be followed back,
 * never read as markup. Exact when the collector recorded `redirectedFrom`;
 * on older records, only a 3xx response on the same page and frame shortly
 * before whose host the hop's own URL names (`…&RedC=c.example.test`).
 */
export function redirectOriginOf(e: RequestEvent, byId: Map<string, RequestEvent>, all: RequestEvent[]): RequestEvent | undefined {
  if (e.redirectedFrom) return byId.get(e.redirectedFrom);
  let query: string;
  try {
    const u = new URL(e.url);
    query = decodeURIComponent(u.search + u.hash).toLowerCase();
  } catch {
    return undefined;
  }
  if (!query) return undefined;
  let best: RequestEvent | undefined;
  for (const c of all) {
    if (c === e || c.t > e.t || e.t - c.t > 10_000 || c.status === undefined || c.status < 300 || c.status > 399) continue;
    if (c.pageIndex !== e.pageIndex || (c.frameUrl ?? '') !== (e.frameUrl ?? '')) continue;
    const host = hostOf(c.url);
    if (!host || host === hostOf(e.url) || !query.includes(host.toLowerCase())) continue;
    if (!best || c.t >= best.t) best = c;
  }
  return best;
}

interface SourceContext {
  byUrl: Map<string, RequestEvent>;
  /** Every document URL (pages and frames), hash stripped. */
  docUrls: Set<string>;
  /** Top-level page URLs only, hash stripped. */
  pageDocs: Set<string>;
  sandboxed: Set<string>;
  platform?: { name: PlatformName };
  siteDomain: string;
  redirectOrigin: (id: string | undefined) => RequestEvent | undefined;
}

// Why a party was not held back, from its first request's initiator. A
// markup-leak is claimed only for what the site's OWN document's parser
// fetched (an <img>/<iframe>/<link> in the HTML): a request with no initiator
// at all is a redirect hop (followed back to the request that started it) or
// something the scan could not trace (unknown) — never a leak by default. A
// request a third-party frame's document made belongs to that frame: it is
// 'injected' with the frame as its loader, so it inherits the frame's path.
function explainSource(first: PartyRequest, f: PartyFacts, ctx: SourceContext): { source: PartySource; loadedBy: string[] } {
  const { byUrl, docUrls, pageDocs, sandboxed, platform, siteDomain } = ctx;
  if (first.origin === 'worker' || first.origin === 'service-worker') return { source: 'platform', loadedBy: first.chain.slice(0, 3) };
  const ev = byUrl.get(first.url);
  if (ev?.frameUrl && sandboxed.has(ev.frameUrl)) return { source: 'platform', loadedBy: [ev.frameUrl] };
  const web = (c: string[]): string[] => c.filter((u) => /^https?:\/\//i.test(u));
  const stripQuery = (u: string): string => u.replace(/[?#].*$/, '');
  let chain = web(first.chain);
  let req: { id?: string; chain: string[]; initiatorType: string; resourceType: string; element?: string } = { ...first, id: first.id };
  const via: string[] = []; // redirect origins passed, nearest first
  for (let depth = 0; depth < 6; depth++) {
    if (!chain.length) {
      if (req.initiatorType === 'parser') {
        const leak = ['image', 'iframe', 'document', 'ping', 'media'].includes(req.resourceType) || req.element === 'img' || req.element === 'iframe';
        return { source: leak && req.resourceType !== 'script' ? 'markup-leak' : 'markup', loadedBy: via };
      }
      const origin = ctx.redirectOrigin(req.id);
      if (origin) {
        via.push(stripQuery(origin.url));
        chain = web(origin.initiator.chain);
        req = { id: origin.id, chain, initiatorType: origin.initiator.type, resourceType: origin.resourceType, element: origin.initiator.element };
        continue;
      }
      // A <link rel=preload> or a script-less fetch with no document named: in the
      // page, perhaps, but not located — not a leak claim.
      if (req.initiatorType === 'preload') return { source: 'markup', loadedBy: via };
      return { source: 'unknown', loadedBy: via };
    }
    const outside = chain.find((u) => registrableDomain(hostOf(u)) !== f.domain);
    if (outside) {
      const doc = stripHash(outside);
      if (docUrls.has(doc)) {
        // A document that is not the site's own page: a third-party frame. What
        // its parser fetched is the frame's doing — the frame is the loader.
        if (!pageDocs.has(doc) && registrableDomain(hostOf(outside)) !== siteDomain) return { source: 'injected', loadedBy: [...via, outside].slice(0, 4) };
        // An inline script or a tag written in the page itself.
        const leak = req.initiatorType === 'parser' && req.resourceType !== 'script' && req.resourceType !== 'fetch' && req.resourceType !== 'xhr';
        return { source: leak ? 'markup-leak' : 'markup', loadedBy: [...via, outside].slice(0, 4) };
      }
      const injectors = chain.slice(chain.indexOf(outside)).filter((u, i, a) => a.indexOf(u) === i);
      // Injected by the platform's own loader (Shopify, Wix, Squarespace, a WordPress
      // plugin): the fix is the platform's consent bridge, not a rewrite of the tag.
      const platformLoader = injectors.find((u) => platformLoaderOf(u, platform));
      if (platformLoader) return { source: 'platform', loadedBy: [platformLoader, ...injectors.filter((u) => u !== platformLoader)].slice(0, 4) };
      return { source: 'injected', loadedBy: [...via, ...injectors].slice(0, 4) };
    }
    // Every frame is the party's own script: find what loaded that script.
    const own = chain[chain.length - 1];
    const loader = byUrl.get(own);
    if (!loader) return { source: 'unknown', loadedBy: via };
    chain = web(loader.initiator.chain);
    req = { id: loader.id, chain, initiatorType: loader.initiator.type, resourceType: loader.resourceType, element: loader.initiator.element };
  }
  return { source: 'unknown', loadedBy: via };
}

function trackerSignals(f: PartyFacts, firstPartyCookies: Set<string>): string[] {
  const s: string[] = [];
  if (f.stores.some((x) => x.lifetimeDays === null || (x.lifetimeDays ?? 0) >= 30)) s.push('stores-long-lived-id');
  if (f.requests.some((r) => r.kinds.includes('browser-id'))) s.push('sends-stored-id');
  if (f.requests.some((r) => r.kinds.includes('page-address'))) s.push('sends-page-address');
  const byValue = new Map<string, Set<number>>();
  for (const r of f.requests) {
    for (const id of r.ids) {
      const set = byValue.get(id.value) ?? new Set<number>();
      set.add(r.pageIndex);
      byValue.set(id.value, set);
    }
  }
  if ([...byValue.values()].some((pages) => pages.size >= 2)) s.push('repeats-id-across-pages');
  if (f.requests.some((r) => r.ids.some((id) => id.storedAs.startsWith('cookie ') && firstPartyCookies.has(id.storedAs.slice(7)) && !f.stores.some((st) => st.name === id.storedAs.slice(7))))) s.push('receives-first-party-cookie');
  if (f.requests.some((r) => r.markers.some((m) => m.marker !== 'click-id'))) s.push('receives-typed-input');
  if (f.requests.some((r) => r.markers.some((m) => m.marker === 'click-id'))) s.push('receives-click-id');
  if (f.requests.some((r) => r.origin === 'exit-beacon')) s.push('sends-on-page-exit');
  return s;
}

// --- Shared, memoized across rules ------------------------------------------------

const memo = new WeakMap<object, Map<KnowledgeBase, TimelineAnalysis[]>>();

export function analyzeArtifacts(artifacts: Artifact[], kb: KnowledgeBase = DEFAULT_KB): TimelineAnalysis[] {
  const key = artifacts as unknown as object;
  let byKb = memo.get(key);
  if (!byKb) {
    byKb = new Map();
    memo.set(key, byKb);
  }
  let out = byKb.get(kb);
  if (!out) {
    out = parseTimelines(artifacts).map((t) => analyzeTimeline(t, kb));
    byKb.set(kb, out);
  }
  return out;
}

/** Party categories that mean "needs prior consent" for this party. */
export function partyCategories(f: PartyFacts): PartyCategory[] {
  return f.categories.filter((c): c is PartyCategory => c !== 'unknown');
}

/** Does a document.cookie write with these attributes delete the cookie? `nowSec`: when it was written (epoch seconds). */
export function isCookieDeletion(attributes: string | undefined, nowSec: number): boolean {
  if (!attributes) return false;
  const maxAge = /(?:^|;)\s*max-age\s*=\s*(-?\d+)/i.exec(attributes)?.[1];
  if (maxAge !== undefined) return Number(maxAge) <= 0;
  const expires = /(?:^|;)\s*expires\s*=\s*([^;]+)/i.exec(attributes)?.[1];
  if (!expires) return false;
  const at = Date.parse(expires.trim());
  return Number.isFinite(at) && at / 1000 <= nowSec + 1;
}
