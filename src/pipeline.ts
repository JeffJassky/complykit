import {
  resolveFinding,
  type Finding,
  type RunId,
  type Artifact,
  type CoverageGap,
  type MatrixCell,
  type AccessLevel,
  type LocationSpec,
  type ScenarioId,
  type TrackingEvaluation,
} from './record/index.js';
import {
  AXE_VERSION,
  REGISTRY_VERSION,
  DEFAULT_KB,
  getRequirement,
  requirementApplies,
  registrableDomain,
  type KnowledgeBase,
  type RuleId,
} from './registry/index.js';
import { ALL_RULES, evaluate, resolveCapsFor, isLlmRule, tracking } from './rules/index.js';
import { normalizeEngineArtifacts } from './engines.js';
import { collectStatic } from './collect/static/index.js';
import { buildVueScopeMap, enrichFindingsWithVueSource } from './enrich/vue-scope.js';
import { supersedeByMeasurement } from './enrich/supersede.js';
import { applyWorkspace, type WorkspaceSnapshot } from './site-workspace.js';
import { reconcileCompatibility } from './consent-compatibility.js';
import type { RouteDiscoveryOptions } from './collect/browser/routes.js';
import { localCopyRecord, type LocalCopy } from './collect/browser/evaluation/local-copy.js';

// The scan pipeline: collect artifacts, normalize engine output, evaluate our
// pure rules, and resolve everything into stored Findings. Kept OUT of the root
// export (it pulls collector deps) and out of cli/ (which is wiring only). The
// browser layer is loaded via dynamic import so a static-only run never requires
// the optional `playwright` peer.

/**
 * Drop findings whose cited requirement does not apply to this property's
 * (hand-set) tags. WCAG has no appliesIf so it always survives; GDPR / AI Act
 * findings survive only when the property declares the matching tags.
 */
function gateByTags(findings: Finding[], tags: readonly string[]): Finding[] {
  return findings.filter((f) => {
    const req = getRequirement(String(f.requirementId));
    return req ? requirementApplies(req, tags) : true;
  });
}

/** Tally the glyph-mask walk's own results (style-probe/contrast artifacts),
 *  independent of what the rules/engines pass did with them — the trace line
 *  should say what was MEASURED even if every measured fail also produced a
 *  finding, and even if a run has zero contrast findings at all. */
function contrastCounts(artifacts: Artifact[]): { measured: number; pass: number; fail: number; unmeasured: number } {
  let measured = 0;
  let pass = 0;
  let fail = 0;
  let unmeasured = 0;
  for (const a of artifacts) {
    if (a.kind !== 'style-probe' || a.check !== 'contrast') continue;
    for (const raw of a.results as Array<Record<string, unknown>>) {
      if (raw.status === 'measured') {
        measured++;
        if (raw.verdict === 'pass') pass++;
        else if (raw.verdict === 'fail') fail++;
      } else if (raw.status === 'unmeasured') {
        unmeasured++;
      }
    }
  }
  return { measured, pass, fail, unmeasured };
}

/** Resolve a rule's RawFindings into stored Findings (producer: rule). */
function resolveRuleFindings(
  raws: ReturnType<typeof evaluate>,
  runId: RunId,
  packageVersion: string,
): Finding[] {
  return raws.map((raw) =>
    resolveFinding(raw, {
      caps: resolveCapsFor(raw.ruleId, raw.requirementId),
      runId,
      producer: { type: 'rule', packageVersion },
    }),
  );
}

// --- static layer -----------------------------------------------------------

export interface StaticScanOptions {
  runId: RunId;
  property: string;
  repoDir: string;
  tags?: string[];
  packageVersion: string;
}

export interface StaticScanResult {
  findings: Finding[];
  engineVersions: Record<string, string>;
  hasAiFeatures: boolean;
  fileCount: number;
  unmapped: Array<{ engine: string; engineRule: string; count: number }>;
  accessLevels: AccessLevel[];
}

export async function runStaticScan(opts: StaticScanOptions): Promise<StaticScanResult> {
  const collection = await collectStatic({ cwd: opts.repoDir, property: opts.property });
  const artifacts: Artifact[] = collection.artifacts;
  // Tags are hand-set in the config; nothing is auto-derived. hasAiFeatures is
  // reported so the CLI can NUDGE the user to set the tag, not to set it for them.
  const tags = opts.tags ?? [];

  const engine = normalizeEngineArtifacts(artifacts, { runId: opts.runId, engineVersions: collection.engineVersions });
  const raws = evaluate(artifacts, ALL_RULES, { property: opts.property, tags });
  const ruleFindings = resolveRuleFindings(raws, opts.runId, opts.packageVersion);

  return {
    findings: gateByTags([...engine.findings, ...ruleFindings], tags),
    engineVersions: collection.engineVersions,
    hasAiFeatures: collection.hasAiFeatures,
    fileCount: collection.fileCount,
    unmapped: engine.unmapped,
    accessLevels: ['repo'],
  };
}

