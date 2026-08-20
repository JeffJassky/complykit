import { describe, it, expect } from 'vitest';
import {
  verifyRegistry,
  ALL_REQUIREMENTS,
  requirementsForRuleset,
  findRuleSet,
  unmappedEngineRules,
  coverage,
  ALL_RULES,
  type CoverageIndex,
  type RuleLayer,
} from '../src/index.js';

function coverageIndex(): CoverageIndex {
  const index: CoverageIndex = new Map();
  for (const rule of ALL_RULES) {
    for (const reqId of rule.requirements) {
      const key = String(reqId);
      const layers = index.get(key) ?? new Set<RuleLayer>();
      layers.add(rule.layer);
      index.set(key, layers);
    }
  }
  return index;
}

describe('registry integrity', () => {
  it('verifies clean: no duplicate ids, resolvable instruments, exhaustive axe mappings', () => {
    const report = verifyRegistry();
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.counts.requirements).toBe(ALL_REQUIREMENTS.length);
  });

  it('flags volatile + bot-blocked entries as needing a human check', () => {
    const report = verifyRegistry();
    // Art. 50 entries are volatile and their eur-lex source is bot-blocked.
    expect(report.needsHumanCheck.some((n) => n.id.startsWith('eu-ai-act.art50'))).toBe(true);
  });

  it('detects an engine rule with no mapping (upgrade-drift gate)', () => {
    expect(unmappedEngineRules('axe-core', ['color-contrast', 'brand-new-rule'])).toEqual(['brand-new-rule']);
    expect(unmappedEngineRules('axe-core', ['color-contrast'])).toEqual([]);
  });
});

describe('rulesets are queries', () => {
  it('wcag22aa selects only WCAG A/AA criteria', () => {
    const sel = requirementsForRuleset('wcag22aa', ALL_REQUIREMENTS);
    expect(sel.length).toBeGreaterThan(0);
    expect(sel.every((r) => String(r.instrument) === 'wcag')).toBe(true);
    expect(sel.every((r) => r.citation.kind === 'sc' && r.citation.level !== 'AAA')).toBe(true);
  });

  it('ai-act-50 selects only Article 50 obligations', () => {
    const sel = requirementsForRuleset('ai-act-50', ALL_REQUIREMENTS);
    expect(sel.every((r) => r.citation.kind === 'article' && r.citation.article === 50)).toBe(true);
  });

  it('an unknown ruleset selects nothing', () => {
    expect(findRuleSet('does-not-exist')).toBeUndefined();
    expect(requirementsForRuleset('does-not-exist', ALL_REQUIREMENTS)).toEqual([]);
  });
});

describe('coverage is derived, and states the honest gap', () => {
  it('reports Art. 50 as llm-assisted and WCAG as manual-only until browser rules land', () => {
    const aiAct = coverage('ai-act-50', coverageIndex());
    expect(aiAct.llmAssisted).toBeGreaterThan(0);

    const wcag = coverage('wcag22aa', coverageIndex());
    // No deterministic WCAG rules registered yet -> every criterion is the gap.
    expect(wcag.autoChecked).toBe(0);
    expect(wcag.manualOnly).toBe(wcag.total);
  });
});
