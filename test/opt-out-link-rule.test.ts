import { describe, expect, it } from 'vitest';
import { getRule } from '../src/rules/index.js';
import type { Artifact, RawFinding } from '../src/record/index.js';

// PR B contract (plans/location-rules-plan.md): tracking.opt-out-link fires under
// ccpa.opt-out-link in California and under us-states.opt-out-method in every
// other state whose act is in force on the scan date. Hand-built timelines; no
// browser.

const PLACES: Record<string, { id: string; country: string; region?: string; jurisdictions: string[] }> = {
  ca: { id: 'us-ca', country: 'US', region: 'CA', jurisdictions: ['us', 'us-ca'] },
  tx: { id: 'us-tx', country: 'US', region: 'TX', jurisdictions: ['us', 'us-tx'] },
  va: { id: 'us-va', country: 'US', region: 'VA', jurisdictions: ['us', 'us-va'] },
  ok: { id: 'us-ok', country: 'US', region: 'OK', jurisdictions: ['us', 'us-ok'] },
  ny: { id: 'us-ny', country: 'US', region: 'NY', jurisdictions: ['us', 'us-ny'] },
  us: { id: 'us', country: 'US', jurisdictions: ['us'] },
  de: { id: 'de', country: 'DE', jurisdictions: ['eu', 'eu-de'] },
};

const AD_REQUEST = {
  type: 'request', t: 500, id: 'r1', url: 'https://www.facebook.com/tr/?id=1&ev=PageView&dl=https%3A%2F%2Fexample-shop.test%2F', method: 'GET', resourceType: 'image',
  origin: 'page', pageUrl: 'https://example-shop.test/', pageIndex: 0, initiator: { type: 'script', chain: ['https://connect.facebook.net/en_US/fbevents.js'] }, status: 200, setCookies: [],
};

function timeline(
  place: keyof typeof PLACES,
  walk: Record<string, unknown> | undefined,
  opts: { verified?: boolean; ads?: boolean; startedAt?: string } = {},
): Artifact {
  const p = PLACES[place];
  const verified = opts.verified !== false;
  const events: Record<string, unknown>[] = [];
  if (opts.ads !== false) events.push(AD_REQUEST);
  if (walk) events.push({ type: 'opt-out-walk', t: 2000, requiredFields: [], pageIndex: 0, ...walk });
  return {
    kind: 'consent-timeline',
    subject: { property: 'shop', routePattern: '*', instanceUrl: 'https://example-shop.test/' },
    capturedAt: '2026-10-08T00:00:00.000Z',
    scenario: 'opt-out-link',
    location: { id: p.id, label: p.id, country: p.country, ...(p.region ? { region: p.region } : {}) },
    verification: {
      verdict: verified ? 'verified' : 'unknown',
      expected: { country: p.country, ...(p.region ? { region: p.region } : {}) },
      observed: { country: p.country, region: p.region },
      sources: [],
      siteReported: [],
      jurisdictions: verified ? p.jurisdictions : [],
      checkedAt: '2026-10-08T00:00:00.000Z',
    },
    events,
    snapshot: {
      site: { url: 'https://example-shop.test/', host: 'example-shop.test', registrableDomain: 'example-shop.test' },
      scenario: 'opt-out-link', locationId: p.id, startedAt: opts.startedAt ?? '2026-10-08T00:00:00.000Z', durationMs: 3000, gpc: false,
      browser: { name: 'chromium' }, pages: [{ url: 'https://example-shop.test/' }], cookies: [], storage: [], frames: [], dns: [], notTested: [], evidence: {},
    },
  } as unknown as Artifact;
}

function run(artifacts: Artifact[]): RawFinding[] {
  const rule = getRule('tracking.opt-out-link');
  if (!rule || rule.layer === 'llm' || !('evaluate' in rule)) throw new Error('not a deterministic rule');
  return rule.evaluate({ 'consent-timeline': artifacts } as never, { property: 'shop' });
}
const pat = (f: RawFinding): string => (f.details as { pattern: string }).pattern;
const req = (f: RawFinding): string => String(f.requirementId);
const scope = (f: RawFinding): string | undefined => f.subject.locator?.landmark;