// --- browser layer (M2 passive) --------------------------------------------

export interface BrowserScanOptions {
  runId: RunId;
  property: string;
  targetUrl: string;
  cwd?: string;
  tags?: string[];
  packageVersion: string;
  repoDir?: string; // when set, browser findings are mapped back to source files (Vue scope ids)
  viewports?: string[];
  schemes?: Array<'light' | 'dark'>;
  routes?: RouteDiscoveryOptions;
  storageStatePath?: string;
  trace?: (line: string) => void;
}

export interface BrowserScanResult {
  findings: Finding[];
  gaps: CoverageGap[];
  matrix: MatrixCell[];
  accessLevels: AccessLevel[];
  engineVersions: Record<string, string>;
  unmapped: Array<{ engine: string; engineRule: string; count: number }>;
  spike: { closedShadowHosts: number; piercedClosedShadow: boolean };
  scanned: string[];
}

/**
 * The browser passive pass. Dynamic-imports collect/browser so the `playwright`
 * peer is only required when a browser scan actually runs. A missing peer
 * surfaces as a clear install message, not a module-resolution crash.
 */
export async function runBrowserScan(opts: BrowserScanOptions): Promise<BrowserScanResult> {
  let collectBrowser: typeof import('./collect/browser/index.js').collectBrowser;
  try {
    ({ collectBrowser } = await import('./collect/browser/index.js'));
  } catch {
    throw new Error(
      "the browser layer needs the 'playwright' peer. Install it with `npm i -D playwright` " +
        'and `npx playwright install chromium`, or run `complykit static` for the repo-only pass.',
    );
  }

  const collection = await collectBrowser({
    property: opts.property,
    targetUrl: opts.targetUrl,
    runId: opts.runId,
    cwd: opts.cwd,
    viewports: opts.viewports,
    schemes: opts.schemes,
    routes: opts.routes,
    storageStatePath: opts.storageStatePath,
    trace: opts.trace,
  });

  const tags = opts.tags ?? [];
  const engineVersions = { 'axe-core': AXE_VERSION };
  const engine = normalizeEngineArtifacts(collection.artifacts, { runId: opts.runId, engineVersions });
  const sup = engine.superseded;
  const cc = contrastCounts(collection.artifacts);
  if (cc.measured || cc.unmeasured || sup.settled || sup.unmatched) {
    opts.trace?.(
      `contrast: measured ${cc.measured} text element(s) (${cc.pass} pass, ${cc.fail} fail), ${cc.unmeasured} unmeasured; ` +
        `axe: ${sup.settled} node(s) settled by measurement, ${sup.unmatched} unmatched, ${sup.disagreements} disagreement(s)`,
    );
    for (const ex of sup.examples) {
      opts.trace?.(`  disagreement: ${ex.selector} — axe ${ex.axe}:1, measured ${ex.measured}:1`);
    }
  }
  const raws = evaluate(collection.artifacts, ALL_RULES, { property: opts.property, tags });
  const ruleFindings = resolveRuleFindings(raws, opts.runId, opts.packageVersion);

  let findings = gateByTags([...engine.findings, ...ruleFindings], tags);
  // Signal fusion: a physical measurement of an element supersedes another
  // producer's needs-review shrug about the same element (see enrich/supersede.ts).
  const fusion = supersedeByMeasurement(findings, collection.artifacts);
  findings = fusion.findings;
  if (fusion.superseded) {
    const per = Object.entries(fusion.byProvider).map(([k, v]) => `${k}: ${v}`).join(', ');
    opts.trace?.(`fusion: ${fusion.superseded} needs-review finding(s) superseded by measurement (${per})`);
  }
  // Source mapping: resolve data-v-<hash> scope ids in the findings' evidence
  // back to .vue files, so browser findings carry a file locus too.
  if (opts.repoDir) {
    const res = enrichFindingsWithVueSource(findings, buildVueScopeMap(opts.repoDir), opts.repoDir);
    opts.trace?.(
      `vue source map: ${res.components} component(s), ${res.relativized} runtime path(s) relativized, ${res.enriched} finding(s) mapped via scope id`,
    );
  }

  return {
    findings,
    gaps: collection.gaps,
    matrix: collection.matrix,
    accessLevels: collection.accessLevels,
    engineVersions,
    unmapped: engine.unmapped,
    spike: collection.spike,
    scanned: collection.scanned,
  };
}

