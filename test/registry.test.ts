import { describe, it, expect } from 'vitest';
import {
  verifyRegistry,
  ALL_REQUIREMENTS,
  requirementsForRuleset,
  findRuleSet,
  unmappedEngineRules,
  coverage,
  buildCoverageIndex,
  getRequirement,
  requirementApplies,
} from '../src/index.js';

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

describe('applicability gating (tags are hand-set, nothing auto-derived)', () => {
  it('WCAG requirements always apply, regardless of tags', () => {
    const wcag = getRequirement('wcag22.1.4.3')!;
    expect(requirementApplies(wcag, [])).toBe(true);
    expect(requirementApplies(wcag, ['targets-eu'])).toBe(true);
  });

  it('a GDPR requirement applies only when the property declares all its tags', () => {
    const gdpr = getRequirement('gdpr.art13')!; // appliesIf: processes-personal-data + targets-eu
    expect(requirementApplies(gdpr, [])).toBe(false);
    expect(requirementApplies(gdpr, ['targets-eu'])).toBe(false); // missing the other tag
    expect(requirementApplies(gdpr, ['targets-eu', 'processes-personal-data'])).toBe(true);
  });

  it('an AI Act requirement applies only when has-ai-features is set by hand', () => {
    const art50 = getRequirement('eu-ai-act.art50.1')!;
    expect(requirementApplies(art50, [])).toBe(false);
    expect(requirementApplies(art50, ['has-ai-features'])).toBe(true);
  });
});

describe('coverage is derived, and states the honest gap', () => {
  it('WCAG is largely auto-checked via engine mappings, with a real manual gap', () => {
    const wcag = coverage('wcag22aa', buildCoverageIndex());
    // eslint (static) + axe (browser) mappings cover most criteria...
    expect(wcag.autoChecked).toBeGreaterThan(0);
    // ...but contrast/target-size/focus-visible criteria with no mapping remain
    // the honest manual-only gap printed in every report.
    expect(wcag.manualOnly).toBeGreaterThan(0);
    expect(wcag.autoChecked + wcag.llmAssisted + wcag.manualOnly).toBe(wcag.total);
  });

  it('Art. 50 has an auto-checked lead (inventory) and a manual-only paragraph', () => {
    const aiAct = coverage('ai-act-50', buildCoverageIndex());
    // art50.1 is reached by the ai-framework inventory (static) + the llm rule;
    // art50.2 (content marking) has no rule yet -> manual.
    expect(aiAct.autoChecked).toBeGreaterThanOrEqual(1);
    expect(aiAct.manualOnly).toBeGreaterThanOrEqual(1);
  });
});
