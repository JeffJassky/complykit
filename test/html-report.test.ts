import { describe, it, expect } from 'vitest';
import {
  renderHtmlReport,
  containsBannedVocabulary,
  coverage,
  buildCoverageIndex,
  asRunId,
  asRuleId,
  asRequirementId,
  fingerprint,
  REGISTRY_VERSION,
  type Run,
  type Finding,
} from '../src/index.js';

const run: Run = {
  schemaVersion: 1,
  id: asRunId('2026-08-19T10-00-00.000Z'),
  property: 'shop',
  startedAt: 'now',
  versions: { package: '0.0.0', registry: REGISTRY_VERSION, engines: {} },
  accessLevels: ['public', 'repo'],
  matrix: [],
  gaps: [{ reason: 'bot-blocked', subject: { property: 'shop', routePattern: '/admin' } }],
  rulesExecuted: [],
};

const sub = { property: 'shop', routePattern: '/', locator: { role: 'text', ordinal: 0 } };
const finding: Finding = {
  schemaVersion: 1,
  ruleId: asRuleId('axe-core:color-contrast'),
  requirementId: asRequirementId('wcag22.1.4.3'),
  subject: sub,
  confidence: 'violation',
  severity: 'serious',
  message: 'Text contrast is below 4.5:1.',
  evidence: [{ kind: 'computed-style', properties: { color: '#999', background: '#fff', ratio: '2.8', required: '4.5' } }],
  fingerprint: fingerprint({ detects: 'presence', ruleId: asRuleId('axe-core:color-contrast'), subject: sub }),
  producer: { type: 'engine', name: 'axe-core', version: '4.10.3' },
  runId: asRunId('2026-08-19T10-00-00.000Z'),
};

describe('static HTML report', () => {
  const html = renderHtmlReport(run, [finding], { coverage: [coverage('wcag22aa', buildCoverageIndex(), run)] });

  it('is a self-contained document with no external fetches', () => {
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<style>'); // inline CSS
    expect(html).not.toMatch(/<link[^>]+href=|<script[^>]+src=/); // no external assets
    expect(html).not.toMatch(/https?:\/\/[^"']*\.(css|js)/);
  });

  it('states the finding, its requirement, and the coverage gap', () => {
    expect(html).toContain('wcag22.1.4.3');
    expect(html).toContain('Text contrast is below');
    expect(html).toContain('bot-blocked');
    expect(html).toContain('manual-only');
  });

  it('never says "compliant"', () => {
    expect(containsBannedVocabulary(html)).toBe(false);
    expect(html).toContain('does not assert conformance');
  });

  it('renders filter controls for severity and confidence', () => {
    expect(html).toContain('data-f="sev"');
    expect(html).toContain('data-f="conf"');
  });

  it('escapes finding text (no raw HTML injection)', () => {
    const evil: Finding = { ...finding, message: '<img src=x onerror=alert(1)>' };
    const out = renderHtmlReport(run, [evil]);
    expect(out).not.toContain('<img src=x onerror=alert(1)>');
    expect(out).toContain('&lt;img src=x');
  });
});