// --- consent evaluation (plans/consent-design.md §2–3) ----------------------

export interface ConsentScanOptions {
  runId: RunId;
  property: string;
  targetUrl: string;
  cwd?: string;
  tags?: string[];
  packageVersion: string;
  locations?: LocationSpec[];
  scenarios?: ScenarioId[];
  /** Quick first look: shorter dwell, one extra page, the reduced scenario set. */
  quick?: boolean;
  journey?: import('./collect/browser/evaluation/journey.js').JourneyOptions;
  knowledgeBase?: KnowledgeBase;
  /** The site's workspace (C3): its classifications apply to this run as KB overrides; done tasks are recorded on the evaluation. */
  workspace?: WorkspaceSnapshot;
  rawEvidence?: boolean;
  har?: boolean;
  concurrency?: number;
  /** Visits per scenario (default 1). Runs after the first repeat the scenario under network + CPU throttling. */
  runs?: number;
  /** Per-scenario hard budget, ms (default 300000). */
  scenarioTimeoutMs?: number;
  /** Throttled repeat runs get scenarioTimeoutMs times this (default 3). */
  throttledBudgetFactor?: number;
  /**
   * Local-copy mode (D11): apply an owner's change set to the site inside the
   * scanner's own browser (src/local-copy.ts). The run is then evidence about
   * the rewritten copy, not the live site, and the record says so.
   */
  localCopy?: LocalCopy;
  /** Tests only: stub geolocation + map fake hosts. */
  geoSources?: import('./collect/browser/evaluation/location.js').GeoSource[];
  launchArgs?: string[];
  bannerWaitMs?: number;
  trace?: (line: string) => void;
  onEvent?: (e: import('./collect/browser/evaluation/index.js').EvaluationEvent) => void;
  /**
   * After every finished visit: the same analysis as the final result, over the
   * visits finished so far (no DNS records, no containers yet). For live views —
   * the CLI writes the owner report from it. A throw here never stops the scan.
   */
  onPartial?: (partial: ConsentScanPartial) => void;
}

/** The analysis of the visits finished so far (onPartial). */
export interface ConsentScanPartial {
  findings: Finding[];
  evaluation: TrackingEvaluation;
  /** The timelines it was built from (pages visited, banner seen). */
  timelines: import('./record/index.js').Timeline[];
}

export interface ConsentScanResult {
  findings: Finding[];
  evaluation: TrackingEvaluation;
  matrix: MatrixCell[];
  rulesExecuted: RuleId[];
}

/**
 * The consent & tracking evaluation: verify each location, run its scenarios in
 * fresh profiles, analyze the timelines, and apply each verified location's
 * rules. Findings are gated by MEASURED location inside the rules — never by
 * property tags (tags only lift a US opt-out finding from needs-review to
 * violation once counsel confirms the business is covered).
 */
export async function runConsentScan(opts: ConsentScanOptions): Promise<ConsentScanResult> {
  return analyzeConsentScan(await collect(opts, true), opts);
}

/**
 * Browser half: verify locations, run scenarios, write evidence. No findings are written.
 * When `onPartial` is given the live analysis (bundled KB unless `knowledgeBase`) also runs after every visit.
 */
export function collectConsentScan(opts: ConsentScanOptions): Promise<import('./collect/browser/evaluation/index.js').ConsentEvaluationCollection> {
  return collect(opts, true);
}

