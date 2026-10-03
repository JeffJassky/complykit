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
  | { kind: 'screenshot'; path: string; region?: Box; pageState?: string; overlayPath?: string }
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
  | (ArtifactBase & { kind: 'style-probe'; check: string; screenshotPath?: string; results: Loose[] })
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
  | (ArtifactBase & {
      kind: 'consent-timeline';
      scenario: string;
      location: Loose;
      verification: Loose;
      events: Loose[];
      snapshot: Loose;
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
    | 'crash'
    | 'contrast-unmeasured';
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
  consent?: ConsentConfig;
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
  | { kind: 'section'; title: number; section: string }
  | { kind: 'statute'; code: string; section: string };
export interface JurisdictionScope {
  code: string;
  from?: IsoDate;
}
export type RequirementKind = 'obligation' | 'exposure' | 'practice';
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
  jurisdictions?: JurisdictionScope[];
  kind?: RequirementKind;
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

export type CookieCategory = 'necessary' | 'functional' | 'analytics' | 'advertising' | 'unknown';
export interface CookieClassification {
  category: CookieCategory;
  vendor?: string;
}
export function classifyCookie(name: string): CookieClassification;
export function requiresConsent(category: CookieCategory): boolean;
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
  tags?: string[];
  knowledgeBase?: KnowledgeBase;
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
export interface HtmlOptions {
  cwd?: string;
  coverage?: CoverageMatrix[];
}
export function renderHtmlReport(run: Run, findings: Finding[], opts?: HtmlOptions): string;
export function renderReport(run: Run, findings: Finding[], format: ReportFormat): string;
export interface JsonReportOptions {
  coverage?: CoverageMatrix[];
  cwd?: string;
}
export function renderJsonReport(run: Run, findings: Finding[], opts?: JsonReportOptions): string;
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

// --- consent & tracking evaluation (plans/consent-design.md) ----------------
export type ScenarioId =
  | 'do-nothing'
  | 'browse'
  | 'dismiss'
  | 'reject'
  | 'accept'
  | 'partial'
  | 'withdraw'
  | 'gpc'
  | 'opt-out-all'
  | 'opt-out-link'
  | 'return-visit'
  | 'markers';
export interface ProxySpec {
  server: string;
  username?: string;
  password?: string;
  bypass?: string;
}
export interface LocationSpec {
  id: string;
  label?: string;
  country?: string;
  region?: string;
  proxy?: ProxySpec;
  timezone?: string;
  locale?: string;
  scenarios?: ScenarioId[];
}
export interface GeoSourceResult {
  name: string;
  ip?: string;
  country?: string;
  region?: string;
  city?: string;
  org?: string;
  error?: string;
}
export interface LocationVerification {
  verdict: 'verified' | 'mismatch' | 'unknown';
  expected: { country?: string; region?: string };
  observed: { ip?: string; country?: string; region?: string; city?: string };
  sources: GeoSourceResult[];
  siteReported: Array<{ source: string; value: string }>;
  jurisdictions: string[];
  regionUnverified?: boolean;
  checkedAt: string;
  note?: string;
}
export interface Initiator {
  type: string;
  chain: string[];
  element?: string;
}
export interface RequestEvent {
  type: 'request';
  t: number;
  id: string;
  url: string;
  method: string;
  resourceType: string;
  origin: 'page' | 'frame' | 'worker' | 'service-worker' | 'exit-beacon';
  frameUrl?: string;
  sandboxedFrame?: boolean;
  pageUrl: string;
  pageIndex: number;
  initiator: Initiator;
  postData?: string;
  status?: number;
  failure?: string;
  setCookies: Array<{ name: string; domain?: string; maxAgeSec?: number; expires?: string; sameSite?: string }>;
  responseHeaders?: Record<string, string>;
}
export type TimelineEvent =
  | RequestEvent
  | { type: 'websocket'; t: number; url: string; direction: 'open' | 'sent'; payload?: string; pageIndex: number }
  | { type: 'cookie-write'; t: number; name: string; value: string; attributes?: string; frameUrl: string; chain: string[]; pageIndex: number }
  | { type: 'storage-write'; t: number; area: 'local' | 'session'; key: string; value: string; frameUrl: string; chain: string[]; pageIndex: number }
  | { type: 'action'; t: number; action: 'navigate' | 'click' | 'scroll' | 'type' | 'key' | 'wait' | 'reload' | 'eval'; detail?: string; url?: string; title?: string; pageIndex: number }
  | { type: 'banner'; t: number; state: 'shown' | 'not-found' | 'gone' | 'reappeared'; cmp?: string; via?: string; pageIndex: number }
  | { type: 'choice'; t: number; choice: 'accept' | 'reject' | 'dismiss' | 'partial' | 'withdraw' | 'opt-out-link'; ok: boolean; method: string; clicks?: number; note?: string; pageIndex: number }
  | { type: 'consent-readout'; t: number; label: string; data: Record<string, unknown>; pageIndex: number }
  | { type: 'screenshot'; t: number; label: string; path: string; pageIndex: number }
  | {
      type: 'opt-out-walk';
      t: number;
      found: boolean;
      linkText?: string;
      href?: string;
      hasIcon?: boolean;
      steps?: number;
      requiredFields: string[];
      confirmation?: string;
      landedUrl?: string;
      pageIndex: number;
    }
  | { type: 'note'; t: number; text: string; pageIndex: number };
export interface CookieSnapshot {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: string;
}
export interface StorageSnapshot {
  origin: string;
  area: 'local' | 'session' | 'indexeddb';
  key: string;
  value?: string;
}
export interface TimelineSnapshot {
  site: { url: string; host: string; registrableDomain: string };
  scenario: ScenarioId;
  locationId: string;
  startedAt: string;
  durationMs: number;
  gpc: boolean;
  browser: { name: string; version?: string };
  pages: Array<{ url: string; title?: string }>;
  cookies: CookieSnapshot[];
  storage: StorageSnapshot[];
  frames: Array<{ url: string; sandboxed?: boolean }>;
  dns: Array<{ host: string; cname: string[] }>;
  markers?: { email: string; text: string; clickIds: Record<string, string> };
  notTested: string[];
  evidence: { har?: string; timeline?: string };
}
export interface Timeline {
  location: LocationSpec;
  verification: LocationVerification;
  events: TimelineEvent[];
  snapshot: TimelineSnapshot;
}
export type PartySource = 'markup' | 'markup-leak' | 'injected' | 'platform' | 'first-party-proxy' | 'unknown';
export interface PartyInventoryItem {
  partyId: string;
  label: string;
  owner?: string;
  domain: string;
  hosts: string[];
  recognized: boolean;
  kbStatus: 'confirmed' | 'proposed' | 'unrecognized';
  categories: string[];
  behavesLikeTracker: boolean;
  trackerSignals: string[];
  sends: string[];
  stores: Array<{ name: string; kind: string; lifetimeDays: number | null }>;
  sources: PartySource[];
  loadedBy: string[];
  consentApi?: string;
  seenIn: Array<{ location: string; scenario: ScenarioId; requests: number; firstMs: number; phases: string[] }>;
}
export interface ScenarioSummary {
  scenario: ScenarioId;
  status: 'tested' | 'not-tested' | 'not-applicable';
  reason?: string;
  durationMs?: number;
  banner?: { found: boolean; cmp?: string; shownAtMs?: number };
  choice?: { kind: string; ok: boolean; method: string };
  counts?: { requests: number; thirdPartyRequests: number; parties: number; cookies: number };
  evidence: { har?: string; timeline?: string; screenshots: string[] };
}
export interface LocationSummary {
  spec: Omit<LocationSpec, 'proxy'> & { proxied: boolean };
  verification: LocationVerification;
  scenarios: ScenarioSummary[];
}
export interface NotTestedItem {
  scope: 'location' | 'scenario' | 'page' | 'flow' | 'frame' | 'signal';
  id: string;
  location?: string;
  reason: string;
}
export interface TrackingEvaluation {
  schemaVersion: number;
  runId: string;
  property: string;
  site: { url: string; host: string; registrableDomain: string };
  versions: { kb: string; registry: string; package: string; autoconsent?: string };
  startedAt: string;
  finishedAt: string;
  locations: LocationSummary[];
  inventory: PartyInventoryItem[];
  notTested: NotTestedItem[];
  researchQueue: Array<{ partyId: string; domain: string; reason: string }>;
  redacted: boolean;
}
export const TRACKING_SCHEMA_VERSION: number;
export const TRACKING_FILE: string;
export function redactTimeline(t: Timeline): Timeline;
export function writeTrackingEvaluation(dir: string, evaluation: TrackingEvaluation): string;
export function readTrackingEvaluation(dir: string): TrackingEvaluation | undefined;

export interface ConsentConfig {
  locations?: LocationSpec[];
  scenarios?: ScenarioId[];
  journey?: { dwellMs?: number; pageDwellMs?: number; scrollSteps?: number; paths?: string[]; maxPages?: number };
  knowledgeBase?: { entries?: string; overrides?: Array<{ id: string; categories?: string[]; note?: string }> };
  rawEvidence?: boolean;
}

// Knowledge base + jurisdictions (registry).
export type PartyCategory =
  | 'necessary'
  | 'functional'
  | 'analytics'
  | 'advertising'
  | 'session-recording'
  | 'chat'
  | 'identity-resolution'
  | 'fingerprinting'
  | 'embed'
  | 'fonts'
  | 'captcha'
  | 'cdn'
  | 'payments'
  | 'tag-manager'
  | 'consent'
  | 'error-monitoring'
  | 'marketing-email'
  | 'reviews';
export type ConsentDecoder = 'google' | 'meta' | 'tiktok' | 'microsoft' | 'iab' | 'none';
export interface KnowledgeEntry {
  id: string;
  vendor: string;
  owner?: string;
  match: { hosts: string[]; path?: string };
  categories: PartyCategory[];
  sends: string[];
  stores: Array<{ name: string; kind: 'cookie' | 'local' | 'session'; lifetimeDays?: number }>;
  consentApi?: string;
  decoder: ConsentDecoder;
  restrictedMode?: string;
  notes?: string;
  provenance: { proposedBy: string; proposedAt: string; confirmedBy?: string; confirmedAt?: string; sources: string[] };
}
/** An entry as written (defaults filled in on parse). */
export type KnowledgeEntryInput = Omit<KnowledgeEntry, 'sends' | 'stores' | 'decoder' | 'provenance'> & {
  sends?: string[];
  stores?: Array<{ name: string; kind?: 'cookie' | 'local' | 'session'; lifetimeDays?: number }>;
  decoder?: ConsentDecoder;
  provenance: { proposedBy: string; proposedAt: string; confirmedBy?: string; confirmedAt?: string; sources?: string[] };
};
export interface KnowledgeBase {
  version: string;
  entries: KnowledgeEntry[];
}
export interface SiteOverride {
  id: string;
  categories?: PartyCategory[];
  note?: string;
}
export interface MeasuredPlace {
  country: string;
  region?: string;
}
export const KB_VERSION: string;
export const KB_ENTRIES: KnowledgeEntry[];
export const DEFAULT_KB: KnowledgeBase;
/** Categories that need prior consent in the EU/UK. */
export const CONSENT_CATEGORIES: ReadonlySet<PartyCategory>;
/** Categories whose need for consent depends on use (chat, embeds, fonts…). */
export const CONTEXT_CATEGORIES: ReadonlySet<PartyCategory>;
/** Categories wiretap suits target (session recording, chat, identity resolution, ads). */
export const WIRETAP_CATEGORIES: ReadonlySet<PartyCategory>;
/** "Sale"/"sharing" under US state laws (cross-context behavioral advertising). */
export const SALE_SHARE_CATEGORIES: ReadonlySet<PartyCategory>;
export function hostOf(url: string): string;
export function hostMatches(host: string, suffix: string): boolean;
export function isEuEea(country: string): boolean;
export function buildKnowledgeBase(opts?: { extra?: KnowledgeEntryInput[]; overrides?: SiteOverride[] }): KnowledgeBase;
export function lookupEntry(kb: KnowledgeBase, host: string, pathname?: string): KnowledgeEntry | undefined;
export function lookupStore(kb: KnowledgeBase, key: string): KnowledgeEntry | undefined;
export function entryStatus(e: KnowledgeEntry): 'confirmed' | 'proposed';
export function registrableDomain(host: string): string;
export function jurisdictionsFor(place: MeasuredPlace): string[];
export function requirementScopeFor(req: Requirement, codes: readonly string[], onDate: string): string | undefined;
export function normalizeRegion(country: string, region: string | undefined): string | undefined;

// Evaluation planning + summary (rules).
export function decideVerification(spec: LocationSpec, sources: GeoSourceResult[], checkedAt?: string): LocationVerification;
export function defaultScenarios(jurisdictions: readonly string[]): ScenarioId[];
export function locationPreset(id: string): LocationSpec;
export interface EvaluationInput {
  runId: string;
  property: string;
  site: { url: string; host: string; registrableDomain: string };
  versions: { kb: string; registry: string; package: string; autoconsent?: string };
  startedAt: string;
  finishedAt: string;
  locations: Array<{ spec: LocationSpec; verification: LocationVerification; scenarios: ScenarioSummary[] }>;
  timelines: Timeline[];
  notTested: NotTestedItem[];
  redacted: boolean;
  kb?: KnowledgeBase;
}
export function buildTrackingEvaluation(input: EvaluationInput): TrackingEvaluation;

// Consent report.
export type FindingKind = 'violation' | 'needs-review' | 'exposure' | 'practice';
export interface GridCell {
  status: 'tested' | 'not-tested' | 'not-applicable' | 'not-run';
  reason?: string;
  counts: Record<FindingKind, number>;
  banner?: string;
  choice?: string;
}
export interface ReportFinding {
  fingerprint: string;
  kind: FindingKind;
  ruleId: string;
  requirementId: string;
  requirementTitle: string;
  citation: string;
  sourceUrl?: string;
  scope: string;
  party?: string;
  message: string;
  severity: string;
  details: Record<string, unknown>;
  evidence: Evidence[];
  plaintiffRank: number;
  regulatorRank: number;
}
export interface ConsentReportModel {
  site: TrackingEvaluation['site'];
  runId: string;
  property: string;
  startedAt: string;
  finishedAt: string;
  versions: TrackingEvaluation['versions'];
  redacted: boolean;
  locations: Array<{
    id: string;
    label: string;
    verdict: string;
    observed: string;
    jurisdictions: string[];
    note?: string;
    siteReported: Array<{ source: string; value: string }>;
    proxied: boolean;
  }>;
  scenarios: ScenarioId[];
  grid: Record<string, Partial<Record<ScenarioId, GridCell>>>;
  findings: ReportFinding[];
  totals: Record<FindingKind, number>;
  inventory: PartyInventoryItem[];
  notTested: NotTestedItem[];
  researchQueue: TrackingEvaluation['researchQueue'];
  evidenceIndex: Array<{ location: string; scenario: ScenarioId; har?: string; timeline?: string; screenshots: string[] }>;
}
export interface ConsentHtmlOptions {
  runDir?: string;
}
export function findingKind(f: Finding): FindingKind;
export function citationLabel(req: Requirement): string;
export function buildConsentReportModel(evaluation: TrackingEvaluation, findings: Finding[]): ConsentReportModel;
export function renderConsentHtml(m: ConsentReportModel, opts?: ConsentHtmlOptions): string;
export function renderConsentMarkdown(m: ConsentReportModel, opts?: { maxFindings?: number }): string;
