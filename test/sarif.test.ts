import { describe, it, expect } from 'vitest';
import {
  renderSarif,
  renderReport,
  asRunId,
  asRuleId,
  asRequirementId,
  fingerprint,
  REGISTRY_VERSION,
  containsBannedVocabulary,
  type Run,
  type Finding,
} from '../src/index.js';

const run: Run = {
  schemaVersion: 1,
  id: asRunId('2026-08-19T10-00-00.000Z'),
  property: 'shop',
  startedAt: '2026-08-19T00:00:00.000Z',
  versions: { package: '1.2.3', registry: REGISTRY_VERSION, engines: {} },
  accessLevels: ['repo'],
  matrix: [],
  gaps: [],
  rulesExecuted: [],
};

const finding: Finding = {
  schemaVersion: 1,
  ruleId: asRuleId('eslint-plugin-jsx-a11y:alt-text'),
  requirementId: asRequirementId('wcag22.1.1.1'),
  subject: { property: 'shop', file: { path: 'src/A.tsx', line: 3 }, locator: { role: 'element', ordinal: 0 } },
  confidence: 'violation',
  severity: 'serious',
  message: 'img must have alt text',
  evidence: [{ kind: 'file', path: 'src/A.tsx', line: 3, snippet: 'img must have alt text' }],
  fingerprint: fingerprint({ detects: 'presence', ruleId: asRuleId('eslint-plugin-jsx-a11y:alt-text'), subject: { property: 'shop', file: { path: 'src/A.tsx' }, locator: { role: 'element', ordinal: 0 } } }),
  producer: { type: 'engine', name: 'eslint-plugin-jsx-a11y', version: '6.10.2' },
  runId: asRunId('2026-08-19T10-00-00.000Z'),
};

describe('SARIF renderer', () => {
  it('emits valid SARIF 2.1.0 with tool, results, and file locations', () => {
    const doc = JSON.parse(renderSarif(run, [finding]));
    expect(doc.version).toBe('2.1.0');
    expect(doc.runs[0].tool.driver.name).toBe('complykit');
    expect(doc.runs[0].tool.driver.version).toBe('1.2.3');
    const result = doc.runs[0].results[0];
    expect(result.ruleId).toBe('eslint-plugin-jsx-a11y:alt-text');
    expect(result.level).toBe('error'); // serious -> error
    expect(result.locations[0].physicalLocation.artifactLocation.uri).toBe('src/A.tsx');
    expect(result.locations[0].physicalLocation.region.startLine).toBe(3);
  });

  it('keys results by the frozen fingerprint so code-scanning dedupes across runs', () => {
    const doc = JSON.parse(renderSarif(run, [finding]));
    expect(doc.runs[0].results[0].partialFingerprints.complykitFingerprintV1).toBe(String(finding.fingerprint));
  });

  it('never emits the banned verdict vocabulary', () => {
    const sarif = renderReport(run, [finding], 'sarif');
    expect(containsBannedVocabulary(sarif)).toBe(false);
  });
});
