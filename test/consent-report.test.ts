import { describe, it, expect } from 'vitest';
import { resolveFinding, asRunId, TrackingEvaluation, type Finding } from '../src/record/index.js';
import { resolveCapsFor } from '../src/rules/index.js';
import { buildConsentReportModel, renderConsentHtml, renderConsentMarkdown, containsBannedVocabulary, findingKind } from '../src/report/index.js';
import { groupConsentActions } from '../src/report/consent-view.js';

// The consent report: grid counts per location × scenario, finding kinds from
// the requirement (exposure is never a violation), the two sort orders, and
// the vocabulary guard over every renderer.

const evaluation = TrackingEvaluation.parse({
  runId: 'r1',
  property: 'shop',
  site: { url: 'https://shop.example/', host: 'shop.example', registrableDomain: 'shop.example' },
  versions: { kb: '0.1.0', registry: '0.2.0', package: '0.0.0' },
  startedAt: '2026-10-02T10:00:00Z',
  finishedAt: '2026-10-02T10:20:00Z',
  locations: [
    {
      spec: { id: 'de', label: 'Germany', country: 'DE', proxied: true },
      verification: { verdict: 'verified', expected: { country: 'DE' }, observed: { country: 'DE' }, sources: [], jurisdictions: ['eu', 'eu-de'], checkedAt: 'x' },
      scenarios: [
        { scenario: 'do-nothing', status: 'tested', banner: { found: true, cmp: 'OneTrust' } },
        { scenario: 'reject', status: 'tested', banner: { found: true, cmp: 'OneTrust' }, choice: { kind: 'reject', ok: true, method: 'autoconsent:OneTrust' } },
        { scenario: 'partial', status: 'not-tested', reason: 'no analytics-only control' },
      ],
    },
    {
      spec: { id: 'us-ca', label: 'California, US', country: 'US', region: 'CA', proxied: true },
      verification: { verdict: 'verified', expected: { country: 'US', region: 'CA' }, observed: { country: 'US', region: 'CA' }, sources: [], jurisdictions: ['us', 'us-ca'], checkedAt: 'x' },
      scenarios: [{ scenario: 'do-nothing', status: 'tested' }, { scenario: 'markers', status: 'tested' }],
    },
    {
      spec: { id: 'fr', label: 'France', country: 'FR', proxied: true },
      verification: { verdict: 'mismatch', expected: { country: 'FR' }, observed: { country: 'BE' }, sources: [], jurisdictions: [], checkedAt: 'x', note: 'exit is in BE' },
      scenarios: [],
    },
  ],
  inventory: [],
  notTested: [{ scope: 'location', id: 'fr', reason: 'location mismatch' }],
  researchQueue: [],
  redacted: true,
});

function finding(ruleId: string, requirementId: string, landmark: string, confidence: 'violation' | 'needs-review', occurrences: Array<{ location: string; scenario: string; phases: string[]; sent?: string[]; markers?: string[] }>): Finding {
  return resolveFinding(
    {
      ruleId,
      requirementId,
      subject: { property: 'shop', routePattern: '*', instanceUrl: 'https://shop.example/', locator: { role: 'tracking-party', name: `p-${ruleId}-${landmark}`, landmark, ordinal: 0 } },
      confidence,
      message: `${ruleId} message`,
      details: { occurrences: occurrences.map((o) => ({ firstMs: 400, requests: 2, sent: o.sent ?? ['page-address'], stored: [], decoded: [], markers: o.markers ?? [], ...o })), party: { label: 'X', domain: 'x.example', categories: ['advertising'], kbStatus: 'proposed', recognized: true } },
      evidence: [],
    },
    { caps: resolveCapsFor(ruleId, requirementId), runId: asRunId('r1'), producer: { type: 'rule', packageVersion: '0.0.0' } },
  );
}

const findings = [
  finding('tracking.prior-consent', 'eprivacy.art5.3', 'eu', 'violation', [
    { location: 'de', scenario: 'do-nothing', phases: ['before-choice'] },
    { location: 'de', scenario: 'reject', phases: ['after-reject'] },
  ]),
  finding('tracking.wiretap-exposure', 'cipa.631', 'us-ca', 'needs-review', [{ location: 'us-ca', scenario: 'markers', phases: ['no-banner'], sent: ['form-input'], markers: ['email (plain)'] }]),
  finding('tracking.unrecognized-party', 'practice.tracker-inventory', 'any', 'needs-review', [{ location: 'us-ca', scenario: 'do-nothing', phases: ['no-banner'] }]),
];

