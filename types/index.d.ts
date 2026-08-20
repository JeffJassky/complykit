// Public type contract for @jeffjassky/complykit (root export).
//
// Hand-written and curated (house-style.md). This package is zod-first, so the
// usual "src imports its types from here" drift-guard is replaced by a
// compile-time assertion in src/record/contract.ts that `z.infer<schema>` equals
// the shapes below — a schema that grows a field fails tsc against this file.
// types/test-d.ts exercises the surface from outside as a host sees it.

import type { z } from 'zod';

// --- branded ids ------------------------------------------------------------
export type RequirementId = string & z.BRAND<'RequirementId'>;
export type RuleId = string & z.BRAND<'RuleId'>;
export type Fingerprint = string & z.BRAND<'Fingerprint'>;
export type RunId = string & z.BRAND<'RunId'>;
export type InstrumentId = string & z.BRAND<'InstrumentId'>;
export type IsoDate = string;

export function asRequirementId(s: string): RequirementId;
export function asRuleId(s: string): RuleId;
export function asRunId(s: string): RunId;
export function asInstrumentId(s: string): InstrumentId;

// --- vocabulary -------------------------------------------------------------
export type Severity = 'critical' | 'serious' | 'moderate' | 'minor';
export type Confidence = 'violation' | 'needs-review';
export type ConsentPhase = 'pre-consent' | 'post-reject' | 'post-accept';
export type ColorScheme = 'light' | 'dark';
export type ViewportId = string;
export type VerdictValue = 'violation' | 'pass' | 'unclear';
export type AccessLevel = 'public' | 'authed' | 'repo' | 'infra';

export const SCHEMA_VERSION: number;
export function severityNarrows(base: Severity, narrowed: Severity): boolean;

// --- subject ----------------------------------------------------------------
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StructuralLocator {
  role: string;
  name?: string;
  landmark?: string;
  ordinal: number;
  cssPath?: string;
}

export interface Subject {
  property: string;
  routePattern?: string;
  file?: { path: string; line?: number };
  instanceUrl?: string;
  state?: string;
  viewport?: ViewportId;
  colorScheme?: ColorScheme;
  locator?: StructuralLocator;
}

// --- evidence ---------------------------------------------------------------
export type Evidence =
  | { kind: 'screenshot'; path: string; region?: Box; pageState?: string }
  | { kind: 'dom-snippet'; html: string; locator?: StructuralLocator }
  | { kind: 'computed-style'; properties: Record<string, string> }
  | {
      kind: 'network-request';
      url: string;
      initiatorChain: string[];
      phase?: ConsentPhase;
      resourceType?: string;
    }
  | {
      kind: 'cookie';
      name: string;
      domain: string;
      phase: ConsentPhase;
      flags: { secure: boolean; httpOnly: boolean; sameSite?: string };
      classification?: string;
    }
  | { kind: 'file'; path: string; line: number; snippet: string }
  | { kind: 'interaction-log'; steps: Array<Record<string, unknown>> }
  | {
      kind: 'verdict';
      model: string;
      rubricVersion: string;
      cropPath: string;
      verdict: VerdictValue;
      reason: string;
    };
export type EvidenceKind = Evidence['kind'];

// --- producer ---------------------------------------------------------------
export type Producer =
  | { type: 'engine'; name: string; version: string }
  | { type: 'rule'; packageVersion: string }
  | { type: 'agent'; model: string; rubricVersion: string };

// --- finding ----------------------------------------------------------------
export interface RawFinding {
  ruleId: RuleId;
  requirementId: RequirementId;
  subject: Subject;
  confidence: Confidence;
  message: string;
  details?: unknown;
  evidence: Evidence[];
}

export interface Finding extends RawFinding {
  schemaVersion: number;
  fingerprint: Fingerprint;
  severity: Severity;
  producer: Producer;
  runId: RunId;
}

export interface Verdict {
  verdict: VerdictValue;
  requirementId: RequirementId;
  reason: string;
  leads?: Array<{ mark: number; suspicion: string }>;
}

