import { allDenied, adsRestricted } from './decoders.js';
import type {
  Timeline,
  TrackingEvaluation,
  PartyInventoryItem,
  LocationSummary,
  NotTestedItem,
  LocationSpec,
  LocationVerification,
  ScenarioSummary,
  PartySource,
  PlatformSignals,
  ContainerCapture,
} from '../../record/index.js';
import { DEFAULT_KB, classifyPlatform, entryStatus, registrableDomain, type KnowledgeBase, type KnowledgeEntry } from '../../registry/index.js';
import { analyzeTimeline, phaseAt, REJECT_GRACE_PHASE, WITHDRAW_GRACE_MS, WITHDRAW_GRACE_PHASE, type PartyRequest, type TimelineAnalysis } from './analyze.js';
import { buildMarkupSection } from './markup.js';
import { parseContainers } from './gtm.js';
import { classifyImplementations, firstPartyCollectEndpoints, scriptIndex } from './implementation.js';
import { summarizeConsentApi } from './consent-api.js';
import { evaluateCompatibility } from './compatibility.js';

// The run-level evaluation record (plans/consent-design.md §3): locations and
// their verification, the scenarios each ran, the inventory of every outside
// party seen — recognized or not — and everything not tested. The inventory is
// the tracker list regulators have ordered companies to keep. Pure.

export interface EvaluationInput {
  runId: string;
  property: string;
  site: { url: string; host: string; registrableDomain: string };
  versions: { kb: string; registry: string; package: string; autoconsent?: string };
  startedAt: string;
  finishedAt: string;
  locations: Array<{ spec: LocationSpec; verification: LocationVerification; scenarios: ScenarioSummary[] }>;
  timelines: Timeline[];
  notTested: NotTestedItem[];
  redacted: boolean;
  kb?: KnowledgeBase;
  /** Tag-manager containers fetched by the collector (A2); absent = not looked for. */
  containers?: ContainerCapture[];
}

/** Flows a browser cannot observe — always listed, never implied clean (§1). */
export const ALWAYS_NOT_TESTED: NotTestedItem[] = [
  { scope: 'flow', id: 'server-to-server', reason: 'data the site’s server sends to vendors directly (conversion APIs, server-side tagging) — a configuration checklist item, not a browser test' },
  { scope: 'flow', id: 'vendor-processing', reason: 'what vendors do with data after receiving it' },
  { scope: 'flow', id: 'contracts', reason: 'vendor contracts (whether a disclosure is a “sale”, processor terms)' },
  { scope: 'flow', id: 'consent-records', reason: 'whether consent records are stored correctly on the site’s backend' },
  { scope: 'page', id: 'unvisited', reason: 'pages and flows the journey did not visit (logged-in areas, checkout beyond the cart, forms that were not submitted)' },
];

const MAX_SAMPLES = 5;

/** 'px.example.com/collect?ev&uid' — host + path, query keys only (values are data). */
function sampleOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    const keys = [...new Set([...u.searchParams.keys()])].slice(0, 12);
    const path = u.pathname.length > 80 ? `${u.pathname.slice(0, 80)}…` : u.pathname;
    return `${u.hostname}${path}${keys.length ? `?${keys.join('&')}` : ''}`;
  } catch {
    return undefined;
  }
}

/** Sensitive field kinds whose undeclared appearance is worth a re-look. */
const DRIFT_KINDS = new Set(['hashed-email', 'form-input', 'search-term']);

/** Where observed behavior disagrees with the entry (§4.2: observed outranks
 *  documented, and the disagreement is recorded). Only checked where the entry
 *  makes a claim — an entry that lists no stores says nothing about storage. */
export function driftFrom(entry: KnowledgeEntry, p: Pick<PartyInventoryItem, 'stores' | 'sends'>, kb?: KnowledgeBase): string[] {
  const out: string[] = [];
  if (entry.stores.length) {
    // Large vendors share cookies across their own products (Microsoft's MUID,
    // Google's conversion linker): a cookie any entry of the same owner
    // declares is not drift.
    const family = entry.owner && kb ? kb.entries.filter((e) => e.owner === entry.owner) : [entry];
    const declared = family.flatMap((e) => e.stores).map((s) => new RegExp(s.name));
    const extra = p.stores.filter((s) => !declared.some((re) => re.test(s.name))).map((s) => s.name);
    if (extra.length) out.push(`stores ${extra.slice(0, 5).join(', ')}${extra.length > 5 ? ` (+${extra.length - 5})` : ''} not in the entry`);
  }
  if (entry.sends.length) {
    const extra = p.sends.filter((k) => DRIFT_KINDS.has(k) && !entry.sends.some((s) => s.replace(/\?$/, '') === k));
    if (extra.length) out.push(`sends ${extra.join(', ')} not in the entry`);
  }
  return out;
}

