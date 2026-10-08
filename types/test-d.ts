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
  classifyCookie,
  requiresConsent,
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
  renderHtmlReport,
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
const _cls = classifyCookie('_ga');
const _needsConsent: boolean = requiresConsent(_cls.category);
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
const _html: string = renderHtmlReport(run, [finding], { cwd: '.' });

// Engine mapping surface + normalization.
const _tables = ENGINE_TABLES.map((t) => t.engine);
const _allMappings: number = ALL_ENGINE_MAPPINGS.length;
const _mapping = getEngineMapping('axe-core', 'color-contrast');
const _norm = normalizeEngineArtifacts([], { runId });
const _normFindings: Finding[] = _norm.findings;

// Evidence discriminated union is expressible.
const ev: Evidence = { kind: 'dom-snippet', html: '<button>' };
_use(ev);

// Consent & tracking evaluation surface (values exercised as values).
import {
  TRACKING_SCHEMA_VERSION,
  TRACKING_FILE,
  redactTimeline,
  writeTrackingEvaluation,
  readTrackingEvaluation,
  KB_VERSION,
  KB_ENTRIES,
  DEFAULT_KB,
  CONSENT_CATEGORIES,
  CONTEXT_CATEGORIES,
  WIRETAP_CATEGORIES,
  SALE_SHARE_CATEGORIES,
  buildKnowledgeBase,
  lookupEntry,
  matchVendorSignatures,
  hostsInText,
  entriesForText,
  inlineRegExp,
  parseContainers,
  parseGtmContainer,
  extractContainerData,
  type TagContainer,
  lookupStore,
  entryStatus,
  registrableDomain,
  hostOf,
  hostMatches,
  isEuEea,
  jurisdictionsFor,
  requirementScopeFor,
  normalizeRegion,
  regimeFor,
  parseRegimeLocation,
  isOptOutSignalState,
  isWiretapJurisdiction,
  WIRETAP_STATES,
  regimeForCodes,
  isUsPrivacyActState,
  US_PRIVACY_ACT_STATES,
  US_OPT_OUT_SIGNAL_STATES,
  EU_EEA_COUNTRIES,
  US_STATE_PRIVACY_ACTS,
  US_STATE_NAMES,
  usStateAct,
  describeLocationRules,
  hostedOn,
  domainLabel,
  type RegimeVerdict,
  type LocationRules,
  type LocationRuleLaw,
  type DescribeLocationOptions,
  type UsStatePrivacyAct,
  decideVerification,
  defaultScenarios,
  locationPreset,
  buildTrackingEvaluation,
  summarizeConsentApi,
  evaluateCompatibility,
  compatibilityFor,
  behaviorCellsFrom,
  consentToolDefaultFinding,
  verdictRank,
  findingKind,
  citationLabel,
  buildConsentReportModel,
  renderConsentHtml,
  renderConsentMarkdown,
  getRequirement as _getReq,
  type Timeline,
  type TrackingEvaluation,
  type CompatibilitySection,
  type PartyCompatibility,
  type ConsentApiObservation,
  type BehaviorCell,
  type ConsentReportModel,
  type LocationVerification,
  type KnowledgeBase,
  type ScenarioId,
} from './index.js';
import { COLLECTION_FILE, COLLECTION_KIND, COLLECTION_SCHEMA_VERSION, writeCollectionHandoff, readCollectionHandoff, mergeCollections, mergeEvidence, type ConsentCollectionHandoff } from './index.js';
import { collectConsentEvaluation, DEFAULT_GEO_SOURCES, LOCAL_LOCATION, resolveJourney, contextOptionsFor, redactHar } from './collect-browser.js';

