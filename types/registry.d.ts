// Public types for the `@jeffjassky/complykit/registry` subpath — the pure legal
// data + verification API, importable without Playwright, an API key, or the
// record layer. A subset of the root surface, re-exported so the dep-light
// consumer imports only what registry declares.

export type {
  RequirementId,
  RuleId,
  InstrumentId,
  IsoDate,
  Severity,
  Confidence,
  Citation,
  VerifiedUrl,
  AuthorityRef,
  ApplicabilityTag,
  Requirement,
  RequirementFilter,
  Instrument,
  EngineRuleMapping,
  EngineTable,
  RuleSet,
  VerifyReport,
} from './index.js';

export {
  asRequirementId,
  asRuleId,
  asInstrumentId,
  INSTRUMENTS,
  ALL_REQUIREMENTS,
  AXE_MAPPINGS,
  AXE_PINNED_RULES,
  AXE_VERSION,
  ENGINE_TABLES,
  ALL_ENGINE_MAPPINGS,
  getEngineMapping,
  RULESETS,
  REGISTRY_VERSION,
  findRuleSet,
  requirementsForRuleset,
  getRequirement,
  getInstrument,
  verifyRegistry,
  unmappedEngineRules,
} from './index.js';