describe('consent report model', () => {
  const m = buildConsentReportModel(evaluation, findings);

  it('derives the kind from the requirement — exposure and research are never violations', () => {
    expect(findings.map(findingKind)).toEqual(['violation', 'exposure', 'practice']);
    expect(m.totals).toEqual({ violation: 1, 'needs-review': 0, exposure: 1, practice: 1 });
  });

  it('counts findings into each location × scenario cell; unverified locations are not tested', () => {
    expect(m.grid.de['do-nothing']?.counts.violation).toBe(1);
    expect(m.grid.de.reject?.counts.violation).toBe(1);
    expect(m.grid.de.partial?.status).toBe('not-tested');
    expect(m.grid['us-ca'].markers?.counts.exposure).toBe(1);
    expect(m.grid.fr['do-nothing']?.status).toBe('not-tested');
    expect(m.grid['us-ca'].reject?.status).toBe('not-run');
  });

  it('sorts as regulators test and as plaintiffs build cases', () => {
    const reg = [...m.findings].sort((a, b) => a.regulatorRank - b.regulatorRank).map((f) => f.kind);
    const pl = [...m.findings].sort((a, b) => a.plaintiffRank - b.plaintiffRank).map((f) => f.kind);
    expect(reg[0]).toBe('violation');
    expect(pl[0]).toBe('exposure');
  });

  it('renders HTML and Markdown without verdict vocabulary', () => {
    const html = renderConsentHtml(m);
    const md = renderConsentMarkdown(m);
    for (const out of [html, md]) expect(containsBannedVocabulary(out)).toBe(false);
    expect(html).toContain('not tested');
    expect(html).toContain('Exposure (for counsel)');
    expect(md).toContain('| Germany |');
  });
});

describe('human consent report', () => {
  const m = buildConsentReportModel(evaluation, findings);

  it('groups the same work across citations while preserving original evidence and certainty', () => {
    const first = m.findings.find((f) => f.ruleId === 'tracking.prior-consent')!;
    const second = { ...first, fingerprint: 'another', requirementId: 'pecr.reg6', citation: 'PECR Reg. 6', scope: 'uk', message: 'A separate UK observation' };
    const uncertain = { ...second, fingerprint: 'uncertain', kind: 'needs-review' as const };
    const model = { ...m, findings: [first, second, uncertain] };
    expect(groupConsentActions(model)).toHaveLength(2);
    const html = renderConsentHtml(model);
    expect(html.match(/data-action-kind=/g)).toHaveLength(2);
    expect(html).toContain('PECR Reg. 6');
    expect(html).toContain('A separate UK observation');
    expect(html).toContain('Needs confirmation');
    expect(html).toContain('observation needs confirmation');
    expect(renderConsentHtml(m)).toContain('not a detected violation');
  });

  it('does not merge different fix locations or different behaviors for one tool', () => {
    const f = m.findings[0];
    const model = { ...m, findings: [f, { ...f, details: { ...f.details, source: 'platform' } }, { ...f, details: { ...f.details, pattern: 'different-behavior' } }] };
    expect(groupConsentActions(model)).toHaveLength(3);
  });

  it('renders work briefs and keeps every technical record collapsed without changing the model', () => {
    const before = JSON.stringify(m);
    const html = renderConsentHtml(m);
    expect(html).toContain('Who can help');
    expect(html).toContain('How to check the fix');
    expect(html).toContain('Technical evidence and legal references');
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
    expect(html).toContain('not legal advice');
    expect(JSON.stringify(m)).toBe(before);
  });

  it('never treats a failed choice with zero findings as a successful privacy check', () => {
    const model = { ...m, grid: { de: { reject: { status: 'tested' as const, choice: 'reject (failed)', counts: { violation: 0, 'needs-review': 0, exposure: 0, practice: 0 } } } } };
    const html = renderConsentHtml(model);
    expect(html).toContain('attempted visitor choice did not succeed');
    expect(html).toContain('not verified passes');
    expect(html).toContain('Choices that did not succeed');
  });

  it('keeps provisional classification separate from tool problems and cookie-specific evidence', () => {
    const inventory = [{ partyId: 'x', label: 'X', domain: 'x.example', hosts: ['x.example'], recognized: true, kbStatus: 'proposed' as const, categories: ['analytics'], behavesLikeTracker: true, trackerSignals: [], sends: ['page-address'], stores: [{ name: '_test', kind: 'cookie', lifetimeDays: 400 }], sources: ['injected' as const], loadedBy: [], samples: [], seenIn: [] }];
    const model = { ...m, inventory, findings: [m.findings.find((f) => f.kind === 'violation')!] };
    const html = renderConsentHtml(model);
    expect(html).toContain('data-tool-state="problem classify"');
    expect(html).toContain('Needs classification or verification');
    expect(html).not.toContain('Cookie problem observed</span>');
    expect(html).toContain('Tool-level tracking findings do not automatically');
    const f = model.findings[0];
    const exact = { ...model, findings: [{ ...f, evidence: [{ kind: 'cookie' as const, name: '_test', domain: '.x.example', phase: 'pre-consent' as const, flags: { secure: true, httpOnly: false } }] }] };
    expect(renderConsentHtml(exact)).toContain('Cookie problem observed</span>');
  });

  it('escapes untrusted descriptions and blocks executable evidence links', () => {
    const malicious = { ...m, findings: [{ ...m.findings[0], sourceUrl: 'javascript:alert(1)', message: '<img src=x onerror=alert(1)>', details: { party: { label: '<script>alert(1)</script>', domain: 'x.example' } } }] };
    const html = renderConsentHtml(malicious);
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('&lt;img src=x');
  });
});

