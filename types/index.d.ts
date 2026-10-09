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

export type CookieCategory = 'necessary' | 'functional' | 'analytics' | 'performance' | 'advertising' | 'other' | 'unknown';
export interface CookieClassification {
  category: CookieCategory;
  vendor?: string;
}
export function classifyCookie(name: string): CookieClassification;
export function requiresConsent(category: CookieCategory): boolean;
export type PlatformName = PlatformFingerprint['name'];
export function classifyPlatform(signals: PlatformSignals | undefined): PlatformFingerprint | undefined;
export function platformLoaderOf(url: string, fingerprint: { name: PlatformName } | undefined): PlatformName | undefined;
/** The asset-path pattern (regex source) that fingerprints a consent plugin by id; undefined for a plugin without one. */
export function consentPluginPathPattern(id: string): string | undefined;
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
  /** The id of the request this one is a redirect hop of. */
  redirectedFrom?: string;
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
      /** The scan used the opt-out control (never a form asking for personal data). */
      performed?: boolean;
      pageIndex: number;
    }
  | { type: 'note'; t: number; text: string; pageIndex: number }
  | {
      type: 'consent-api';
      t: number;
      api: ConsentApiName;
      kind: 'call' | 'ready';
      call: string;
      args: unknown[];
      frameUrl: string;
      top: boolean;
      chain: string[];
      pageIndex: number;
    };
export type ConsentApiName = 'google' | 'meta' | 'tiktok' | 'clarity' | 'microsoft-uet' | 'tcf' | 'gpp' | 'shopify';
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
export interface PlatformSignals {
  globals: string[];
  generator?: string;
  assetUrls: string[];
  templateVersion?: string;
}
export interface PlatformFingerprint {
  name: 'shopify' | 'wix' | 'squarespace' | 'wordpress';
  version?: string;
  consentPlugin?: string;
  wpConsentApi?: boolean;
  evidence: string[];
}
/** What the browser does with a tag on a normal page load (static markup inspection). */
export type MarkupLoads = 'executes' | 'fetches' | 'connects' | 'held' | 'inert';
export interface MarkupElement {
  kind: 'script' | 'img' | 'iframe' | 'link';
  /** 1-based line of the start tag in the served HTML. */
  line: number;
  context: 'document' | 'noscript' | 'template';
  loads: MarkupLoads;
  url?: string;
  attributes: Record<string, string>;
  /** Inline script body (truncated; dropped by redaction). */
  body?: string;
  bodyLength?: number;
  bodyDigest?: string;
  hosts: string[];
  ids: string[];
  /** The inline body calls document.write / writeln (read from the whole body; survives redaction). */
  documentWrite?: boolean;
  /** The script's code is a data: URL, decoded into body / hosts / ids (the URL itself is never recorded). */
  dataUrl?: MarkupDataUrl;
  /** A performance plugin re-typed the script and runs it itself (WP Rocket, LiteSpeed, Perfmatters, Rocket Loader): not consent gating. */
  optimizer?: string;
}
export interface MarkupDataUrl {
  /** The attribute that carries it: 'src', 'data-src', 'data-rocket-src'. */
  attribute: string;
  mediaType: string;
  encoding: 'base64' | 'percent';
  encodedLength: number;
  /** Longer than the decode limit: only its start was inspected. */
  truncated?: boolean;
}
export interface MarkupPage {
  url: string;
  pageIndex: number;
  status: 'inspected' | 'not-inspected';
  via?: 'navigation' | 'refetch';
  reason?: string;
  bytes?: number;
  digest?: string;
  lines?: number;
  elements: MarkupElement[];
}
/** gateable = executable script; leak = fetched by the browser itself (img/iframe/preload/noscript); hint = dns-prefetch/preconnect; held = already switched off in markup. */
export type MarkupVerdict = 'gateable' | 'leak' | 'hint' | 'held';
export interface MarkupFinding {
  partyId: string;
  label: string;
  recognized: boolean;
  verdict: MarkupVerdict;
  trigger?: 'page-load' | 'javascript-disabled';
  kind: 'script' | 'img' | 'iframe' | 'link';
  context: 'document' | 'noscript';
  page: string;
  line: number;
  url?: string;
  inline: boolean;
  attributes: Record<string, string>;
  matchedBy: 'host' | 'inline-pattern' | 'inline-host' | 'inline-id';
  match: string;
  /** An inline snippet whose body calls document.write: not gateable asynchronously. */
  documentWrite?: boolean;
  /** Tag ids read from an inline (or data: URL) body: G-…, AW-…, GTM-… */
  ids?: string[];
  /** The script's code is a data: URL (its payload is never recorded). */
  dataUrl?: Pick<MarkupDataUrl, 'attribute' | 'mediaType' | 'encoding'>;
  /** A performance plugin delays the script and runs it itself: not consent gating. */
  optimizer?: string;
  locations: string[];
  alsoOn: string[];
  occurrences: number;
}
export interface MarkupSection {
  pages: Array<{ url: string; status: 'inspected' | 'not-inspected'; via?: 'navigation' | 'refetch'; reason?: string; locations: string[]; elements: number; bytes?: number }>;
  findings: MarkupFinding[];
  unexplained: Array<{ partyId: string; source: string; reason: string }>;
}
export interface TimelineSnapshot {
  site: { url: string; host: string; registrableDomain: string };
  scenario: ScenarioId;
  locationId: string;
  startedAt: string;
  durationMs: number;
  gpc: boolean;
  run?: number;
  throttled?: boolean;
  browser: { name: string; version?: string };
  pages: Array<{ url: string; title?: string }>;
  cookies: CookieSnapshot[];
  storage: StorageSnapshot[];
  frames: Array<{ url: string; sandboxed?: boolean }>;
  platformSignals?: PlatformSignals;
  /** Static markup inspection: the served HTML of each visited page, parsed. Absent = not run. */
  markup?: MarkupPage[];
  dns: Array<{ host: string; cname: string[] }>;
  markers?: { email: string; text: string; clickIds: Record<string, string> };
  notTested: string[];
  /** Where the visit's time went: one row per step path ("land", "browse.page.navigate"), repeats aggregated (count, total ms, max ms), slowest first; open = still running when recorded. Absent = not recorded. */
  steps?: Array<{ step: string; count: number; ms: number; maxMs: number; open?: boolean }>;
  evidence: { har?: string; timeline?: string };
}
export interface Timeline {
  location: LocationSpec;
  verification: LocationVerification;
  events: TimelineEvent[];
  snapshot: TimelineSnapshot;
}
export type PartySource = 'markup' | 'markup-leak' | 'injected' | 'platform' | 'first-party-proxy' | 'unknown';
/** How a party got onto the page — one of the seven implementations (client-consent design §3). */
export type ImplementationClass = 'direct-script' | 'markup-leak' | 'gtm' | 'other-tag-manager' | 'platform' | 'cname' | 'server-side-suspected' | 'unknown';
export interface ImplementationEvidence {
  class: ImplementationClass;
  kind: 'markup' | 'container-tag' | 'source' | 'loader' | 'cname' | 'endpoint' | 'none';
  /** true = the scan saw the tracker load this way; false = static presence or inference. */
  observed: boolean;
  note: string;
  page?: string;
  line?: number;
  verdict?: string;
  containerId?: string;
  tagId?: number;
  url?: string;
  host?: string;
  target?: string;
}
export interface PartyImplementation {
  class: ImplementationClass;
  /** Deciding evidence first. */
  evidence: ImplementationEvidence[];
  /** Other classes with evidence, in precedence order. */
  alsoSeen: ImplementationClass[];
}
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
  /** Which of the seven implementations; absent on records from older builds. */
  implementation?: PartyImplementation;
  consentApi?: string;
  samples: string[];
  seenIn: Array<{ location: string; scenario: ScenarioId; requests: number; firstMs: number; phases: string[] }>;
}
export interface ConsentToolRecord {
  vendor: string | null;
  defaultGrants: Record<string, boolean>;
  decoded: boolean;
  choiceRecorded?: boolean;
  source: string;
  note?: string;
}
// complykit's OWN consent tool as the rescan sees it (D10, src/record/consent-tool-proof.ts).
export interface ComplykitDiagnostics {
  gtm?: { dataLayer?: string; regime?: string; orderOk?: boolean; containersLoadedBefore: string[]; gtmEventBefore?: boolean; containerScriptsBefore: string[]; warnings: string[] };
  adapters?: { regime?: string; active: Array<{ adapter: string; vendors: string[] }>; waiting: string[]; notes: unknown[] };
  location?: { source: string; regime: string; pending?: boolean; gpc?: boolean };
  ui?: { url?: string; state: 'loading' | 'loaded' | 'failed'; error?: string };
  shopify?: unknown;
  wix?: unknown;
}
export interface ComplykitToolSnapshot {
  present: boolean;
  global: boolean;
  version?: string;
  configElement: boolean;
  /** The config element's raw text (the site's own public markup), capped. */
  configJson?: string;
  cookiePresent: boolean;
  /** ComplyKit.get() returned a state: the store started on the config. */
  running: boolean;
  state?: { status: 'chosen' | 'unset'; regime: string; gpc: boolean; categories: Record<string, boolean>; configHash?: string };
  diagnostics?: ComplykitDiagnostics;
  gate: { released: number; held: number; heldCategories: string[] };
  bannerShown: boolean;
  reopenControl: boolean;
}
export type ConsentToolProofConfigStatus = 'ok' | 'refused' | 'invalid' | 'not-json' | 'missing';
export type ConsentToolProofFindingCode =
  | 'config-missing'
  | 'config-refused'
  | 'config-invalid'
  | 'config-edited'
  | 'config-behind'
  | 'config-other-site'
  | 'tool-after-gtm'
  | 'ui-not-loaded'
  | 'gate-rule-unrewritten'
  | 'necessary-tracker'
  | 'regime-mismatch'
  | 'vendor-not-controlled'
  | 'tool-not-running'
  | 'gpc-not-honored'
  | 'vendor-not-in-config'
  | 'gated-document-write';
