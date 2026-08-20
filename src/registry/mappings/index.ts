import type { EngineRuleMapping } from '../schema.js';
import { AXE_MAPPINGS, AXE_PINNED_RULES, AXE_VERSION } from './axe.js';
import { JSX_A11Y_MAPPINGS, JSX_A11Y_PINNED_RULES, JSX_A11Y_VERSION } from './jsx-a11y.js';
import { VUE_A11Y_MAPPINGS, VUE_A11Y_PINNED_RULES, VUE_A11Y_VERSION } from './vuejs-a11y.js';

export { AXE_MAPPINGS, AXE_PINNED_RULES, AXE_VERSION } from './axe.js';
export { JSX_A11Y_MAPPINGS, JSX_A11Y_PINNED_RULES, JSX_A11Y_VERSION } from './jsx-a11y.js';
export { VUE_A11Y_MAPPINGS, VUE_A11Y_PINNED_RULES, VUE_A11Y_VERSION } from './vuejs-a11y.js';

// Every engine the registry maps, with the pinned version and the rule set that
// version ships. verify.ts checks each: every mapping references a known rule,
// every pinned rule is mapped. An engine upgrade that changes the rule set
// breaks CI until the table is reconciled.
export interface EngineTable {
  engine: string;
  version: string;
  layer: 'static' | 'browser'; // which detection layer runs this engine
  mappings: EngineRuleMapping[];
  pinnedRules: string[];
}

export const ENGINE_TABLES: EngineTable[] = [
  { engine: 'axe-core', version: AXE_VERSION, layer: 'browser', mappings: AXE_MAPPINGS, pinnedRules: AXE_PINNED_RULES },
  { engine: 'eslint-plugin-jsx-a11y', version: JSX_A11Y_VERSION, layer: 'static', mappings: JSX_A11Y_MAPPINGS, pinnedRules: JSX_A11Y_PINNED_RULES },
  { engine: 'eslint-plugin-vuejs-accessibility', version: VUE_A11Y_VERSION, layer: 'static', mappings: VUE_A11Y_MAPPINGS, pinnedRules: VUE_A11Y_PINNED_RULES },
];

export const ALL_ENGINE_MAPPINGS: EngineRuleMapping[] = ENGINE_TABLES.flatMap((t) => t.mappings);

const BY_ENGINE_RULE = new Map<string, EngineRuleMapping>(
  ALL_ENGINE_MAPPINGS.map((m) => [`${m.engine}::${m.engineRule}`, m]),
);

/** Look up the mapping for one engine rule, or undefined if unmapped. */
export function getEngineMapping(engine: string, engineRule: string): EngineRuleMapping | undefined {
  return BY_ENGINE_RULE.get(`${engine}::${engineRule}`);
}
