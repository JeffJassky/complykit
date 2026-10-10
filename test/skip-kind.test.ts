import { describe, it, expect } from 'vitest';
import { skipKindOf, skipCauseOf } from '../src/report/skip-kind.js';
import { buildConsentReportModel } from '../src/report/consent-model.js';
import { buildOwnerReport } from '../src/report/owner-report.js';
import { TrackingEvaluation } from '../src/record/index.js';

// A skipped check is one of three kinds, and the owner must be able to tell them apart
// (2026-10-09): nothing to test (grey), the scan could not (amber, unknown — never a pass),
// or the site stopped the visitor (red: if the scan cannot do it, neither can a visitor).

const EU = { regime: 'opt-in', wiretap: false };
const CA = { regime: 'opt-out-signal', wiretap: true };
const TX = { regime: 'opt-out-signal', wiretap: false };
const skipped = (cause?: string, status: 'not-tested' | 'not-applicable' = 'not-tested', reason?: string) => ({ status, ...(cause ? { cause: cause as never } : {}), ...(reason ? { reason } : {}) });

describe('skipKindOf', () => {
  it('nothing to test: no banner, no close control — anywhere', () => {
    for (const where of [EU, CA, TX]) {
      expect(skipKindOf(skipped('no-banner', 'not-applicable'), where)).toBe('not-applicable');
      expect(skipKindOf(skipped('no-close', 'not-applicable'), where)).toBe('not-applicable');
    }
  });

  it('the scan could not: a failed click, a timeout, a crash, bot protection, an action not run', () => {
    for (const c of ['choice-failed', 'timeout', 'crashed', 'bot-blocked', 'opt-out-asks-personal-data']) expect(skipKindOf(skipped(c), EU), c).toBe('untestable');
    expect(skipKindOf({ status: 'not-run' }, EU)).toBe('untestable');
    expect(skipKindOf(skipped(undefined, 'not-tested', 'location unverified'), EU)).toBe('untestable');
  });

  it('a consent tool that crashed before drawing its banner blocks the visitor everywhere (the site meant to ask and cannot); older reports are read from the reason', () => {
    for (const where of [EU, CA, TX]) expect(skipKindOf(skipped('tool-broken'), where)).toBe('blocked');
    expect(skipCauseOf(skipped(undefined, 'not-tested', 'the consent tool (x) is on the page but its script crashed before showing a banner, so …'))).toBe('tool-broken');
  });

  it('the site blocked the visitor: a dead settings control anywhere; no way to withdraw where consent is the choice; no per-category choice under opt-in; no opt-out link where the law requires one', () => {
    for (const where of [EU, CA, TX]) expect(skipKindOf(skipped('settings-dead'), where)).toBe('blocked');
    expect(skipKindOf(skipped('no-withdraw-entry'), EU)).toBe('blocked');
    expect(skipKindOf(skipped('no-withdraw-entry'), CA)).toBe('blocked');
    expect(skipKindOf(skipped('no-withdraw-entry'), TX)).toBe('not-applicable');
    expect(skipKindOf(skipped('no-category-choice'), EU)).toBe('blocked');
    expect(skipKindOf(skipped('no-category-choice'), CA)).toBe('not-applicable');
    expect(skipKindOf(skipped('no-opt-out-link'), TX)).toBe('blocked');
    expect(skipKindOf(skipped('no-opt-out-link'), { regime: 'unknown', wiretap: true })).toBe('not-applicable');
  });

  it('reports saved before cause codes fall back to the recorded reason (storyfolder.com, 2026-10-08)', () => {
    expect(skipCauseOf(skipped(undefined, 'not-applicable', 'the banner offers no way to close it without choosing'))).toBe('no-close');
    expect(skipCauseOf(skipped(undefined, 'not-applicable', 'the consent tool (cookieconsent3) is on the page but showed no banner to this visitor'))).toBe('no-banner');
    expect(skipKindOf(skipped(undefined, 'not-tested', 'the banner’s “Cookie settings” control did not open the cookie settings, so a visitor cannot choose per category'), EU)).toBe('blocked');
    expect(skipKindOf(skipped(undefined, 'not-tested', 'could not grant a single category (no recognizable analytics-only control)'), EU)).toBe('untestable');
    expect(skipKindOf({ status: 'tested', choiceGap: 'No opt-out link was found, so the opt-out could not be made.' }, TX)).toBe('blocked');
  });
});