/** `live`: also run the analysis after every visit for onPartial (runConsentScan; needs the KB). */
async function collect(opts: ConsentScanOptions, live: boolean): Promise<import('./collect/browser/evaluation/index.js').ConsentEvaluationCollection> {
  let mod: typeof import('./collect/browser/index.js');
  try {
    mod = await import('./collect/browser/index.js');
  } catch {
    throw new Error(
      "the consent evaluation needs the 'playwright' peer. Install it with `npm i -D playwright` and `npx playwright install chromium`.",
    );
  }
  const baseKb = opts.knowledgeBase ?? DEFAULT_KB;
  const journey = opts.quick ? { dwellMs: 4000, pageDwellMs: 2000, scrollSteps: 2, maxPages: 1, ...opts.journey } : opts.journey;
  return mod.collectConsentEvaluation({
    property: opts.property,
    targetUrl: opts.targetUrl,
    runId: opts.runId,
    cwd: opts.cwd,
    locations: opts.locations,
    scenarios: opts.scenarios,
    journey,
    rawEvidence: opts.rawEvidence,
    har: opts.har,
    concurrency: opts.concurrency,
    runs: opts.runs,
    scenarioTimeoutMs: opts.scenarioTimeoutMs,
    throttledBudgetFactor: opts.throttledBudgetFactor,
    localCopy: opts.localCopy,
    geoSources: opts.geoSources,
    launchArgs: opts.launchArgs,
    bannerWaitMs: opts.bannerWaitMs,
    trace: opts.trace,
    onEvent: opts.onEvent,
    onProgress: live && opts.onPartial
      ? (partial) => {
          try {
            const r = analyzeConsentCollection(partial, opts, baseKb);
            opts.onPartial!({ ...r, timelines: partial.timelines });
          } catch (err) {
            opts.trace?.(`live analysis skipped: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      : undefined,
    policy: {
      registrableDomain,
      verify: (spec, sources) => tracking.decideVerification(spec, sources),
      scenariosFor: (_spec, v) => (opts.quick ? tracking.quickScenarios(v.jurisdictions) : tracking.defaultScenarios(v.jurisdictions)),
    },
  });
}

/** Analysis half: rules + evaluation + matrix, from any collection (one run's, or merged). */
export function analyzeConsentScan(
  collection: import('./collect/browser/evaluation/index.js').ConsentEvaluationCollection,
  opts: ConsentScanOptions,
): ConsentScanResult {
  const baseKb = opts.knowledgeBase ?? DEFAULT_KB;
  const { findings, evaluation } = analyzeConsentCollection(collection, opts, baseKb);
  const tested = collection.locations.flatMap((l) => l.scenarios.filter((s) => s.status === 'tested'));
  const matrix: MatrixCell[] = [
    {
      family: 'evidence',
      routePatterns: 1,
      instances: collection.timelines.length,
      viewports: ['desktop'],
      schemes: ['light'],
      states: tested.length,
    },
  ];
  const rulesExecuted = ALL_RULES.filter((r) => !isLlmRule(r) && (r as { consumes?: readonly string[] }).consumes?.includes('consent-timeline')).map((r) => r.id);
  return { findings, evaluation, matrix, rulesExecuted };
}

/**
 * Collection → findings + evaluation, the same for the final result and the
 * live partials (onPartial), so a live view and the report agree.
 */
function analyzeConsentCollection(
  collection: import('./collect/browser/evaluation/index.js').PartialConsentCollection,
  opts: ConsentScanOptions,
  baseKb: KnowledgeBase,
): { findings: Finding[]; evaluation: TrackingEvaluation } {
  // The site workspace is applied after collection: its keys are computed from
  // what this run observed (src/site-workspace.ts), so the KB below is per run.
  const site = opts.workspace ? applyWorkspace(collection.timelines, baseKb, opts.workspace) : undefined;
  const kb = site?.kb ?? baseKb;
  const raws = evaluate(collection.artifacts, ALL_RULES, { property: opts.property, tags: opts.tags ?? [], knowledgeBase: kb });
  const findings = resolveRuleFindings(raws, opts.runId, opts.packageVersion);
  const evaluation = tracking.buildTrackingEvaluation({
    runId: String(opts.runId),
    property: opts.property,
    site: collection.site,
    versions: { kb: kb.version, registry: REGISTRY_VERSION, package: opts.packageVersion, autoconsent: collection.autoconsentVersion },
    startedAt: collection.startedAt,
    finishedAt: collection.finishedAt,
    locations: collection.locations,
    timelines: collection.timelines,
    notTested: collection.notTested,
    containers: collection.containers,
    redacted: opts.rawEvidence !== true,
    kb,
  });
  if (site) evaluation.siteWorkspace = site.record;
  if (opts.localCopy) evaluation.localCopy = localCopyRecord(opts.localCopy);
  // complykit's own tool, when installed (D10): the deployed config against
  // what happened, and whether it is the workspace's latest. Its denied-state
  // misfires feed the compatibility verdict below as behavior mismatches.
  evaluation.consentToolProof = tracking.evaluateConsentToolProof(evaluation, { workspaceConfig: opts.workspace?.config });
  // Re-decide compatibility against the report's own matrix, now that the
  // workspace is on the record, so the change list and the grid agree (B2).
  evaluation.compatibility = reconcileCompatibility(evaluation, { kb, extraBehavior: tracking.configBehaviorCells(evaluation.consentToolProof) });
  return { findings, evaluation };
}
