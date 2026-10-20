// plans/report-truth.md Part 2 D — the owner report's judgement is one pure function,
// `judgeOwnerReport`, that the server and the browser both run on the same facts.
import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import { buildConsentReportModel } from '../src/report/consent-model.js';
import { buildOwnerReport, type OwnerReport } from '../src/report/owner-report.js';
import { judgeOwnerReport } from '../src/report/owner-judge.js';
import { categoryLabel } from '../src/report/cookie-purpose.js';
import { refuseNecessaryTrackers } from '../src/consent-generator.js';
import { DEFAULT_KB } from '../src/registry/index.js';
import { TrackingEvaluation } from '../src/record/index.js';

const site = { url: 'https://shop.example/', host: 'shop.example', registrableDomain: 'shop.example' };
const loc = (id: string, label: string, country: string, jurisdictions: string[]) => ({
  spec: { id, label, country, proxied: false },
  verification: { verdict: 'verified', expected: { country }, observed: { country }, sources: [], jurisdictions, checkedAt: 'now' },
  scenarios: [{ scenario: 'do-nothing', status: 'tested' }, { scenario: 'accept', status: 'tested', choice: { kind: 'accept', ok: true, method: 'test' } }, { scenario: 'reject', status: 'not-tested', reason: 'bot protection blocked the visit (HTTP 429)' }],
});
const DE = loc('de', 'Germany', 'DE', ['eu', 'eu-de']);
const CA = loc('us-ca', 'California', 'US', ['us', 'us-ca']);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const party = (o: Record<string, unknown>): Record<string, any> => ({ hosts: [o.domain], kbStatus: 'proposed', behavesLikeTracker: false, trackerSignals: [], sends: [], stores: [], sources: ['injected'], loadedBy: [], seenIn: [], ...o });
const store = (name: string, o: Record<string, unknown> = {}) => ({ name, kind: 'cookie', writePhase: 'before-choice', writePhases: ['before-choice'], presentAtEnd: true, attribution: 'observed', ...o });
const seen = (location: string, scenario: string, parties: Array<{ partyId: string; requests?: number; stores?: unknown[] }>, known: string[] = parties.map((p) => p.partyId)) => ({
  location, scenario, durationMs: 10000, knownPartyIds: known,
  parties: parties.map((p) => ({ partyId: p.partyId, dataRequests: p.requests ?? 0, requestPhases: p.requests ? ['before-choice'] : [], dataRequestPhases: p.requests ? { 'before-choice': p.requests } : {}, limitedRequestsByPhase: {}, stores: p.stores ?? [] })),
});
const evaluation = (o: Record<string, unknown>) => TrackingEvaluation.parse({ runId: 'r', property: 'shop', site, startedAt: '2026-10-19T00:00:00Z', finishedAt: '2026-10-19T00:10:00Z', versions: { kb: '0', registry: '0', package: '0' }, locations: [DE, CA], inventory: [], notTested: [], researchQueue: [], redacted: true, behaviorObservations: [], ...o });
const owner = (ev: TrackingEvaluation): OwnerReport => buildOwnerReport({ model: buildConsentReportModel(ev, []), stage: 'final', runId: 'r', site: ev.site, startedAt: ev.startedAt, finishedAt: ev.finishedAt, generatedAt: 'now' });