// --- artifacts (inner payloads intentionally loose) -------------------------
export interface ArtifactBase {
  subject: Subject;
  capturedAt: IsoDate;
  payloadPath?: string;
}
type Loose = Record<string, unknown>;
export type Artifact =
  | (ArtifactBase & { kind: 'dom-snapshot'; nodes: Loose[] })
  | (ArtifactBase & { kind: 'axe-result'; results: Loose })
  | (ArtifactBase & { kind: 'static-scan'; engine: string; results: Loose[] })
  | (ArtifactBase & { kind: 'style-probe'; check: string; results: Loose[] })
  | (ArtifactBase & { kind: 'inventory'; category: 'tracker' | 'ai-framework' | 'pii'; items: Loose[] })
  | (ArtifactBase & { kind: 'cookie-capture'; phase: ConsentPhase; cookies: Loose[]; storage: Loose[] })
  | (ArtifactBase & { kind: 'network-log'; phase: ConsentPhase; requests: Loose[] })
  | (ArtifactBase & {
      kind: 'consent-flow';
      cmp?: string;
      clicksToAccept: number;
      clicksToReject: number | null;
      buttonMetrics: Loose[];
    })
  | (ArtifactBase & { kind: 'focus-walk'; stops: Loose[]; traps: Loose[] })
  | (ArtifactBase & {
      kind: 'screenshot';
      path: string;
      viewport: ViewportId;
      scheme: ColorScheme;
      pageState?: string;
    })
  | (ArtifactBase & { kind: 'verdict'; ruleId: RuleId; cropHash: string; result: Verdict; model: string });
export type ArtifactKind = Artifact['kind'];

// --- run / coverage / disposition ------------------------------------------
export interface MatrixCell {
  family: 'passive' | 'probes' | 'evidence' | 'sweep';
  routePatterns: number;
  instances: number;
  viewports: ViewportId[];
  schemes: ColorScheme[];
  states: number;
}
export interface CoverageGap {
  reason:
    | 'cross-origin-iframe'
    | 'closed-shadow-root'
    | 'page-timeout'
    | 'bot-blocked'
    | 'scroll-cap'
    | 'no-key'
    | 'crash';
  subject: Subject;
  note?: string;
}
export interface Run {
  schemaVersion: number;
  id: RunId;
  property: string;
  startedAt: IsoDate;
  finishedAt?: IsoDate;
  versions: {
    package: string;
    registry: string;
    engines: Record<string, string>;
    models?: Record<string, string>;
  };
  gitSha?: string;
  accessLevels: AccessLevel[];
  matrix: MatrixCell[];
  gaps: CoverageGap[];
  rulesExecuted: RuleId[];
}
export interface Disposition {
  fingerprint: Fingerprint;
  status: 'open' | 'fixed' | 'accepted-risk' | 'false-positive' | 'wont-fix';
  by: string;
  at: IsoDate;
  why: string;
}

// --- fingerprint ------------------------------------------------------------
export const FINGERPRINT_VERSION: string;
export type FingerprintInput =
  | { detects: 'presence'; ruleId: RuleId; subject: Subject }
  | { detects: 'absence'; requirementId: RequirementId; subject: Subject };
export function fingerprint(input: FingerprintInput): Fingerprint;

// --- normalize --------------------------------------------------------------
export interface FindingCaps {
  detects: 'presence' | 'absence';
  maxConfidence: Confidence;
  requirementSeverity: Severity;
  ruleSeverity?: Severity;
  ruleRequirements: readonly RequirementId[];
}
export interface NormalizeContext {
  caps: FindingCaps;
  runId: RunId;
  producer: Producer;
}
export function resolveFinding(rawInput: unknown, ctx: NormalizeContext): Finding;

// --- run store --------------------------------------------------------------
export const COMPLY_DIR: string;
export function runsRoot(cwd?: string): string;
export function runDir(runId: RunId, cwd?: string): string;
export function runIdFromTimestamp(iso: string): RunId;
export function writeRun(run: Run, cwd?: string): string;
export function readRun(runId: RunId, cwd?: string): Run;
export function loadRun(runId: RunId, cwd?: string): { run: Run; findings: Finding[] };
export function listRuns(property?: string, cwd?: string): Run[];
export function appendFinding(runId: RunId, finding: Finding, cwd?: string): void;
export function readFindings(runId: RunId, cwd?: string): Finding[];
export function putEvidence(runId: RunId, payload: Buffer | string, ext: string, cwd?: string): string;