const _tv: number = TRACKING_SCHEMA_VERSION + TRACKING_FILE.length + KB_VERSION.length + KB_ENTRIES.length + DEFAULT_KB.entries.length;
const _cats: boolean = CONSENT_CATEGORIES.has('analytics') && CONTEXT_CATEGORIES.has('chat') && WIRETAP_CATEGORIES.has('chat') && SALE_SHARE_CATEGORIES.has('advertising');
declare const tl: Timeline;
const _red: Timeline = redactTimeline(tl);
declare const ev2: TrackingEvaluation;
_use(() => writeTrackingEvaluation('.', ev2));
// B1: the compatibility verdict and its inputs, exercised as values.
declare const tl2: Timeline;
const _cao: ConsentApiObservation = summarizeConsentApi(tl2);
const _cs: CompatibilitySection = evaluateCompatibility(ev2);
const _pc: PartyCompatibility = compatibilityFor(ev2.inventory[0], { markup: ev2.markup, behavior: behaviorCellsFrom(ev2), partyIndex: 0 });
const _bc: BehaviorCell[] = behaviorCellsFrom(ev2);
_use(_cao.calls + _cs.parties.length + _bc.length + verdictRank(_pc.verdict) + consentToolDefaultFinding(ev2.locations).grants.length);
const _readEv: TrackingEvaluation | undefined = readTrackingEvaluation('.');
const kb2: KnowledgeBase = buildKnowledgeBase({ overrides: [{ id: 'intercom', categories: ['functional'] }] });
_use(lookupEntry(kb2, 'www.facebook.com', '/tr'));
_use(lookupStore(DEFAULT_KB, '_ga'));
const _sig: string[] = matchVendorSignatures('fbq("init")').concat(hostsInText('https://a.b.test/x'), entriesForText(DEFAULT_KB, '').map((e) => e.id));
_use(inlineRegExp('fbq'));
const _gtm: TagContainer[] = parseContainers([], {}).concat(parseGtmContainer({ id: 'GTM-XXXX01', kind: 'gtm', url: '', locationId: 'local', seenOn: [], fetchedAt: '', status: 'error' }));
_use(extractContainerData('').reason);
_use(KB_ENTRIES[0] ? entryStatus(KB_ENTRIES[0]) : 'proposed');
const _rd: string = registrableDomain('a.b.co.uk') + hostOf('https://x.y/') + String(hostMatches('a.b', 'b')) + String(isEuEea('DE'));
const _j: string[] = jurisdictionsFor({ country: 'US', region: 'CA' });
_use(requirementScopeFor(_getReq('eprivacy.art5.3')!, _j, '2026-10-02'));
_use(normalizeRegion('US', 'California'));
const _rg: string = regimeFor(parseRegimeLocation('US-CA'), '2026-10-06');
_use(isOptOutSignalState('CA') && _rg);
_use(isWiretapJurisdiction(['us', 'us-ca']) && WIRETAP_STATES.has('us-ca'));
const _rvc: RegimeVerdict = regimeForCodes(['us', 'us-tx'], '2026-10-08', { unverifiedUs: 'baseline' });
_use(isUsPrivacyActState('VA') && _rvc);
const _acts: number = US_PRIVACY_ACT_STATES.length + US_OPT_OUT_SIGNAL_STATES.length + Object.keys(US_STATE_PRIVACY_ACTS).length + Object.keys(US_STATE_NAMES).length + EU_EEA_COUNTRIES.length;
const _act = usStateAct('TX'); const _actBase: UsStatePrivacyAct | undefined = _act;
const _dopts: DescribeLocationOptions = { verified: true, observed: 'US-TX' };
const _lr: LocationRules = describeLocationRules(['us', 'us-tx'], '2026-10-08', _dopts);
const _law: LocationRuleLaw | undefined = _lr.laws[0];
_use(domainLabel('x.example') + (hostedOn('x.example')?.provider ?? ''));
_use(_acts + (_actBase?.name ?? '') + (_act?.from ?? '') + (_law?.citation ?? '') + _lr.label);
const _lv: LocationVerification = decideVerification({ id: 'local' }, []);
const _sc: ScenarioId[] = defaultScenarios(['eu']);
_use(locationPreset('us-ca'));
_use(() => buildTrackingEvaluation({ runId: 'r', property: 'p', site: { url: '', host: '', registrableDomain: '' }, versions: { kb: '', registry: '', package: '' }, startedAt: '', finishedAt: '', locations: [], timelines: [], notTested: [], redacted: true }));
_use(findingKind(finding));
_use(citationLabel(_getReq('cipa.631')!));
const model: ConsentReportModel = buildConsentReportModel(ev2, [finding]);
const _ch: string = renderConsentHtml(model, { runDir: '.' }) + renderConsentMarkdown(model, { maxFindings: 3 });
_use(() => collectConsentEvaluation({ property: 'p', targetUrl: 'https://x', runId, policy: { registrableDomain, verify: (s, src) => decideVerification(s, src), scenariosFor: () => ['do-nothing'] } }));
_use(DEFAULT_GEO_SOURCES.length + LOCAL_LOCATION.id.length);
_use(resolveJourney({ dwellMs: 1 }).dwellMs);
_use(contextOptionsFor(LOCAL_LOCATION));
_use(() => redactHar({ log: { entries: [] } }));