// Three tools: an unknown pay-later widget that behaves like a tracker, an unknown review widget that does not,
// and GA4 (known). Each sets a cookie; the pay-later one's is Cloudflare's __cf_bm (a known name).
const pay = party({ partyId: 'unknown:paylater.example', label: 'paylater.example', domain: 'paylater.example', recognized: false, categories: ['unknown'], behavesLikeTracker: true, trackerSignals: ['stores-long-lived-id', 'sends-page-address'], stores: [{ name: '__cf_bm', kind: 'cookie', lifetimeDays: 1 }] });
const reviews = party({ partyId: 'unknown:reviews.example', label: 'reviews.example', domain: 'reviews.example', recognized: false, categories: ['unknown'], stores: [{ name: 'rv_session', kind: 'cookie', lifetimeDays: 1 }] });
const ga4 = party({ partyId: 'google.analytics', label: 'Google Analytics 4', domain: 'google-analytics.com', hosts: ['google-analytics.com'], recognized: true, categories: ['analytics'], behavesLikeTracker: true, trackerSignals: ['stores-long-lived-id'], stores: [{ name: '_ga', kind: 'cookie', lifetimeDays: 400 }] });
const ids = ['unknown:paylater.example', 'unknown:reviews.example', 'google.analytics'];
const observations = [
  seen('de', 'do-nothing', [{ partyId: pay.partyId, requests: 2, stores: [store('__cf_bm', { thirdParty: true })] }, { partyId: reviews.partyId, requests: 1, stores: [store('rv_session')] }, { partyId: ga4.partyId, requests: 0 }], ids),
  seen('de', 'accept', [{ partyId: pay.partyId, requests: 2 }, { partyId: reviews.partyId, requests: 1 }, { partyId: ga4.partyId, requests: 3, stores: [store('_ga', { writePhases: ['after-accept'], writePhase: 'after-accept' })] }], ids),
  seen('us-ca', 'do-nothing', [{ partyId: pay.partyId, requests: 2, stores: [store('__cf_bm', { thirdParty: true })] }, { partyId: reviews.partyId, requests: 1 }, { partyId: ga4.partyId, requests: 0 }], ids),
  seen('us-ca', 'accept', [{ partyId: pay.partyId, requests: 2 }, { partyId: reviews.partyId, requests: 1 }, { partyId: ga4.partyId, requests: 3 }], ids),
];
const baseEv = () => evaluation({ inventory: [pay, reviews, ga4], behaviorObservations: observations });
const base = owner(baseEv());
const keyOf = (label: string) => base.matrix.tools.find((t) => t.label === label)!.classKey;
const toolOf = (r: OwnerReport, label: string) => r.matrix.tools.find((t) => t.label === label)!;
const colIndex = (r: OwnerReport, id: string) => r.matrix.columns.findIndex((c) => c.id === id);
const cell = (r: OwnerReport, label: string, col: string) => toolOf(r, label).cells[colIndex(r, col)];

/** The evaluation as the pipeline leaves it after the site answered: categories applied, then the tracker guard. */
const answeredEv = (answers: Record<string, string | string[]>) => {
  const cats = (c: string | string[]) => (Array.isArray(c) ? c : [c]);
  const inv = [pay, reviews, ga4].map((p) => (answers[p.partyId] ? { ...p, categories: cats(answers[p.partyId]) } : p));
  const ev = evaluation({ inventory: inv, behaviorObservations: observations, siteWorkspace: { appliedAt: 'now', classifications: Object.entries(answers).map(([partyId, c]) => ({ key: keyOf(inv.find((p) => p.partyId === partyId)!.label), kind: 'tool', partyId, domain: inv.find((p) => p.partyId === partyId)!.domain, categories: cats(c) })), doneTasks: [] } });
  refuseNecessaryTrackers(ev, DEFAULT_KB);
  return ev;
};
/** classKey → the answer's categories (a set: the technical report's workbench can add "also used for" categories). */
const answersByKey = (answers: Record<string, string | string[]>) => Object.fromEntries(Object.entries(answers).map(([partyId, c]) => [keyOf([pay, reviews, ga4].find((p) => p.partyId === partyId)!.label), Array.isArray(c) ? c : [c]]));
/** What the browser shows versus what the server renders — the part that must never differ. */
const judged = (r: OwnerReport) => ({ counts: r.matrix.counts, decisions: r.decisions.map((d) => d.classKey), tools: r.matrix.tools.map((t) => ({ label: t.label, purpose: t.purpose, categories: t.categories, classified: t.classified, answer: t.answer, cells: t.cells.map((c) => ({ state: c.state, expected: c.expected, reason: c.reason, observed: c.observed })), cookies: t.cookies.map((k) => ({ name: k.name, purpose: k.purpose, classified: k.classified, cells: k.cells.map((c) => c.state) })) })) });

