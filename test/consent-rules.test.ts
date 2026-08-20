import { describe, it, expect } from 'vitest';
import { getRule } from '../src/index.js';
import type { Artifact, RawFinding } from '../src/index.js';

// Consent + GDPR rules, tested from recorded artifacts (no browser).

function run(ruleId: string, kind: string, artifacts: Artifact[]): RawFinding[] {
  const rule = getRule(ruleId);
  if (!rule || rule.layer === 'llm' || !('evaluate' in rule)) throw new Error('not a deterministic rule');
  return rule.evaluate({ [kind]: artifacts } as never, { property: 'shop' });
}

const cookieCapture = (phase: string, names: string[]): Artifact => ({
  kind: 'cookie-capture',
  subject: { property: 'shop' },
  capturedAt: '2026-08-19T00:00:00.000Z',
  phase: phase as 'pre-consent',
  cookies: names.map((name) => ({ name, domain: '.shop.example' })),
  storage: [],
});

const consentFlow = (over: Partial<Record<string, unknown>>): Artifact => ({
  kind: 'consent-flow',
  subject: { property: 'shop' },
  capturedAt: '2026-08-19T00:00:00.000Z',
  cmp: 'heuristic',
  clicksToAccept: 1,
  clicksToReject: 1,
  buttonMetrics: [],
  ...over,
});

describe('pre-consent tracker rule', () => {
  it('flags a known tracker cookie set pre-consent as a violation, skips necessary cookies', () => {
    const findings = run('consent.pre-consent-tracker', 'cookie-capture', [
      cookieCapture('pre-consent', ['_ga', 'session_id', '_fbp']),
    ]);
    const names = findings.map((f) => (f.details as { name: string }).name).sort();
    expect(names).toEqual(['_fbp', '_ga']); // session_id is necessary
    expect(findings.every((f) => f.confidence === 'violation')).toBe(true); // known vendors
    expect(String(findings[0].requirementId)).toBe('gdpr.art7.4');
  });

  it('does not flag trackers in the post-accept phase', () => {
    const findings = run('consent.pre-consent-tracker', 'cookie-capture', [cookieCapture('post-accept', ['_ga'])]);
    expect(findings).toHaveLength(0);
  });

  it('flags legacy analytics cookies too (vendor-attributed -> violation)', () => {
    const findings = run('consent.pre-consent-tracker', 'cookie-capture', [cookieCapture('pre-consent', ['__utma'])]);
    expect(findings).toHaveLength(1);
    expect(findings[0].confidence).toBe('violation');
    expect((findings[0].details as { vendor: string }).vendor).toMatch(/Google Analytics/);
  });
});

describe('consent asymmetry rule', () => {
  it('flags a banner with no reject path', () => {
    const findings = run('consent.click-asymmetry', 'consent-flow', [consentFlow({ clicksToReject: null })]);
    expect(findings).toHaveLength(1);
    expect((findings[0].details as { pattern: string }).pattern).toBe('no-reject');
    expect(String(findings[0].requirementId)).toBe('gdpr.art7.3');
  });

  it('flags click asymmetry when reject costs more clicks than accept', () => {
    const findings = run('consent.click-asymmetry', 'consent-flow', [consentFlow({ clicksToAccept: 1, clicksToReject: 2 })]);
    expect(findings.some((f) => (f.details as { pattern: string }).pattern === 'click-asymmetry')).toBe(true);
  });

  it('flags prominence asymmetry when accept dwarfs reject', () => {
    const findings = run('consent.click-asymmetry', 'consent-flow', [
      consentFlow({
        buttonMetrics: [
          { role: 'accept', area: 10000, fontSizePx: 16, background: 'rgb(0,120,0)', visible: true },
          { role: 'reject', area: 1000, fontSizePx: 12, background: 'rgb(240,240,240)', visible: true },
        ],
      }),
    ]);
    expect(findings.some((f) => (f.details as { pattern: string }).pattern === 'prominence-asymmetry')).toBe(true);
  });

  it('says nothing when no CMP banner was detected', () => {
    const findings = run('consent.click-asymmetry', 'consent-flow', [consentFlow({ cmp: undefined, clicksToReject: null })]);
    expect(findings).toHaveLength(0);
  });
});
