import { describe, it, expect } from 'vitest';
import type { LocationSummary, PartyInventoryItem } from '../src/record/index.js';
import { behaviorCellsFrom } from '../src/rules/tracking/index.js';
import { compareCookieBehavior, type ComparisonFacts, type PrivacyRegime } from '../src/report/cookie-purpose.js';
import { scopeLine } from '../src/report/consent-scope.js';
import { isWiretapJurisdiction, WIRETAP_CATEGORIES, describeLocationRules } from '../src/registry/index.js';
import { noBannerReason } from '../src/collect/browser/evaluation/scenarios.js';
import type { ConsentReportModel } from '../types/index.js';

// Wiretap posture (field run storyfolder.com, 2026-10-08). California is an
// opt-out state under the CCPA, so the matrix called Meta Pixel and Google Ads
// firing before any choice "working as expected" and the headline read "101
// checks working as expected" — while the scan's own wiretap rule had found the
// exact pattern CIPA §631 / §638.51 suits are built on. complykit exists to
// catch that pattern, so in the wiretap-litigation states (CA, FL, PA) the
// wiretap-relevant categories are expected OFF until the visitor accepts.
// Resolves plans/consent-design.md open question 2 (Jeff, 2026-10-08).

describe('registry: which jurisdictions carry wiretap-litigation exposure', () => {
  it('California, Florida and Pennsylvania do; other states, the EU and the bare US do not', () => {
    expect(isWiretapJurisdiction(['us', 'us-ca'])).toBe(true);
    expect(isWiretapJurisdiction(['us', 'us-fl'])).toBe(true);
    expect(isWiretapJurisdiction(['us', 'us-pa'])).toBe(true);
    expect(isWiretapJurisdiction(['us', 'us-tx'])).toBe(false);
    expect(isWiretapJurisdiction(['us'])).toBe(false);
    expect(isWiretapJurisdiction(['eu', 'eu-de'])).toBe(false);
    expect(isWiretapJurisdiction([])).toBe(false);
  });

  it('California’s location rules say ad, recording, chat and identity tools are held until the visitor accepts, and why', () => {
    const ca = describeLocationRules(['us', 'us-ca'], '2026-10-08');
    const text = [ca.label, ca.summary, ...ca.mustHave].join('\n');
    expect(text).toMatch(/wiretap/i);
    expect(text).toMatch(/until the visitor accepts/i);
    const tx = describeLocationRules(['us', 'us-tx'], '2026-10-08');
    expect([tx.label, tx.summary, ...tx.mustHave].join('\n')).not.toMatch(/wiretap/i);
  });
});

describe('compareCookieBehavior: wiretap posture (runs inside saved HTML, so it carries its own category list)', () => {
  const facts = (scenario: string, regime: PrivacyRegime, wiretap: boolean, over: Partial<ComparisonFacts> = {}): ComparisonFacts => ({ scenario, regime, wiretap, hasActivity: true, limitedOnly: false, captureGap: false, ...over });
  const cmp = (scenario: string, regime: PrivacyRegime, wiretap: boolean, categories: string[], over: Partial<ComparisonFacts> = {}) => compareCookieBehavior(facts(scenario, regime, wiretap, over), { categories });

  it('an ad tool firing before any choice in a wiretap state is a mismatch, and the expectation says why', () => {
    for (const s of ['do-nothing', 'browse', 'markers', 'dismiss']) {
      const r = cmp(s, 'opt-out-signal', true, ['advertising']);
      expect(r.status, s).toBe('mismatch');
      expect(r.expected, s).toMatch(/until the visitor accepts/i);
      expect(r.expected, s).toMatch(/wiretap/i);
    }
  });

  it('every wiretap category is held (the inline list cannot drift from the registry)', () => {
    for (const c of WIRETAP_CATEGORIES) expect(cmp('do-nothing', 'opt-out-signal', true, [c]).status, c).toBe('mismatch');
  });

  it('accepting releases it; not running before a choice meets it', () => {
    expect(cmp('accept', 'opt-out-signal', true, ['advertising']).status).toBe('match');
    expect(cmp('do-nothing', 'opt-out-signal', true, ['advertising'], { hasActivity: false }).status).toBe('match');
  });

  it('refusals and opt-outs stay off, as before', () => {
    for (const s of ['reject', 'gpc', 'opt-out-all', 'opt-out-link']) expect(cmp(s, 'opt-out-signal', true, ['advertising']).status, s).toBe('mismatch');
    expect(cmp('partial', 'opt-out-signal', true, ['advertising']).status).toBe('mismatch');
  });

  it('chat and session recording are held too (the classic CIPA targets)', () => {
    expect(cmp('do-nothing', 'opt-out-signal', true, ['chat']).status).toBe('mismatch');
    expect(cmp('browse', 'opt-out-signal', true, ['session-recording', 'analytics']).status).toBe('mismatch');
  });

  it('analytics alone is not a wiretap category: unchanged', () => {
    expect(cmp('do-nothing', 'opt-out-signal', true, ['analytics']).status).toBe('match');
  });

  it('limited-only pings (Consent Mode cookieless, Meta LDU) keep their existing treatment', () => {
    expect(cmp('do-nothing', 'opt-out-signal', true, ['advertising'], { limitedOnly: true }).status).toBe('match');
  });

  it('a state without wiretap exposure is unchanged, and so are opt-in and reports saved without the flag', () => {
    expect(cmp('do-nothing', 'opt-out-signal', false, ['advertising']).status).toBe('match');
    expect(compareCookieBehavior({ scenario: 'do-nothing', regime: 'opt-out-signal', hasActivity: true, limitedOnly: false, captureGap: false }, { categories: ['advertising'] }).status).toBe('match');
    expect(cmp('do-nothing', 'opt-in', true, ['advertising']).status).toBe('mismatch');
    expect(cmp('accept', 'opt-in', true, ['advertising']).status).toBe('match');
  });
});

