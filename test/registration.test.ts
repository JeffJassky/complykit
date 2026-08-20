import { describe, it, expect } from 'vitest';
import { ALL_RULES, getRule, getRequirement } from '../src/index.js';

// Mechanical registration-completeness check (package-structure.md #4, the
// traps.md registration pattern): every rule file under src/rules/ must be
// registered in ALL_RULES, and every registered rule must map to >=1 real
// requirement. A rule file that is never wired in fails HERE, not silently at
// runtime by never firing.

// Every .ts under src/rules except the plumbing (index, types, evaluate).
const modules = import.meta.glob('../src/rules/**/*.ts', { eager: true }) as Record<
  string,
  Record<string, unknown>
>;

function looksLikeRule(v: unknown): v is { id: string; requirements: unknown; layer: unknown } {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Record<string, unknown>).id === 'string' &&
    Array.isArray((v as Record<string, unknown>).requirements) &&
    typeof (v as Record<string, unknown>).layer === 'string'
  );
}

describe('rule registration completeness', () => {
  const PLUMBING = ['index.ts', 'types.ts', 'evaluate.ts'];

  it('every rule exported from a rule file is registered in ALL_RULES', () => {
    const registeredIds = new Set(ALL_RULES.map((r) => String(r.id)));
    for (const [file, mod] of Object.entries(modules)) {
      if (PLUMBING.some((p) => file.endsWith(p))) continue;
      const exportedRules = Object.values(mod).filter(looksLikeRule);
      expect(exportedRules.length, `${file} exports no rule-shaped value`).toBeGreaterThan(0);
      for (const rule of exportedRules) {
        expect(registeredIds.has(rule.id), `${rule.id} (${file}) is not in ALL_RULES`).toBe(true);
        expect(getRule(rule.id), `getRule('${rule.id}') is undefined`).toBeDefined();
      }
    }
  });

  it('every registered rule maps to at least one real requirement', () => {
    for (const rule of ALL_RULES) {
      expect(rule.requirements.length, `${String(rule.id)} has no requirements`).toBeGreaterThan(0);
      for (const reqId of rule.requirements) {
        expect(getRequirement(String(reqId)), `${String(rule.id)} cites unknown ${String(reqId)}`).toBeDefined();
      }
    }
  });

  it('rule ids are unique', () => {
    const ids = ALL_RULES.map((r) => String(r.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
