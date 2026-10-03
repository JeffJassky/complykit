import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { TrackingEvaluation, writeTrackingEvaluation } from '../src/record/index.js';
import { buildKnowledgeBase, lookupEntry, KB_ENTRIES } from '../src/registry/index.js';
import { driftFrom } from '../src/rules/tracking/summary.js';
import { KbStore, mergeEvaluation, rankQueue, researchItem, researchBrief, researchPacket, ingestEvaluation, type ResearchFn } from '../src/research/index.js';
import { cmdKb } from '../src/cli/commands/kb.js';

// M9 (plans/consent-design.md §4.2): an unknown party goes
// scan → queue → proposal (cited) → a person confirms → recognized next scan.

function evaluationFor(site: string, parties: Array<{ domain: string; recognized?: boolean; partyId?: string; stores?: string[]; requests?: number }>, kind: 'unrecognized' | 'drift' = 'unrecognized') {
  return TrackingEvaluation.parse({
    runId: `r-${site}`,
    property: site,
    site: { url: `https://${site}/`, host: site, registrableDomain: site },
    versions: { kb: '0.1.1', registry: '0.2.0', package: '0.0.0' },
    startedAt: '2026-10-03T10:00:00Z',
    finishedAt: '2026-10-03T10:05:00Z',
    locations: [],
    inventory: parties.map((p) => ({
      partyId: p.partyId ?? `unknown:${p.domain}`,
      label: p.domain,
      domain: p.domain,
      hosts: [`px.${p.domain}`],
      recognized: p.recognized ?? false,
      kbStatus: p.recognized ? 'proposed' : 'unrecognized',
      categories: [],
      behavesLikeTracker: true,
      trackerSignals: ['sets an identifier cookie'],
      sends: ['page-address', 'browser-id'],
      stores: (p.stores ?? ['_px_id']).map((name) => ({ name, kind: 'cookie', lifetimeDays: 365 })),
      sources: ['injected'],
      loadedBy: [`https://cdn.${p.domain}/tag.js`],
      samples: [`px.${p.domain}/collect?ev&uid`],
      seenIn: [{ location: 'local', scenario: 'do-nothing', requests: p.requests ?? 3, firstMs: 500, phases: ['before-choice'] }],
    })),
    notTested: [],
    researchQueue: parties.map((p) => ({ partyId: p.partyId ?? `unknown:${p.domain}`, domain: p.domain, reason: 'behaves like a tracker', kind })),
    redacted: true,
  });
}

const GOOD_PROPOSAL = {
  entry: {
    id: 'pixelco.tag',
    vendor: 'PixelCo tag',
    owner: 'PixelCo, Inc.',
    match: { hosts: ['pixelco.io'] },
    categories: ['advertising'],
    sends: ['page-address', 'browser-id'],
    stores: [{ name: '^_px_id$', kind: 'cookie', lifetimeDays: 365 }],
    consentApi: 'none — must be held back',
  },
  sources: ['https://pixelco.io/docs/tag', 'https://pixelco.io/privacy'],
  rationale: 'PixelCo documents the tag as a retargeting pixel (docs/tag); it sets a 1-year id cookie, as observed.',
  confidence: 'high',
  disagreements: [],
};

let dir: string;
let store: KbStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-kb-'));
  store = new KbStore(dir);
});

describe('research queue', () => {
  it('aggregates one domain across sites and ranks widespread vendors first', () => {
    let q = mergeEvaluation([], evaluationFor('a.example', [{ domain: 'pixelco.io' }, { domain: 'rare.io' }]), 't1').queue;
    q = mergeEvaluation(q, evaluationFor('b.example', [{ domain: 'pixelco.io' }]), 't2').queue;
    const ranked = rankQueue(q);
    expect(ranked.map((x) => x.domain)).toEqual(['pixelco.io', 'rare.io']);
    expect(ranked[0]).toMatchObject({ sites: ['a.example', 'b.example'], runs: 2, requests: 6, firstSeen: 't1', lastSeen: 't2', samples: ['px.pixelco.io/collect?ev&uid'] });
  });

  it("skips the site's own domain", () => {
    const q = mergeEvaluation([], evaluationFor('a.example', [{ domain: 'a.example' }]), 't').queue;
    expect(q).toEqual([]);
  });

  it('flags drift where the entry makes a claim, and only there', () => {
    const ga = KB_ENTRIES.find((e) => e.id === 'google.analytics')!;
    expect(driftFrom(ga, { stores: [{ name: '_ga', kind: 'cookie', lifetimeDays: 400 }], sends: ['page-address'] })).toEqual([]);
    expect(driftFrom(ga, { stores: [{ name: '_ga', kind: 'cookie', lifetimeDays: 400 }, { name: 'ga_secret', kind: 'local', lifetimeDays: null }], sends: ['hashed-email'] })).toEqual([
      'stores ga_secret not in the entry',
      'sends hashed-email not in the entry',
    ]);
    const noClaims = { ...ga, stores: [], sends: [] };
    expect(driftFrom(noClaims, { stores: [{ name: 'x', kind: 'cookie', lifetimeDays: 1 }], sends: ['hashed-email'] })).toEqual([]);
  });
});

