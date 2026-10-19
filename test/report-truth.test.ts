// plans/report-truth.md — acceptance tests for the three field bugs of 2026-10-19
// (telabio.com hsforms.net, allen-heath.com "couldn't test", samsontech.com affirm.com).
// Generic shapes, not the sites: each case is the smallest record that reproduces the bug.
import { describe, it, expect } from 'vitest';
import { buildBehaviorMatrix } from '../src/report/consent-matrix.js';
import { buildConsentReportModel } from '../src/report/consent-model.js';
import { buildOwnerReport } from '../src/report/owner-report.js';
import { hidesActivity } from '../src/report/capture-gap.js';
import { refuseNecessaryTrackers } from '../src/consent-generator.js';
import { DEFAULT_KB } from '../src/registry/index.js';
import { TrackingEvaluation } from '../src/record/index.js';

const site = { url: 'https://shop.example/', host: 'shop.example', registrableDomain: 'shop.example' };
const loc = (id: string, label: string, country: string, jurisdictions: string[]) => ({
  spec: { id, label, country, proxied: false },
  verification: { verdict: 'verified', expected: { country }, observed: { country }, sources: [], jurisdictions, checkedAt: 'now' },
  scenarios: [{ scenario: 'do-nothing', status: 'tested' }, { scenario: 'browse', status: 'tested' }, { scenario: 'reject', status: 'tested', choice: { kind: 'reject', ok: true, method: 'test' } }],
});
const DE = loc('de', 'Germany', 'DE', ['eu', 'eu-de']);
const CA = loc('us-ca', 'California', 'US', ['us', 'us-ca']);

const party = (o: Record<string, unknown>): Record<string, any> => ({ hosts: [o.domain], kbStatus: 'proposed', behavesLikeTracker: false, trackerSignals: [], sends: [], stores: [], sources: ['injected'], loadedBy: [], seenIn: [], ...o });
const store = (name: string, o: Record<string, unknown> = {}) => ({ name, kind: 'cookie', writePhase: 'before-choice', writePhases: ['before-choice'], presentAtEnd: true, attribution: 'observed', ...o });
const seen = (location: string, scenario: string, parties: Array<{ partyId: string; requests?: number; stores?: unknown[] }>) => ({
  location, scenario, durationMs: 10000, knownPartyIds: parties.map((p) => p.partyId),
  parties: parties.map((p) => ({ partyId: p.partyId, dataRequests: p.requests ?? 0, requestPhases: p.requests ? ['before-choice'] : [], dataRequestPhases: p.requests ? { 'before-choice': p.requests } : {}, limitedRequestsByPhase: {}, stores: p.stores ?? [] })),
});
const evaluation = (o: Record<string, unknown>) => TrackingEvaluation.parse({ runId: 'r', property: 'shop', site, startedAt: '2026-10-19T00:00:00Z', finishedAt: '2026-10-19T00:10:00Z', versions: { kb: '0', registry: '0', package: '0' }, locations: [DE], inventory: [], notTested: [], researchQueue: [], redacted: true, behaviorObservations: [], ...o });
const rowOf = (m: ReturnType<typeof buildConsentReportModel>, kind: 'tool' | 'storage', label: string) => buildBehaviorMatrix(m).rows.find((r) => r.kind === kind && r.label === label)!;
const cellOf = (m: ReturnType<typeof buildConsentReportModel>, kind: 'tool' | 'storage', label: string, column: string) => {
  const bm = buildBehaviorMatrix(m);
  const i = bm.columns.findIndex((c) => c.id === column);
  expect(i, `column ${column}`).toBeGreaterThanOrEqual(0);
  return bm.rows.find((r) => r.kind === kind && r.label === label)!.cells[i];
};
const owner = (ev: TrackingEvaluation) => buildOwnerReport({ model: buildConsentReportModel(ev, []), stage: 'final', runId: 'r', site: ev.site, startedAt: ev.startedAt, finishedAt: ev.finishedAt });

