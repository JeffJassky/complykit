// Root export (`.`) — dep-light: record + registry + rules (pure) + report +
// config. No Playwright, no Anthropic SDK — CI diff/report tooling imports this
// without Chromium. The heavy collectors live behind their own subpath exports
// (`./collect-static`, `./collect-browser`, `./judge`).
//
// The public surface is TYPES + FUNCTIONS. The internal zod schemas (which
// share names with their inferred types) stay internal — a consumer wants
// `Finding` the type and `resolveFinding` the function, not the validator
// object. `export type` for every shape keeps the schemas out of the runtime
// bundle; scripts/check-exports asserts the value surface matches the .d.ts.

// --- config -----------------------------------------------------------------
export { defineConfig, syntheticConfig } from './config.js';
export type {
  Config,
  Property,
  Targets,
  AuthConfig,
  RoutesConfig,
  ReviewConfig,
  BudgetConfig,
} from './config.js';

// --- record: runtime ---------------------------------------------------------
export {
  SCHEMA_VERSION,
  severityNarrows,
  FINGERPRINT_VERSION,
  fingerprint,
  resolveFinding,
  COMPLY_DIR,
  runsRoot,
  runDir,
  runIdFromTimestamp,
  writeRun,
  readRun,
  loadRun,
  listRuns,
  appendFinding,
  readFindings,
  putEvidence,
  asRequirementId,
  asRuleId,
  asRunId,
  asInstrumentId,
} from './record/index.js';

// --- record: types -----------------------------------------------------------
export type {
  RequirementId,
  RuleId,
  Fingerprint,
  RunId,
  InstrumentId,
  IsoDate,
  Severity,
  Confidence,
  ConsentPhase,
  ColorScheme,
  ViewportId,
  VerdictValue,
  AccessLevel,
  Box,
  StructuralLocator,
  Subject,
  Evidence,
  EvidenceKind,
  Producer,
  RawFinding,
  Finding,
  Verdict,
  MatrixCell,
  CoverageGap,
  Run,
  Disposition,
  Artifact,
  ArtifactKind,
  FingerprintInput,
  FindingCaps,
  NormalizeContext,
} from './record/index.js';

// --- registry: runtime -------------------------------------------------------
export {
  RULESETS,
  findRuleSet,
  requirementsForRuleset,
  INSTRUMENTS,
  ALL_REQUIREMENTS,
  AXE_MAPPINGS,
  AXE_PINNED_RULES,
  AXE_VERSION,
  ENGINE_TABLES,
  ALL_ENGINE_MAPPINGS,
  getEngineMapping,
  verifyRegistry,
  unmappedEngineRules,
  REGISTRY_VERSION,
  getRequirement,
  getInstrument,
} from './registry/index.js';

// --- registry: types ---------------------------------------------------------
export type {
  Requirement,
  Instrument,
  Citation,
  VerifiedUrl,
  AuthorityRef,
  RequirementFilter,
  EngineRuleMapping,
  EngineTable,
  ApplicabilityTag,
  RuleSet,
  VerifyReport,
} from './registry/index.js';

// --- engine normalization (engine output -> findings) -----------------------
export { normalizeEngineArtifacts } from './engines.js';
export type { EngineNormalization, NormalizeEngineOptions } from './engines.js';

// --- coverage index (rules + engine mappings) -------------------------------
export { buildCoverageIndex } from './coverage-index.js';

// --- rules: runtime + types --------------------------------------------------
export { ALL_RULES, getRule, resolveCapsFor, evaluate, isLlmRule } from './rules/index.js';
export type {
  RuleMeta,
  Rule,
  LlmRule,
  AnyRule,
  ArtifactsOf,
  EvalContext,
  PropertyContext,
} from './rules/index.js';

// --- report (functions + types; no schema values) ---------------------------
export {
  renderJsonl,
  renderMarkdown,
  renderSarif,
  renderReport,
  containsBannedVocabulary,
  assertReportVocabulary,
  diffRuns,
  budgetBreaches,
  coverage,
  renderCoverage,
} from './report/index.js';
export type {
  ReportFormat,
  RunDiff,
  BudgetGate,
  RuleLayer,
  CoverageIndex,
  CoverageRow,
  CoverageMatrix,
} from './report/index.js';

// --- orchestration ----------------------------------------------------------
export { addFinding } from './finding.js';
export type { AddFindingOptions } from './finding.js';