// --- config -----------------------------------------------------------------
export interface Targets {
  public?: { url: string };
  local?: { command: string; port: number; readyPath?: string };
  staging?: { url: string };
}
export type AuthConfig =
  | { kind: 'storage-state'; path: string }
  | { kind: 'form'; script: string };
export interface RoutesConfig {
  sitemap?: boolean;
  crawl?: { maxPages: number; sameOrigin: boolean };
  manifest?: string;
  include?: string[];
  exclude?: string[];
  sample?: number;
}
export interface Property {
  id: string;
  targets: Targets;
  auth?: AuthConfig;
  repo?: string;
  tags?: string[];
  routes: RoutesConfig;
  viewports?: string[];
  colorSchemes?: ColorScheme[];
  rulesets: string[];
  components?: Record<string, string>;
  policies?: { privacy?: string; terms?: string };
}
export interface ReviewConfig {
  models?: { adjudicate?: string; sweep?: string };
  confirmCritical?: boolean;
  sweep?: 'all' | 'changed' | 'off';
}
export interface BudgetConfig {
  failOn: 'new-critical' | 'new-serious' | 'none';
}
export interface Config {
  properties: Property[];
  review?: ReviewConfig;
  budget: BudgetConfig;
}
export function defineConfig(cfg: unknown): Config;
export function syntheticConfig(url: string): Config;

// --- registry surface -------------------------------------------------------
export type Citation =
  | { kind: 'article'; article: number; paragraph?: number; point?: string }
  | { kind: 'sc'; principle: number; guideline: number; sc: number; level: 'A' | 'AA' | 'AAA' }
  | { kind: 'clause'; clause: string }
  | { kind: 'section'; title: number; section: string };
export interface VerifiedUrl {
  href: string;
  verified?: IsoDate;
  botBlocked?: boolean;
}
export interface AuthorityRef {
  ref: string;
  note?: string;
}
export type ApplicabilityTag = string;
export interface Requirement {
  id: RequirementId;
  instrument: InstrumentId;
  citation: Citation;
  title: string;
  text: string;
  authority?: AuthorityRef[];
  urls: VerifiedUrl[];
  effective: { from: IsoDate; until?: IsoDate };
  version?: string | null;
  appliesIf?: ApplicabilityTag[];
  severity: Severity;
  supersedes?: RequirementId;
  volatile?: boolean;
}
export interface RequirementFilter {
  version?: string;
  maxLevel?: 'A' | 'AA' | 'AAA';
  idPrefix?: string;
}
export interface Instrument {
  id: InstrumentId;
  name: string;
  jurisdiction: string[];
  textLicense: string;
  incorporates?: Array<{ instrument: InstrumentId; filter: RequirementFilter }>;
}
export interface EngineRuleMapping {
  engine: string;
  engineVersion: string;
  engineRule: string;
  requirements: RequirementId[];
  confidence: 'violation' | 'needs-review';
}
export interface RuleSet {
  id: string;
  description: string;
  match(req: Requirement): boolean;
}
export interface VerifyReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  counts: { requirements: number; instruments: number; mappings: number };
  needsHumanCheck: Array<{ id: string; reason: string }>;
}
export interface EngineTable {
  engine: string;
  version: string;
  layer: 'static' | 'browser';
  mappings: EngineRuleMapping[];
  pinnedRules: string[];
}
export const INSTRUMENTS: Instrument[];
export const ALL_REQUIREMENTS: Requirement[];
export const AXE_MAPPINGS: EngineRuleMapping[];
export const AXE_PINNED_RULES: string[];
export const AXE_VERSION: string;
export const ENGINE_TABLES: EngineTable[];
export const ALL_ENGINE_MAPPINGS: EngineRuleMapping[];
export const RULESETS: RuleSet[];
export const REGISTRY_VERSION: string;
export function getEngineMapping(engine: string, engineRule: string): EngineRuleMapping | undefined;
export function findRuleSet(id: string): RuleSet | undefined;
export function requirementsForRuleset(id: string, requirements: Requirement[]): Requirement[];
export function getRequirement(id: string): Requirement | undefined;
export function getInstrument(id: string): Instrument | undefined;
export function requirementApplies(requirement: Requirement, tags: readonly string[]): boolean;
export function verifyRegistry(sinceLastRelease?: string): VerifyReport;
export function unmappedEngineRules(engine: string, observedRules: string[]): string[];

