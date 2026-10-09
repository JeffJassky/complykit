import { describe, it, expect } from 'vitest';
import { compareCookieBehavior, type ComparisonFacts, type PrivacyRegime } from '../src/report/cookie-purpose.js';
import { regimeFor, categoryLabel } from '../src/report/consent-matrix.js';
import { buildConsentReportModel } from '../src/report/consent-model.js';
import { TrackingEvaluation } from '../src/record/index.js';

// The standard behavior per purpose category × visitor action × location rules,
// checked automatically against what the scan observed. A tool's cookies
// inherit its category, and only what can't be identified becomes research.

const facts = (scenario: string, regime: PrivacyRegime, over: Partial<ComparisonFacts> = {}): ComparisonFacts => ({ scenario, regime, hasActivity: true, limitedOnly: false, captureGap: false, ...over });
const status = (scenario: string, regime: PrivacyRegime, categories: string[], over: Partial<ComparisonFacts> = {}) => compareCookieBehavior(facts(scenario, regime, over), { categories }).status;

describe('expected behavior by category, visitor action and location rules', () => {
  it('opt-in (EU/UK): consent-type uses are off until permission and after refusal', () => {
    expect(status('do-nothing', 'opt-in', ['analytics'])).toBe('mismatch');
    expect(status('do-nothing', 'opt-in', ['analytics'], { hasActivity: false })).toBe('match');
    expect(status('reject', 'opt-in', ['advertising'])).toBe('mismatch');
    expect(status('withdraw', 'opt-in', ['session-recording', 'analytics'])).toBe('mismatch');
    expect(status('accept', 'opt-in', ['advertising'])).toBe('match');
    expect(status('partial', 'opt-in', ['analytics'])).toBe('match');
    expect(status('partial', 'opt-in', ['advertising'])).toBe('mismatch');
    // A privacy signal with no choice is still "no permission" under opt-in rules.
    expect(status('gpc', 'opt-in', ['analytics'])).toBe('mismatch');
  });

  it('US with an opt-out-signal law: may run before a choice; sale/share stops under the signal', () => {
    expect(status('do-nothing', 'opt-out-signal', ['analytics'])).toBe('match');
    expect(status('do-nothing', 'opt-out-signal', ['advertising'])).toBe('match');
    expect(status('gpc', 'opt-out-signal', ['advertising'])).toBe('mismatch');
    expect(status('gpc', 'opt-out-signal', ['advertising'], { hasActivity: false })).toBe('match');
    expect(status('gpc', 'opt-out-signal', ['advertising'], { limitedOnly: true })).toBe('match'); // rdp / LDU
    expect(status('opt-out-link', 'opt-out-signal', ['identity-resolution'])).toBe('mismatch');
    expect(status('gpc', 'opt-out-signal', ['analytics'])).toBe('match'); // not a sale/share use
  });

  it('US opt-out rules: running after the visitor accepted the banner is expected, and the label says why', () => {
    for (const regime of ['opt-out-signal', 'opt-out'] as const) {
      for (const cats of [['advertising'], ['analytics'], ['session-recording']]) {
        const r = compareCookieBehavior(facts('accept', regime), { categories: cats });
        expect(r.status).toBe('match');
        expect(r.expected).toBe('May run: the visitor accepted');
        expect(compareCookieBehavior(facts('accept', regime, { hasActivity: false }), { categories: cats }).status).toBe('match');
      }
    }
  });

  it('US without an opt-out-signal law: the signal is not required, but a refusal the site offered is', () => {
    expect(status('gpc', 'opt-out', ['advertising'])).toBe('match');
    expect(status('reject', 'opt-out', ['analytics'])).toBe('mismatch');
    expect(status('do-nothing', 'opt-out', ['advertising'])).toBe('match');
  });

  it('necessary uses may always run; unclassified ones ask for a classification (a fact); a place with no mapped law gets opt-in, the strictest rules', () => {
    expect(status('do-nothing', 'opt-in', ['necessary'])).toBe('match');
    expect(status('reject', 'opt-in', ['cdn'])).toBe('match');
    expect(status('do-nothing', 'opt-in', ['unknown'])).toBe('review');
    expect(status('do-nothing', 'opt-in', [])).toBe('review');
    expect(status('do-nothing', 'unknown', ['analytics'])).toBe('mismatch');
    expect(status('accept', 'unknown', ['analytics'])).toBe('match');
  });

  it('context uses (chat, embeds, fonts) loaded unasked under opt-in rules are a problem: the scan never asks for the feature (2026-10-09)', () => {
    expect(status('do-nothing', 'opt-in', ['chat'])).toBe('mismatch');
    expect(status('reject', 'opt-in', ['fonts'])).toBe('mismatch');
    expect(status('accept', 'opt-in', ['embed'])).toBe('match');
    expect(status('do-nothing', 'opt-in', ['chat'], { hasActivity: false })).toBe('match');
    expect(status('do-nothing', 'opt-out-signal', ['chat'])).toBe('match');
  });

  it('reports saved before regimes existed keep the opt-in comparison', () => {
    expect(compareCookieBehavior({ scenario: 'do-nothing', hasActivity: true, limitedOnly: false, captureGap: false }, { categories: ['analytics'] }).status).toBe('mismatch');
  });

  it('names categories plainly for the grid', () => {
    expect(categoryLabel(['session-recording', 'analytics'])).toBe('Session recording · Analytics');
    expect(categoryLabel(['cdn'])).toBe('Necessary (content delivery)');
    expect(categoryLabel(['unknown'])).toBe('Unclassified');
    expect(categoryLabel([])).toBe('Unclassified');
  });

  it('derives the rules from the verified location', () => {
    expect(regimeFor(['eu', 'eu-de']).regime).toBe('opt-in');
    expect(regimeFor(['uk']).regime).toBe('opt-in');
    expect(regimeFor(['us', 'us-ca']).regime).toBe('opt-out-signal');
    expect(regimeFor(['us']).regime).toBe('opt-out');
    expect(regimeFor(['br']).regime).toBe('unknown');
  });
});

