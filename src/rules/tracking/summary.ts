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
} from '../../record/index.js';
import { DEFAULT_KB, entryStatus, type KnowledgeBase } from '../../registry/index.js';
import { analyzeTimeline } from './analyze.js';

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
}

/** Flows a browser cannot observe — always listed, never implied clean (§1). */
export const ALWAYS_NOT_TESTED: NotTestedItem[] = [
  { scope: 'flow', id: 'server-to-server', reason: 'data the site’s server sends to vendors directly (conversion APIs, server-side tagging) — a configuration checklist item, not a browser test' },
  { scope: 'flow', id: 'vendor-processing', reason: 'what vendors do with data after receiving it' },
  { scope: 'flow', id: 'contracts', reason: 'vendor contracts (whether a disclosure is a “sale”, processor terms)' },
  { scope: 'flow', id: 'consent-records', reason: 'whether consent records are stored correctly on the site’s backend' },
  { scope: 'page', id: 'unvisited', reason: 'pages and flows the journey did not visit (logged-in areas, checkout beyond the cart, forms that were not submitted)' },
];

export function buildTrackingEvaluation(input: EvaluationInput): TrackingEvaluation {
  const kb = input.kb ?? DEFAULT_KB;
  const inv = new Map<string, PartyInventoryItem>();
  const kindsOf = new Map<string, Set<string>>();
  for (const tl of input.timelines) {
    const a = analyzeTimeline(tl, kb);
    for (const f of a.parties.values()) {
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
      const sorted = [...f.requests].sort((x, y) => x.t - y.t);
      item.seenIn.push({
        location: a.locationId,
        scenario: a.scenario,
        requests: f.requests.length,
        firstMs: Math.round(sorted[0]?.t ?? 0),
        phases: [...new Set(f.requests.map((r) => r.phase))],
      });
    }
  }
  for (const [id, kinds] of kindsOf) inv.get(id)!.sends = [...kinds];

  const inventory = [...inv.values()].sort((a, b) => {
    const rank = (x: PartyInventoryItem): number => (x.behavesLikeTracker ? 0 : 1) + (x.recognized ? 0 : -0.5);
    return rank(a) - rank(b) || a.label.localeCompare(b.label);
  });

  const researchQueue = inventory
    .filter((p) => !p.recognized)
    .map((p) => ({
      partyId: p.partyId,
      domain: p.domain,
      reason: p.behavesLikeTracker ? `behaves like a tracker (${p.trackerSignals.join(', ')})` : p.stores.length ? 'stores data on the device' : 'seen; purpose unknown',
    }));

  const locations: LocationSummary[] = input.locations.map((l) => {
    const { proxy, ...spec } = l.spec;
    return { spec: { ...spec, proxied: Boolean(proxy) }, verification: l.verification, scenarios: l.scenarios };
  });

  // De-duplicate not-tested items (the same flow note repeats per scenario).
  const seen = new Set<string>();
  const notTested: NotTestedItem[] = [];
  for (const n of [...input.notTested, ...ALWAYS_NOT_TESTED]) {
    const key = `${n.scope}|${n.location ?? ''}|${n.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    notTested.push(n);
  }

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
    notTested,
    researchQueue,
    redacted: input.redacted,
  };
}