describe('D. the owner report ships its facts', () => {
  it('every cell of a finished column carries the comparison facts; cells of a skipped column do not', () => {
    for (const t of base.matrix.tools) for (const row of [t, ...t.cookies]) row.cells.forEach((c, i) => expect(!!c.facts, `${row.id} ${base.matrix.columns[i].id}`).toBe(base.matrix.columns[i].state === 'done'));
  });
  it('each tool says what the knowledge base makes of it before any answer, and why it counts as a tracker', () => {
    expect(toolOf(base, 'paylater.example').judge).toEqual({ base: [], trackerReason: expect.stringMatching(/behaved like a tracker/) });
    expect(toolOf(base, 'reviews.example').judge).toEqual({ base: [] });
    expect(toolOf(base, 'Google Analytics 4').judge).toEqual({ base: ['analytics'], trackerReason: expect.stringMatching(/knowledge-base entry/) });
    expect(toolOf(base, 'paylater.example').cookies[0].judge).toEqual({ name: ['cdn'], site: [] });
    expect(base.answers).toEqual({});
  });
});

describe('D. judgeOwnerReport is the server’s judgement, run anywhere', () => {
  const cases: Array<[string, Record<string, string | string[]>]> = [
    ['a two-category answer from the technical report (functional, also advertising)', { 'unknown:reviews.example': ['functional', 'advertising'] }],
    ['"necessary, also advertising" on an unknown tracker (not refused: the set is not necessary-only)', { 'unknown:paylater.example': ['necessary', 'advertising'] }],
    ['a refused "necessary" on an unknown tracker', { 'unknown:paylater.example': 'necessary' }],
    ['an applied "functional" on an unknown widget', { 'unknown:reviews.example': 'functional' }],
    ['a legacy fine-grained answer', { 'unknown:reviews.example': 'reviews' }],
    ['a refused "necessary" on a known tool', { 'google.analytics': 'necessary' }],
    ['advertising on the tool whose cookie has a known name', { 'unknown:paylater.example': 'advertising' }],
    ['every tool answered at once', { 'unknown:paylater.example': 'necessary', 'unknown:reviews.example': 'functional', 'google.analytics': 'analytics' }],
  ];
  for (const [name, answers] of cases) {
    it(`matches the server render: ${name}`, () => {
      const server = owner(answeredEv(answers));
      expect(server.answers).toEqual(answersByKey(answers));
      expect(judged(judgeOwnerReport(base, answersByKey(answers)))).toEqual(judged(server));
      // Idempotent: judging an already-judged report with the same answers changes nothing.
      expect(judged(judgeOwnerReport(server, server.answers))).toEqual(judged(server));
    });
  }

  it('is pure and ignores answers for tools it does not have', () => {
    const before = JSON.stringify(base);
    const out = judgeOwnerReport(base, { 'class:nope': ['advertising'], [keyOf('reviews.example')]: ['analytics'] });
    expect(JSON.stringify(base)).toBe(before);
    expect(out).not.toBe(base);
    expect(toolOf(out, 'reviews.example').purpose).toBe('Analytics');
  });

  it('judges in the browser what Part 1 decided on the server', () => {
    const k = answersByKey({ 'unknown:paylater.example': 'necessary', 'google.analytics': 'necessary', 'unknown:reviews.example': 'functional' });
    const out = judgeOwnerReport(base, k);
    // Refused unknown tracker: advertising, with the reason; red before a choice in Germany and California.
    const p = toolOf(out, 'paylater.example');
    expect(p.answer).toEqual({ categories: ['necessary'], applied: false, reason: expect.stringMatching(/behaved like a tracker/) });
    expect(out.answers[keyOf('paylater.example')]).toEqual(['necessary']);
    expect(p.purpose).toBe('Needs consent (behaves like a tracker)');
    expect(p.categories).toEqual(['advertising']);
    expect(cell(out, 'paylater.example', 'de:do-nothing').state).toBe('mismatch');
    expect(cell(out, 'paylater.example', 'us-ca:do-nothing').state).toBe('mismatch');
    expect(cell(out, 'paylater.example', 'de:accept').state).toBe('ok');
    // Its __cf_bm follows the tool (advertising ∪ cdn): red where the tool is red.
    expect(p.cookies[0].classified).toBe(true);
    expect(p.cookies[0].cells[colIndex(out, 'de:do-nothing')].state).toBe('mismatch');
    // Refused known tool keeps its purpose.
    const g = toolOf(out, 'Google Analytics 4');
    expect(g.purpose).toBe('Analytics');
    expect(g.answer?.applied).toBe(false);
    expect(cell(out, 'Google Analytics 4', 'de:do-nothing').state).toBe('ok'); // did not run before a choice
    expect(cell(out, 'Google Analytics 4', 'de:accept').state).toBe('ok');
    // Applied functional: a review widget loaded unasked needs consent under opt-in rules, may run in California.
    const r = toolOf(out, 'reviews.example');
    expect(r.answer).toEqual({ categories: ['functional'], applied: true });
    expect(r.purpose).toBe('Functional');
    expect(cell(out, 'reviews.example', 'de:do-nothing').state).toBe('mismatch');
    expect(cell(out, 'reviews.example', 'us-ca:do-nothing').state).toBe('ok');
    expect(r.cookies[0].purpose).toBe('Functional');
    // Skipped columns stay as they were.
    expect(cell(out, 'reviews.example', 'de:reject').state).toBe('not-checked');
    // Nothing left to decide; the counts follow.
    expect(out.decisions).toEqual([]);
    expect(out.matrix.counts.needsDecision).toBe(0);
    expect(base.matrix.counts.needsDecision).toBeGreaterThan(0);
  });

  it('a two-category answer is judged on the whole set, as the technical report is: functional + advertising is held in a wiretap state', () => {
    const out = judgeOwnerReport(base, answersByKey({ 'unknown:reviews.example': ['functional', 'advertising'] }));
    const r = toolOf(out, 'reviews.example');
    expect(r.answer).toEqual({ categories: ['functional', 'advertising'], applied: true });
    expect(r.purpose).toBe('Functional · Advertising');
    expect(cell(out, 'reviews.example', 'us-ca:do-nothing').state).toBe('mismatch');
    expect(cell(out, 'reviews.example', 'us-ca:accept').state).toBe('ok');
  });

  it('an unanswered tool stays on its base judgement, with its cookie waiting on it', () => {
    const out = judgeOwnerReport(base, answersByKey({ 'google.analytics': 'analytics' }));
    const r = toolOf(out, 'reviews.example');
    expect(r.classified).toBe(false);
    expect(r.answer).toBeUndefined();
    expect(cell(out, 'reviews.example', 'de:do-nothing').state).toBe('needs-decision');
    expect(r.cookies[0]).toMatchObject({ classified: false, purpose: 'Depends on what reviews.example is for' });
    expect(out.decisions.map((d) => d.label)).toEqual(['paylater.example', 'reviews.example']);
  });
});

