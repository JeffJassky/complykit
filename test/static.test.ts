import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectStatic, type StaticCollection } from '../src/collect/static/index.js';
import { normalizeEngineArtifacts } from '../src/engines.js';
import { evaluate, ALL_RULES, resolveCapsFor } from '../src/rules/index.js';
import { resolveFinding, asRunId, type Artifact } from '../src/record/index.js';

// The static layer end to end, against a tiny fixture repo (Vue + JSX a11y
// issues, tracker/AI/PII imports). This is the one place the real ESLint pass
// runs; rule tests below work from recorded artifacts only.

const REPO = path.join(fileURLToPath(new URL('./fixtures/sample-repo', import.meta.url)));

describe('collect/static on the sample repo', () => {
  let collection: StaticCollection;
  beforeAll(async () => {
    collection = await collectStatic({ cwd: REPO, property: 'sample' });
  }, 30000);

  it('detects the vue + jsx a11y engines and produces static-scan artifacts', () => {
    const engines = collection.artifacts
      .filter((a): a is Extract<Artifact, { kind: 'static-scan' }> => a.kind === 'static-scan')
      .map((a) => a.engine);
    expect(engines).toContain('eslint-plugin-vuejs-accessibility');
    expect(engines).toContain('eslint-plugin-jsx-a11y');
  });

  it('derives has-ai-features from the @anthropic-ai/sdk import', () => {
    expect(collection.hasAiFeatures).toBe(true);
  });

  it('inventories the tracker, AI framework, and PII fields', () => {
    const cats = collection.artifacts
      .filter((a): a is Extract<Artifact, { kind: 'inventory' }> => a.kind === 'inventory')
      .map((a) => a.category);
    expect(cats).toContain('ai-framework');
    expect(cats).toContain('tracker');
    expect(cats).toContain('pii');
  });

  it('normalizes engine output into findings citing WCAG requirements (missing alt)', () => {
    const { findings } = normalizeEngineArtifacts(collection.artifacts, {
      runId: asRunId('t'),
      engineVersions: collection.engineVersions,
    });
    // alt-text maps to wcag22.1.1.1; both the .vue and .tsx images should fire.
    const altFindings = findings.filter((f) => String(f.requirementId) === 'wcag22.1.1.1');
    expect(altFindings.length).toBeGreaterThanOrEqual(2);
    expect(altFindings.every((f) => f.producer.type === 'engine')).toBe(true);
  });

  it('the two JSX images in one file get distinct fingerprints (ordinal anchor)', () => {
    const { findings } = normalizeEngineArtifacts(collection.artifacts, { runId: asRunId('t') });
    const tsxAlt = findings.filter(
      (f) => String(f.requirementId) === 'wcag22.1.1.1' && f.subject.file?.path.endsWith('Bad.tsx'),
    );
    expect(tsxAlt.length).toBe(2);
    expect(tsxAlt[0].fingerprint).not.toBe(tsxAlt[1].fingerprint);
  });

  it('inventory rules turn the artifacts into needs-review leads', () => {
    const raws = evaluate(collection.artifacts, ALL_RULES, { property: 'sample', tags: ['has-ai-features'] });
    const findings = raws.map((r) =>
      resolveFinding(r, {
        caps: resolveCapsFor(r.ruleId, r.requirementId),
        runId: asRunId('t'),
        producer: { type: 'rule', packageVersion: '0.0.0' },
      }),
    );
    const ruleIds = new Set(findings.map((f) => String(f.ruleId)));
    expect(ruleIds.has('inventory.ai-framework')).toBe(true);
    expect(ruleIds.has('inventory.tracker')).toBe(true);
    expect(ruleIds.has('inventory.pii-surface')).toBe(true);
    expect(findings.every((f) => f.confidence === 'needs-review')).toBe(true);
  });
});
