import { z } from 'zod';
import type { RawFinding, Artifact } from '../../record/index.js';
import type { Rule, EvalContext } from '../types.js';
import { asRuleId, asRequirementId } from '../../registry/index.js';

// Inventories are the only layer that can see server-side code. Each inventory
// category becomes needs-review LEADS (not violations): the tracker/framework is
// provably present, but whether it is *undisclosed* or *unconsented* is what the
// browser and LLM layers confirm. One finding per distinct item (package,
// domain, field) — occurrences collapse into evidence, never per-instance
// findings.

const Item = z.object({
  name: z.string(),
  file: z.string(),
  line: z.number().int().optional(),
  evidence: z.string().optional(),
  detail: z.string().optional(),
});

export interface InventoryRuleSpec {
  id: string;
  category: 'tracker' | 'ai-framework' | 'pii';
  requirement: string;
  remediation: string;
  falsePositives: string;
  message: (name: string, count: number) => string;
}

export function makeInventoryRule(spec: InventoryRuleSpec): Rule<readonly ['inventory']> {
  return {
    id: asRuleId(spec.id),
    requirements: [asRequirementId(spec.requirement)],
    layer: 'static',
    confidence: 'needs-review',
    detects: 'presence',
    evidence: ['file'],
    remediation: spec.remediation,
    falsePositives: spec.falsePositives,
    consumes: ['inventory'] as const,
    evaluate(input: { inventory: Artifact[] }, ctx: EvalContext): RawFinding[] {
      // Collapse occurrences of the same item name across the property.
      const byName = new Map<string, Array<{ file: string; line?: number; evidence?: string }>>();
      for (const artifact of input.inventory) {
        if (artifact.kind !== 'inventory' || artifact.category !== spec.category) continue;
        for (const rawItem of artifact.items) {
          const parsed = Item.safeParse(rawItem);
          if (!parsed.success) continue;
          const it = parsed.data;
          const list = byName.get(it.name) ?? [];
          list.push({ file: it.file, line: it.line, evidence: it.evidence });
          byName.set(it.name, list);
        }
      }

      const findings: RawFinding[] = [];
      for (const [name, occurrences] of byName) {
        findings.push({
          ruleId: asRuleId(spec.id),
          requirementId: asRequirementId(spec.requirement),
          subject: {
            property: ctx.property,
            locator: { role: spec.category, name, ordinal: 0 },
          },
          confidence: 'needs-review',
          message: spec.message(name, occurrences.length),
          details: { name, occurrences: occurrences.length },
          evidence: occurrences.slice(0, 20).map((o) => ({
            kind: 'file' as const,
            path: o.file,
            line: o.line ?? 1,
            snippet: o.evidence ?? name,
          })),
        });
      }
      return findings;
    },
  };
}
