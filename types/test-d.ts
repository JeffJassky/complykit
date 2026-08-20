/**
 * Compile-only exercise of the public declarations, from OUTSIDE — the way a
 * host consumes them. Never executed; `tsc --noEmit` failing here means the
 * .d.ts drifted. src/contract.ts guards the record shapes against the zod
 * schemas; this file guards that every export exists and is the right KIND.
 *
 * Rule from traps.md #9: exercise every VALUE export AS A VALUE (read a
 * property, call it, bind it). Importing a value as a type proves nothing — a
 * const accidentally declared `type` would sail through. scripts/check-exports
 * closes the remaining blind spot against the built bundle.
 */
import {
  defineConfig,
  syntheticConfig,
  fingerprint,
  resolveFinding,
  addFinding,
  writeRun,
  readRun,
  loadRun,
  listRuns,
  readFindings,
  appendFinding,
  putEvidence,
  runIdFromTimestamp,
  runsRoot,
  runDir,
  severityNarrows,
  SCHEMA_VERSION,
  FINGERPRINT_VERSION,
  COMPLY_DIR,
  asRunId,
  asRequirementId,
  asRuleId,
  asInstrumentId,
  INSTRUMENTS,
  ALL_REQUIREMENTS,
  AXE_MAPPINGS,
  AXE_PINNED_RULES,
  AXE_VERSION,
  RULESETS,
  REGISTRY_VERSION,
  findRuleSet,
  requirementsForRuleset,
  getRequirement,
  getInstrument,
  requirementApplies,
  verifyRegistry,
  unmappedEngineRules,
  ALL_RULES,
  getRule,
  resolveCapsFor,
  evaluate,
  isLlmRule,
  renderJsonl,
  renderMarkdown,
  renderReport,
  containsBannedVocabulary,
  assertReportVocabulary,
  diffRuns,
  budgetBreaches,
  coverage,
  renderCoverage,
  renderSarif,
  buildCoverageIndex,
  normalizeEngineArtifacts,
  ENGINE_TABLES,
  ALL_ENGINE_MAPPINGS,
  getEngineMapping,
} from './index.js';
import type {
  Config,
  Finding,
  RawFinding,
  Run,
  Subject,
  Producer,
  Evidence,
  Requirement,
  Rule,
  LlmRule,
  RunDiff,
  CoverageMatrix,
  FindingCaps,
} from './index.js';

// Value exports exercised as values.
const _v: number = SCHEMA_VERSION;
const _fpv: string = FINGERPRINT_VERSION;
const _cd: string = COMPLY_DIR;
const _av: string = AXE_VERSION;
const _rv: string = REGISTRY_VERSION;
const _narrows: boolean = severityNarrows('serious', 'moderate');
const _first: Requirement | undefined = ALL_REQUIREMENTS[0];
const _instName: string | undefined = INSTRUMENTS[0]?.name;
const _mapCount: number = AXE_MAPPINGS.length;
const _pinned: string[] = AXE_PINNED_RULES;
const _rulesetIds: string[] = RULESETS.map((r) => r.id);
const _rs = findRuleSet('wcag22aa');
const _sel: Requirement[] = requirementsForRuleset('wcag22aa', ALL_REQUIREMENTS);
const _req = getRequirement('wcag22.1.4.3');
const _inst = getInstrument('wcag');
const _applies: boolean = _req ? requirementApplies(_req, ['targets-eu']) : false;
const _report = verifyRegistry();
const _ok: boolean = _report.ok;
const _unmapped: string[] = unmappedEngineRules('axe-core', ['color-contrast']);
const _rule: Rule | LlmRule | undefined = getRule('art50.ai-interaction-disclosure');
const _allRules = ALL_RULES;
const _isLlm: boolean = _allRules.length > 0 && isLlmRule(_allRules[0]);

// Config.
const cfg: Config = defineConfig({
  properties: [{ id: 'x', targets: { public: { url: 'https://example.com' } }, rulesets: ['wcag22aa'] }],
});
const zero: Config = syntheticConfig('https://example.com');
const _budget: string = cfg.budget.failOn;

// Ids + fingerprint.
const runId = runIdFromTimestamp('2026-08-19T00:00:00.000Z');
const subject: Subject = { property: 'x', routePattern: '/p/:id' };
const fp = fingerprint({ detects: 'presence', ruleId: asRuleId('r'), subject });
const _fpStr: string = fp;

// Caps + normalize + addFinding.
const caps: FindingCaps = resolveCapsFor('art50.ai-interaction-disclosure', 'eu-ai-act.art50.1');
const producer: Producer = { type: 'agent', model: 'claude', rubricVersion: '1' };
const raw: RawFinding = {
  ruleId: asRuleId('art50.ai-interaction-disclosure'),
  requirementId: asRequirementId('eu-ai-act.art50.1'),
  subject,
  confidence: 'needs-review',
  message: 'no disclosure found',
  evidence: [],
};
declare function _use(x: unknown): void;
_use(caps);
_use((): Finding => resolveFinding(raw, { caps, runId, producer }));
_use((): Finding => addFinding(raw, { runId, producer, persist: false }));

// Run store.
declare const run: Run;
_use((): string => writeRun(run));
_use((): Run => readRun(runId));
_use((): { run: Run; findings: Finding[] } => loadRun(runId));
_use((): Run[] => listRuns('x'));
_use((): Finding[] => readFindings(runId));
declare const finding: Finding;
_use(() => appendFinding(runId, finding));
_use((): string => putEvidence(runId, Buffer.from('x'), 'png'));
_use((): string => runsRoot());
_use((): string => runDir(runId));
_use(asRunId('a'));
_use(asInstrumentId('wcag'));

// Evaluate (pure) + report.
const _evaluated: RawFinding[] = evaluate([], _allRules, { property: 'x' });
const _jsonl: string = renderJsonl([finding]);
const _md: string = renderMarkdown(run, [finding]);
const _rep: string = renderReport(run, [finding], 'jsonl');
const _banned: boolean = containsBannedVocabulary('findings');
_use(() => assertReportVocabulary('findings'));
const diff: RunDiff = diffRuns({ run, findings: [] }, { run, findings: [finding] });
const _breaches: Finding[] = budgetBreaches(diff, 'new-critical');
const matrix: CoverageMatrix = coverage('wcag22aa', buildCoverageIndex());
const _cov: string = renderCoverage(matrix);
const _sarif: string = renderSarif(run, [finding]);

// Engine mapping surface + normalization.
const _tables = ENGINE_TABLES.map((t) => t.engine);
const _allMappings: number = ALL_ENGINE_MAPPINGS.length;
const _mapping = getEngineMapping('axe-core', 'color-contrast');
const _norm = normalizeEngineArtifacts([], { runId });
const _normFindings: Finding[] = _norm.findings;

// Evidence discriminated union is expressible.
const ev: Evidence = { kind: 'dom-snippet', html: '<button>' };
_use(ev);
