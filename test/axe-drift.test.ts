import { describe, it, expect } from 'vitest';
import axe from 'axe-core';
import {
  AXE_VERSION,
  AXE_ALL_RULES,
  AXE_PINNED_RULES,
  AXE_UNMAPPED_INTENTIONAL,
} from '../src/registry/mappings/axe.js';

// The upgrade-drift gate for axe (build-plan §engine exhaustiveness). axe ships
// ~100 rules; we consume the WCAG subset backed by registry requirements and
// record the rest as intentionally unmapped. If an axe upgrade adds, removes, or
// renames a rule, one of these fails — forcing a conscious re-map, never a silent
// coverage change.

describe('axe engine drift', () => {
  it('the pinned version matches the installed axe-core', () => {
    expect(AXE_VERSION).toBe(axe.version);
  });

  it('AXE_ALL_RULES is exactly the installed rule set', () => {
    const installed = axe.getRules().map((r) => r.ruleId).sort();
    expect([...AXE_ALL_RULES].sort()).toEqual(installed);
  });

  it('mapped + intentionally-unmapped partition every rule exactly', () => {
    const mapped = new Set(AXE_PINNED_RULES);
    const unmapped = new Set(AXE_UNMAPPED_INTENTIONAL.map(([r]) => r));
    // No overlap.
    for (const r of mapped) expect(unmapped.has(r)).toBe(false);
    // Union covers everything, nothing extra.
    const union = new Set([...mapped, ...unmapped]);
    expect(union.size).toBe(AXE_ALL_RULES.length);
    for (const r of AXE_ALL_RULES) expect(union.has(r)).toBe(true);
  });

  it('every intentionally-unmapped rule carries a reason', () => {
    for (const [rule, reason] of AXE_UNMAPPED_INTENTIONAL) {
      expect(rule.length).toBeGreaterThan(0);
      expect(reason.length).toBeGreaterThan(0);
    }
  });
});