describe('the loop: scan → proposal → confirmation → recognized', () => {
  it('recognizes a confirmed proposal on the next scan, and resolves its queue item', () => {
    const ev = evaluationFor('a.example', [{ domain: 'pixelco.io' }]);
    ingestEvaluation(store, ev, buildKnowledgeBase({ extra: store.confirmedEntries() }));
    expect(store.queue()[0]).toMatchObject({ domain: 'pixelco.io', status: 'open' });

    // Unknown before.
    expect(lookupEntry(buildKnowledgeBase({ extra: store.confirmedEntries() }), 'px.pixelco.io')).toBeUndefined();

    const p = store.propose('pixelco.io', GOOD_PROPOSAL, 'agent:test-model');
    expect(p).toMatchObject({ id: 'p-pixelco.io-1', status: 'proposed' });
    expect(store.queue()[0]).toMatchObject({ status: 'proposed', proposalId: p.id });
    // A proposal alone is not recognition.
    expect(lookupEntry(buildKnowledgeBase({ extra: store.confirmedEntries() }), 'px.pixelco.io')).toBeUndefined();

    const entry = store.confirm(p.id, 'jeff');
    expect(entry.provenance).toMatchObject({ proposedBy: 'agent:test-model', confirmedBy: 'jeff', sources: GOOD_PROPOSAL.sources });

    const kb = buildKnowledgeBase({ extra: store.confirmedEntries() });
    expect(lookupEntry(kb, 'px.pixelco.io')?.id).toBe('pixelco.tag');
    expect(store.queue()[0].status).toBe('resolved');

    // The next scan of another site: still resolved, not re-queued as open.
    const again = mergeEvaluation(store.queue(), evaluationFor('b.example', []), 't3', kb);
    expect(again.queue[0].status).toBe('resolved');
  });

  it('marks open items resolved when the scan KB already recognizes them', () => {
    store.saveQueue(mergeEvaluation([], evaluationFor('a.example', [{ domain: 'pixelco.io' }]), 't1').queue);
    const kb = buildKnowledgeBase({ extra: [{ ...GOOD_PROPOSAL.entry, provenance: { proposedBy: 'x', proposedAt: 't', confirmedBy: 'jeff', sources: [] } }] as never });
    const res = mergeEvaluation(store.queue(), evaluationFor('b.example', []), 't2', kb);
    expect(res.resolved).toEqual(['unrecognized|pixelco.io']);
  });

  it('refuses an uncited proposal and an agent confirming', () => {
    expect(() => store.propose('pixelco.io', { ...GOOD_PROPOSAL, sources: [] }, 'agent:x')).toThrow(/sources/);
    const p = store.propose('pixelco.io', GOOD_PROPOSAL, 'agent:x');
    expect(() => store.confirm(p.id, 'agent:x')).toThrow(/agents never confirm/);
    expect(() => store.confirm(p.id, '')).toThrow(/reviewer/);
  });

  it('applies corrections on confirm', () => {
    const p = store.propose('pixelco.io', GOOD_PROPOSAL, 'agent:x');
    const e = store.confirm(p.id, 'jeff', { categories: ['advertising', 'identity-resolution'] });
    expect(e.categories).toEqual(['advertising', 'identity-resolution']);
    expect(store.proposals()[0].reviewNote).toMatch(/categories/);
  });

  it('a rejection reopens the item and the next brief carries it', () => {
    store.saveQueue(mergeEvaluation([], evaluationFor('a.example', [{ domain: 'pixelco.io' }]), 't1').queue);
    const p = store.propose('pixelco.io', GOOD_PROPOSAL, 'agent:x');
    store.reject(p.id, 'jeff', 'it is a chat widget, not ads');
    const item = store.queue()[0];
    expect(item.status).toBe('open');
    expect(researchBrief(item, store.proposals())).toMatch(/rejected by jeff: it is a chat widget, not ads/);
  });

  it('confirming a seed entry by id replaces the seed (with corrections)', () => {
    const e = store.confirm('google.analytics', 'jeff', { notes: 'checked against GA4 docs' });
    expect(e.provenance).toMatchObject({ proposedBy: 'complykit-seed', confirmedBy: 'jeff' });
    const kb = buildKnowledgeBase({ extra: store.confirmedEntries() });
    expect(kb.entries.filter((x) => x.id === 'google.analytics')).toHaveLength(1);
    expect(lookupEntry(kb, 'www.google-analytics.com')?.provenance.confirmedBy).toBe('jeff');
  });

  it('dismiss takes a domain off the queue; a dismissed item stays dismissed', () => {
    store.saveQueue(mergeEvaluation([], evaluationFor('a.example', [{ domain: 'pixelco.io' }]), 't1').queue);
    store.dismiss('pixelco.io', "the site's image CDN");
    const q = mergeEvaluation(store.queue(), evaluationFor('b.example', [{ domain: 'pixelco.io' }]), 't2').queue;
    expect(q[0]).toMatchObject({ status: 'dismissed', sites: ['a.example', 'b.example'] });
  });
});

