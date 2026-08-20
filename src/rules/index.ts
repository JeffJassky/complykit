import type { AnyRule } from './types.js';
import type { FindingCaps } from '../record/index.js';
import type { RequirementId, RuleId } from '../registry/index.js';
import { getRequirement } from '../registry/index.js';
import { art50AiInteraction } from './art50/ai-interaction.js';
import { inventoryAiFrameworks } from './inventories/ai-frameworks.js';
import { inventoryTrackers } from './inventories/trackers.js';
import { inventoryPii } from './inventories/pii.js';

export * from './types.js';
export * from './evaluate.js';

// Explicit registration. A mechanical test (test/registration.test.ts) asserts
// every rule exported from a rule file is registered here and every registered
// rule maps to >=1 requirement — the traps.md registration-completeness pattern,
// so a rule that is never wired in fails CI instead of silently not running.
export const ALL_RULES: AnyRule[] = [
  art50AiInteraction,
  inventoryAiFrameworks,
  inventoryTrackers,
  inventoryPii,
];

const RULE_BY_ID = new Map<string, AnyRule>(ALL_RULES.map((r) => [String(r.id), r]));

export function getRule(id: RuleId | string): AnyRule | undefined {
  return RULE_BY_ID.get(String(id));
}

/**
 * Resolve the authority caps record/normalize needs to stamp a finding. Bridges
 * the two pure layers: the rule's declared limits (from rules/) and the cited
 * requirement's default severity (from registry/). Throws if the rule or
 * requirement is unknown — a finding cannot be minted against a phantom rule.
 */
export function resolveCapsFor(ruleId: RuleId | string, requirementId: RequirementId | string): FindingCaps {
  const rule = getRule(ruleId);
  if (!rule) throw new Error(`unknown rule: ${String(ruleId)}`);
  const requirement = getRequirement(String(requirementId));
  if (!requirement) throw new Error(`unknown requirement: ${String(requirementId)}`);
  return {
    detects: rule.detects,
    maxConfidence: rule.confidence,
    requirementSeverity: requirement.severity,
    ruleSeverity: rule.severity,
    ruleRequirements: rule.requirements,
  };
}
