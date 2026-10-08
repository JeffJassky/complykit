import { describe, expect, it } from 'vitest';
import type { JobReportResponse, JobSummary, LawScanProgress, OwnerCell, OwnerReport } from '../../shared/api';
import { reportForLocation, tabReport } from './lawReport';

// plans/per-law-report-contract.md, PR C2: one law's view of a multi-location owner
// report (its columns, its cells, its banner), and which report a law's tab shows.

const ok: OwnerCell = { state: 'ok', reason: 'fine' };
const bad: OwnerCell = { state: 'mismatch', reason: 'on before consent' };
const ask: OwnerCell = { state: 'needs-decision', reason: 'classify it' };
const wait: OwnerCell = { state: 'pending' };

function twoLocations(stage: 'live' | 'final'): OwnerReport {
  return {
    version: 1, stage, runId: 'r', generatedAt: 'x', site: { url: 'https://shop.example/', host: 'shop.example', domain: 'shop.example' },
    scan: { startedAt: 'a', visitsDone: 4, visitsTotal: 4, pagesVisited: 7, location: { id: 'de', label: 'Germany', verified: true } },
    banner: { state: 'detected', provider: 'OneTrust', visitsWithBanner: 2, visitsChecked: 4, consentTools: ['OneTrust'] },
    matrix: {
      columns: [
        { id: 'de:do-nothing', location: 'de', scenario: 'do-nothing', label: 'Before a choice', locationLabel: 'Germany', state: 'done' },
        { id: 'de:reject', location: 'de', scenario: 'reject', label: 'After rejection', locationLabel: 'Germany', state: 'done' },
        { id: 'us-ca:do-nothing', location: 'us-ca', scenario: 'do-nothing', label: 'Before a choice', locationLabel: 'California, US', state: 'done' },
        { id: 'us-ca:gpc', location: 'us-ca', scenario: 'gpc', label: 'Privacy signal (GPC)', locationLabel: 'California, US', state: 'done' },
      ],
      tools: [
        { id: 'tool:meta', partyId: 'meta', label: 'Meta Pixel', domain: 'facebook.com', purpose: 'Advertising', categories: ['advertising'], classified: true, recognized: true, classKey: 'class:meta', cells: [bad, ok, ok, bad], cookies: [{ id: 'c1', name: '_fbp', kind: 'cookie', purpose: 'Advertising', classified: true, cells: [bad, ok, wait, ok] }] },
        { id: 'tool:ca-only', partyId: 'w', label: 'widgets.test', domain: 'widgets.test', purpose: 'Unclassified', categories: [], classified: false, recognized: false, classKey: 'class:w', cells: [wait, wait, ask, ask], cookies: [] },
      ],
      counts: { ok: 4, mismatch: 3, needsDecision: 2, pending: 3, notChecked: 0 },
    },
    decisions: [{ partyId: 'w', label: 'widgets.test', domain: 'widgets.test', classKey: 'class:w' }],
    locations: [
      { id: 'de', label: 'Germany', verified: true, observed: 'DE', visitsDone: 2, visitsTotal: 2, banner: { state: 'detected', provider: 'OneTrust', visitsWithBanner: 2, visitsChecked: 2 } },
      { id: 'us-ca', label: 'California, US', verified: true, observed: 'US-CA', visitsDone: 2, visitsTotal: 2, banner: { state: 'none', visitsWithBanner: 0, visitsChecked: 2 } },
    ],
  };
}

describe('reportForLocation', () => {
  it('keeps that location’s columns and the matching cells of every tool and cookie; recounts', () => {
    const r = reportForLocation(twoLocations('final'), 'us-ca');
    expect(r.matrix.columns.map((c) => c.id)).toEqual(['us-ca:do-nothing', 'us-ca:gpc']);
    expect(r.matrix.columns.every((c) => c.locationLabel === undefined)).toBe(true); // the tab names the location
    const meta = r.matrix.tools.find((t) => t.partyId === 'meta')!;
    expect(meta.cells).toEqual([ok, bad]);
    expect(meta.cookies[0].cells).toEqual([wait, ok]);
    expect(r.matrix.tools.find((t) => t.partyId === 'w')!.cells).toEqual([ask, ask]);
    expect(r.matrix.counts).toEqual({ ok: 2, mismatch: 1, needsDecision: 2, pending: 1, notChecked: 0 });
  });

  it('takes the banner, location and visit counts from that location’s summary', () => {
    const r = reportForLocation(twoLocations('final'), 'us-ca');
    expect(r.banner).toEqual({ state: 'none', visitsWithBanner: 0, visitsChecked: 2 });
    expect(r.scan.location).toEqual({ id: 'us-ca', label: 'California, US', verified: true, observed: 'US-CA' });
    expect(r.scan).toMatchObject({ visitsDone: 2, visitsTotal: 2, pagesVisited: 7 });
  });

  it('final: drops a tool never seen at that location (every kept cell pending); live keeps it', () => {
    expect(reportForLocation(twoLocations('final'), 'de').matrix.tools.map((t) => t.partyId)).toEqual(['meta']);
    expect(reportForLocation(twoLocations('live'), 'de').matrix.tools.map((t) => t.partyId)).toEqual(['meta', 'w']);
  });

  it('leaves everything else as it was and does not mutate its input', () => {
    const src = twoLocations('final');
    const before = JSON.stringify(src);
    const r = reportForLocation(src, 'de');
    expect(JSON.stringify(src)).toBe(before);
    expect(r.decisions).toEqual(src.decisions);
    expect(r.site).toEqual(src.site);
    expect(r.stage).toBe('final');
  });

  it('an old report without locations falls back to the report-wide banner and location', () => {
    const { locations: _l, ...old } = twoLocations('final');
    const r = reportForLocation(old, 'de');
    expect(r.banner).toEqual(old.banner);
    expect(r.scan.location).toEqual(old.scan.location);
    expect(r.matrix.columns).toHaveLength(2);
  });
});

describe('tabReport', () => {
  const progress = (id: 'eu' | 'ca', state: LawScanProgress['state']): LawScanProgress => ({ id, locationId: id === 'eu' ? 'de' : 'us-ca', region: id === 'eu' ? 'fra' : 'lax', local: id === 'ca', state, visitsDone: 0, visitsTotal: 0 });
  const data = (over: Partial<JobReportResponse>): JobReportResponse => ({ job: { laws: ['eu', 'ca'] } as JobSummary, domain: 'shop.example', report: null, todo: { state: 'waiting', tasks: [] }, updating: false, ...over });
  const liveDe = { ...twoLocations('live'), runId: 'live-de' };

  it('prefers the law’s own live report', () => {
    const d = data({ report: twoLocations('final'), laws: [{ id: 'eu', progress: progress('eu', 'scanning'), report: liveDe }, { id: 'ca', progress: progress('ca', 'waiting'), report: null }] });
    expect(tabReport(d, 'eu')).toBe(liveDe);
  });

  it('else the final report cut to the law’s location', () => {
    const d = data({ report: twoLocations('final'), laws: [{ id: 'eu', progress: progress('eu', 'done'), report: null }, { id: 'ca', progress: progress('ca', 'done'), report: null }] });
    expect(tabReport(d, 'ca')!.matrix.columns.map((c) => c.location)).toEqual(['us-ca', 'us-ca']);
  });

  it('null when nothing is known yet', () => {
    expect(tabReport(data({ laws: [{ id: 'eu', progress: progress('eu', 'starting'), report: null }] }), 'eu')).toBeNull();
  });
});