// --- engine normalization ---------------------------------------------------
export interface NormalizeEngineOptions {
  runId: RunId;
  engineVersions?: Record<string, string>;
}
export interface EngineNormalization {
  findings: Finding[];
  unmapped: Array<{ engine: string; engineRule: string; count: number }>;
}
export function normalizeEngineArtifacts(
  artifacts: Artifact[],
  opts: NormalizeEngineOptions,
): EngineNormalization;

// --- rules surface ----------------------------------------------------------
export interface RuleMeta {
  id: RuleId;
  requirements: [RequirementId, ...RequirementId[]];
  layer: 'static' | 'browser' | 'llm';
  confidence: Confidence;
  detects: 'presence' | 'absence';
  severity?: Severity;
  evidence: EvidenceKind[];
  remediation: string;
  falsePositives?: string;
}
export type ArtifactsOf<K extends readonly ArtifactKind[]> = {
  [P in K[number]]: Extract<Artifact, { kind: P }>[];
};
export interface PropertyContext {
  property: string;
  tags: ApplicabilityTag[];
}
export interface EvalContext {
  property: string;
}
export interface Rule<K extends readonly ArtifactKind[] = readonly ArtifactKind[]> extends RuleMeta {
  consumes: K;
  applies?(ctx: PropertyContext): boolean;
  evaluate(input: ArtifactsOf<K>, ctx: EvalContext): RawFinding[];
}
export interface LlmRule extends RuleMeta {
  layer: 'llm';
  mode: 'adjudicate' | 'sweep';
  rubric: string;
  rubricVersion: string;
  schemeSensitive?: boolean;
  escalation?: 'cheap-first' | 'strong-only';
}
export type AnyRule = Rule<readonly ArtifactKind[]> | LlmRule;
export const ALL_RULES: AnyRule[];
export function getRule(id: RuleId | string): AnyRule | undefined;
export function resolveCapsFor(ruleId: RuleId | string, requirementId: RequirementId | string): FindingCaps;
export function evaluate(
  artifacts: Artifact[],
  rules: AnyRule[],
  ctx: EvalContext & { tags?: string[] },
): RawFinding[];
export function isLlmRule(rule: AnyRule): rule is LlmRule;

// --- report surface ---------------------------------------------------------
export type ReportFormat = 'jsonl' | 'md' | 'sarif' | 'html';
export function renderJsonl(findings: Finding[]): string;
export function renderMarkdown(run: Run, findings: Finding[]): string;
export function renderSarif(run: Run, findings: Finding[]): string;
export function renderReport(run: Run, findings: Finding[], format: ReportFormat): string;
export function containsBannedVocabulary(text: string): boolean;
export function assertReportVocabulary(text: string): void;

export interface RunDiff {
  base: { runId: string; property: string };
  head: { runId: string; property: string };
  added: Finding[];
  resolved: Finding[];
  persisting: Finding[];
}
export type BudgetGate = 'new-critical' | 'new-serious' | 'none';
export function diffRuns(
  base: { run: Run; findings: Finding[] },
  head: { run: Run; findings: Finding[] },
): RunDiff;
export function budgetBreaches(diff: RunDiff, failOn?: BudgetGate): Finding[];

export type RuleLayer = 'static' | 'browser' | 'llm';
export type CoverageIndex = Map<string, Set<RuleLayer>>;
export interface CoverageRow {
  requirementId: string;
  title: string;
  layers: RuleLayer[];
  bucket: 'auto' | 'llm' | 'manual';
}
export interface CoverageMatrix {
  ruleset: string;
  total: number;
  autoChecked: number;
  llmAssisted: number;
  manualOnly: number;
  rows: CoverageRow[];
}
export function coverage(ruleset: string, index: CoverageIndex, run?: Run): CoverageMatrix;
export function renderCoverage(matrix: CoverageMatrix): string;
export function buildCoverageIndex(): CoverageIndex;

// --- orchestration ----------------------------------------------------------
export interface AddFindingOptions {
  runId: RunId;
  producer: Producer;
  cwd?: string;
  persist?: boolean;
}
export function addFinding(raw: unknown, opts: AddFindingOptions): Finding;