describe('D. browser-safe', () => {
  it('owner-judge imports only cookie-purpose and types', () => {
    const src = fs.readFileSync(new URL('../src/report/owner-judge.ts', import.meta.url), 'utf8');
    const imports = src.split('\n').filter((l) => /^import\s/.test(l) && !/^import type\s/.test(l));
    expect(imports.every((l) => l.includes("'./cookie-purpose.js'")), imports.join('\n')).toBe(true);
  });
  it('cookie-purpose has no value imports (the browser bundle must not pull in src/registry)', () => {
    const src = fs.readFileSync(new URL('../src/report/cookie-purpose.ts', import.meta.url), 'utf8');
    const imports = src.split('\n').filter((l) => /^(import|export\s.*\sfrom)\s/.test(l) && !/^(import|export)\s+type\s/.test(l));
    expect(imports, imports.join('\n')).toEqual([]);
  });
  it('categoryLabel lives in cookie-purpose and covers the four buckets and the legacy ids', () => {
    expect(categoryLabel(['necessary'])).toBe('Necessary');
    expect(categoryLabel(['functional'])).toBe('Functional');
    expect(categoryLabel(['analytics'])).toBe('Analytics');
    expect(categoryLabel(['advertising'])).toBe('Advertising');
    expect(categoryLabel(['reviews'])).toBe('Reviews');
    expect(categoryLabel([])).toBe('Unclassified');
  });
});