// ---------------------------------------------------------------------------------------
describe('A. a cookie is never judged better than its tool', () => {
  // An unidentified form host behind Cloudflare: its __cf_bm matches the KB's Cloudflare entry by name.
  const forms = party({ partyId: 'unknown:forms.example', label: 'forms.example', domain: 'forms.example', recognized: false, categories: ['unknown'], stores: [{ name: '__cf_bm', kind: 'cookie', lifetimeDays: 1 }] });
  const cfbm = store('__cf_bm', { thirdParty: true });
  const ev = evaluation({ inventory: [forms], behaviorObservations: [seen('de', 'do-nothing', [{ partyId: forms.partyId as string, requests: 1, stores: [cfbm] }]), seen('de', 'reject', [{ partyId: forms.partyId as string, stores: [cfbm] }])] });
  const m = buildConsentReportModel(ev, []);

  it('an unclassified tool’s cookie is unclassified too, even when its name is in the knowledge base', () => {
    const row = rowOf(m, 'storage', '__cf_bm');
    expect(row.categories).toEqual([]);
    expect(row.categorySource).toMatch(/by name/);
    expect(row.categorySource).toContain('forms.example');
    expect(cellOf(m, 'storage', '__cf_bm', 'de:do-nothing').status).toBe('review');
    expect(cellOf(m, 'tool', 'forms.example', 'de:do-nothing').status).toBe('review');
  });

  it('the owner report shows the cookie as depending on its tool, never green', () => {
    const r = owner(ev);
    const tool = r.matrix.tools.find((t) => t.partyId === forms.partyId)!;
    expect(tool.classified).toBe(false);
    const cookie = tool.cookies.find((k) => k.name === '__cf_bm')!;
    expect(cookie.classified).toBe(false);
    expect(cookie.purpose).toBe('Depends on what forms.example is for');
    expect(cookie.cells.every((c) => c.state !== 'ok')).toBe(true);
    expect(cookie.cells.some((c) => c.state === 'needs-decision')).toBe(true);
  });

  it('a cookie can’t be classified greener than its tool: the site’s cookie answer joins the tool’s purpose, and waits for an unclassified tool', () => {
    const cookieAnswer = { key: 'class:x', kind: 'storage', partyId: forms.partyId, domain: 'forms.example', storageKind: 'cookie', name: '__cf_bm', categories: ['necessary'] };
    // Tool unclassified: the cookie still depends on it.
    const m1 = buildConsentReportModel(evaluation({ ...ev, siteWorkspace: { appliedAt: 'now', classifications: [cookieAnswer], doneTasks: [] } }), []);
    expect(cellOf(m1, 'storage', '__cf_bm', 'de:do-nothing').status).toBe('review');
    // Tool classified advertising: "necessary" on its cookie doesn't make the cookie green where the tool is red.
    const toolAnswer = { key: 'class:t', kind: 'tool', partyId: forms.partyId, domain: 'forms.example', categories: ['advertising'] };
    const m2 = buildConsentReportModel(evaluation({ ...ev, inventory: [{ ...forms, categories: ['advertising'] }], siteWorkspace: { appliedAt: 'now', classifications: [toolAnswer, cookieAnswer], doneTasks: [] } }), []);
    expect(rowOf(m2, 'storage', '__cf_bm').categories).toEqual(expect.arrayContaining(['advertising', 'necessary']));
    expect(cellOf(m2, 'tool', 'forms.example', 'de:do-nothing').status).toBe('mismatch');
    expect(cellOf(m2, 'storage', '__cf_bm', 'de:do-nothing').status).toBe('mismatch');
  });

  it('a classified tool’s cookie takes the stricter of the tool’s purpose and its name’s: an ad tool’s __cf_bm is off before consent like the tool', () => {
    const ads = { ...forms, partyId: 'unknown:ads.example', label: 'ads.example', domain: 'ads.example', hosts: ['ads.example'] };
    const ws = { appliedAt: 'now', classifications: [{ key: 'class:y', kind: 'tool', partyId: ads.partyId, domain: 'ads.example', categories: ['advertising'] }], doneTasks: [] };
    const ev2 = evaluation({ inventory: [{ ...ads, categories: ['advertising'] }], siteWorkspace: ws, behaviorObservations: [seen('de', 'do-nothing', [{ partyId: ads.partyId, requests: 1, stores: [cfbm] }])] });
    const m2 = buildConsentReportModel(ev2, []);
    expect(rowOf(m2, 'storage', '__cf_bm').categories).toEqual(expect.arrayContaining(['advertising', 'cdn']));
    expect(cellOf(m2, 'tool', 'ads.example', 'de:do-nothing').status).toBe('mismatch');
    expect(cellOf(m2, 'storage', '__cf_bm', 'de:do-nothing').status).toBe('mismatch');
  });

  it('the site’s own Cloudflare cookie (attributed to the knowledge-base Cloudflare party) stays green', () => {
    const cf = party({ partyId: 'cloudflare', label: 'Cloudflare', domain: 'cloudflare.com', recognized: true, categories: ['cdn'], stores: [{ name: '__cf_bm', kind: 'cookie', lifetimeDays: 1 }] });
    const m2 = buildConsentReportModel(evaluation({ inventory: [cf], behaviorObservations: [seen('de', 'do-nothing', [{ partyId: 'cloudflare', stores: [store('__cf_bm')] }])] }), []);
    expect(cellOf(m2, 'storage', '__cf_bm', 'de:do-nothing').status).toBe('match');
  });
});

