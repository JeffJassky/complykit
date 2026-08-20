// registry/ — pure legal data + verification. Imports nothing internal
// (dependency law): importable without Playwright, an API key, or the record
// layer, so CI report tooling and a future standalone extraction stay light.
//
// The `./registry` subpath surface is data + functions + types. The internal
// zod schemas (Requirement, Instrument, …) share names with their types and
// stay internal — `export type` keeps them out of the runtime bundle so the
// value surface matches types/registry.d.ts (scripts/check-exports).

import type { Requirement, Instrument } from './schema.js';
import { INSTRUMENTS } from './instruments.js';
import { ALL_REQUIREMENTS } from './requirements/index.js';

// --- runtime ----------------------------------------------------------------
export { asRequirementId, asRuleId, asInstrumentId } from './ids.js';
export { RULESETS, findRuleSet, requirementsForRuleset } from './rulesets.js';
export { INSTRUMENTS } from './instruments.js';
export { ALL_REQUIREMENTS } from './requirements/index.js';
// Per-engine mapping arrays stay internal; ENGINE_TABLES is the public handle to
// every engine's mappings + pinned rules + layer.
export {
  AXE_MAPPINGS,
  AXE_PINNED_RULES,
  AXE_VERSION,
  ENGINE_TABLES,
  ALL_ENGINE_MAPPINGS,
  getEngineMapping,
} from './mappings/index.js';
export { verifyRegistry, unmappedEngineRules } from './verify.js';

// --- types ------------------------------------------------------------------
export type { RequirementId, RuleId, InstrumentId, IsoDate, Severity, Confidence } from './ids.js';
export type {
  ApplicabilityTag,
  VerifiedUrl,
  Citation,
  AuthorityRef,
  Requirement,
  RequirementFilter,
  Instrument,
  EngineRuleMapping,
} from './schema.js';
export type { RuleSet } from './rulesets.js';
export type { VerifyReport } from './verify.js';
export type { EngineTable } from './mappings/index.js';

// Stamped into every run.json (types-sketch Run.versions.registry): a finding
// means what the registry meant at the version that produced it. Bump on any
// requirement/mapping change; entries are append-mostly, never edited in place.
export const REGISTRY_VERSION = '0.1.0';

const REQUIREMENT_BY_ID = new Map<string, Requirement>(
  ALL_REQUIREMENTS.map((r) => [String(r.id), r]),
);
const INSTRUMENT_BY_ID = new Map<string, Instrument>(INSTRUMENTS.map((i) => [String(i.id), i]));

export function getRequirement(id: string): Requirement | undefined {
  return REQUIREMENT_BY_ID.get(id);
}

export function getInstrument(id: string): Instrument | undefined {
  return INSTRUMENT_BY_ID.get(id);
}
