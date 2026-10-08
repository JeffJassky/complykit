import { describe, it, expect } from 'vitest';
import { buildConsentReportModel } from '../src/report/consent-model.js';
import { buildOwnerReport, bannerProviderName, OWNER_SCENARIO_LABEL } from '../src/report/owner-report.js';
import { TrackingEvaluation } from '../src/record/index.js';
import { workspaceId } from '../src/report/workspace.js';
import { classificationKey } from '../src/site-workspace.js';
import type { OwnerReport as ServiceOwnerReport } from '../service/src/shared/api.js';

// The owner report (plans/simple-report.md) over the same report model as the
// full report: live (pending columns, rows appearing as visits finish) and final.

const site = { url: 'https://shop.example/', host: 'shop.example', registrableDomain: 'shop.example' };
const meta = { partyId: 'meta.pixel', label: 'Meta Pixel', domain: 'facebook.com', hosts: ['facebook.com'], recognized: true, kbStatus: 'proposed', categories: ['advertising'], behavesLikeTracker: true, trackerSignals: [], sends: [], stores: [{ name: '_fbp', kind: 'cookie', lifetimeDays: 90 }], sources: ['injected'], loadedBy: [], seenIn: [] };
const widget = { ...meta, partyId: 'unknown:widgets.test', label: 'widgets.test', domain: 'widgets.test', hosts: ['widgets.test'], recognized: false, kbStatus: 'unrecognized', categories: [], stores: [] };
const location = { spec: { id: 'de', label: 'Germany', country: 'DE', proxied: false }, verification: { verdict: 'verified', expected: { country: 'DE' }, observed: { country: 'DE' }, sources: [], jurisdictions: ['eu'], checkedAt: 'now' } };
const fbpBeforeChoice = { partyId: 'meta.pixel', dataRequests: 1, requestPhases: ['before-choice'], dataRequestPhases: { 'before-choice': 1 }, limitedRequestsByPhase: {}, stores: [{ name: '_fbp', kind: 'cookie', writePhase: 'before-choice', writePhases: ['before-choice'], presentAtEnd: true, attribution: 'observed' }] };
const widgetActive = { partyId: 'unknown:widgets.test', dataRequests: 2, requestPhases: ['before-choice'], dataRequestPhases: { 'before-choice': 2 }, limitedRequestsByPhase: {}, stores: [] };

function evaluation(opts: { scenarios: object[]; inventory: object[]; observations: object[] }) {
  return TrackingEvaluation.parse({
    runId: 'r1', property: 'shop', site, startedAt: '2026-10-07T10:00:00Z', finishedAt: '2026-10-07T10:05:00Z', versions: { kb: '0', registry: '0', package: '0' },
    locations: [{ ...location, scenarios: opts.scenarios }], inventory: opts.inventory, notTested: [], researchQueue: [], redacted: true, behaviorObservations: opts.observations,
  });
}
const doNothing = { scenario: 'do-nothing', status: 'tested', banner: { found: true, cmp: 'onetrust' } };
const reject = { scenario: 'reject', status: 'tested', banner: { found: true, cmp: 'onetrust' }, choice: { kind: 'reject', ok: true, method: 'button' } };
const obs = (scenario: string, parties: object[]) => ({ location: 'de', scenario, durationMs: 10000, pages: 2, knownPartyIds: ['meta.pixel'], parties });
const plan = [{ location: 'de', scenario: 'do-nothing' }, { location: 'de', scenario: 'reject' }, { location: 'de', scenario: 'accept' }];
const base = { runId: 'r1', site, startedAt: '2026-10-07T10:00:00Z', stage: 'live' as const, plan, locations: [{ id: 'de', label: 'Germany', verdict: 'verified', observed: 'DE' }] };

