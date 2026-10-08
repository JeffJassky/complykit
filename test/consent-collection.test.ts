import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COLLECTION_FILE,
  COLLECTION_KIND,
  COLLECTION_SCHEMA_VERSION,
  mergeCollections,
  mergeEvidence,
  readCollectionHandoff,
  writeCollectionHandoff,
  type ConsentCollectionHandoff,
} from '../src/consent-collection.js';
import { timelineArtifact } from '../src/record/index.js';

// PR 1 contract (plans/multi-region-contract.md §1b): the collect-only handoff,
// the pure merge, and the evidence merge. No browser. Timelines are hand-built
// stand-ins: the merge never looks inside them beyond location ids.

const SITE = { url: 'https://shop.example/', host: 'shop.example', registrableDomain: 'shop.example' };

function tl(locationId: string, scenario = 'do-nothing'): never {
  return {
    location: { id: locationId },
    verification: { verdict: 'verified', expected: {}, observed: {}, sources: [], siteReported: [], jurisdictions: [], checkedAt: 'x' },
    events: [],
    snapshot: { site: SITE, scenario, locationId, startedAt: 'x', durationMs: 1, gpc: false, browser: { name: 'chromium' }, pages: [], cookies: [], storage: [], frames: [], dns: [], notTested: [], evidence: { timeline: `evidence/tracking/${locationId}/${scenario}/timeline.json` } },
  } as never;
}

function handoff(locationId: string, over: Partial<ConsentCollectionHandoff> & { startedAt?: string; finishedAt?: string; site?: typeof SITE; containers?: unknown[]; notTested?: unknown[]; autoconsentVersion?: string } = {}): ConsentCollectionHandoff {
  const { startedAt, finishedAt, site, containers, notTested, autoconsentVersion, ...top } = over;
  return {
    kind: COLLECTION_KIND,
    schemaVersion: COLLECTION_SCHEMA_VERSION,
    packageVersion: '1.2.3',
    property: 'shop',
    targetUrl: 'https://shop.example/',
    runId: `run-${locationId}`,
    collection: {
      timelines: [tl(locationId), tl(locationId, 'reject')],
      locations: [{ spec: { id: locationId }, verification: { verdict: 'verified' }, scenarios: [] }] as never,
      notTested: (notTested ?? []) as never,
      site: site ?? SITE,
      ...(autoconsentVersion ? { autoconsentVersion } : {}),
      containers: (containers ?? []) as never,
      startedAt: startedAt ?? '2026-10-08T10:00:00.000Z',
      finishedAt: finishedAt ?? '2026-10-08T10:05:00.000Z',
    },
    ...top,
  };
}

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'ck-collection-'));

describe('collection handoff file', () => {
  it('round-trips through the run dir', () => {
    const dir = tmp();
    const h = handoff('de');
    const file = writeCollectionHandoff(dir, h);
    expect(file).toBe(path.join(dir, COLLECTION_FILE));
    expect(readCollectionHandoff(dir)).toEqual(h);
  });

  it('refuses a missing file, a foreign file, and another schema version', () => {
    const dir = tmp();
    expect(() => readCollectionHandoff(dir)).toThrow(/no collection\.json/);
    fs.writeFileSync(path.join(dir, COLLECTION_FILE), JSON.stringify({ kind: 'something-else' }));
    expect(() => readCollectionHandoff(dir)).toThrow(/not a complykit consent collection/);
    fs.writeFileSync(path.join(dir, COLLECTION_FILE), '[]');
    expect(() => readCollectionHandoff(dir)).toThrow(/not a complykit consent collection/);
    fs.writeFileSync(path.join(dir, COLLECTION_FILE), JSON.stringify({ ...handoff('de'), schemaVersion: 99 }));
    expect(() => readCollectionHandoff(dir)).toThrow(/schema version/);
  });
});