export interface ConsentToolProofFinding {
  code: ConsentToolProofFindingCode;
  message: string;
  refs: string[];
  details?: Record<string, unknown>;
}
export interface VendorControlObservation {
  location: string;
  scenario: string;
  run?: number;
  regime: string;
  expectedGranted: boolean;
  /** loaded = no data, nothing stored, but the vendor's own script / iframe / pixel loaded. */
  observed: 'fired' | 'restricted' | 'loaded' | 'held';
  requests: number;
  stores: number;
  /** Requests that carried no data (the vendor's own script / resources). Absent when not counted. */
  loads?: number;
  /** What the journey did in the compared phases. Absent when not recorded. */
  journey?: { pages: number; steps: string[] };
  /** Withdraw only: requests between the withdraw click and the reload not counted as post-withdraw activity. */
  graceRequests?: number;
  /** Set when the tool decided a weaker regime than the location's rules. */
  lawRegime?: string;
  expectedGrantedByLaw?: boolean;
  note?: string;
  ref?: string;
  beforeChoice?: boolean;
}
export type VendorControlResult = 'controlled' | 'not-controlled' | 'not-observed';
export interface VendorControlProof {
  id: string;
  label: string;
  category: string;
  control: string;
  result: VendorControlResult;
  reason: string;
  seen: boolean;
  observations: VendorControlObservation[];
}
/**
 * The proof section (D10): the deployed complykit config against what ran.
 * 'controlled' only when held in a denied state AND seen running in a granted
 * one; 'not-controlled' when it fired where the config denies its category;
 * everything else 'not-observed'. Never a pass without an observation.
 */
