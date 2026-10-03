import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runConsentScan, type ConsentScanResult } from '../src/pipeline.js';
import { asRunId, type Finding, type LocationSpec } from '../src/record/index.js';
import { buildKnowledgeBase, getRequirement } from '../src/registry/index.js';
import { startTrackingSite, type TrackingSite } from './fixtures/tracking-site.js';

// M8 "done when" (fixture half): the fixture storefront from verified German
// and Californian locations → findings under each location's rules, an
// inventory with the unrecognized widget, and a research queue. Geolocation is
// stubbed to answer with the location's own expected place.

let chromiumAvailable = false;
try {
  const { chromium } = await import('playwright');
  chromiumAvailable = fs.existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}
const suite = chromiumAvailable ? describe : describe.skip;

const STUB = [
  { name: 'stub-a', lookup: async (_f: unknown, spec: LocationSpec) => ({ ip: '198.51.100.1', country: spec.country, region: spec.region }) },
  { name: 'stub-b', lookup: async (_f: unknown, spec: LocationSpec) => ({ ip: '198.51.100.1', country: spec.country, region: spec.region }) },
];

suite('consent evaluation pipeline (fixture storefront, DE + US-CA)', () => {
  let site: TrackingSite;
  let cwd: string;
  let res: ConsentScanResult;
  const by = (rule: string, landmark?: string): Finding[] =>
    res.findings.filter((f) => String(f.ruleId) === rule && (!landmark || f.subject.locator?.landmark === landmark));
  const party = (f: Finding): string => f.subject.locator?.name ?? '';

  beforeAll(async () => {
    site = await startTrackingSite();
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'complykit-consent-pipe-'));
    res = await runConsentScan({
      runId: asRunId('pipe'),
      property: 'fixture',
      targetUrl: site.url,
      cwd,
      packageVersion: '0.0.0-test',
      locations: [
        { id: 'de', country: 'DE', scenarios: ['browse', 'reject', 'accept', 'withdraw'] },
        { id: 'us-ca', country: 'US', region: 'CA', scenarios: ['gpc', 'markers', 'opt-out-link', 'opt-out-all'] },
        { id: 'fr', country: 'FR' },
      ],
      journey: { dwellMs: 1500, pageDwellMs: 600, scrollSteps: 1, maxPages: 1 },
      bannerWaitMs: 1500,
      geoSources: [
        STUB[0],
        // The French exit is "really" in Belgium: a mismatch, so no findings for fr.
        { name: 'stub-b', lookup: async (_f: unknown, spec: LocationSpec) => ({ ip: '198.51.100.1', country: spec.id === 'fr' ? 'BE' : spec.country, region: spec.region }) },
      ],
      launchArgs: site.launchArgs,
      knowledgeBase: buildKnowledgeBase({
        extra: [
          {
            id: 'fixture.ads',
            vendor: 'Fixture Ads',
            match: { hosts: ['adpixel.test'] },
            categories: ['advertising'],
            decoder: 'meta',
            provenance: { proposedBy: 'test', proposedAt: '2026-10-02', confirmedBy: 'test', confirmedAt: '2026-10-02', sources: [] },
          },
        ],
      }),
      trace: process.env.CK_TRACE ? (l) => console.log(l) : undefined,
    });
    if (process.env.CK_TRACE) for (const f of res.findings) console.log(String(f.ruleId), f.subject.locator?.landmark, party(f), f.confidence, '—', f.message);
  }, 300000);

  afterAll(async () => {
    await site?.close();
    if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('attributes findings only to verified locations — the mismatched exit is not tested', () => {
    const fr = res.evaluation.locations.find((l) => l.spec.id === 'fr')!;
    expect(fr.verification.verdict).toBe('unknown');
    expect(fr.scenarios).toEqual([]);
    expect(res.evaluation.notTested.some((n) => n.scope === 'location' && n.id === 'fr')).toBe(true);
    for (const f of res.findings) expect(['eu', 'us-ca', 'any']).toContain(f.subject.locator?.landmark);
  });

  it('EU: a recognized ad pixel in markup before any choice is a violation, flagged as a markup leak', () => {
    const ads = by('tracking.prior-consent', 'eu').find((f) => party(f) === 'fixture.ads');
    expect(ads?.confidence).toBe('violation');
    expect(String(ads?.requirementId)).toBe('eprivacy.art5.3');
    const d = ads?.details as { source: string; occurrences: Array<{ phases: string[] }> };
    expect(d.source).toBe('markup-leak');
    expect(d.occurrences.flatMap((o) => o.phases)).toContain('before-banner');
    expect(d.occurrences.flatMap((o) => o.phases)).toContain('after-reject');
  });

  it('EU: the unrecognized widget is needs-review, injected by the tag manager, and never the gated script', () => {
    const w = by('tracking.prior-consent', 'eu').find((f) => party(f) === 'unknown:widget.test');
    expect(w?.confidence).toBe('needs-review');
    const d = w?.details as { source: string; loadedBy: string[]; trackerSignals: string[] };
    expect(d.source).toBe('injected');
    expect(d.loadedBy[0]).toMatch(/cdn\.tagmgr\.test:\d+\/tm\.js/);
    expect(d.trackerSignals).toEqual(expect.arrayContaining(['stores-long-lived-id', 'sends-stored-id', 'sends-page-address']));
    expect(by('tracking.prior-consent').some((f) => party(f) === 'unknown:consented.test')).toBe(false);
  });

  it('EU: no way to reopen consent settings → withdrawal needs review', () => {
    const w = by('tracking.withdrawal', 'eu');
    expect(w.some((f) => f.subject.locator?.name === 'no-entry-point')).toBe(true);
  });

  it('CA: GPC ignored by a tracker-like party; no "opt-out honored" display', () => {
    const sig = by('tracking.opt-out-signal', 'us-ca');
    expect(sig.some((f) => party(f) === 'unknown:widget.test' && f.confidence === 'needs-review')).toBe(true);
    // The fixture's ad pixel honors GPC — so it must NOT appear.
    expect(sig.some((f) => party(f) === 'fixture.ads')).toBe(false);
    expect(by('tracking.opt-out-display', 'us-ca').length).toBe(1);
  });

  it('CA: typed (unsubmitted) email reaching a third party is wiretap exposure, labelled as such', () => {
    const w = by('tracking.wiretap-exposure', 'us-ca').find((f) => party(f) === 'unknown:capture.test');
    expect(w).toBeDefined();
    expect(String(w!.requirementId)).toBe('cipa.631');
    expect(getRequirement(String(w!.requirementId))?.kind).toBe('exposure');
    expect(w!.confidence).toBe('needs-review');
  });

  it('builds an inventory and a research queue', () => {
    const inv = res.evaluation.inventory;
    const widget = inv.find((p) => p.partyId === 'unknown:widget.test')!;
    expect(widget.behavesLikeTracker).toBe(true);
    expect(widget.recognized).toBe(false);
    expect(widget.stores.some((s) => s.name === '_uw' && (s.lifetimeDays ?? 0) >= 399)).toBe(true);
    expect(inv.find((p) => p.partyId === 'fixture.ads')?.kbStatus).toBe('confirmed');
    expect(res.evaluation.researchQueue.some((q) => q.domain === 'widget.test')).toBe(true);
    expect(res.evaluation.notTested.some((n) => n.id === 'server-to-server')).toBe(true);
  });

  it('fingerprints one finding per party per jurisdiction', () => {
    const fps = res.findings.map((f) => f.fingerprint);
    expect(new Set(fps).size).toBe(fps.length);
  });
});