describe('mergeCollections', () => {
  it('concatenates locations and timelines in input order and rebuilds the artifacts', () => {
    const m = mergeCollections([handoff('de'), handoff('us-tx')]);
    expect(m.locations.map((l) => l.spec.id)).toEqual(['de', 'us-tx']);
    expect(m.timelines.map((t) => `${t.location.id}/${t.snapshot.scenario}`)).toEqual(['de/do-nothing', 'de/reject', 'us-tx/do-nothing', 'us-tx/reject']);
    expect(m.artifacts).toHaveLength(4);
    expect(m.artifacts[2]).toEqual(timelineArtifact(m.timelines[2], 'shop', SITE.url, m.finishedAt));
    expect(m.site).toEqual(SITE);
  });

  it('takes the earliest start, the latest finish, the first autoconsent version', () => {
    const m = mergeCollections([
      handoff('de', { startedAt: '2026-10-08T10:02:00.000Z', finishedAt: '2026-10-08T10:09:00.000Z' }),
      handoff('uk', { startedAt: '2026-10-08T10:00:30.000Z', finishedAt: '2026-10-08T10:04:00.000Z', autoconsentVersion: '14.1.0' }),
      handoff('us-tx', { autoconsentVersion: '9.9.9' }),
    ]);
    expect(m.startedAt).toBe('2026-10-08T10:00:30.000Z');
    expect(m.finishedAt).toBe('2026-10-08T10:09:00.000Z');
    expect(m.autoconsentVersion).toBe('14.1.0');
  });

  it('keeps one of each not-tested item and one of each container (first wins)', () => {
    const shared = { scope: 'flow', id: 'login', reason: 'not attempted' };
    const m = mergeCollections([
      handoff('de', { notTested: [shared, { scope: 'location', id: 'de', location: 'de', reason: 'a' }], containers: [{ id: 'GTM-1', from: 'de' }] }),
      handoff('uk', { notTested: [{ ...shared, reason: 'other words' }, { scope: 'location', id: 'uk', location: 'uk', reason: 'b' }], containers: [{ id: 'GTM-1', from: 'uk' }, { id: 'GTM-2', from: 'uk' }] }),
    ]);
    expect(m.notTested).toEqual([shared, { scope: 'location', id: 'de', location: 'de', reason: 'a' }, { scope: 'location', id: 'uk', location: 'uk', reason: 'b' }]);
    expect(m.containers).toEqual([{ id: 'GTM-1', from: 'de' }, { id: 'GTM-2', from: 'uk' }]);
  });

  it('refuses what cannot be one report', () => {
    expect(() => mergeCollections([])).toThrow(/nothing to merge/);
    expect(() => mergeCollections([handoff('de'), handoff('uk', { packageVersion: '1.2.4' })])).toThrow(/version skew.*1\.2\.3.*1\.2\.4|version skew.*1\.2\.4.*1\.2\.3/);
    expect(() => mergeCollections([handoff('de'), handoff('uk', { site: { ...SITE, registrableDomain: 'other.example' } })])).toThrow(/different sites/);
    expect(() => mergeCollections([handoff('de'), handoff('uk', { property: 'blog' })])).toThrow(/different properties/);
    expect(() => mergeCollections([handoff('de'), handoff('de')])).toThrow(/collected twice.*de/);
  });

  it('does not mutate its inputs', () => {
    const a = handoff('de');
    const b = handoff('uk');
    const before = JSON.stringify([a, b]);
    mergeCollections([a, b]);
    expect(JSON.stringify([a, b])).toBe(before);
  });
});

describe('mergeEvidence', () => {
  it('copies evidence trees, first source wins, never the handoff file', () => {
    const a = tmp();
    const b = tmp();
    const dest = tmp();
    const put = (root: string, rel: string, body: string): void => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), body);
    };
    put(a, 'evidence/tracking/de/do-nothing/timeline.json', 'de');
    put(a, 'evidence/tracking/containers/GTM-1.js', 'from-de');
    put(a, COLLECTION_FILE, 'raw');
    put(a, 'findings.jsonl', 'nope');
    put(b, 'evidence/tracking/uk/do-nothing/timeline.json', 'uk');
    put(b, 'evidence/tracking/containers/GTM-1.js', 'from-uk');
    const r = mergeEvidence([a, b, tmp() /* no evidence/ at all */], dest);
    expect(r).toEqual({ copied: 3, skipped: 1 });
    expect(fs.readFileSync(path.join(dest, 'evidence/tracking/de/do-nothing/timeline.json'), 'utf8')).toBe('de');
    expect(fs.readFileSync(path.join(dest, 'evidence/tracking/uk/do-nothing/timeline.json'), 'utf8')).toBe('uk');
    expect(fs.readFileSync(path.join(dest, 'evidence/tracking/containers/GTM-1.js'), 'utf8')).toBe('from-de');
    expect(fs.existsSync(path.join(dest, COLLECTION_FILE))).toBe(false);
    expect(fs.existsSync(path.join(dest, 'findings.jsonl'))).toBe(false);
    expect(fs.readFileSync(path.join(a, COLLECTION_FILE), 'utf8')).toBe('raw'); // sources untouched
  });
});