// --- consent tool config (D2): every value export exercised AS a value ------------
import {
  CONSENT_CONFIG_MAJOR,
  CONSENT_CONFIG_VERSION,
  CONSENT_CONFIG_ELEMENT_ID,
  NECESSARY_CATEGORY,
  REGIMES,
  FALLBACK_REGIME,
  CONSENT_MODE_SIGNALS,
  CONSENT_STRING_KEYS,
  CONSENT_CONFIG_JSON_SCHEMA_ID,
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
  validateConsentStrings,
  DO_NOT_SELL_OR_SHARE,
  type ConsentStringIssue,
  type ConsentToolConfig,
  type Regime,
} from './index.js';
const _ccv: number = CONSENT_CONFIG_ELEMENT_ID.length + CONSENT_CONFIG_MAJOR + CONSENT_CONFIG_VERSION.length + NECESSARY_CATEGORY.length + REGIMES.length + FALLBACK_REGIME.length + CONSENT_MODE_SIGNALS.length + CONSENT_STRING_KEYS.length + CONSENT_CONFIG_JSON_SCHEMA_ID.length;
_use(parseConsentConfigVersion('1.0')?.major);
_use(consentConfigVersionStatus('1.0') === 'current');
const _ctc: ConsentToolConfig = withConsentConfigHash({
  version: CONSENT_CONFIG_VERSION,
  generatedFrom: { runId: 'r', at: '2026-10-06T00:00:00.000Z', site: 'example-shop.test', complykit: '0.0.0' },
  regimeSource: { kind: 'fixed', regime: 'opt-in' },
  categories: [{ id: 'necessary', label: 'Necessary', description: '', defaultByRegime: { 'opt-in': true, 'opt-out-signal': true, 'opt-out': true } }],
  strings: { en: { 'banner.title': 'Privacy', byRegime: { 'opt-out-signal': { 'optOut.link': 'Do Not Sell or Share My Personal Information' } } } },
  consent: { lifetimeDays: 180 },
});
_use(readConsentConfigHeader(_ctc).generatedFrom?.site);
const _csi: ConsentStringIssue[] = validateConsentStrings(_ctc.strings);
_use(_csi[0]?.rule ?? DO_NOT_SELL_OR_SHARE.length);
const _g = guardConsentToolConfig(_ctc);
_use(_g.ok ? _g.config.layout : _g.reason);
const _r: Regime = 'opt-out';
_use(isNecessaryCategory('necessary') && consentCategoryDefault(_ctc, 'analytics', _r));
const _hash: string = hashConsentToolConfig(_ctc) + canonicalJson({ b: 1, a: 2 });
const _p = parseConsentToolConfig(_ctc);
_use(_p.ok ? _p.hashMatches : _p.issues.length);
_use(consentToolConfigJsonSchema().$schema);