describe('owner report: live', () => {
  it('before any visit finishes: every planned column pending, the banner unknown, no rows', () => {
    const r = buildOwnerReport({ ...base, current: { location: 'de', scenario: 'do-nothing' } });
    expect(r.matrix.columns.map((c) => [c.label, c.state])).toEqual([
      ['Before a choice', 'running'],
      ['After rejection', 'pending'],
      ['After acceptance', 'pending'],
    ]);
    expect(r.banner).toEqual({ state: 'pending', visitsWithBanner: 0, visitsChecked: 0 });
    expect(r.matrix.tools).toEqual([]);
    expect(r.scan).toMatchObject({ visitsDone: 0, visitsTotal: 3, current: 'Before a choice', location: { id: 'de', label: 'Germany', verified: true } });
    expect(r.decisions).toEqual([]);
  });

  it('after the first visit: its column is judged, the rest stay pending; the banner and its provider are named', () => {
    const model = buildConsentReportModel(evaluation({ scenarios: [doNothing], inventory: [meta], observations: [obs('do-nothing', [fbpBeforeChoice])] }), []);
    const r = buildOwnerReport({ ...base, model, done: [{ location: 'de', scenario: 'do-nothing' }], current: { location: 'de', scenario: 'reject' }, pagesVisited: 2 });
    expect(r.matrix.columns.map((c) => c.state)).toEqual(['done', 'running', 'pending']);
    expect(r.banner).toMatchObject({ state: 'detected', provider: 'OneTrust', visitsWithBanner: 1 });
    const tool = r.matrix.tools[0];
    expect(tool).toMatchObject({ label: 'Meta Pixel', purpose: 'Advertising', classified: true, classKey: classificationKey({ kind: 'tool', partyId: 'meta.pixel', domain: 'facebook.com', recognized: true }) });
    expect(tool.cells.map((c) => c.state)).toEqual(['mismatch', 'pending', 'pending']);
    expect(tool.cells[0].expected).toBeTruthy();
    expect(tool.cookies.map((c) => [c.name, c.cells.map((x) => x.state)])).toEqual([['_fbp', ['mismatch', 'pending', 'pending']]]);
    expect(r.matrix.counts).toMatchObject({ mismatch: 2, pending: 4 });
    expect(r.scan).toMatchObject({ visitsDone: 1, visitsTotal: 3, pagesVisited: 2, current: 'After rejection' });
  });

  it('rows appear as later visits discover tools; an unclassified tool needs a decision and is a to-do', () => {
    const model = buildConsentReportModel(evaluation({ scenarios: [doNothing, reject], inventory: [meta, widget], observations: [obs('do-nothing', [fbpBeforeChoice]), obs('reject', [widgetActive])] }), []);
    const r = buildOwnerReport({ ...base, model, done: [{ location: 'de', scenario: 'do-nothing' }, { location: 'de', scenario: 'reject' }] });
    expect(r.matrix.tools.map((t) => t.label)).toEqual(['Meta Pixel', 'widgets.test']);
    const w = r.matrix.tools[1];
    expect(w).toMatchObject({ classified: false, purpose: 'Unclassified', recognized: false, classKey: 'class:' + workspaceId('tool', ['unknown:widgets.test', 'widgets.test']) });
    expect(w.cells.map((c) => c.state)).toEqual(['needs-decision', 'needs-decision', 'pending']);
    expect(r.decisions).toEqual([{ partyId: 'unknown:widgets.test', label: 'widgets.test', domain: 'widgets.test', classKey: w.classKey }]);
  });

  it('each tool row says what it did: requests only, or what it stored, with example addresses and its loader', () => {
    const bucket = { ...widget, partyId: 'unknown:shop-assets.s3.amazonaws.com', label: 'shop-assets (Amazon S3)', domain: 'shop-assets.s3.amazonaws.com', hosts: ['shop-assets.s3.amazonaws.com'], samples: ['shop-assets.s3.amazonaws.com/beta.yml?t'], loadedBy: ['https://shop.example/app.js'], seenIn: [{ location: 'de', scenario: 'do-nothing', requests: 2, firstMs: 900, phases: ['before-banner'] }] };
    const model = buildConsentReportModel(evaluation({ scenarios: [doNothing], inventory: [meta, bucket], observations: [obs('do-nothing', [fbpBeforeChoice])] }), []);
    const r = buildOwnerReport({ ...base, site: { ...base.site, registrableDomain: 'shop.example' }, model, done: [{ location: 'de', scenario: 'do-nothing' }] });
    const b = r.matrix.tools.find((t) => t.partyId === bucket.partyId)!;
    expect(b.activity).toEqual({ requests: 2, visits: 1, cookies: 0, storage: 0, samples: ['shop-assets.s3.amazonaws.com/beta.yml?t'], loadedBy: ['https://shop.example/app.js'], hostedOn: { provider: 'Amazon S3', name: 'shop-assets', matchesSite: true } });
    const m = r.matrix.tools.find((t) => t.label === 'Meta Pixel')!;
    expect(m.activity.cookies).toBe(m.cookies.filter((k) => k.kind === 'cookie').length);
    expect(m.activity.hostedOn).toBeUndefined();
  });

  it('a cookie of a tool your team classified takes the tool’s purpose (no lingering "?")', () => {
    const classified = { ...widget, categories: ['analytics'], stores: [{ name: '_w', kind: 'cookie', lifetimeDays: 30 }] };
    const wObs = { ...widgetActive, stores: [{ name: '_w', kind: 'cookie', writePhase: 'before-choice', writePhases: ['before-choice'], presentAtEnd: true, attribution: 'observed' }] };
    const model = buildConsentReportModel(evaluation({ scenarios: [doNothing], inventory: [classified], observations: [obs('do-nothing', [wObs])] }), []);
    const r = buildOwnerReport({ ...base, stage: 'final', model });
    const t = r.matrix.tools[0];
    expect(t.classified).toBe(true);
    expect(t.cookies[0]).toMatchObject({ name: '_w', purpose: 'Analytics', classified: true });
    expect(t.cookies[0].cells[0].state).toBe('mismatch');
    expect(r.banner.consentTools).toBeUndefined();
  });

  it('a repeat visit keeps its column pending until every run of it is done', () => {
    const model = buildConsentReportModel(evaluation({ scenarios: [doNothing], inventory: [meta], observations: [obs('do-nothing', [fbpBeforeChoice])] }), []);
    const r = buildOwnerReport({ ...base, plan: plan.map((p) => ({ ...p, runs: 2 })), model, done: [{ location: 'de', scenario: 'do-nothing' }], current: { location: 'de', scenario: 'do-nothing', run: 2 } });
    expect(r.matrix.columns[0].state).toBe('running');
    expect(r.scan).toMatchObject({ visitsDone: 1, visitsTotal: 6, current: 'Before a choice (slow connection)' });
  });
});