// ---------------------------------------------------------------------------------------
describe('B. only a note that could hide activity is a capture gap', () => {
  const ga = { domain: 'google-analytics.com', hosts: ['google-analytics.com', 'googletagmanager.com'] };
  const note = (reason: string, id = 'do-nothing') => ({ scope: 'flow' as const, id, location: 'us-ca', reason });

  it('routine notes say nothing about whether a tool loaded', () => {
    for (const reason of [
      'page-exit sends from cross-origin frames (recovered only for same-origin navigations)',
      'site search: no usable search input was found on the landing page — search terms and page titles sent from a results page were not tested',
      'site search: the search form submits by POST, which the journey does not do — search terms and page titles sent from a results page were not tested',
      'button clicked but the stored consent state did not change',
      'clicked; no readable consent state to confirm it was stored',
      'the stored consent state does not reflect the click',
      'autoconsent self-test: the stored choice does not reflect the opt-out',
      'complykit’s tool is on the page: driven by its exact hooks only, no fallback',
      'banner driver (@duckduckgo/autoconsent) not installed — heuristic banner detection only',
      'banner reject failed (cmp) — opted out by signal and link only',
      'navigator.globalPrivacyControl inside workers (init scripts do not run in workers; the Sec-GPC header is still sent)',
      'banner design: low contrast',
      'no visible search field to type the marker into',
    ]) expect(hidesActivity(note(reason), ga), reason).toBe(false);
    for (const id of ['server-to-server', 'vendor-processing', 'contracts', 'consent-records', 'unvisited']) expect(hidesActivity({ scope: 'flow', id, reason: 'x' }, ga)).toBe(false);
  });

  it('real capture limits stay gaps, and unrecognised notes stay conservative', () => {
    expect(hidesActivity(note('HAR export may be incomplete: the browser context did not close within 60s'), ga)).toBe(true);
    expect(hidesActivity(note('unreadable frame in this visit'), ga)).toBe(true);
    expect(hidesActivity({ scope: 'scenario', id: 'do-nothing', location: 'us-ca', reason: 'throttled run 2 of 2 did not complete: timeout' }, ga)).toBe(true);
    expect(hidesActivity(note('something new the scanner learned to say'), ga)).toBe(true);
  });

  it('a sandboxed frame hides only its own site’s storage', () => {
    const turnstile = note('storage inside sandboxed frame https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/f/av0 (opaque origin, unreadable)', 'reject');
    expect(hidesActivity(turnstile, ga)).toBe(false);
    expect(hidesActivity(turnstile, { domain: 'cloudflare.com', hosts: ['cloudflare.com'] })).toBe(true);
  });

  it('a sandboxed frame with no host (about:srcdoc, data:) hides every party’s storage', () => {
    for (const url of ['about:srcdoc', 'data:text/html,x']) {
      const n = note(`storage inside sandboxed frame ${url} (opaque origin, unreadable)`);
      expect(hidesActivity(n, ga)).toBe(true);
      expect(hidesActivity(n, { domain: 'cloudflare.com', hosts: [] })).toBe(true);
    }
  });

  // allen-heath.com's shape: a California visit with a cross-origin video frame and no search box;
  // the banner holds GA4, which therefore sends nothing before a choice.
  it('a tool held before a choice in a wiretap state passes, frame and missing search box notwithstanding', () => {
    const ga4 = party({ partyId: 'google.analytics', label: 'Google Analytics 4', domain: 'google-analytics.com', hosts: ga.hosts, recognized: true, categories: ['analytics'], behavesLikeTracker: true });
    const ev = evaluation({
      locations: [CA],
      inventory: [ga4],
      notTested: [
        note('page-exit sends from cross-origin frames (recovered only for same-origin navigations)'),
        note('site search: no usable search input was found on the landing page — search terms and page titles sent from a results page were not tested', 'browse'),
        { scope: 'flow', id: 'server-to-server', reason: 'data the site’s server sends to vendors directly' },
      ],
      behaviorObservations: [seen('us-ca', 'do-nothing', []), seen('us-ca', 'browse', []), seen('us-ca', 'reject', [])].map((o) => ({ ...o, knownPartyIds: ['google.analytics'] })),
    });
    const m = buildConsentReportModel(ev, []);
    for (const col of ['us-ca:do-nothing', 'us-ca:browse']) {
      const c = cellOf(m, 'tool', 'Google Analytics 4', col);
      expect(c.expected, col).toMatch(/wiretap/);
      expect(c.status, col).toBe('match');
    }
    const r = owner(ev).matrix.tools.find((t) => t.partyId === 'google.analytics')!;
    expect(r.cells.filter((c) => c.state === 'not-checked')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
describe('C. a refused answer is recorded, shown and judged', () => {
  // A pay-later widget the knowledge base doesn't know, that behaves like a tracker; the site says "necessary".
  const pay = party({ partyId: 'unknown:paylater.example', label: 'paylater.example', domain: 'paylater.example', recognized: false, categories: ['necessary'], behavesLikeTracker: true, trackerSignals: ['stores-long-lived-id', 'sends-page-address'] });
  const ws = () => ({ appliedAt: 'now', classifications: [{ key: 'class:pay', kind: 'tool' as const, partyId: pay.partyId as string, domain: 'paylater.example', categories: ['necessary'] }], doneTasks: [] });

  it('refuseNecessaryTrackers records the refusal on the site classification', () => {
    const ev = evaluation({ inventory: [pay], siteWorkspace: ws() });
    const notes = refuseNecessaryTrackers(ev, DEFAULT_KB);
    expect(notes).toHaveLength(1);
    expect(ev.inventory[0].categories).toEqual(['unknown']); // the generator's strictest treatment, unchanged
    expect(ev.siteWorkspace!.classifications[0].refused).toMatch(/behaved like a tracker/);
  });

  it('the matrix judges a refused tool as needing consent — a verdict, not a "?"', () => {
    const ev = evaluation({ inventory: [pay], siteWorkspace: ws(), behaviorObservations: [seen('de', 'do-nothing', [{ partyId: pay.partyId as string, requests: 2 }])] });
    refuseNecessaryTrackers(ev, DEFAULT_KB);
    const m = buildConsentReportModel(ev, []);
    const row = rowOf(m, 'tool', 'paylater.example');
    expect(row.categories).toEqual(['other']);
    expect(row.categorySource).toMatch(/behaves like a tracker/);
    expect(cellOf(m, 'tool', 'paylater.example', 'de:do-nothing').status).toBe('mismatch');
  });

  it('the owner report says what complykit did with the answer', () => {
    const ev = evaluation({ inventory: [pay], siteWorkspace: ws(), behaviorObservations: [seen('de', 'do-nothing', [{ partyId: pay.partyId as string, requests: 2 }])] });
    refuseNecessaryTrackers(ev, DEFAULT_KB);
    const t = owner(ev).matrix.tools.find((x) => x.partyId === pay.partyId)!;
    expect(t.answer).toMatchObject({ categories: ['necessary'], applied: false });
    expect(t.answer!.reason).toMatch(/behaved like a tracker/);
    expect(t.classified).toBe(true);
    expect(t.purpose).toBe('Needs consent (behaves like a tracker)');
    expect(t.cells.some((c) => c.state === 'mismatch')).toBe(true);
    expect(t.cells.some((c) => c.state === 'needs-decision')).toBe(false);
  });

  it('an accepted answer is reported as applied', () => {
    const quiet = { ...pay, behavesLikeTracker: false, trackerSignals: [], categories: ['payments'] };
    const ev = evaluation({ inventory: [quiet], siteWorkspace: { ...ws(), classifications: [{ ...ws().classifications[0], categories: ['payments'] }] } });
    refuseNecessaryTrackers(ev, DEFAULT_KB);
    const t = owner(ev).matrix.tools.find((x) => x.partyId === pay.partyId)!;
    expect(t.answer).toEqual({ categories: ['payments'], applied: true });
    expect(t.purpose).toBe('Payments');
  });

  // Review finding 2026-10-19: a KB-known tool whose "necessary" answer is refused keeps its KB purpose (strictest of both).
  it('a refused answer on a known tool keeps the knowledge base’s purpose: GA4 called "necessary" still waits for consent in a wiretap state', () => {
    const ga4 = party({ partyId: 'google.analytics', label: 'Google Analytics 4', domain: 'google-analytics.com', hosts: ['google-analytics.com'], recognized: true, categories: ['necessary'], behavesLikeTracker: true });
    const answer = { appliedAt: 'now', classifications: [{ key: 'class:ga', kind: 'tool' as const, partyId: 'google.analytics', domain: 'google-analytics.com', categories: ['necessary'] }], doneTasks: [] };
    const ev = evaluation({ locations: [CA], inventory: [ga4], siteWorkspace: answer, behaviorObservations: [seen('us-ca', 'do-nothing', [{ partyId: 'google.analytics', requests: 3 }])] });
    refuseNecessaryTrackers(ev, DEFAULT_KB);
    expect(ev.siteWorkspace!.classifications[0].refused).toMatch(/knowledge-base entry/);
    const m = buildConsentReportModel(ev, []);
    expect(rowOf(m, 'tool', 'Google Analytics 4').categories).toEqual(expect.arrayContaining(['analytics']));
    expect(cellOf(m, 'tool', 'Google Analytics 4', 'us-ca:do-nothing').status).toBe('mismatch');
    const t = owner(ev).matrix.tools.find((x) => x.partyId === 'google.analytics')!;
    expect(t.answer).toMatchObject({ applied: false });
    expect(t.purpose).toMatch(/Analytics/);
    expect(t.purpose).not.toMatch(/behaves like a tracker/);
  });
});
