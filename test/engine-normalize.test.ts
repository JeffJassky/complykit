import { describe, it, expect } from 'vitest';
import { normalizeEngineArtifacts } from '../src/engines.js';
import { asRunId, type Artifact } from '../src/record/index.js';

// Engine normalization from a recorded static-scan artifact — no ESLint needed.

function staticScan(engine: string, results: Record<string, unknown>[]): Artifact {
  return {
    kind: 'static-scan',
    subject: { property: 'shop' },
    capturedAt: '2026-08-19T00:00:00.000Z',
    engine,
    results,
  };
}

describe('normalizeEngineArtifacts', () => {
  it('maps a mapped rule to its requirement with producer engine', () => {
    const art = staticScan('eslint-plugin-jsx-a11y', [
      { engineRule: 'alt-text', file: 'src/A.tsx', line: 3, message: 'img needs alt', ordinal: 0 },
    ]);
    const { findings } = normalizeEngineArtifacts([art], { runId: asRunId('r'), engineVersions: { 'eslint-plugin-jsx-a11y': '6.10.2' } });
    expect(findings).toHaveLength(1);
    expect(String(findings[0].requirementId)).toBe('wcag22.1.1.1');
    expect(findings[0].producer).toEqual({ type: 'engine', name: 'eslint-plugin-jsx-a11y', version: '6.10.2' });
    expect(findings[0].confidence).toBe('violation');
    expect(findings[0].subject.file?.path).toBe('src/A.tsx');
  });

  it('caps a needs-review-mapped rule to needs-review', () => {
    const art = staticScan('eslint-plugin-jsx-a11y', [
      { engineRule: 'click-events-have-key-events', file: 'src/A.tsx', line: 3, message: 'add key handler', ordinal: 0 },
    ]);
    const { findings } = normalizeEngineArtifacts([art], { runId: asRunId('r') });
    expect(findings[0].confidence).toBe('needs-review');
    expect(String(findings[0].requirementId)).toBe('wcag22.2.1.1');
  });

  it('reports an unmapped engine rule instead of inventing a finding', () => {
    const art = staticScan('eslint-plugin-jsx-a11y', [
      { engineRule: 'some-future-rule', file: 'src/A.tsx', line: 1, message: 'x', ordinal: 0 },
    ]);
    const { findings, unmapped } = normalizeEngineArtifacts([art], { runId: asRunId('r') });
    expect(findings).toHaveLength(0);
    expect(unmapped).toEqual([{ engine: 'eslint-plugin-jsx-a11y', engineRule: 'some-future-rule', count: 1 }]);
  });

  it('distinguishes two occurrences of one rule in one file by ordinal', () => {
    const art = staticScan('eslint-plugin-jsx-a11y', [
      { engineRule: 'alt-text', file: 'src/A.tsx', line: 3, message: 'a', ordinal: 0 },
      { engineRule: 'alt-text', file: 'src/A.tsx', line: 7, message: 'b', ordinal: 1 },
    ]);
    const { findings } = normalizeEngineArtifacts([art], { runId: asRunId('r') });
    expect(findings).toHaveLength(2);
    expect(findings[0].fingerprint).not.toBe(findings[1].fingerprint);
  });
});