describe('owner report: final', () => {
  it('nothing pending; a choice with no banner to act on is one not-checked column with one note', () => {
    const noBanner = { scenario: 'reject', status: 'not-applicable', reason: 'no banner', banner: { found: false } };
    const model = buildConsentReportModel(evaluation({ scenarios: [{ ...doNothing, banner: { found: false } }, noBanner], inventory: [meta], observations: [obs('do-nothing', [fbpBeforeChoice])] }), []);
    const r = buildOwnerReport({ ...base, stage: 'final', plan: undefined, model, finishedAt: '2026-10-07T10:05:00Z' });
    expect(r.stage).toBe('final');
    expect(r.matrix.columns).toEqual([
      { id: 'de:do-nothing', location: 'de', scenario: 'do-nothing', label: 'Before a choice', state: 'done' },
      { id: 'de:reject', location: 'de', scenario: 'reject', label: 'After rejection', state: 'not-checked', note: 'There was no consent banner, so this choice couldn’t be made.' },
    ]);
    expect(r.matrix.tools[0].cells.map((c) => c.state)).toEqual(['mismatch', 'not-checked']);
    expect(r.matrix.counts.pending).toBe(0);
    expect(r.banner).toEqual({ state: 'none', visitsWithBanner: 0, visitsChecked: 2 });
    expect(r.scan).toMatchObject({ visitsDone: 2, visitsTotal: 2, pagesVisited: 2, finishedAt: '2026-10-07T10:05:00Z' });
  });

  it('a final built with the live plan treats every planned visit as done', () => {
    const model = buildConsentReportModel(evaluation({ scenarios: [doNothing, reject], inventory: [meta], observations: [obs('do-nothing', [fbpBeforeChoice]), obs('reject', [])] }), []);
    const r = buildOwnerReport({ ...base, stage: 'final', plan: plan.slice(0, 2), model });
    expect(r.matrix.columns.map((c) => c.state)).toEqual(['done', 'done']);
    expect(r.matrix.tools[0].cells.map((c) => c.state)).toEqual(['mismatch', 'ok']);
  });

  it('carries the checklist the model has (the generated config’s tasks)', () => {
    const model = buildConsentReportModel(evaluation({ scenarios: [doNothing], inventory: [meta], observations: [obs('do-nothing', [fbpBeforeChoice])] }), []);
    const task = { id: 'install', kind: 'install', group: 'install', title: 'Install the complykit consent tool', summary: 's', tools: [], partyIds: [], steps: [], pages: [], verify: { check: 'install', method: 'static' }, status: 'todo', optional: false, notes: [], order: 0 };
    model.remediation = { tasks: [task as never], source: 'workspace', configAt: 'x', runId: 'r1' };
    expect(buildOwnerReport({ ...base, stage: 'final', model }).todo).toEqual({ tasks: [task], configAt: 'x', runId: 'r1' });
  });

  it('column labels are the visitor actions in plain words', () => {
    expect(OWNER_SCENARIO_LABEL.gpc).toBe('Privacy signal (GPC)');
    expect(bannerProviderName('onetrust')).toBe('OneTrust');
    expect(bannerProviderName('Cookiebot')).toBe('Cookiebot');
    expect(bannerProviderName('shopify-banner')).toBe('Shopify');
    expect(bannerProviderName('banner')).toBeUndefined();
    expect(bannerProviderName('Acme CMP')).toBe('Acme CMP');
  });
});

describe('owner report: the service’s mirror (service/src/shared/api.ts)', () => {
  it('accepts the builder’s output (compile-time) and names the same top-level parts', () => {
    const model = buildConsentReportModel(evaluation({ scenarios: [doNothing], inventory: [meta, widget], observations: [obs('do-nothing', [fbpBeforeChoice])] }), []);
    const r: ServiceOwnerReport = buildOwnerReport({ ...base, model, done: [{ location: 'de', scenario: 'do-nothing' }] });
    expect(Object.keys(r).sort()).toEqual(['banner', 'decisions', 'generatedAt', 'matrix', 'runId', 'scan', 'site', 'stage', 'version']);
    expect(Object.keys(r.matrix.counts).sort()).toEqual(['mismatch', 'needsDecision', 'notChecked', 'ok', 'pending']);
  });
});
