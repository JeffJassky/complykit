import type { CoverageIndex, RuleLayer } from './report/index.js';
import { ENGINE_TABLES } from './registry/index.js';
import { ALL_RULES } from './rules/index.js';

// The coverage index maps requirement -> the layers that can auto-check it. It
// draws from BOTH our own rules AND the engine mapping tables (a WCAG criterion
// checked only by axe or eslint is still auto-checked, just not by a rule of
// ours). report/coverage may not import rules/ or the engine tables under the
// dependency law, so this top-level module builds the index and passes it in.

export function buildCoverageIndex(): CoverageIndex {
  const index: CoverageIndex = new Map();
  const add = (requirementId: string, layer: RuleLayer): void => {
    const layers = index.get(requirementId) ?? new Set<RuleLayer>();
    layers.add(layer);
    index.set(requirementId, layers);
  };

  for (const rule of ALL_RULES) {
    for (const reqId of rule.requirements) add(String(reqId), rule.layer);
  }
  for (const table of ENGINE_TABLES) {
    for (const mapping of table.mappings) {
      for (const reqId of mapping.requirements) add(String(reqId), table.layer);
    }
  }
  return index;
}
