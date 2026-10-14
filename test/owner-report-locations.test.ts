import { describe, expect, it } from 'vitest';
import { buildConsentReportModel } from '../src/report/consent-model.js';
import { buildOwnerReport } from '../src/report/owner-report.js';
import { TrackingEvaluation } from '../src/record/index.js';
import type { OwnerReport as ServiceOwnerReport } from '../service/src/shared/api.js';

// plans/per-law-report-contract.md, PR A2: the owner report carries one summary per
// location (its visits and the banner its own visits saw), so a page can show each
// law's scan on its own. The report-wide fields keep their meaning.

const site = { url: 'https://shop.example/', host: 'shop.example', registrableDomain: 'shop.example' };
const meta = { partyId: 'meta.pixel', label: 'Meta Pixel', domain: 'facebook.com', hosts: ['facebook.com'], recognized: true, kbStatus: 'proposed', categories: ['advertising'], behavesLikeTracker: true, trackerSignals: [], sends: [], stores: [], sources: ['injected'], loadedBy: [], seenIn: [] };
const de = { spec: { id: 'de', label: 'Germany', country: 'DE', proxied: false }, verification: { verdict: 'verified', expected: { country: 'DE' }, observed: { country: 'DE' }, sources: [], jurisdictions: ['eu'], checkedAt: 'now' } };

const withBanner = (scenario: string) => ({ scenario, status: 'tested', banner: { found: true, cmp: 'onetrust' }, ...(scenario === 'reject' ? { choice: { kind: 'reject', ok: true, method: 'button' } } : {}) });
const noBanner = (scenario: string) => ({ scenario, status: 'tested', banner: { found: false } });

function model(scenarios: object[]) {
  const ev = TrackingEvaluation.parse({
    runId: 'r1', property: 'shop', site, startedAt: '2026-10-07T10:00:00Z', finishedAt: '2026-10-07T10:05:00Z', versions: { kb: '0', registry: '0', package: '0' },
    locations: [{ ...de, scenarios }], inventory: [meta], notTested: [], researchQueue: [], redacted: true, behaviorObservations: [],
  });
  return buildConsentReportModel(ev, []);
}

const plan = [
  { location: 'de', scenario: 'do-nothing' },
  { location: 'de', scenario: 'reject' },
  { location: 'de', scenario: 'accept' },
  { location: 'us-ca', scenario: 'do-nothing' },
  { location: 'us-ca', scenario: 'gpc', runs: 2 },
];
const announced = [
  { id: 'de', label: 'Germany', verdict: 'verified', observed: 'DE' },
  { id: 'us-ca', label: 'California, US', verdict: 'verified', observed: 'US-CA' },
];
const base = { runId: 'r1', site, startedAt: '2026-10-07T10:00:00Z' };

describe('owner report: per-location summaries', () => {
  it('two locations: each gets its own visits and the banner its own visits saw, in plan order', () => {
    const m = model([withBanner('do-nothing'), withBanner('reject'), noBanner('accept')]);
    const r = buildOwnerReport({
      ...base, stage: 'live', model: m, plan, locations: announced,
      done: [{ location: 'de', scenario: 'do-nothing' }, { location: 'de', scenario: 'reject' }, { location: 'de', scenario: 'accept' }],
      current: { location: 'us-ca', scenario: 'do-nothing' },
    });
    expect(r.locations?.map((l) => l.id)).toEqual(['de', 'us-ca']);
    const [g, c] = r.locations!;
    expect(g).toMatchObject({ id: 'de', label: 'Germany', verified: true, visitsDone: 3, visitsTotal: 3 });
    expect(g.banner).toEqual({ state: 'detected', provider: 'OneTrust', visitsWithBanner: 2, visitsChecked: 3 });
    expect(c).toMatchObject({ id: 'us-ca', label: 'California, US', verified: true, visitsDone: 0, visitsTotal: 3 });
    expect(c.banner).toEqual({ state: 'pending', visitsWithBanner: 0, visitsChecked: 0 });
    // The report-wide banner keeps its meaning (every finished visit).
    expect(r.banner).toMatchObject({ state: 'detected', provider: 'OneTrust', visitsWithBanner: 2, visitsChecked: 3 });
  });

  it('a location whose visits found no banner says none; repeats count toward its total', () => {
    const m = model([noBanner('do-nothing')]);
    const r = buildOwnerReport({ ...base, stage: 'live', model: m, plan: plan.slice(0, 3), locations: announced.slice(0, 1), done: [{ location: 'de', scenario: 'do-nothing' }] });
    expect(r.locations![0]).toMatchObject({ visitsDone: 1, visitsTotal: 3, banner: { state: 'none', visitsWithBanner: 0, visitsChecked: 1 } });
  });

  it('live, before any visit finishes (no model): totals from the plan, nothing done, banner pending', () => {
    const r = buildOwnerReport({ ...base, stage: 'live', plan, locations: announced });
    expect(r.locations).toEqual([
      { id: 'de', label: 'Germany', verified: true, observed: 'DE', visitsDone: 0, visitsTotal: 3, banner: { state: 'pending', visitsWithBanner: 0, visitsChecked: 0 } },
      { id: 'us-ca', label: 'California, US', verified: true, observed: 'US-CA', visitsDone: 0, visitsTotal: 3, banner: { state: 'pending', visitsWithBanner: 0, visitsChecked: 0 } },
    ]);
  });

  it('an unverified location is listed with its note and no visits', () => {
    const r = buildOwnerReport({ ...base, stage: 'live', plan: plan.slice(0, 3), locations: [...announced.slice(0, 1), { id: 'uk', label: 'United Kingdom', verdict: 'mismatch', observed: 'NL', note: 'exit in NL' }] });
    expect(r.locations![1]).toMatchObject({ id: 'uk', verified: false, note: 'exit in NL', visitsDone: 0, visitsTotal: 0, banner: { state: 'pending' } });
  });

  it('single location, final with no plan: one entry, all visits done, banner equal to the report-wide one minus consent tools', () => {
    const m = model([withBanner('do-nothing'), withBanner('reject'), noBanner('accept')]);
    const r = buildOwnerReport({ ...base, stage: 'final', model: m, finishedAt: '2026-10-07T10:05:00Z' });
    expect(r.locations).toHaveLength(1);
    expect(r.locations![0]).toMatchObject({ id: 'de', visitsDone: 3, visitsTotal: 3 });
    const { consentTools: _ct, ...wide } = r.banner;
    expect(r.locations![0].banner).toEqual(wide);
  });

  it('the service mirror accepts the new field', () => {
    const r: ServiceOwnerReport = buildOwnerReport({ ...base, stage: 'live', plan, locations: announced });
    expect(r.locations?.length).toBe(2);
  });
});