export function buildTrackingEvaluation(input: EvaluationInput): TrackingEvaluation {
  const kb = input.kb ?? DEFAULT_KB;
  const inv = new Map<string, PartyInventoryItem>();
  const kindsOf = new Map<string, Set<string>>();
  const entryOf = new Map<string, KnowledgeEntry>();
  const cnames: Record<string, Array<{ host: string; target?: string }>> = {};
  for (const tl of input.timelines) {
    const a = analyzeTimeline(tl, kb);
    for (const f of a.parties.values()) {
      if (f.cnameOf) {
        const list = (cnames[f.partyId] ??= []);
        if (!list.some((x) => x.host === f.cnameOf)) {
          const target = tl.snapshot.dns.find((d) => d.host === f.cnameOf)?.cname.map((c) => c.replace(/\.$/, '')).find((c) => f.hosts.has(c) || c.endsWith(f.domain));
          list.push({ host: f.cnameOf, ...(target ? { target } : {}) });
        }
      }
      let item = inv.get(f.partyId);
      if (!item) {
        item = {
          partyId: f.partyId,
          label: f.label,
          owner: f.owner,
          domain: f.domain,
          hosts: [],
          recognized: f.recognized,
          kbStatus: f.entry ? entryStatus(f.entry) : 'unrecognized',
          categories: f.categories,
          behavesLikeTracker: false,
          trackerSignals: [],
          sends: [],
          stores: [],
          sources: [],
          loadedBy: [],
          consentApi: f.entry?.consentApi,
          samples: [],
          seenIn: [],
        };
        inv.set(f.partyId, item);
        kindsOf.set(f.partyId, new Set());
      }
      for (const h of f.hosts) if (!item.hosts.includes(h)) item.hosts.push(h);
      item.behavesLikeTracker = item.behavesLikeTracker || f.behavesLikeTracker;
      for (const s of f.trackerSignals) if (!item.trackerSignals.includes(s)) item.trackerSignals.push(s);
      const kinds = kindsOf.get(f.partyId)!;
      for (const r of f.requests) for (const k of r.kinds) kinds.add(k);
      for (const s of f.stores) {
        if (!item.stores.some((x) => x.name === s.name && x.kind === s.kind)) item.stores.push({ name: s.name, kind: s.kind, lifetimeDays: s.lifetimeDays });
      }
      if (!item.sources.includes(f.source)) item.sources.push(f.source as PartySource);
      for (const u of f.loadedBy) if (!item.loadedBy.includes(u) && item.loadedBy.length < 6) item.loadedBy.push(u);
      // Data-bearing requests first: they say most about what the party is.
      for (const r of [...f.requests].sort((x, y) => Number(y.dataBearing) - Number(x.dataBearing))) {
        if (item.samples.length >= MAX_SAMPLES) break;
        const s = sampleOf(r.url);
        if (s && !item.samples.includes(s)) item.samples.push(s);
      }
      if (f.entry) entryOf.set(f.partyId, f.entry);
      const sorted = [...f.requests].sort((x, y) => x.t - y.t);
      // A repeat run (A7) of the same location × scenario merges into one entry.
      const seen = item.seenIn.find((s) => s.location === a.locationId && s.scenario === a.scenario);
      const phases = [...new Set(f.requests.map((r) => r.phase))];
      if (seen) {
        seen.requests = Math.max(seen.requests, f.requests.length);
        seen.firstMs = Math.min(seen.firstMs, Math.round(sorted[0]?.t ?? seen.firstMs));
        for (const ph of phases) if (!seen.phases.includes(ph)) seen.phases.push(ph);
      } else {
        item.seenIn.push({
          location: a.locationId,
          scenario: a.scenario,
          requests: f.requests.length,
          firstMs: Math.round(sorted[0]?.t ?? 0),
          phases,
        });
      }
    }
  }
  for (const [id, kinds] of kindsOf) inv.get(id)!.sends = [...kinds];

  const inventory = [...inv.values()].sort((a, b) => {
    const rank = (x: PartyInventoryItem): number => (x.behavesLikeTracker ? 0 : 1) + (x.recognized ? 0 : -0.5);
    return rank(a) - rank(b) || a.label.localeCompare(b.label);
  });

  const researchQueue: TrackingEvaluation['researchQueue'] = [];
  for (const p of inventory) {
    if (!p.recognized) {
      researchQueue.push({
        partyId: p.partyId,
        domain: p.domain,
        kind: 'unrecognized',
        reason: p.behavesLikeTracker ? `behaves like a tracker (${p.trackerSignals.join(', ')})` : p.stores.length ? 'stores data on the device' : 'seen; purpose unknown',
      });
      continue;
    }
    const entry = entryOf.get(p.partyId);
    const drift = entry ? driftFrom(entry, p, kb) : [];
    if (drift.length) researchQueue.push({ partyId: p.partyId, domain: p.domain, kind: 'drift', reason: `behaves differently than its entry: ${drift.join('; ')}` });
  }

  const locations: LocationSummary[] = input.locations.map((l) => {
    const { proxy, ...spec } = l.spec;
    return { spec: { ...spec, proxied: Boolean(proxy) }, verification: l.verification, scenarios: l.scenarios };
  });

  // Static markup inspection: tags in the served HTML, cross-checked against the inventory.
  const markup = buildMarkupSection(input.timelines, kb, inventory);
  const containers = input.containers ? parseContainers(input.containers, { kb }) : undefined;
  const platform = platformOf(input.timelines);

  // One implementation class per party (§3), from everything above.
  const implementations = classifyImplementations(inventory, {
    site: input.site,
    markup: markup?.section,
    containers,
    platform,
    endpoints: firstPartyCollectEndpoints(input.timelines, containers),
    cnames,
    scripts: scriptIndex(input.timelines),
  });
  for (const p of inventory) p.implementation = implementations.get(p.partyId);

  // De-duplicate not-tested items (the same flow note repeats per scenario).
  const seen = new Set<string>();
  const notTested: NotTestedItem[] = [];
  for (const n of [...input.notTested, ...(markup?.notTested ?? []), ...ALWAYS_NOT_TESTED]) {
    const key = `${n.scope}|${n.location ?? ''}|${n.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    notTested.push(n);
  }

  // What the page told each vendor's consent API, per timeline (A3).
  const consentApi = input.timelines.map(summarizeConsentApi);
  const behaviorObservations = summarizeBehavior(input.timelines, kb);

  // The compatibility verdict per tool (B1), from everything above. Behavior
  // outranks implementation; missing inputs weaken verdicts, never strengthen.
  const compatibility = evaluateCompatibility({ inventory, locations, markup: markup?.section, containers, consentApi, platform, behaviorObservations, kb, startedAt: input.startedAt });

  return {
    schemaVersion: 1,
    runId: input.runId,
    property: input.property,
    site: input.site,
    versions: input.versions,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    locations,
    inventory,
    platform,
    behaviorObservations,
    ...(markup ? { markup: markup.section } : {}),
    ...(containers ? { containers } : {}),
    consentApi,
    compatibility,
    notTested,
    researchQueue,
    redacted: input.redacted,
  };
}

/** One platform fingerprint for the property: signals pooled across every scenario's page. */
export function platformOf(timelines: Timeline[]): TrackingEvaluation['platform'] {
  const pooled: PlatformSignals = { globals: [], assetUrls: [] };
  let any = false;
  for (const tl of timelines) {
    const s = tl.snapshot.platformSignals;
    if (!s) continue;
    any = true;
    for (const g of s.globals) if (!pooled.globals.includes(g)) pooled.globals.push(g);
    for (const u of s.assetUrls) if (!pooled.assetUrls.includes(u)) pooled.assetUrls.push(u);
    pooled.generator ??= s.generator;
    pooled.templateVersion ??= s.templateVersion;
  }
  return any ? classifyPlatform(pooled) : undefined;
}

/** The page a revoking choice was made on and when leaving it ends the grace (see inChoiceGrace). */
interface ChoiceWindow {
  t: number;
  pageIndex: number;
  /** The phase the choice starts ('after-withdraw' / 'after-reject'). */
  phase: string;
  /** When the page started going away: the tool's own reload request, or else the scanner's reload / navigation. */
  exitT?: number;
  /** When the next page committed: the first event on a later page (choice events excluded — they are stamped late). */
  commitT?: number;
  /** Page-exit sends after exitT count as grace (withdraw only; a reject's grace is the bounded window alone). */
  exitSends: boolean;
}

/**
 * Locate the page a choice was made on and its exit. The choice event's `t`
 * is the step's start, but its pageIndex is stamped after the step ended
 * (after the tool's own reload, when it reloads): the choice page is the page
 * of the last other event at or before `t` (#52).
 */
function choiceWindow(tl: Timeline, c: { t: number; pageIndex: number }, phase: string, exitSends: boolean): ChoiceWindow {
  let pageIndex = c.pageIndex;
  for (const e of tl.events) {
    if (!('t' in e) || e.type === 'choice' || typeof e.pageIndex !== 'number') continue;
    if (e.t > c.t) break;
    pageIndex = e.pageIndex;
  }
  const after = tl.events.filter((e) => 't' in e && e.t >= c.t && e.type !== 'choice' && typeof e.pageIndex === 'number');
  const reload = after.find((e) => e.type === 'request' && e.resourceType === 'document' && e.origin === 'page' && e.initiator?.type === 'script' && e.pageIndex === pageIndex);
  const scannerExit = after.find((e) => e.type === 'action' && (e.action === 'reload' || e.action === 'navigate') && e.pageIndex === pageIndex);
  const exit = reload ?? scannerExit;
  const commit = after.find((e) => (e.pageIndex as number) > pageIndex);
  return { t: c.t, pageIndex, phase, exitSends, ...(exit ? { exitT: exit.t } : {}), ...(commit ? { commitT: commit.t } : {}) };
}

/**
 * Is this request part of a revoking choice's grace (#52, #57)? Sent on the
 * page the choice was made on, before the next page committed, and either
 *  - within WITHDRAW_GRACE_MS of the choice step's start (data the vendor had
 *    queued, flushed as it is told), or
 *  - withdraw only: a page-exit send (sendBeacon / keepalive at pagehide)
 *    after the reload started — the page going away, not new activity.
 * Everything else counts, however long the reload takes. No commit observed:
 * the page-exit allowance ends WITHDRAW_GRACE_MS after the exit started (fail
 * closed). Data requests and loads alike; storage writes never get grace.
 */
function inChoiceGrace(r: Pick<PartyRequest, 't' | 'pageIndex' | 'phase' | 'origin'>, w: ChoiceWindow | undefined): boolean {
  if (!w || r.phase !== w.phase || r.pageIndex !== w.pageIndex || r.t < w.t) return false;
  if (w.commitT !== undefined && r.t >= w.commitT) return false;
  if (r.t - w.t <= WITHDRAW_GRACE_MS) return true;
  return w.exitSends && r.origin === 'exit-beacon' && w.exitT !== undefined && r.t >= w.exitT && (w.commitT !== undefined || r.t < w.exitT + WITHDRAW_GRACE_MS);
}

/** Per phase: the pages the journey was on and the steps it took (navigate, scroll, search). */
function journeyByPhase(tl: Timeline, a: TimelineAnalysis): Record<string, { pageIndexes: number[]; steps: string[] }> {
  const out: Record<string, { pageIndexes: Set<number>; steps: Set<string> }> = {};
  for (const e of tl.events) {
    if (!('t' in e) || typeof e.pageIndex !== 'number') continue;
    const ph = phaseAt(e.t, a.bannerShownT, a.choices);
    const j = (out[ph] ??= { pageIndexes: new Set(), steps: new Set() });
    if (e.type === 'request' && e.origin !== 'page') continue; // frames and workers say nothing about which page the visitor was on
    j.pageIndexes.add(e.pageIndex);
    if (e.type !== 'action') continue;
    if (e.action === 'navigate' || e.action === 'reload') j.steps.add('navigate');
    else if (e.action === 'scroll') j.steps.add('scroll');
    else if (e.action === 'type' && e.detail === 'search marker') j.steps.add('search');
  }
  return Object.fromEntries(Object.entries(out).map(([ph, j]) => [ph, { pageIndexes: [...j.pageIndexes].sort((x, y) => x - y), steps: [...j.steps].sort() }]));
}

/** Scenario facts only: no legal verdict and no inferred cookie-to-request association. */
export function summarizeBehavior(timelines: Timeline[], kb: KnowledgeBase = DEFAULT_KB): NonNullable<TrackingEvaluation['behaviorObservations']> {
  return timelines.map((tl) => {
    const a = analyzeTimeline(tl, kb);
    const w = a.choices.find((c) => c.choice === 'withdraw' && c.ok);
    const withdraw = w ? choiceWindow(tl, w, 'after-withdraw', true) : undefined;
    // #57: a reject that revokes a granted state (an opt-out regime's default, or
    // a returning visitor's change of mind) is a withdrawal for a vendor that was
    // already active: the same bounded grace, for that vendor only. A vendor that
    // was held until the choice (opt-in, nothing granted) has nothing to flush.
    const rj = a.choices.find((c) => c.choice === 'reject' && c.ok);
    const reject = rj ? choiceWindow(tl, rj, 'after-reject', false) : undefined;
    const keyFor = (p: { requests: PartyRequest[] }) => {
      // Active = it sent data before the choice (a script that only loaded has nothing queued to flush).
      const activeBefore = reject !== undefined && p.requests.some((r) => r.dataBearing && r.t < reject.t);
      return (r: PartyRequest): string => (inChoiceGrace(r, withdraw) ? WITHDRAW_GRACE_PHASE : activeBefore && inChoiceGrace(r, reject) ? REJECT_GRACE_PHASE : r.phase);
    };
    // A store's writes get the same grace as its requests: a write at the instant of the
    // choice (the vendor's handler racing the consent tool's) is the choice taking effect.
    const writePhasesOf = (p: { requests: PartyRequest[] }, st: TimelineAnalysis['parties'] extends Map<string, infer F> ? F extends { stores: Array<infer S> } ? S : never : never): string[] => {
      if (!st.writes?.length) return st.writePhases ?? (st.phase ? [st.phase] : []);
      const key = keyFor(p);
      return [...new Set(st.writes.map((w) => key({ t: w.t, pageIndex: w.pageIndex, phase: w.phase, origin: 'page' } as PartyRequest)))];
    };
    // A cookie that exists only on another company's domain (doubleclick.net's IDE,
    // facebook.com's fr) is one the site cannot remove: its mere presence is not the site's activity.
    const siteDomain = tl.snapshot.site.registrableDomain;
    const onlyThirdParty = (name: string): boolean => {
      const jar = tl.snapshot.cookies.filter((c) => c.name === name);
      return jar.length > 0 && jar.every((c) => registrableDomain(c.domain.replace(/^\./, '')) !== siteDomain);
    };
    const count = (p: { requests: PartyRequest[] }, keep: (r: PartyRequest) => boolean): Record<string, number> => {
      const key = keyFor(p);
      const rs = p.requests;
      const out: Record<string, number> = {};
      for (const r of rs) out[key(r)] = (out[key(r)] ?? 0) + (keep(r) ? 1 : 0);
      return out;
    };
    return {
      location: a.locationId,
      scenario: a.scenario,
      run: tl.snapshot.run,
      throttled: tl.snapshot.throttled,
      pages: tl.snapshot.pages.length,
      durationMs: tl.snapshot.durationMs,
      knownPartyIds: kb.entries.map((e) => e.id),
      journey: journeyByPhase(tl, a),
      parties: [...a.parties.values()].map((p) => ({
        partyId: p.partyId,
        dataRequests: p.requests.filter((r) => r.dataBearing).length,
        requestPhases: [...new Set(p.requests.filter((r) => r.dataBearing).map(keyFor(p)))],
        limitedRequestsByPhase: count(p, (r) => r.dataBearing && (allDenied(r.decoded) || adsRestricted(r.decoded))),
        dataRequestPhases: count(p, (r) => r.dataBearing),
        loadRequestsByPhase: count(p, (r) => !r.dataBearing),
        stores: p.stores.map((s) => ({
          name: s.name,
          kind: s.kind,
          writePhase: s.phase,
          writePhases: writePhasesOf(p, s),
          presentAtEnd: s.kind === 'cookie' ? tl.snapshot.cookies.some((c) => c.name === s.name) : tl.snapshot.storage.some((v) => v.key === s.name && v.area === s.kind),
          ...(s.kind === 'cookie' && onlyThirdParty(s.name) ? { thirdParty: true } : {}),
          attribution: s.setBy === 'known-name' ? ('known-name' as const) : ('observed' as const),
        })),
      })),
    };
  });
}