describe('cookies inherit their tool; research covers only what is unknown', () => {
  const party = (id: string, recognized: boolean, categories: string[], cookie: string) => ({ partyId: id, label: id, domain: `${id}.example`, hosts: [`${id}.example`], recognized, kbStatus: recognized ? 'proposed' : 'unrecognized', categories, behavesLikeTracker: true, trackerSignals: [], sends: [], stores: [{ name: cookie, kind: 'cookie', lifetimeDays: 30 }], sources: ['injected'], loadedBy: [], seenIn: [] });
  const ev = TrackingEvaluation.parse({
    runId: 'r', property: 'p', site: { url: 'https://site.example/', host: 'site.example', registrableDomain: 'site.example' }, startedAt: 'a', finishedAt: 'b', versions: { kb: '0', registry: '0', package: '0' }, redacted: true,
    locations: [{ spec: { id: 'us-ca', label: 'California', country: 'US', region: 'CA', proxied: false }, verification: { verdict: 'verified', expected: { country: 'US' }, observed: { country: 'US', region: 'CA' }, sources: [], jurisdictions: ['us', 'us-ca'], checkedAt: 'now' }, scenarios: [{ scenario: 'do-nothing', status: 'tested' }, { scenario: 'gpc', status: 'tested' }] }],
    inventory: [party('clarityish', true, ['session-recording', 'analytics'], 'cx_visit'), party('mystery', false, ['unknown'], 'zz_id')],
    behaviorObservations: [
      { location: 'us-ca', scenario: 'do-nothing', durationMs: 1000, knownPartyIds: ['clarityish'], parties: [{ partyId: 'clarityish', dataRequests: 1, requestPhases: ['before-choice'], dataRequestPhases: { 'before-choice': 1 }, limitedRequestsByPhase: {}, stores: [{ name: 'cx_visit', kind: 'cookie', writePhases: ['before-choice'], presentAtEnd: true, attribution: 'observed' }] }] },
      { location: 'us-ca', scenario: 'gpc', durationMs: 1000, knownPartyIds: ['clarityish'], parties: [] },
    ],
    notTested: [], researchQueue: [],
  });
  const m = buildConsentReportModel(ev, []);

  it('gives an identified tool’s cookie the tool’s categories, and checks it under the location’s rules', () => {
    const sm = m.behaviorMatrix!.rows.find((r) => r.label === 'cx_visit')!;
    expect(sm.categories).toEqual(['session-recording', 'analytics']);
    expect(sm.categorySource).toBe('set by clarityish');
    expect(sm.cells.map((c) => c.status)).toEqual(['mismatch', 'match']); // California is a wiretap-litigation state: session recording is held until the visitor accepts (do-nothing → mismatch); with no activity under GPC it is met
    expect(m.behaviorMatrix!.columns.map((c) => c.scenario)).toEqual(['do-nothing', 'gpc']);
  });

  it('leaves a cookie of an unidentified tool unclassified', () => {
    const zz = m.behaviorMatrix!.rows.find((r) => r.label === 'zz_id')!;
    expect(zz.categories).toEqual([]);
  });

  it('creates research only for the unidentified tool and its cookie', () => {
    const labels = m.researchWorkflow!.items.filter((i) => i.target.kind !== 'finding').map((i) => i.target.label).sort();
    expect(labels).toEqual(['mystery', 'zz_id']);
  });
});
