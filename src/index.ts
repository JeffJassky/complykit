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
  ConsentConfig,
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
  TRACKING_SCHEMA_VERSION,
  TRACKING_FILE,
  redactTimeline,
  writeTrackingEvaluation,
  readTrackingEvaluation,
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
  ScenarioId,
  ProxySpec,
  LocationSpec,
  GeoSourceResult,
  LocationVerification,
  Initiator,
  RequestEvent,
  TimelineEvent,
  CookieSnapshot,
  StorageSnapshot,
  TimelineSnapshot,
  Timeline,
  PartySource,
  PartyInventoryItem,
  ScenarioSummary,
  LocationSummary,
  NotTestedItem,
  TrackingEvaluation,
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
  requirementApplies,
  classifyCookie,
  requiresConsent,
  KB_VERSION,
  KB_ENTRIES,
  DEFAULT_KB,
  CONSENT_CATEGORIES,
  CONTEXT_CATEGORIES,
  WIRETAP_CATEGORIES,
  SALE_SHARE_CATEGORIES,
  hostOf,
  hostMatches,
  isEuEea,
  buildKnowledgeBase,
  lookupEntry,
  lookupStore,
  entryStatus,
  registrableDomain,
  jurisdictionsFor,
  requirementScopeFor,
  normalizeRegion,
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
  CookieCategory,
  CookieClassification,
  JurisdictionScope,
  RequirementKind,
  KnowledgeBase,
  KnowledgeEntry,
  KnowledgeEntryInput,
  PartyCategory,
  ConsentDecoder,
  SiteOverride,
  MeasuredPlace,
} from './registry/index.js';

// --- engine normalization (engine output -> findings) -----------------------
export { normalizeEngineArtifacts } from './engines.js';
export type { EngineNormalization, NormalizeEngineOptions } from './engines.js';

// --- coverage index (rules + engine mappings) -------------------------------
export { buildCoverageIndex } from './coverage-index.js';

// --- rules: runtime + types --------------------------------------------------
export { ALL_RULES, getRule, resolveCapsFor, evaluate, isLlmRule } from './rules/index.js';
export { decideVerification, defaultScenarios, locationPreset, buildTrackingEvaluation } from './rules/tracking/index.js';
export type { EvaluationInput } from './rules/tracking/index.js';
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
  renderHtmlReport,
  renderJsonReport,
  renderReport,
  containsBannedVocabulary,
  assertReportVocabulary,
  diffRuns,
  budgetBreaches,
  coverage,
  renderCoverage,
  findingKind,
  citationLabel,
  buildConsentReportModel,
  renderConsentHtml,
  renderConsentMarkdown,
} from './report/index.js';
export type {
  ReportFormat,
  HtmlOptions,
  JsonReportOptions,
  RunDiff,
  BudgetGate,
  RuleLayer,
  CoverageIndex,
  CoverageRow,
  CoverageMatrix,
  FindingKind,
  GridCell,
  ReportFinding,
  ConsentReportModel,
  ConsentHtmlOptions,
} from './report/index.js';

// --- orchestration ----------------------------------------------------------
export { addFinding } from './finding.js';
export type { AddFindingOptions } from './finding.js';