describe('owner report: the three kinds reach the columns, cells and counts', () => {
  const site = { url: 'https://shop.example/', host: 'shop.example', registrableDomain: 'shop.example' };
  const meta = { partyId: 'meta.pixel', label: 'Meta Pixel', domain: 'facebook.com', hosts: ['facebook.com'], recognized: true, kbStatus: 'proposed', categories: ['advertising'], behavesLikeTracker: true, trackerSignals: [], sends: [], stores: [], sources: ['injected'], loadedBy: [], seenIn: [] };
  const location = { spec: { id: 'de', label: 'Germany', country: 'DE', proxied: false }, verification: { verdict: 'verified', expected: { country: 'DE' }, observed: { country: 'DE' }, sources: [], jurisdictions: ['eu', 'eu-de'], checkedAt: 'now' } };
  const banner = { found: true, cmp: 'cookieconsent3' };
  const scenarios = [
    { scenario: 'do-nothing', status: 'tested', banner },
    { scenario: 'reject', status: 'tested', banner, choice: { kind: 'reject', ok: true, method: 'button' } },
    { scenario: 'dismiss', status: 'not-applicable', reason: 'the banner offers no way to close it without choosing', cause: 'no-close', banner },
    { scenario: 'partial', status: 'not-tested', reason: 'the banner’s “Cookie settings” control did not open the cookie settings, so a visitor cannot choose per category', cause: 'settings-dead', banner },
    { scenario: 'accept', status: 'not-tested', reason: 'could not make the "accept" choice (heuristic)', cause: 'choice-failed', banner },
  ];
  const obs = (scenario: string) => ({ location: 'de', scenario, durationMs: 10000, pages: 2, knownPartyIds: ['meta.pixel'], parties: [] });
  const ev = TrackingEvaluation.parse({
    runId: 'r1', property: 'shop', site, startedAt: '2026-10-09T10:00:00Z', finishedAt: '2026-10-09T10:05:00Z', versions: { kb: '0', registry: '0', package: '0' },
    locations: [{ ...location, scenarios }], inventory: [meta], notTested: [], researchQueue: [], redacted: true, behaviorObservations: [obs('do-nothing'), obs('reject')],
  });
  const r = buildOwnerReport({ runId: 'r1', site, startedAt: ev.startedAt, finishedAt: ev.finishedAt, stage: 'final', model: buildConsentReportModel(ev, []) });
  const col = (s: string) => r.matrix.columns.find((c) => c.scenario === s)!;
  const cell = (s: string) => r.matrix.tools[0].cells[r.matrix.columns.indexOf(col(s))];

  it('no close control: not applicable, said once, grey', () => {
    expect(col('dismiss')).toMatchObject({ state: 'not-applicable' });
    expect(col('dismiss').note).toMatch(/no way to close/);
    expect(cell('dismiss').state).toBe('not-applicable');
  });

  it('a dead settings button: blocked — a problem, with the visitor-facing reason', () => {
    expect(col('partial')).toMatchObject({ state: 'blocked' });
    expect(cell('partial').state).toBe('blocked');
    expect(cell('partial').reason).toMatch(/^A visitor cannot do this: the banner’s “Cookie settings” control did not open/);
    expect(col('partial').note!.match(/A visitor cannot do this/g)).toHaveLength(1);
  });

  it('a click the scan could not make: not checked, never counted as working', () => {
    expect(col('accept')).toMatchObject({ state: 'not-checked' });
    expect(cell('accept').state).toBe('not-checked');
  });

  it('counts keep the kinds apart', () => {
    expect(r.matrix.counts).toMatchObject({ notApplicable: 1, blocked: 1, notChecked: 1 });
  });
});