const NO_LINK = { found: false };
const PRIVACY_CHOICES_NO_ICON = { found: true, linkText: 'Your Privacy Choices', href: '/privacy-choices', hasIcon: false, steps: 1 };
const FRICTION = { found: true, linkText: 'Opt out of targeted advertising', href: '/opt-out', hasIcon: false, steps: 4, requiredFields: ['email', 'full name'] };

describe('tracking.opt-out-link by state', () => {
  it('declares both requirements', () => {
    const rule = getRule('tracking.opt-out-link')!;
    expect(rule.requirements.map(String).sort()).toEqual(['ccpa.opt-out-link', 'us-states.opt-out-method']);
  });

  it('California: missing link → ccpa.opt-out-link, landmark us-ca, one finding', () => {
    const out = run([timeline('ca', NO_LINK)]);
    expect(out.map((f) => [pat(f), req(f), scope(f)])).toEqual([['missing-link', 'ccpa.opt-out-link', 'us-ca']]);
    expect(out[0].message).toMatch(/Do Not Sell or Share/);
  });

  it('Texas: missing link → us-states.opt-out-method, landmark us-tx; the message names the Texas act, not 11 CCR', () => {
    const out = run([timeline('tx', NO_LINK)]);
    expect(out.map((f) => [pat(f), req(f), scope(f)])).toEqual([['missing-link', 'us-states.opt-out-method', 'us-tx']]);
    expect(out[0].message).toMatch(/Texas Data Privacy and Security Act/);
    expect(out[0].message).not.toMatch(/CCR|Do Not Sell or Share/);
    expect(out[0].confidence).toBe('needs-review');
  });

  it('Virginia (act in force, no signal duty): missing link fires too', () => {
    const out = run([timeline('va', NO_LINK)]);
    expect(out.map((f) => [pat(f), req(f), scope(f)])).toEqual([['missing-link', 'us-states.opt-out-method', 'us-va']]);
    expect(out[0].message).toMatch(/Virginia Consumer Data Protection Act/);
  });

  it('no advertising party at the location: a missing link is not a finding, in any state', () => {
    expect(run([timeline('ca', NO_LINK, { ads: false })])).toEqual([]);
    expect(run([timeline('tx', NO_LINK, { ads: false })])).toEqual([]);
  });

  it('the icon rule is California-only: “Your Privacy Choices” without an icon is missing-icon in CA and nothing in TX', () => {
    expect(run([timeline('ca', PRIVACY_CHOICES_NO_ICON)]).map(pat)).toEqual(['missing-icon']);
    expect(run([timeline('tx', PRIVACY_CHOICES_NO_ICON)])).toEqual([]);
  });

  it('friction patterns fire in both scopes, with the state requirement outside California', () => {
    const ca = run([timeline('ca', FRICTION)]);
    expect(ca.map(pat).sort()).toEqual(['requires-personal-info', 'too-many-steps']);
    expect(new Set(ca.map(req))).toEqual(new Set(['ccpa.opt-out-link']));
    const tx = run([timeline('tx', FRICTION)]);
    expect(tx.map(pat).sort()).toEqual(['requires-personal-info', 'too-many-steps']);
    expect(new Set(tx.map(req))).toEqual(new Set(['us-states.opt-out-method']));
    for (const f of tx) expect(f.message).not.toMatch(/§70\d\d/);
  });

  it('a state whose act starts after the scan date is inert; on the date it fires', () => {
    expect(run([timeline('ok', NO_LINK)])).toEqual([]);
    const later = run([timeline('ok', NO_LINK, { startedAt: '2027-01-01T00:00:00.000Z' })]);
    expect(later.map((f) => [pat(f), req(f), scope(f)])).toEqual([['missing-link', 'us-states.opt-out-method', 'us-ok']]);
  });

  it('no act state, unverified state, unverified location, EU: nothing', () => {
    expect(run([timeline('ny', NO_LINK)])).toEqual([]);
    expect(run([timeline('us', NO_LINK)])).toEqual([]);
    expect(run([timeline('tx', NO_LINK, { verified: false })])).toEqual([]);
    expect(run([timeline('de', NO_LINK)])).toEqual([]);
  });

  it('California and Texas in one run: one finding each, never a CCPA finding for Texas', () => {
    const out = run([timeline('ca', NO_LINK), timeline('tx', NO_LINK)]);
    expect(out.map((f) => [req(f), scope(f)]).sort()).toEqual([['ccpa.opt-out-link', 'us-ca'], ['us-states.opt-out-method', 'us-tx']]);
  });
});
