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
  PlatformSignals,
  PlatformFingerprint,
  Timeline,
  PartySource,
  ImplementationClass,
  ImplementationEvidence,
  PartyImplementation,
  PartyInventoryItem,
  ScenarioSummary,
  LocationSummary,
  NotTestedItem,
  TrackingEvaluation,
  MarkupElement,
  MarkupPage,
  MarkupLoads,
  MarkupVerdict,
  MarkupFinding,
  MarkupSection,
  ContainerCapture,
  ContainerTag,
  TagContainer,
  TagConsentStatus,
  ConsentApiObservedCall,
  ConsentApiObservation,
  CompatibilityVerdict,
  CompatibilityChangeKind,
  CompatibilityChange,
  CompatibilityReason,
  PartyCompatibility,
  ConsentToolDefaultFinding,
  CompatibilitySection,
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
  matchVendorSignatures,
  hostsInText,
  entriesForText,
  inlineRegExp,
  registrableDomain,
  jurisdictionsFor,
  requirementScopeFor,
  normalizeRegion,
  regimeFor,
  parseRegimeLocation,
  isOptOutSignalState,
  classifyPlatform,
  platformLoaderOf,
  consentPluginPathPattern,
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
  ControlApi,
  TagControl,
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
export { parseGtmContainer, parseContainers, extractContainerData } from './rules/tracking/gtm.js';
export type { ContainerData, ParseContainerOptions } from './rules/tracking/gtm.js';
export { summarizeConsentApi } from './rules/tracking/consent-api.js';
export { evaluateCompatibility, compatibilityFor, behaviorCellsFrom, consentToolDefaultFinding, verdictRank } from './rules/tracking/compatibility.js';
export type { BehaviorCell, CompatibilityInput, CompatibilityEvaluationInput } from './rules/tracking/compatibility.js';
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
  diffConsentModels,
  buildCompatibilityReport,
  renderChangeListMarkdown,
  CHANGE_LIST_FILE,
} from './report/index.js';
export type { CompatibilityReport, CompatibilityRow, ChangeItem, ChangeGroup } from './report/index.js';
export { reconcileCompatibility } from './consent-compatibility.js';
// D10: complykit's own tool — deployed config vs reality.
export { evaluateConsentToolProof, configBehaviorCells } from './rules/tracking/consent-tool-proof.js';
export type { ConsentToolProofInput } from './rules/tracking/consent-tool-proof.js';
export { buildConsentToolProofReport, renderConsentToolProofHtml, renderConsentToolProofMarkdown } from './report/consent-tool-proof.js';
export type { ConsentToolProofReport, ProofVendorRow } from './report/consent-tool-proof.js';
export { generateConsentConfig, DEFAULT_SCRIPT_SRC } from './consent-generator.js';
export type { GenerateConsentConfigOptions, GeneratedConsentConfig, GeneratorNote, SnippetRewrite } from './consent-generator.js';
// The guided remediation flow (plans/remediation-flow.md): stable change ids,
// the task model, the task builder and the pure verify checkers.
export { changeId, changeSignature, elementSignatureOf, remediationTaskKey, readRemediationTaskValue, resolveRemediationTaskValue, isRemediationDone, classificationDecided, REMEDIATION_TASK_KEY_PREFIX, INSTALL_TASK_ID } from './record/index.js';
export type {
  RemediationTask,
  RemediationTaskKind,
  RemediationVerifySpec,
  RemediationVerifyMethod,
  RemediationStatus,
  RemediationTaskValue,
  RemediationLastVerify,
  VerifyOutcome,
  VerifyResult,
  ElementSignature,
  SpotCheckObservation,
  ChangeIdInput,
} from './record/index.js';
export { buildRemediationTasks, installTask, removeExistingToolTasks, remediationTotals, renderHeadSnippet, scriptJson } from './remediation.js';
export type { RemediationSource, RemediationSourceNote, BuildRemediationTasksOptions } from './remediation.js';
// R3: the report's "Your to-do list" checklist.
export { renderRemediationHtml, remediationFromWorkspace, parseRemediationTasks } from './report/consent-remediation.js';
export type { RemediationSection, RemediationWorkspaceLike } from './report/consent-remediation.js';
export { verifyInstall, verifyRewriteTag, verifyRemoveLeak, verifyGtmTagConsent, verifyConsentDefault, verifyRemoveExistingTool, judgeSpotCheck, runVerify, elementMatches } from './rules/remediation/verify.js';
export type { VerifyOptions, StaticVerifyInput, InstallExpectation, SpotCheckSpec, RemoveExistingToolExpectation } from './rules/remediation/verify.js';
export type {
  ReportFormat,
  HtmlOptions,
  JsonReportOptions,
  ResearchWorkflow,
  ResearchItem,
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
  ConsentRunDiff,
  SiteWorkspaceRecord,
  ConsentHtmlOptions,
} from './report/index.js';

// --- consent tool config (shared by scanner, generator, client) ---------------
// The client imports consent-config-guard.ts by relative path (zero deps);
// this surface is for the generator, the proof scanner and the service.
export {
  CONSENT_CONFIG_MAJOR,
  CONSENT_CONFIG_VERSION,
  CONSENT_CONFIG_ELEMENT_ID,
  NECESSARY_CATEGORY,
  REGIMES,
  FALLBACK_REGIME,
  CONSENT_MODE_SIGNALS,
  CONSENT_STRING_KEYS,
  parseConsentConfigVersion,
  consentConfigVersionStatus,
  readConsentConfigHeader,
  guardConsentToolConfig,
  isNecessaryCategory,
  consentCategoryDefault,
  canonicalJson,
  hashConsentToolConfig,
  withConsentConfigHash,
  parseConsentToolConfig,
  consentToolConfigJsonSchema,
  CONSENT_CONFIG_JSON_SCHEMA_ID,
  validateConsentStrings,
  DO_NOT_SELL_OR_SHARE,
} from './record/index.js';
export type {
  Regime,
  RegimeSource,
  ConsentCategory,
  VendorControl,
  ConsentVendor,
  GateRule,
  ConsentModeSignal,
  GtmConfig,
  ConsentPlatform,
  ConsentTheme,
  ConsentLayout,
  ConsentStringKey,
  ConsentStringTable,
  ConsentStateConfig,
  ConsentRecordEndpoint,
  ConsentToolConfig,
  ConsentToolConfigInput,
  ConsentConfigHeader,
  ConsentConfigVersionStatus,
  ConsentConfigGuardResult,
  ConsentConfigIssue,
  ParseConsentToolConfigResult,
  ConsentStringIssue,
  ConsentStringIssueSeverity,
  ConsentStringRule,
} from './record/index.js';

// --- orchestration ----------------------------------------------------------
export { addFinding } from './finding.js';
export type { AddFindingOptions } from './finding.js';

export type { BehaviorObservation, BehaviorMatrix, BehaviorMatrixCell } from '../types/index.js';