// --- consent config generator (D8) ------------------------------------------------
import { generateConsentConfig, DEFAULT_SCRIPT_SRC, type GeneratedConsentConfig, type TrackingEvaluation as _TE } from './index.js';
declare const _te: _TE;
const _gen: () => GeneratedConsentConfig = () => generateConsentConfig(_te, { complykitVersion: '0.0.0', scriptSrc: DEFAULT_SCRIPT_SRC, workspace: { entries: {} } });
_use(_gen);

// --- guided remediation flow ---------------------------------------------------------
import {
  changeId,
  changeSignature,
  elementSignatureOf,
  remediationTaskKey,
  readRemediationTaskValue,
  isRemediationDone,
  REMEDIATION_TASK_KEY_PREFIX,
  INSTALL_TASK_ID,
  buildRemediationTasks,
  installTask,
  removeExistingToolTasks,
  remediationTotals,
  renderHeadSnippet,
  scriptJson,
  verifyInstall,
  verifyRewriteTag,
  verifyRemoveLeak,
  verifyGtmTagConsent,
  verifyConsentDefault,
  verifyRemoveExistingTool,
  judgeSpotCheck,
  runVerify,
  elementMatches,
  consentPluginPathPattern,
  renderRemediationHtml,
  remediationFromWorkspace,
  parseRemediationTasks,
  type RemediationSection,
  type RemediationTask,
  type ElementSignature,
  type MarkupFinding as _MF,
} from './index.js';
declare const _mf: _MF;
const _esig: ElementSignature = elementSignatureOf(_mf);
const _cid: string = changeId({ kind: 'rewrite-tag', signature: _esig }) + remediationTaskKey(INSTALL_TASK_ID) + REMEDIATION_TASK_KEY_PREFIX;
_use([_cid, changeSignature({ kind: 'install' }), readRemediationTaskValue({ status: 'todo' })?.status, isRemediationDone('verified')]);
const _tasks: RemediationTask[] = buildRemediationTasks(_gen(), _te, { workspace: { entries: {} } });
_use([_tasks[0]?.verify.method, remediationTotals(_tasks).verified, installTask(_ctc, DEFAULT_SCRIPT_SRC, 'https://example.test/').id, removeExistingToolTasks(_te, [], 'https://example.test/').length]);
_use(renderHeadSnippet(_ctc, DEFAULT_SCRIPT_SRC) + scriptJson({}));
const _remSec: RemediationSection | undefined = remediationFromWorkspace({ entries: {}, config: { value: { tasks: _tasks } } });
_use([renderRemediationHtml(_remSec), parseRemediationTasks([]).length]);
_use(verifyInstall('<html></html>', { page: 'https://example.test/', configHash: _hash, scriptSrc: DEFAULT_SCRIPT_SRC }).result);
_use([verifyRewriteTag('', { page: '', element: _esig, category: 'analytics' }).message, verifyRemoveLeak('', { page: '', element: _esig }).evidence.length]);
_use([verifyGtmTagConsent('', { containerId: 'GTM-X', tagId: 1, consentTypes: [] }).result, verifyConsentDefault('', { page: '', consentTypes: [] }).result]);
_use([verifyRemoveExistingTool('', { page: '', label: 'x' }).result, judgeSpotCheck({ page: '', partyId: 'x', hosts: [] }, { page: '', phases: [] }).result]);
_use([runVerify(_tasks[0].verify, { html: '' }).result, elementMatches({ kind: 'script', line: 1, context: 'document', loads: 'executes', attributes: {}, hosts: [], ids: [] }, _esig), consentPluginPathPattern('complianz')]);

// Multi-region: collect-only handoff + pure merge.
declare const _handoff: ConsentCollectionHandoff;
const _hf: string = writeCollectionHandoff('.', _handoff) + COLLECTION_FILE + COLLECTION_KIND + String(COLLECTION_SCHEMA_VERSION);
const _hr: ConsentCollectionHandoff = readCollectionHandoff('.');
const _mc = mergeCollections([_hr]);
const _me: { copied: number; skipped: number } = mergeEvidence(['.'], '.');
_use(_hf + _mc.site.url + String(_me.copied));