export interface ConsentToolProof {
  detected: boolean;
  version?: string;
  seenIn: Array<{ location: string; scenario: string; running: boolean; bannerShown: boolean }>;
  config: {
    status: ConsentToolProofConfigStatus;
    version?: string;
    hash?: string;
    generatedFrom?: { runId?: string; at?: string; site?: string; complykit?: string; kb?: string };
    versionStatus?: string;
    hashMatches?: boolean;
    guard?: { ok: boolean; reason?: string; detail?: string };
    issues: Array<{ path: string; message: string }>;
    workspace?: { hash?: string; at?: string; runId?: string; same: boolean; sameContent?: boolean };
  };
  vendors: VendorControlProof[];
  totals: { controlled: number; notControlled: number; notObserved: number };
  findings: ConsentToolProofFinding[];
  driven: Array<{ location: string; scenario: string; choice: string; ok: boolean; method: string }>;
  notTested: string[];
  scope?: { pages?: number; locations: number; runs: number };
}
/** Why a visit was skipped or its choice not completed; the report sorts it into not applicable, couldn't test, or blocked by the site. */
export type SkipCause = 'no-banner' | 'no-close' | 'settings-dead' | 'no-category-choice' | 'no-withdraw-entry' | 'no-opt-out-link' | 'opt-out-asks-personal-data' | 'choice-failed' | 'timeout' | 'crashed' | 'bot-blocked';
export interface ScenarioSummary {
  scenario: ScenarioId;
  status: 'tested' | 'not-tested' | 'not-applicable';
  reason?: string;
  cause?: SkipCause;
  durationMs?: number;
  banner?: { found: boolean; cmp?: string; shownAtMs?: number };
  choice?: { kind: string; ok: boolean; method: string };
  /** The opt-out link walk on this scenario's visit, when one ran: why an opt-out was or was not completed. */
  optOutWalk?: { found: boolean; linkText?: string; requiredFields: string[]; performed?: boolean };
  consentTool?: ConsentToolRecord;
  /** complykit's own tool as this scenario's landing exposed it (D10). */
  complykit?: ComplykitToolSnapshot;
  runs?: number;
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
export interface BehaviorMatrixCell {
  columnId:string;status:'match'|'mismatch'|'review'|'unknown'|'not-tested'|'allowed';/** Set when the column was skipped: nothing to test, the scan could not, or the site blocked the visitor. */skip?:'not-applicable'|'untestable'|'blocked';expected:string;observed:string;reason:string;evidencePointers:string[];runs?:{total:number;active:number};comparisonFacts?:{scenario:string;unavailable?:{status:'unknown'|'not-tested';reason:string};hasActivity:boolean;limitedOnly:boolean;captureGap:boolean};
}
export interface BehaviorMatrix {
  version:1;comparison:string;
  /** `unavailable`: the column's visitor action did not run or its choice did not succeed — one gap for the whole column; its cells are 'not-tested'. `kind`: nothing to test (not-applicable), the scan could not (untestable), or the site blocked the visitor (blocked). */
  columns:Array<{id:string;location:string;scenario:ScenarioId;label:string;locationLabel:string;unavailable?:{reason:string;kind:'not-applicable'|'untestable'|'blocked'}}>;
  rows:Array<{id:string;kind:'tool'|'storage';label:string;tool:string;partyId:string;storageKind?:string;categories:string[];purposeCategories?:string[];categorySource:string;link:string;cells:BehaviorMatrixCell[]}>;
}
export interface BehaviorObservation {
  location: string; scenario: ScenarioId; run?: number; throttled?: boolean; /** Pages the journey visited in this run. */ pages?: number; durationMs: number; knownPartyIds:string[];
  /** Per phase: pages the journey was on (pageIndex) and the steps it took ('navigate' | 'scroll' | 'search'). */
  journey?: Record<string, { pageIndexes: number[]; steps: string[] }>;
  /** Phase keys include 'withdraw-grace' (requests between the withdraw click and the reload not counted as post-withdraw activity). loadRequestsByPhase = requests that carried no data. */
  parties: Array<{partyId:string;dataRequests:number;requestPhases:string[];dataRequestPhases:Record<string,number>;limitedRequestsByPhase:Record<string,number>;loadRequestsByPhase?:Record<string,number>;stores:Array<{name:string;kind:string;writePhase?:string;writePhases:string[];presentAtEnd:boolean;thirdParty?:boolean;attribution:'observed'|'known-name'}>}>;
}
// Tag-manager containers (A2). A capture is the collector's fetch result; a
// TagContainer is the parsed record. An unreadable container has no tags and a
// reason — never a consent claim.
export interface ContainerCapture {
  id: string;
  kind: 'gtm' | 'gtag';
  url: string;
  locationId: string;
  seenOn: string[];
  fetchedAt: string;
  status: 'ok' | 'error';
  httpStatus?: number;
  bytes?: number;
  evidencePath?: string;
  source?: string;
  error?: string;
}
export type TagConsentStatus = 'required' | 'built-in' | 'template-checks' | 'none' | 'unknown';
export interface ContainerTag {
  tagId: number;
  index: number;
  template: string;
  templateLabel: string;
  kind: 'tag' | 'helper' | 'setting';
  custom: boolean;
  paused: boolean;
  partyId?: string;
  partyLabel?: string;
  mappedBy?: 'template' | 'parameter' | 'signature' | 'permission' | 'host';
  identifiers: string[];
  loads: string[];
  triggers: string[];
  exceptions: string[];
  events: string[];
  firesOnPageLoad: boolean;
  consent: { status: TagConsentStatus; additional: string[]; builtIn: string[]; note?: string };
  sequencing?: { setup: number[]; teardown: number[] };
  settings?: Record<string, string | number | boolean>;
}
export interface TagContainer {
  id: string;
  kind: 'gtm' | 'gtag';
  url: string;
  fetchedAt: string;
  locationId?: string;
  seenOn: string[];
  evidencePath?: string;
  status: 'parsed' | 'unreadable' | 'not-fetched';
  reason?: string;
  version?: string;
  tags: ContainerTag[];
  counts?: { tags: number; helpers: number; settings: number; required: number; builtIn: number; templateChecks: number; none: number; unknown: number; unmapped: number };
  unmappedTemplates: string[];
  consentMode?: { initTrigger: boolean; defaultsSetBy: string[]; updatedBy: string[] };
  warnings: string[];
}
// Consent-API observations (A3): what the page told each vendor's consent API,
// per timeline. Measurement calls are counted, not listed.
export interface ConsentApiObservedCall {
  t: number;
  api: ConsentApiName;
  call: string;
  command?: string;
  action: 'default' | 'update' | 'grant' | 'revoke' | 'hold' | 'measure' | 'read' | 'ready' | 'other';
  phase: string;
  consent?: Record<string, 'granted' | 'denied'>;
  grants: boolean;
  denies: boolean;
  regional: boolean;
  pageIndex: number;
}
export interface ConsentApiObservation {
  location: string;
  scenario: ScenarioId;
  run?: number;
  apis: ConsentApiName[];
  calls: number;
  consentCalls: ConsentApiObservedCall[];
  states: Array<{ state: 'default-after-load' | 'not-called-after-refusal' | 'grant-on-load'; api: ConsentApiName; t: number; phase: string; reason: string }>;
  unknowns: string[];
}
// Compatibility verdict per tool (B1). Conservative: 'gateable' needs a gateable
// markup finding and no leak; missing evidence is 'unknown', never a pass.
export type CompatibilityVerdict = 'gateable' | 'tag-manager' | 'platform' | 'uncontrollable' | 'unknown';
export type CompatibilityChangeKind =
  | 'behavior-mismatch'
  | 'rewrite-tag'
  | 'remove-leak'
  | 'gate-gtm-tag'
  | 'set-consent-default'
  | 'configure-tag-manager'
  | 'use-platform-api'
  | 'call-consent-api'
  | 'change-dns'
  | 'accepted-exposure'
  | 'needs-a-look';
export interface CompatibilityChange {
  kind: CompatibilityChangeKind;
  note: string;
  page?: string;
  line?: number;
  url?: string;
  element?: string;
  containerId?: string;
  tagId?: number;
  consentTypes?: string[];
  api?: string;
  platform?: string;
  manager?: string;
  host?: string;
  target?: string;
  /** Why the change is needed, shown with the item in the change list. */
  why?: string;
  /** A Google tag destination a GTM container loads from a gtag('config') command in the page (no container tag carries it). */
  destinationId?: string;
}
export interface CompatibilityReason {
  source: 'behavior' | 'implementation' | 'markup' | 'container' | 'consent-api' | 'consent-tool' | 'control' | 'platform';
  note: string;
  /** JSON-pointer-style reference into the evaluation record. */
  ref?: string;
}
export interface PartyCompatibility {
  partyId: string;
  label: string;
  implementation: ImplementationClass;
  verdict: CompatibilityVerdict;
  /** Does the purpose need consent? 'not-required' parties carry no changes (the verdict only describes how they load). */
  purpose?: 'needs-consent' | 'context' | 'not-required' | 'unclassified';
  /** Behavior disagreed with expectations somewhere tested; outranks the verdict. */
  behaviorMismatch: boolean;
  /** At least one location × scenario could be compared. */
  behaviorChecked: boolean;
  reasons: CompatibilityReason[];
  /** The owner's change list; a 'behavior-mismatch' entry comes first when one exists. */
  changes: CompatibilityChange[];
}
export interface ConsentToolDefaultFinding {
  status: 'grants-by-default' | 'no-grants-decoded' | 'not-observed';
  vendor?: string | null;
  grants: string[];
  observed: Array<{ location: string; scenario: ScenarioId; source: string; grants: string[] }>;
  note: string;
}
export interface CompatibilitySection {
  parties: PartyCompatibility[];
  consentTool: ConsentToolDefaultFinding;
  inputs: { markup: boolean; containers: boolean; consentApi: boolean; consentTool: boolean; behavior: boolean };
}
export interface LocalCopyRecord {
  file: string;
  origin: string;
  head: boolean;
  documents: { rewritten: number; unreadable: number };
  errors: string[];
  replacements: Array<{ label: string; applied: number }>;
  served: Array<{ path: string; requests: number }>;
  resources: Array<{ url: string; status: 'rewritten' | 'unchanged' | 'not-seen'; note?: string }>;
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
  platform?: PlatformFingerprint;
  /** Static markup inspection; absent = not run. */
  markup?: MarkupSection;
  /** Tag-manager containers seen loading, fetched and parsed; absent = none seen. */
  containers?: TagContainer[];
  /** Consent-API observations per timeline (A3); absent = not recorded. */
  consentApi?: ConsentApiObservation[];
  /** Per-tool compatibility verdicts and the owner's change list (B1); absent on older records. */
  compatibility?: CompatibilitySection;
  /** complykit's own consent tool, when installed: deployed config vs reality (D10). */
  consentToolProof?: ConsentToolProof;
  /** Local-copy mode (D11): the site was rewritten inside the scanner's browser; the run is evidence about that copy only. */
  localCopy?: LocalCopyRecord;
  notTested: NotTestedItem[];
  researchQueue: Array<{ partyId: string; domain: string; reason: string; kind: 'unrecognized' | 'drift' }>;
  redacted: boolean;
  behaviorObservations?: BehaviorObservation[];
  siteWorkspace?: SiteWorkspaceRecord;
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
/** A vendor's documented runtime consent call; strings are the JS to run. */
export interface ControlApi {
  name: string;
  /** Run before the tag loads so it starts denied. */
  hold?: string;
  grant: string;
  revoke: string;
  afterRevoke: 'stops' | 'cookieless' | 'stops-storage' | 'unknown';
  sources: string[];
}
/** How a tag is controlled (gate the load always works; this is what varies). */
export interface TagControl {
  /** Absent: no documented consent API — gate the load. */
  api?: ControlApi;
  restrictedMode?: { name: string; set: string; sources: string[] };
  /** Install-snippet markup that fires without script. */
  snippetLeak?: 'noscript-img' | 'iframe' | 'none';
  loadsOthers?: boolean;
  /** Part of a platform; only the platform's consent API controls it. */
  platform?: string;
  /** IAB TCF / GPP is the only consent signal. */
  tcf?: { vendorId?: number; gpp?: boolean; sources: string[] };
  notes?: string;
  sources: string[];
}
export interface KnowledgeEntry {
  id: string;
  vendor: string;
  owner?: string;
  match: { hosts: string[]; path?: string; /** Regex sources over inline <script> bodies (static markup inspection). */ inline?: string[] };
  categories: PartyCategory[];
  sends: string[];
  stores: Array<{ name: string; kind: 'cookie' | 'local' | 'session'; lifetimeDays?: number }>;
  consentApi?: string;
  decoder: ConsentDecoder;
  restrictedMode?: string;
  control?: TagControl;
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
/** A domain on a shared cloud or hosting platform: who hosts it and the tenant's name ('acme.s3.amazonaws.com' → Amazon S3, 'acme'). Undefined for an ordinary domain. */
export function hostedOn(domain: string): { provider: string; name: string } | undefined;
/** A party's display name from its domain: 'acme (Amazon S3)' for a cloud tenant, else the domain. */
export function domainLabel(domain: string): string;
export function isEuEea(country: string): boolean;
export function buildKnowledgeBase(opts?: { extra?: KnowledgeEntryInput[]; overrides?: SiteOverride[] }): KnowledgeBase;
export function lookupEntry(kb: KnowledgeBase, host: string, pathname?: string): KnowledgeEntry | undefined;
// Vendor install signatures over script text: KB entries' `match.inline`, shared by the markup inspector and the GTM parser.
export function matchVendorSignatures(text: string, kb?: KnowledgeBase): string[];
export function inlineRegExp(src: string): RegExp | null;
export function hostsInText(text: string): string[];
export function entriesForText(kb: KnowledgeBase, text: string): KnowledgeEntry[];
export function lookupStore(kb: KnowledgeBase, key: string): KnowledgeEntry | undefined;
export function entryStatus(e: KnowledgeEntry): 'confirmed' | 'proposed';
export function registrableDomain(host: string): string;
export function jurisdictionsFor(place: MeasuredPlace): string[];
export function requirementScopeFor(req: Requirement, codes: readonly string[], onDate: string): string | undefined;
export function normalizeRegion(country: string, region: string | undefined): string | undefined;
// Location → consent regime, shared with the client package (src/registry/regime.ts).
// Unknown or unresearched location ⇒ 'opt-in'; US without a state ⇒ 'opt-out-signal'.
export function regimeFor(location: MeasuredPlace | undefined, onDate?: string): Regime;
/** "DE", "US-CA", "USCA" → { country, region? }; anything else → undefined. */
export function parseRegimeLocation(raw: unknown): MeasuredPlace | undefined;
/** Whether a US state's law requires honoring GPC on a date. */
export function isOptOutSignalState(region: string, onDate?: string): boolean;
/** Whether a visitor from these jurisdiction codes carries wiretap-litigation exposure (CA, FL, PA — derived from the registry's wiretap requirements). */
export function isWiretapJurisdiction(codes: readonly string[]): boolean;
/** The wiretap-litigation state codes ("us-ca", "us-fl", "us-pa"). */
export const WIRETAP_STATES: ReadonlySet<string>;
/** EU-27 + EEA country codes (ePrivacy prior consent), shared with the client. */
export const EU_EEA_COUNTRIES: readonly string[];
/** Whether a US state has a comprehensive privacy act in force on a date. */
export function isUsPrivacyActState(region: string, onDate?: string): boolean;
/** The scanner's regime for a measured location: a Regime, or 'unknown' when no researched law reaches it. */
export type RegimeVerdict = Regime | 'unknown';
/**
 * The regime for jurisdiction codes (jurisdictionsFor) on a date — the scanner's decision.
 * 'us' with no state code is 'opt-out' (default 'baseline') or 'opt-out-signal' ('strict',
 * the client's posture). Codes outside EU/UK/US are 'unknown'.
 */
export function regimeForCodes(codes: readonly string[], onDate?: string, opts?: { unverifiedUs?: 'baseline' | 'strict' }): RegimeVerdict;
/** US states with a comprehensive privacy act: in-force date and, where the act requires honoring GPC, that date. */
export const US_PRIVACY_ACT_STATES: ReadonlyArray<{ state: string; from: string; gpcFrom?: string }>;
/** US states whose law requires honoring an opt-out preference signal (GPC), with the date that duty starts. */
export const US_OPT_OUT_SIGNAL_STATES: ReadonlyArray<{ state: string; from: string }>;
export interface UsStatePrivacyAct {
  state: string;
  name: string;
  citation: string;
  urls: VerifiedUrl[];
  sensitive: 'opt-in' | 'notice-and-opt-out' | 'sale-banned';
}
/** The state comprehensive privacy acts by USPS code. */
export const US_STATE_PRIVACY_ACTS: Readonly<Record<string, UsStatePrivacyAct>>;
/** USPS code → state name. */
export const US_STATE_NAMES: Readonly<Record<string, string>>;
/** The act for a state with its dates, or undefined. */
export function usStateAct(region: string): (UsStatePrivacyAct & { from: string; gpcFrom?: string }) | undefined;
export interface LocationRuleLaw {
  requirementId: string;
  instrument: string;
  instrumentName: string;
  title: string;
  citation: string;
  kind: RequirementKind;
  urls: string[];
  since: string;
}
/** Which rules the scan compares a location against, derived from the registry (describeLocationRules). */
export interface LocationRules {
  regime: RegimeVerdict;
  label: string;
  summary: string;
  mustHave: string[];
  laws: LocationRuleLaw[];
  stateAct?: { state: string; name: string; citation: string; urls: string[]; from: string; gpcFrom?: string; inForce: boolean; sensitive: UsStatePrivacyAct['sensitive'] };
  notes: string[];
  verified: boolean;
}
export interface DescribeLocationOptions {
  verified?: boolean;
  observed?: string;
}
export function describeLocationRules(codes: readonly string[], onDate: string, opts?: DescribeLocationOptions): LocationRules;

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
  /** Tag-manager containers fetched by the collector; absent = not looked for. */
  containers?: ContainerCapture[];
}
export function buildTrackingEvaluation(input: EvaluationInput): TrackingEvaluation;
// Consent-API summary (A3) and the compatibility verdict (B1). Pure; fixture-tested.
export function summarizeConsentApi(timeline: Timeline): ConsentApiObservation;
export interface BehaviorCell {
  partyId: string;
  location: string;
  scenario: string;
  run?: number;
  status: 'mismatch' | 'no-mismatch-observed' | 'not-established';
  reason: string;
  ref?: string;
}
export interface CompatibilityInput {
  markup?: MarkupSection;
  containers?: TagContainer[];
  consentApi?: ConsentApiObservation[];
  platform?: Pick<PlatformFingerprint, 'name' | 'consentPlugin' | 'wpConsentApi'>;
  behavior?: BehaviorCell[];
  kb?: KnowledgeBase;
  partyIndex?: number;
  /** Privacy regime per location id, to qualify grant-on-load changes. */
  regimes?: Record<string, 'opt-in' | 'opt-out-signal' | 'opt-out' | 'unknown'>;
}
export type CompatibilityEvaluationInput = Pick<TrackingEvaluation, 'inventory' | 'locations'> &
  Partial<Pick<TrackingEvaluation, 'markup' | 'containers' | 'consentApi' | 'platform' | 'behaviorObservations'>> & { kb?: KnowledgeBase };
export function evaluateCompatibility(ev: CompatibilityEvaluationInput): CompatibilitySection;
export function compatibilityFor(party: PartyInventoryItem, input: CompatibilityInput): PartyCompatibility;
export function behaviorCellsFrom(ev: Pick<TrackingEvaluation, 'locations' | 'inventory' | 'behaviorObservations'>): BehaviorCell[];
export function consentToolDefaultFinding(locations: LocationSummary[]): ConsentToolDefaultFinding;
export function verdictRank(v: CompatibilityVerdict): number;
// GTM container parser (pure; fixture-tested).
export interface ContainerData {
  resource: { version?: unknown; macros: unknown[]; tags: unknown[]; predicates: unknown[]; rules: unknown[] };
  runtime?: unknown[];
  permissions?: Record<string, Record<string, unknown>>;
  sandboxed_scripts?: string[];
}
export interface ParseContainerOptions {
  kb?: KnowledgeBase;
}
export function extractContainerData(source: string): { data?: ContainerData; reason?: string };
export function parseGtmContainer(capture: ContainerCapture, opts?: ParseContainerOptions): TagContainer;
export function parseContainers(captures: ContainerCapture[], opts?: ParseContainerOptions): TagContainer[];

// Consent report.
export type FindingKind = 'violation' | 'needs-review' | 'exposure' | 'practice';
export interface GridCell {
  status: 'tested' | 'not-tested' | 'not-applicable' | 'not-run';
  reason?: string;
  counts: Record<FindingKind, number>;
  banner?: string;
  choice?: string;
  /** Why the visitor choice this scenario depends on was not completed, in the owner's words (absent = completed or no choice). */
  choiceGap?: string;
  /** Why the visit was skipped or its choice not completed, as a code. */
  cause?: SkipCause;
  /** Visits that completed (1 = a single run; 2 = plus the throttled pass). Absent = not recorded. */
  runs?: number;
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
export interface ResearchItem {
  id: string;
  target: { kind: 'finding' | 'defect' | 'tool' | 'storage'; pointer: string; label: string };
  context?: { domain?: string; partyId?: string; storageName?: string; storageKind?: string };
  evidencePointers: string[];
  suggestedMethods: string[];
  questions: Array<{ id: string; prompt: string; guidance: string; responsibility: 'agent' | 'agent-with-human-review' | 'human'; requires: 'research' | 'site-access-or-existing-evidence' | 'human-input' }>;
}
export interface ResearchWorkflow {
  schemaVersion: 1;
  reportId: string;
  instructions: string[];
  items: ResearchItem[];
  answerSchema: Record<string, unknown>;
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
    /** Which model of rules the scan compared this location against, and the laws behind it (describeLocationRules). */
    rules: LocationRules;
  }>;
  scenarios: ScenarioId[];
  grid: Record<string, Partial<Record<ScenarioId, GridCell>>>;
  findings: ReportFinding[];
  totals: Record<FindingKind, number>;
  inventory: PartyInventoryItem[];
  notTested: NotTestedItem[];
  researchQueue: TrackingEvaluation['researchQueue'];
  researchWorkflow?: ResearchWorkflow;
  behaviorObservations?: BehaviorObservation[];
  behaviorMatrix?: BehaviorMatrix;
  evidenceIndex: Array<{ location: string; scenario: ScenarioId; har?: string; timeline?: string; screenshots: string[] }>;
  /** The site workspace applied to this run (C3). */
  siteWorkspace?: SiteWorkspaceRecord;
  /** What changed since the previous run of this site (C3). */
  since?: ConsentRunDiff;
  /** Per-tool compatibility rows, the owner's change list and the "outside your consent tool's reach" line (B2). */
  compatibility?: CompatibilityReport;
  /** complykit's own tool, when installed: deployed config vs what ran (D10). */
  consentToolProof?: ConsentToolProofReport;
  /** The guided checklist from the latest generated config (R3); absent = no config generated yet. */
  remediation?: RemediationSection;
  /** Local-copy mode (D11): present when the site was rewritten in the scanner's browser — the report leads with it. */
  localCopy?: LocalCopyRecord;
}

// --- Compatibility section and change list (B2) -------------------------------
export interface CompatibilityRow {
  partyId: string;
  label: string;
  categories: string[];
  /** Does its purpose need a consent decision? 'context' = normally not (fonts, CDN, captcha…). */
  purpose: 'consent' | 'unclassified' | 'context';
  verdict: CompatibilityVerdict;
  verdictLabel: string;
  implementation: ImplementationClass;
  implementationLabel: string;
  loader: string;
  /** From the report matrix: only-may-run = compared only where it may run anyway (never presented as verified). */
  behavior: 'mismatch' | 'no-mismatch-observed' | 'only-may-run' | 'not-established';
  behaviorNote: string;
  /** Counted in the "outside your consent tool's reach" line. */
  outsideReach: boolean;
  reachReason?: string;
  purposeScope?: 'needs-consent' | 'context' | 'not-required' | 'unclassified';
  /** A tag-manager tool whose every container tag was proven held back. */
  provenHeld: boolean;
  /** What the verdict does not cover (e.g. a platform setting does not reach server-side forwarding). */
  caveats?: string[];
  whatToChange: string;
  changes: CompatibilityChange[];
  reasons: CompatibilityReason[];
}
export interface ChangeItem {
  /** Stable id (changeId): what the change touches, never where it was seen. Workspace key `task:change:<id>`. */
  id: string;
  kind: CompatibilityChangeKind;
  /** rewrite-tag / remove-leak: the element the id was computed from (what verifyRewriteTag / verifyRemoveLeak look for). */
  signature?: ElementSignature;
  tools: string[];
  partyIds: string[];
  note: string;
  page?: string;
  line?: number;
  element?: string;
  url?: string;
  containerId?: string;
  tagId?: number;
  tagNote?: string;
  consentTypes?: string[];
  api?: string;
  platform?: string;
  manager?: string;
  host?: string;
  target?: string;
  category?: string;
  categoryNote?: string;
  before?: string;
  after?: string;
  hint?: string;
  /** Why the change is needed / what to watch for (a data: URL tag, a performance plugin's delay, a destination GTM loads from the page). */
  notes?: string[];
  /** Every tool on this item is unclassified: applies only if it tracks visitors. */
  classifyFirst?: boolean;
  guide?: { label: string; href: string };
}
export interface ChangeGroup {
  id: 'mismatch' | 'rewrite' | 'gtm' | 'consent-default' | 'tag-manager' | 'platform' | 'consent-api' | 'leaks' | 'dns' | 'exposures' | 'needs-a-look';
  title: string;
  intro: string;
  items: ChangeItem[];
  guide?: { label: string; href: string };
}
export interface CompatibilityReport {
  scope: string;
  reach: { count: number; line: string; tools: Array<{ partyId: string; label: string; verdict: CompatibilityVerdict; reason: string }>; definition: string };
  consentTool: ConsentToolDefaultFinding & { headline: string; tone: 'red' | 'amber' | 'grey' };
  rows: CompatibilityRow[];
  groups: ChangeGroup[];
  otherChanges: ChangeItem[];
  notRequired: Array<{ partyId: string; label: string; categories: string[]; verdict: CompatibilityVerdict }>;
  inputs: CompatibilitySection['inputs'];
  missingInputs: string[];
}
/** The file the CLI writes beside the consent HTML report. */
export const CHANGE_LIST_FILE: string;
export function buildCompatibilityReport(
  section: CompatibilitySection,
  ctx: { inventory: PartyInventoryItem[]; markup?: MarkupSection; locations: Array<{ id: string; label: string; verdict: string }>; runs?: number; matrix?: BehaviorMatrix },
): CompatibilityReport;
/** The standalone change-list.md. */
export function renderChangeListMarkdown(m: { site: { host: string; url: string }; runId: string; startedAt: string; compatibility?: CompatibilityReport }): string;
/** Re-decide compatibility against the report's behavior matrix (after the site workspace is applied). `extraBehavior`: cells from another expected side (the deployed complykit config's, D10). */
export function reconcileCompatibility(evaluation: TrackingEvaluation, opts?: { kb?: KnowledgeBase; extraBehavior?: BehaviorCell[] }): CompatibilitySection;

// --- multi-region scans: collect on workers, merge on the primary -----------
export const COLLECTION_FILE: 'collection.json';
export const COLLECTION_KIND: 'complykit-consent-collection';
export const COLLECTION_SCHEMA_VERSION: 1;
/** Structurally the collect-browser `ConsentEvaluationCollection` (declared here so the root types do not import the collector's). */
export interface MergedConsentCollection {
  artifacts: Artifact[];
  timelines: Timeline[];
  locations: Array<{ spec: LocationSpec; verification: LocationVerification; scenarios: ScenarioSummary[] }>;
  notTested: NotTestedItem[];
  site: { url: string; host: string; registrableDomain: string };
  autoconsentVersion?: string;
  containers: ContainerCapture[];
  startedAt: string;
  finishedAt: string;
}
/** What a collect-only run leaves in its run dir. Contains RAW timelines: transient, never copied into a merged run. */
export interface ConsentCollectionHandoff {
  kind: typeof COLLECTION_KIND;
  schemaVersion: typeof COLLECTION_SCHEMA_VERSION;
  packageVersion: string;
  property: string;
  targetUrl: string;
  runId: string;
  collection: Omit<MergedConsentCollection, 'artifacts'>;
}
/** Writes <runDir>/collection.json; returns its path. */
export function writeCollectionHandoff(runDir: string, handoff: ConsentCollectionHandoff): string;
/** Throws on a missing file, a foreign file, or another schema version. */
export function readCollectionHandoff(runDir: string): ConsentCollectionHandoff;
/** Pure. Throws on version skew, different sites or properties, a location collected twice, or nothing to merge. */
export function mergeCollections(handoffs: readonly ConsentCollectionHandoff[]): MergedConsentCollection;
/** Copies each source's evidence/ into the destination (first source wins). Sources are untouched. */
export function mergeEvidence(sourceRunDirs: readonly string[], destRunDir: string): { copied: number; skipped: number };

// --- The proof step (D10): complykit's own tool, deployed config vs reality ---------
/** Pure, over the evaluation record. See ConsentToolProof for the decision rules. */
export function evaluateConsentToolProof(ev: TrackingEvaluation, input?: { workspaceConfig?: { value: unknown; at?: string; runId?: string } }): ConsentToolProof;
/** Behavior-mismatch cells for the compatibility verdict: vendors that fired where the deployed config denies them. */
export function configBehaviorCells(proof: ConsentToolProof | undefined): BehaviorCell[];
export interface ProofVendorRow {
  id: string;
  label: string;
  category: string;
  control: string;
  controlLabel: string;
  result: VendorControlResult;
  resultLabel: string;
  reason: string;
  seen: boolean;
  observations: Array<{ where: string; regime: string; expected: string; observed: string; note: string }>;
}
export interface ConsentToolProofReport {
  detected: boolean;
  /** "complykit consent tool detected — version …, config generated …: N vendors controlled, M not (…), K not observed." */
  headline: string;
  tone: 'red' | 'amber' | 'grey';
  version?: string;
  configLine: string;
  configStatus: ConsentToolProofConfigStatus;
  totals: { controlled: number; notControlled: number; notObserved: number };
  notControlled: string[];
  vendors: ProofVendorRow[];
  findings: Array<{ code: ConsentToolProofFindingCode; title: string; message: string; tone: 'red' | 'amber' }>;
  driven: string[];
  notTested: string[];
  seenIn: string[];
  section: ConsentToolProof;
}
export function buildConsentToolProofReport(p: ConsentToolProof | undefined): ConsentToolProofReport | undefined;
export function renderConsentToolProofHtml(r: ConsentToolProofReport | undefined): string;
export function renderConsentToolProofMarkdown(r: ConsentToolProofReport | undefined): string[];

/** Consent tool config generator (D8): one consent run (+ the site workspace) → config, snippet, change list. */
export interface GenerateConsentConfigOptions {
  kb?: KnowledgeBase;
  workspace?: { domain?: string; entries: Record<string, { value: unknown; at?: string; by?: string }>; runs?: Array<{ id: string; at: string; jobId?: string; url?: string; meta?: Record<string, unknown> }> };
  findings?: Finding[];
  complykitVersion: string;
  now?: string;
  scriptSrc?: string;
  recordEndpoint?: string;
  privacyPolicyUrl?: string;
  regimeSource?: RegimeSource;
  layout?: ConsentLayout;
  theme?: ConsentTheme;
  lifetimeDays?: number;
}
export interface GeneratorNote {
  code: string;
  level: 'refused' | 'flag' | 'info';
  message: string;
  partyIds?: string[];
}
export interface SnippetRewrite {
  /** The change-list item's stable id. */
  id: string;
  tools: string[];
  partyIds: string[];
  category: string;
  page?: string;
  line?: number;
  before?: string;
  after?: string;
  inline: boolean;
  optional: boolean;
  flags: string[];
}
export interface GeneratedConsentConfig {
  config: ConsentToolConfig;
  json: string;
  snippet: string;
  changeList: string;
  rewrites: SnippetRewrite[];
  notes: GeneratorNote[];
  notesMarkdown: string;
  /** Where the snippet loads the tool from. */
  scriptSrc: string;
  /** The compatibility section the config was built from (its change items carry stable ids). */
  compatibility: CompatibilityReport;
  /** The guided remediation checklist: install first, then one task per change item. */
  tasks: RemediationTask[];
}
/** The snippet's default script path — a self-hosted placeholder the owner adjusts. */
export const DEFAULT_SCRIPT_SRC: string;
export function generateConsentConfig(evaluation: TrackingEvaluation, opts: GenerateConsentConfigOptions): GeneratedConsentConfig;

// --- Guided remediation flow (plans/remediation-flow.md) -------------------------------
/** `<kind>:<12 hex>` over a canonical signature of WHAT the change touches (element, container tag, api, platform, party); 'install' for the install task. */
export function changeId(c: ChangeIdInput): string;
/** The canonical object changeId hashes (exported for tests). */
export function changeSignature(c: ChangeIdInput): Record<string, unknown>;
export interface ChangeIdInput {
  kind: RemediationTaskKind;
  partyId?: string;
  signature?: ElementSignature;
  url?: string;
  containerId?: string;
  tagId?: number;
  api?: string;
  platform?: string;
  manager?: string;
  host?: string;
}
/** What identifies one element in served HTML, independent of its line. */
export interface ElementSignature {
  kind: 'script' | 'img' | 'iframe' | 'link';
  context: 'document' | 'noscript';
  host?: string;
  path?: string;
  /** Tag / container ids in the URL or the inline body. */
  ids: string[];
  /** Inline (or data: URL) script: the vendor-signature text the knowledge base matched. */
  inline?: { match: string };
  dataUrl?: boolean;
}
export function elementSignatureOf(f: Pick<MarkupFinding, 'kind' | 'context' | 'url' | 'inline' | 'match' | 'ids' | 'dataUrl' | 'matchedBy'>): ElementSignature;
/** 'classify': a decision (what an unrecognized tool is for), done when the workspace holds its classification. */
export type RemediationTaskKind = 'classify' | 'install' | 'remove-existing-tool' | CompatibilityChangeKind | 'confirm-in-browser';
export type RemediationVerifyMethod = 'static' | 'browser' | 'manual';
export type RemediationVerifySpec =
  | { check: 'install'; method: 'static'; page: string; configHash: string; scriptSrc: string; elementId: string }
  | { check: 'rewrite-tag'; method: 'static'; page: string; element: ElementSignature; category: string }
  | { check: 'remove-leak'; method: 'static'; page: string; element: ElementSignature }
  | { check: 'gtm-tag-consent'; method: 'static'; containerId: string; containerUrl?: string; tagId: number; consentTypes: string[] }
  | { check: 'consent-default'; method: 'static'; page: string; consentTypes: string[] }
  | { check: 'remove-existing-tool'; method: 'static'; page: string; partyId?: string; hosts: string[]; pathPattern?: string; label: string }
  | { check: 'spot-check'; method: 'browser'; page: string; partyId: string; hosts: string[]; scenario: 'reject-then-accept' }
  | { check: 'manual'; method: 'manual'; reason: string };
export type VerifyResult = 'pass' | 'fail' | 'cannot-verify';
/** What a checker returns. cannot-verify is never folded into pass. */
export interface VerifyOutcome {
  result: VerifyResult;
  message: string;
  evidence: string[];
}
export type RemediationStatus = 'todo' | 'done-unverified' | 'verified' | 'failed' | 'cannot-verify';
export interface RemediationLastVerify extends VerifyOutcome {
  at: string;
}
/** The workspace entry value under `task:change:<id>`. */
export interface RemediationTaskValue {
  status: RemediationStatus;
  note?: string;
  lastVerify?: RemediationLastVerify;
}
export interface RemediationTask {
  id: string;
  kind: RemediationTaskKind;
  /** The change-list group it came from ('install' for the install and remove-existing-tool tasks; 'other' for optional items). */
  group: string;
  title: string;
  summary: string;
  party?: string;
  tools: string[];
  partyIds: string[];
  /** Plain-language steps, in order. */
  steps: string[];
  snippet?: { before?: string; after?: string };
  pages: string[];
  verify: RemediationVerifySpec;
  status: RemediationStatus;
  lastVerify?: RemediationLastVerify;
  /** A context-purpose tool: applies only where it is not strictly needed. */
  optional: boolean;
  classifyFirst?: boolean;
  /** A 'classify' task: the workspace key (class:<id>) whose classification decides it ('verified' = decided). */
  classKey?: string;
  /** The 'classify' tasks this change waits on. */
  waitingOn?: string[];
  notes: string[];
  guide?: { label: string; href: string };
  /** Ids of change-list items folded into this task (their stored status is still found: resolveRemediationTaskValue). */
  aliases?: string[];
  /** "This also fixes: …" — one plain line per folded item. */
  alsoFixes?: string[];
  /** Steps whose wording depends on the surface: each replaces steps[step] on the service (`service`) or in a report file / the CLI (`offline`). */
  stepVariants?: Array<{ step: number; service: string; offline: string }>;
  order: number;
}
/** What a browser spot check observed on one page: reject phase, then accept phase. */
export interface SpotCheckObservation {
  page: string;
  toolPresent?: boolean;
  phases: Array<{ scenario: 'reject' | 'accept'; choiceMade: boolean; requests: Array<{ url: string }>; stores: Array<{ kind: string; name: string; host?: string }> }>;
}
export const REMEDIATION_TASK_KEY_PREFIX: string;
export const INSTALL_TASK_ID: string;
export function remediationTaskKey(id: string): string;
/** Reads the remediation value, and the report workbench's open / in-progress / done (done → done-unverified). */
export function readRemediationTaskValue(value: unknown): RemediationTaskValue | undefined;
export function isRemediationDone(status: RemediationStatus): boolean;
/** The task's own task:change:<id> value, else the first stored under one of its aliases (a carried `verified` reads as done-unverified unless the task's own check is a spot check). */
export function resolveRemediationTaskValue(task: { id: string; aliases?: string[]; verify: { check: string }; classKey?: string }, entries: Record<string, { value: unknown } | undefined>): RemediationTaskValue | undefined;
/** A classification value that decides a 'classify' task: a chosen purpose other than "Other". */
export function classificationDecided(value: unknown): boolean;
export interface RemediationSourceNote {
  code: string;
  message: string;
  partyIds?: string[];
}
/** What buildRemediationTasks reads: GeneratedConsentConfig qualifies, and so does a stored workspace config.value. */
export interface RemediationSource {
  config: ConsentToolConfig;
  notes?: RemediationSourceNote[];
  compatibility?: CompatibilityReport;
  scriptSrc?: string;
  snippet?: string;
}
export interface BuildRemediationTasksOptions {
  workspace?: GenerateConsentConfigOptions['workspace'];
  kb?: KnowledgeBase;
}
/** Pure: install, remove-existing-tool, then one task per change-list item, with status from the workspace. */
export function buildRemediationTasks(generated: RemediationSource, evaluation: TrackingEvaluation, opts?: BuildRemediationTasksOptions): RemediationTask[];
export function installTask(config: ConsentToolConfig, scriptSrc: string, page: string): Omit<RemediationTask, 'status' | 'lastVerify'>;
export function removeExistingToolTasks(ev: TrackingEvaluation, notes: RemediationSourceNote[], page: string): Array<Omit<RemediationTask, 'status' | 'lastVerify' | 'order'>>;
/** The checklist a consent report renders (#remediation, R3). */
export interface RemediationSection {
  tasks: RemediationTask[];
  source: 'workspace' | 'run';
  configAt?: string;
  runId?: string;
}
export interface RemediationWorkspaceLike {
  entries: Record<string, { value: unknown } | undefined>;
  config?: { value: unknown; at?: string; runId?: string };
}
/** The "Make these changes" section: the checklist, or the prompt to generate the config. */
export function renderRemediationHtml(section: RemediationSection | undefined, m?: Pick<ConsentReportModel, 'behaviorMatrix'>): string;
/** The checklist from a site workspace's latest generated config (config.value.tasks), status from its task:change:<id> entries. */
export function remediationFromWorkspace(ws: RemediationWorkspaceLike | undefined): RemediationSection | undefined;
/** Validate tasks read from JSON; invalid ones are dropped. */
export function parseRemediationTasks(raw: unknown): RemediationTask[];
export function remediationTotals(tasks: RemediationTask[]): { total: number; verified: number; doneUnverified: number; failed: number; cannotVerify: number; todo: number; required: number };
/** Part 1 of the snippet: the config element and the core script tag. */
export function renderHeadSnippet(config: ConsentToolConfig, scriptSrc: string): string;
/** JSON safe inside <script>: no "<" survives. */
export function scriptJson(value: unknown): string;
// Pure verify checkers: one fetched page / container / observation in, a fail-closed outcome out.
export interface VerifyOptions {
  kb?: KnowledgeBase;
  site?: string;
}
export interface InstallExpectation {
  page: string;
  configHash: string;
  scriptSrc: string;
  elementId?: string;
}
export interface RemoveExistingToolExpectation {
  page: string;
  partyId?: string;
  hosts?: string[];
  pathPattern?: string;
  label: string;
}
export interface SpotCheckSpec {
  page: string;
  partyId: string;
  hosts: string[];
}
export interface StaticVerifyInput {
  html?: string;
  containerJs?: string;
  observation?: SpotCheckObservation;
}
export function verifyInstall(html: string, expected: InstallExpectation, opts?: VerifyOptions): VerifyOutcome;
export function verifyRewriteTag(html: string, spec: { page: string; element: ElementSignature; category: string }): VerifyOutcome;
export function verifyRemoveLeak(html: string, spec: { page: string; element: ElementSignature }): VerifyOutcome;
export function verifyGtmTagConsent(containerJs: string, spec: { containerId: string; tagId: number; consentTypes: string[] }): VerifyOutcome;
export function verifyConsentDefault(html: string, spec: { page: string; consentTypes: string[] }): VerifyOutcome;
export function verifyRemoveExistingTool(html: string, spec: RemoveExistingToolExpectation, opts?: VerifyOptions): VerifyOutcome;
/** Pass only when nothing reached the vendor after the reject AND something did after the accept. */
export function judgeSpotCheck(spec: SpotCheckSpec, obs: SpotCheckObservation): VerifyOutcome;
export function runVerify(spec: RemediationVerifySpec, input: StaticVerifyInput, opts?: VerifyOptions): VerifyOutcome;
/** Does a parsed element carry the signature (line-independent)? */
export function elementMatches(el: MarkupElement, sig: ElementSignature): boolean;

/** The site workspace applied to a consent run: classifications that matched something observed, tasks marked done. */
export interface SiteWorkspaceRecord {
  domain?: string;
  appliedAt: string;
  classifications: Array<{ key: string; kind: 'tool' | 'storage'; partyId: string; domain: string; storageKind?: string; name?: string; categories: string[]; at?: string; by?: string }>;
  doneTasks: Array<{ key: string; at?: string; by?: string }>;
}

/** Run-to-run diff of two consent evaluations of one site (C3). */
export interface ConsentRunDiff {
  base: { runId: string; startedAt: string };
  head: { runId: string; startedAt: string };
  parties: {
    added: Array<{ partyId: string; label: string; domain: string; categories: string[] }>;
    removed: Array<{ partyId: string; label: string; domain: string; categories: string[] }>;
    recategorized: Array<{ partyId: string; label: string; domain: string; categories: string[]; from: string[] }>;
  };
  verdicts: Array<{ location: string; label: string; scenario?: string; from: string; to: string }>;
  cells: Array<{ rowId: string; row: string; kind: 'tool' | 'storage'; columnId: string; column: string; location: string; from: string; to: string }>;
  classified: Array<{ rowId: string; row: string; kind: 'tool' | 'storage'; from: string[]; to: string[]; source: string }>;
  findings: { added: number; resolved: number; persisting: number };
}
export interface ConsentHtmlOptions {
  runDir?: string;
  /** Link to the change list, relative to the report (default change-list.md); false = no link. */
  changeList?: string | false;
  /** Which classifications this rendering applied (R2, `<script id="ck-render">`): the page offers an update when the workspace's differ. */
  render?: { version: 1; at: string; runId: string; workspace: boolean; classifications: Record<string, string> };
}
export function findingKind(f: Finding): FindingKind;
export function citationLabel(req: Requirement): string;
export function buildConsentReportModel(evaluation: TrackingEvaluation, findings: Finding[]): ConsentReportModel;
/** What changed between two consent runs of one site: parties, verdicts, behavior-matrix cells, findings (C3). */
export function diffConsentModels(base: ConsentReportModel, head: ConsentReportModel): ConsentRunDiff;
export function renderConsentHtml(m: ConsentReportModel, opts?: ConsentHtmlOptions): string;
export function renderConsentMarkdown(m: ConsentReportModel, opts?: { maxFindings?: number }): string;

// --- consent tool config (client-consent epic, D2) ---------------------------
// Shared by the scanner, the generator and the client. The client bundles
// src/record/consent-config-guard.ts (zero deps); the zod schema stays here.
export const CONSENT_CONFIG_MAJOR: number;
export const CONSENT_CONFIG_VERSION: string;
export const NECESSARY_CATEGORY: string;
export const CONSENT_CONFIG_ELEMENT_ID: string;
export type Regime = 'opt-in' | 'opt-out-signal' | 'opt-out';
export const REGIMES: readonly Regime[];
export const FALLBACK_REGIME: Regime;
export type RegimeSource =
  | { kind: 'header'; header: string; endpoint: string }
  | { kind: 'meta'; name: string }
  | { kind: 'platform' }
  | { kind: 'fixed'; regime: Regime };
export interface ConsentCategory {
  id: string;
  label: string;
  description: string;
  defaultByRegime: Record<Regime, boolean>;
}
export type VendorControl = 'gate' | 'api' | 'platform' | 'none';
export interface ConsentVendor {
  id: string;
  label: string;
  category: string;
  control: VendorControl;
  adapter?: string;
  stores: Array<{ name: string; kind: 'cookie' | 'local' | 'session' }>;
  note?: string;
}
export interface GateRule {
  category: string;
  src?: string;
  selector?: string;
  vendor?: string;
}
export type ConsentModeSignal =
  | 'ad_storage'
  | 'ad_user_data'
  | 'ad_personalization'
  | 'analytics_storage'
  | 'functionality_storage'
  | 'personalization_storage'
  | 'security_storage';
export const CONSENT_MODE_SIGNALS: readonly ConsentModeSignal[];
export interface GtmConfig {
  containers: string[];
  dataLayer: string;
  consentMode: Partial<Record<ConsentModeSignal, string>>;
  tags: Array<{ name: string; category: string; vendor?: string }>;
}
export type ConsentPlatform = 'none' | 'shopify' | 'wix' | 'squarespace' | 'wordpress';
export interface ConsentTheme {
  bg?: string;
  fg?: string;
  accent?: string;
  border?: string;
  radius?: string;
}
export type ConsentLayout = 'bar' | 'box' | 'modal';
export const CONSENT_STRING_KEYS: readonly string[];
export type ConsentStringKey =
  | 'banner.title'
  | 'banner.body'
  | 'banner.accept'
  | 'banner.reject'
  | 'banner.manage'
  | 'settings.title'
  | 'settings.body'
  | 'settings.acceptAll'
  | 'settings.rejectAll'
  | 'settings.save'
  | 'settings.close'
  | 'withdraw.link'
  | 'withdraw.confirm'
  | 'withdraw.note'
  | 'withdraw.recall'
  | 'privacyChoices.link'
  | 'optOut.link'
  | 'optOut.confirmed'
  | 'optOut.iconAlt'
  | 'gpc.honored'
  | 'privacyPolicy.link';
export type ConsentStringTable = Partial<Record<ConsentStringKey, string>> & {
  byRegime?: Partial<Record<Regime, Partial<Record<ConsentStringKey, string>>>>;
};
export interface ConsentStateConfig {
  lifetimeDays: number;
  cookieDomain?: string;
}
export interface ConsentRecordEndpoint {
  endpoint: string;
}
export interface ConsentToolConfig {
  version: string;
  generatedFrom: { runId: string; at: string; site: string; complykit: string; kb?: string };
  hash: string;
  regimeSource: RegimeSource;
  categories: ConsentCategory[];
  vendors: ConsentVendor[];
  gate: GateRule[];
  gtm?: GtmConfig;
  platform: ConsentPlatform;
  theme: ConsentTheme;
  strings: Record<string, ConsentStringTable>;
  consent: ConsentStateConfig;
  privacyPolicyUrl?: string;
  record?: ConsentRecordEndpoint;
  layout: ConsentLayout;
}
/** The hand-written shape: defaults optional. */
export type ConsentToolConfigInput = Omit<ConsentToolConfig, 'vendors' | 'gate' | 'gtm' | 'platform' | 'theme' | 'strings' | 'consent' | 'layout' | 'regimeSource'> & {
  regimeSource:
    | { kind: 'header'; header: string; endpoint: string }
    | { kind: 'meta'; name?: string }
    | { kind: 'platform' }
    | { kind: 'fixed'; regime: Regime };
  vendors?: Array<Omit<ConsentVendor, 'stores'> & { stores?: Array<{ name: string; kind?: 'cookie' | 'local' | 'session' }> }>;
  gate?: GateRule[];
  gtm?: Omit<GtmConfig, 'dataLayer' | 'consentMode' | 'tags'> & Partial<Pick<GtmConfig, 'dataLayer' | 'consentMode' | 'tags'>>;
  platform?: ConsentPlatform;
  theme?: ConsentTheme;
  strings?: Record<string, ConsentStringTable>;
  consent?: Partial<ConsentStateConfig>;
  layout?: ConsentLayout;
};
export interface ConsentConfigHeader {
  version?: string;
  hash?: string;
  generatedFrom?: { runId?: string; at?: string; site?: string; complykit?: string; kb?: string };
}
export function readConsentConfigHeader(raw: unknown): ConsentConfigHeader;
export type ConsentConfigVersionStatus = 'current' | 'older-minor' | 'newer-minor' | 'older-major' | 'newer-major' | 'invalid';
export function parseConsentConfigVersion(v: unknown): { major: number; minor: number } | undefined;
export function consentConfigVersionStatus(v: unknown): ConsentConfigVersionStatus;
export type ConsentConfigGuardResult =
  | { ok: true; config: ConsentToolConfig; version: 'current' | 'older-minor' | 'newer-minor' }
  | { ok: false; reason: 'not-an-object' | 'invalid-version' | 'newer-major' | 'older-major' | 'missing-field'; detail: string };
export function guardConsentToolConfig(raw: unknown): ConsentConfigGuardResult;
export function isNecessaryCategory(id: string): boolean;
export function consentCategoryDefault(config: ConsentToolConfig, categoryId: string, regime: Regime): boolean;
export function canonicalJson(value: unknown): string;
export function hashConsentToolConfig(config: Omit<ConsentToolConfig, 'hash'> & { hash?: string }): string;
export function withConsentConfigHash(input: Omit<ConsentToolConfigInput, 'hash'> & { hash?: string }): ConsentToolConfig;
export interface ConsentConfigIssue {
  path: string;
  message: string;
}
export type ParseConsentToolConfigResult =
  | { ok: true; config: ConsentToolConfig; version: 'current' | 'older-minor' | 'newer-minor'; hashMatches: boolean }
  | { ok: false; reason: 'newer-major' | 'older-major' | 'invalid'; version: ConsentConfigVersionStatus; issues: ConsentConfigIssue[] };
export function parseConsentToolConfig(raw: unknown): ParseConsentToolConfigResult;
export const CONSENT_CONFIG_JSON_SCHEMA_ID: string;
export function consentToolConfigJsonSchema(): Record<string, unknown>;
/** The statutory opt-out label, "Do Not Sell or Share My Personal Information". */
export const DO_NOT_SELL_OR_SHARE: string;
export type ConsentStringIssueSeverity = 'error' | 'warning';
export type ConsentStringRule =
  | 'blank'
  | 'opt-in-reject'
  | 'reject-as-settings'
  | 'opt-out-signal-wording'
  | 'privacy-choices-wording'
  | 'ambiguous-accept'
  | 'implied-consent'
  | 'pre-ticked'
  | 'legitimate-interest'
  | 'false-urgency'
  | 'confirmshaming'
  | 'cookie-wall'
  | 'no-sale-claim'
  | 'filler'
  | 'unverified-language';
export interface ConsentStringIssue {
  severity: ConsentStringIssueSeverity;
  rule: ConsentStringRule;
  path: (string | number)[];
  lang: string;
  key: ConsentStringKey;
  regimes: Regime[];
  message: string;
}
/** Required-string and misleading-copy checks over `config.strings` (errors also refuse the config in the schema). */
export function validateConsentStrings(strings: unknown): ConsentStringIssue[];