describe('researching', () => {
  it('retries once with the validation error in the brief, then records the proposal as the agent', async () => {
    store.saveQueue(mergeEvaluation([], evaluationFor('a.example', [{ domain: 'pixelco.io' }]), 't1').queue);
    const briefs: string[] = [];
    const research: ResearchFn = async ({ brief }) => {
      briefs.push(brief);
      return { body: briefs.length === 1 ? { ...GOOD_PROPOSAL, sources: [] } : GOOD_PROPOSAL, model: 'm1', searches: 2 };
    };
    const { proposal, searches } = await researchItem(store, store.queue()[0], research);
    expect(proposal.proposedBy).toBe('agent:m1');
    expect(searches).toBe(4);
    expect(briefs[1]).toMatch(/rejected by validation: .*sources/);
  });

  it('the packet carries the observations and the result schema', () => {
    const item = mergeEvaluation([], evaluationFor('a.example', [{ domain: 'pixelco.io' }]), 't1').queue[0];
    const packet = researchPacket(item);
    expect(packet).toContain('px.pixelco.io/collect?ev&uid');
    expect(packet).toContain('_px_id (cookie, 365d)');
    expect(packet).toContain('kb propose');
    expect(packet).toContain('"rationale"');
  });
});

describe('complykit kb (CLI)', () => {
  it('ingest → propose --file → confirm → entries', async () => {
    const runDir = path.join(dir, 'run');
    writeTrackingEvaluation(runDir, evaluationFor('a.example', [{ domain: 'pixelco.io' }]));
    const proposalFile = path.join(dir, 'p.json');
    fs.writeFileSync(proposalFile, JSON.stringify(GOOD_PROPOSAL));
    const write = process.stdout.write.bind(process.stdout);
    const lines: string[] = [];
    process.stdout.write = ((s: string) => (lines.push(String(s)), true)) as typeof process.stdout.write;
    try {
      expect(await cmdKb(['ingest', runDir, '--dir', dir])).toBe(0);
      expect(await cmdKb(['queue', '--dir', dir])).toBe(0);
      expect(await cmdKb(['propose', 'pixelco.io', '--file', proposalFile, '--by', 'agent:claude', '--dir', dir])).toBe(0);
      expect(await cmdKb(['confirm', 'p-pixelco.io-1', '--by', 'jeff', '--dir', dir])).toBe(0);
      expect(await cmdKb(['entries', '--dir', dir])).toBe(0);
      expect(await cmdKb(['confirm', 'p-pixelco.io-1', '--by', 'jeff', '--category', 'nonsense', '--dir', dir])).toBe(2);
    } finally {
      process.stdout.write = write;
    }
    const text = lines.join('');
    expect(text).toMatch(/queue: 1 new/);
    expect(text).toMatch(/pixelco\.io/);
    expect(text).toMatch(/confirmed pixelco\.tag/);
    expect(new KbStore(dir).entries().map((e) => e.id)).toEqual(['pixelco.tag']);
  });
});
