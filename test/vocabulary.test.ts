import { describe, it, expect } from 'vitest';
import {
  containsBannedVocabulary,
  assertReportVocabulary,
  renderMarkdown,
  renderReport,
  asRunId,
  asRuleId,
  asRequirementId,
  fingerprint,
  REGISTRY_VERSION,
  type Run,
  type Finding,
} from '../src/index.js';

// The report says "findings and evidence", never "compliant" (README: accessiBe
// took a $1M FTC order for that overclaim). Renderer chrome must never emit it.

const run: Run = {
  schemaVersion: 1,
  id: asRunId('2026-08-19T10-00-00.000Z'),
  property: 'shop',
  startedAt: '2026-08-19T00:00:00.000Z',
  versions: { package: '0.0.0', registry: REGISTRY_VERSION, engines: {} },
  accessLevels: ['public'],
  matrix: [],
  gaps: [{ reason: 'bot-blocked', subject: { property: 'shop', routePattern: '/admin' } }],
  rulesExecuted: [],
};

const finding: Finding = {
  schemaVersion: 1,
  ruleId: asRuleId('art50.ai-interaction-disclosure'),
  requirementId: asRequirementId('eu-ai-act.art50.1'),
  subject: { property: 'shop', routePattern: '/assistant' },
  confidence: 'needs-review',
  severity: 'serious',
  message: 'No AI disclosure found.',
  evidence: [],
  fingerprint: fingerprint({ detects: 'absence', requirementId: asRequirementId('eu-ai-act.art50.1'), subject: { property: 'shop', routePattern: '/assistant' } }),
  producer: { type: 'agent', model: 'claude', rubricVersion: '1' },
  runId: asRunId('2026-08-19T10-00-00.000Z'),
};

describe('report vocabulary', () => {
  it('the guard detects the banned verdict word', () => {
    expect(containsBannedVocabulary('this site is compliant')).toBe(true);
    expect(containsBannedVocabulary('non-compliant')).toBe(true);
    expect(containsBannedVocabulary('findings and evidence')).toBe(false);
    expect(() => assertReportVocabulary('fully compliant')).toThrow(/forbidden verdict/);
  });

  it('markdown chrome states coverage and never says compliant', () => {
    const md = renderMarkdown(run, [finding]);
    expect(md.toLowerCase()).not.toContain('compliant');
    expect(md).toContain('Coverage');
    expect(md).toContain('does not assert conformance');
    expect(() => assertReportVocabulary(md)).not.toThrow();
  });

  it('an empty run renders coverage, not a clean bill', () => {
    const md = renderReport(run, [], 'md');
    expect(md.toLowerCase()).not.toContain('compliant');
    expect(md).toContain('No findings were produced');
  });
});
