import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ALL_RULES, getRule, getRequirement } from '../src/index.js';

// Mechanical registration-completeness check (package-structure.md #4, the
// traps.md registration pattern): every rule file under src/rules/ must be
// registered in ALL_RULES, and every registered rule must map to >=1 real
// requirement. A rule file that is never wired in fails HERE, not silently at
// runtime by never firing.

// Every .ts under src/rules except the plumbing (index, types, evaluate). fs
// walk + dynamic import rather than import.meta.glob, which tsc cannot type
// under NodeNext (it is a Vite-only runtime feature).
const RULES_DIR = fileURLToPath(new URL('../src/rules', import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const ruleFiles = walk(RULES_DIR);
const modules: Record<string, Record<string, unknown>> = {};
for (const file of ruleFiles) {
  modules[file] = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
}

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
  it('every rule exported from a rule file is registered in ALL_RULES', () => {
    const registeredIds = new Set(ALL_RULES.map((r) => String(r.id)));
    let seen = 0;
    for (const [file, mod] of Object.entries(modules)) {
      // Helper/plumbing files export no rule-shaped value — skipped naturally.
      for (const rule of Object.values(mod).filter(looksLikeRule)) {
        seen++;
        expect(registeredIds.has(rule.id), `${rule.id} (${file}) is not in ALL_RULES`).toBe(true);
        expect(getRule(rule.id), `getRule('${rule.id}') is undefined`).toBeDefined();
      }
    }
    // Sanity: discovery found at least the rules we registered.
    expect(seen).toBeGreaterThanOrEqual(ALL_RULES.length);
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
