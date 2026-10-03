import type { TrackingEvaluation } from '../record/index.js';
import { lookupEntry, type KnowledgeBase } from '../registry/index.js';
import type { QueueItem } from './schema.js';

// Folding scan results into the research queue. Pure: (queue, evaluation) →
// queue. One item per registrable domain; seeing it on another site, or in
// another run, adds evidence rather than a new item.

const CAP = { sites: 50, hosts: 20, samples: 12, loadedBy: 8, stores: 30 };

function addAll<T>(into: T[], from: readonly T[], cap: number, same: (a: T, b: T) => boolean = (a, b) => a === b): void {
  for (const x of from) {
    if (into.length >= cap) return;
    if (!into.some((y) => same(x, y))) into.push(x);
  }
}

export interface MergeResult {
  queue: QueueItem[];
  added: string[];
  updated: string[];
  /** Items that the scan's KB now recognizes (confirmed since queued). */
  resolved: string[];
}

/** Merge one evaluation into the queue. `kb` is the knowledge base the scan used;
 *  open items it now recognizes are marked resolved. */
export function mergeEvaluation(queue: readonly QueueItem[], ev: TrackingEvaluation, at: string, kb?: KnowledgeBase): MergeResult {
  const out = queue.map((q) => structuredClone(q));
  const byKey = new Map(out.map((q) => [`${q.kind}|${q.domain}`, q]));
  const added: string[] = [];
  const updated: string[] = [];
  const resolved: string[] = [];
  const site = ev.site.host;

  for (const r of ev.researchQueue) {
    const kind = r.kind ?? 'unrecognized';
    const party = ev.inventory.find((p) => p.partyId === r.partyId);
    if (!party) continue;
    // The site's own domain is not an outside party to research.
    if (party.domain === ev.site.registrableDomain) continue;
    const key = `${kind}|${party.domain}`;
    let item = byKey.get(key);
    if (!item) {
      item = {
        domain: party.domain,
        kind,
        status: 'open',
        reason: r.reason,
        entryId: kind === 'drift' ? party.partyId : undefined,
        firstSeen: at,
        lastSeen: at,
        sites: [],
        runs: 0,
        requests: 0,
        hosts: [],
        behavesLikeTracker: false,
        trackerSignals: [],
        sends: [],
        stores: [],
        sources: [],
        loadedBy: [],
        samples: [],
        phases: [],
      };
      out.push(item);
      byKey.set(key, item);
      added.push(key);
    } else {
      updated.push(key);
      // A dismissed item stays dismissed; a resolved one that shows up as
      // unrecognized again (entry removed, or the vendor moved) reopens.
      if (item.status === 'resolved') item.status = 'open';
    }
    item.reason = r.reason;
    item.lastSeen = at;
    item.runs += 1;
    item.requests += party.seenIn.reduce((n, s) => n + s.requests, 0);
    addAll(item.sites, [site], CAP.sites);
    addAll(item.hosts, party.hosts, CAP.hosts);
    item.behavesLikeTracker = item.behavesLikeTracker || party.behavesLikeTracker;
    addAll(item.trackerSignals, party.trackerSignals, 20);
    addAll(item.sends, party.sends, 30);
    addAll(item.stores, party.stores, CAP.stores, (a, b) => a.name === b.name && a.kind === b.kind);
    addAll(item.sources, party.sources, 10);
    addAll(item.loadedBy, party.loadedBy, CAP.loadedBy);
    addAll(item.samples, party.samples ?? [], CAP.samples);
    addAll(item.phases, party.seenIn.flatMap((s) => s.phases), 10);
  }

  if (kb) {
    for (const q of out) {
      if (q.kind !== 'unrecognized' || (q.status !== 'open' && q.status !== 'proposed')) continue;
      if (q.hosts.some((h) => lookupEntry(kb, h, '/')) || lookupEntry(kb, q.domain, '/')) {
        q.status = 'resolved';
        resolved.push(`${q.kind}|${q.domain}`);
      }
    }
  }
  return { queue: out, added, updated, resolved };
}

/** Research order: open first, then by how many sites, then trackers, then volume. */
export function rankQueue(queue: readonly QueueItem[]): QueueItem[] {
  const statusRank: Record<QueueItem['status'], number> = { open: 0, proposed: 1, resolved: 2, dismissed: 3 };
  return [...queue].sort(
    (a, b) =>
      statusRank[a.status] - statusRank[b.status] ||
      b.sites.length - a.sites.length ||
      Number(b.behavesLikeTracker) - Number(a.behavesLikeTracker) ||
      b.requests - a.requests ||
      a.domain.localeCompare(b.domain),
  );
}