describe('behaviorCellsFrom: wiretap posture in the compatibility expectation', () => {
  const party = (partyId: string, categories: string[]): PartyInventoryItem => ({
    partyId, label: partyId, domain: `${partyId.split('.')[0]}.test`, hosts: [`${partyId.split('.')[0]}.test`], recognized: true, kbStatus: 'confirmed',
    categories, behavesLikeTracker: true, trackerSignals: [], sends: [], stores: [], sources: [], loadedBy: [], samples: [],
    seenIn: [{ location: 'local', scenario: 'do-nothing', requests: 2, firstMs: 10, phases: ['no-banner'] }],
  });
  const loc = (jurisdictions: string[]): LocationSummary => ({
    spec: { id: 'local', proxied: false },
    verification: { verdict: 'verified', expected: {}, observed: {}, sources: [], siteReported: [], jurisdictions, checkedAt: '2026-10-08T00:00:00Z' },
    scenarios: [{ scenario: 'do-nothing', status: 'tested', evidence: { screenshots: [] } }],
  });
  const obs = (partyId: string) => [{ location: 'local', scenario: 'do-nothing' as const, durationMs: 1000, knownPartyIds: [partyId], parties: [{ partyId, dataRequests: 2, requestPhases: ['no-banner'], dataRequestPhases: { 'no-banner': 2 }, limitedRequestsByPhase: {}, stores: [] }] }];
  const cells = (jurisdictions: string[], partyId: string, categories: string[]) =>
    behaviorCellsFrom({ locations: [loc(jurisdictions)], inventory: [party(partyId, categories)], behaviorObservations: obs(partyId) });

  it('California, no banner, Meta Pixel sending → mismatch citing the wiretap posture', () => {
    const c = cells(['us', 'us-ca'], 'meta.pixel', ['advertising']);
    expect(c).toEqual([expect.objectContaining({ partyId: 'meta.pixel', scenario: 'do-nothing', status: 'mismatch' })]);
    expect(c[0].reason).toMatch(/wiretap/i);
  });

  it('Florida too; Texas and analytics in California are unchanged', () => {
    expect(cells(['us', 'us-fl'], 'meta.pixel', ['advertising'])[0].status).toBe('mismatch');
    expect(cells(['us', 'us-tx'], 'meta.pixel', ['advertising'])[0].status).toBe('no-mismatch-observed');
    expect(cells(['us', 'us-ca'], 'google.analytics', ['analytics'])[0].status).toBe('no-mismatch-observed');
  });
});

describe('headline: problems before the green number', () => {
  const model = (statuses: string[], exposure: number) =>
    ({
      behaviorMatrix: { rows: [{ cells: statuses.map((status) => ({ status })) }] },
      behaviorObservations: [{ pages: 13 }],
      locations: [{ id: 'local', verdict: 'verified' }],
      scenarios: ['do-nothing'],
      grid: { local: { 'do-nothing': { status: 'tested', runs: 1 } } },
      totals: { violation: 0, 'needs-review': 0, exposure, practice: 0 },
    }) as unknown as ConsentReportModel;

  it('leads with mismatches and litigation exposure when there are any', () => {
    expect(scopeLine(model(['mismatch', 'mismatch', 'match'], 3))).toBe('2 behavior mismatches and 3 litigation exposures — 1 check working as expected on 13 pages, 1 location, logged out, 1 run each');
    expect(scopeLine(model(['mismatch', 'match', 'match'], 0))).toBe('1 behavior mismatch — 2 checks working as expected on 13 pages, 1 location, logged out, 1 run each');
    expect(scopeLine(model(['match'], 1))).toBe('1 litigation exposure — 1 check working as expected on 13 pages, 1 location, logged out, 1 run each');
  });

  it('unchanged when there is nothing to lead with', () => {
    expect(scopeLine(model(['match', 'allowed'], 0))).toBe('2 checks working as expected on 13 pages, 1 location, logged out, 1 run each');
  });
});

describe('scenario skipped for no banner: say what was actually seen', () => {
  it('a consent tool on the page that showed no banner is not a detection failure', () => {
    const r = noBannerReason('cookieconsent3');
    expect(r).toMatch(/consent tool \(cookieconsent3\) is on the page but showed no banner/);
    expect(r).not.toMatch(/did not recognize/);
  });
  it('with no consent tool seen, the old wording stands', () => {
    expect(noBannerReason()).toBe('no consent banner detected (if the site shows one, the driver did not recognize it)');
  });
});
