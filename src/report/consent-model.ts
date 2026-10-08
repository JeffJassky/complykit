import { buildBehaviorMatrix } from './consent-matrix.js';
import type { BehaviorMatrix } from '../../types/index.js';
import { consentResearch, type ResearchWorkflow } from './research.js';
import { buildCompatibilityReport, type CompatibilityReport } from './consent-compatibility.js';
import { buildConsentToolProofReport, type ConsentToolProofReport } from './consent-tool-proof.js';
import type { Finding, TrackingEvaluation, ScenarioId, Evidence } from '../record/index.js';
import { getRequirement, describeLocationRules, citationLabel, type LocationRules } from '../registry/index.js';

// The citation label lives in the registry (citation.ts) so the location popover
// prints the same string; re-exported here for the report's existing callers.
export { citationLabel };

// The consent evaluation report model (plans/consent-design.md §3), shared by
// the HTML, Markdown and JSON renderers:
//
//   1. summary grid — locations × scenarios, findings per cell; cells that don't
//      apply ("no banner") and locations not tested shown as such;
//   2. findings — plain language, with when / sent / stored / came from / rule /
//      evidence;
//   3. inventory — every outside party seen, recognized or not;
//   4. not tested — locations, scenarios, pages and flows the run couldn't cover.
//
// Findings sort two ways: as regulators test (obligations first, by law), and as
// plaintiffs build demand letters (exposure first: third-party data before any
// interaction, from CA/FL/PA, with what was sent). Never "compliant".

export type FindingKind = 'violation' | 'needs-review' | 'exposure' | 'practice';

export const KIND_LABEL: Record<FindingKind, string> = {
  violation: 'Violation',
  'needs-review': 'Needs review',
  exposure: 'Exposure (for counsel)',
  practice: 'Needs research',
};

export const SCENARIO_LABEL: Record<ScenarioId, string> = {
  'do-nothing': 'Do nothing',
  browse: 'Ignore & browse',
  dismiss: 'Dismiss',
  reject: 'Reject',
  accept: 'Accept',
  partial: 'Partial',
  withdraw: 'Withdraw',
  gpc: 'Do-not-sell signal',
  'opt-out-all': 'Opt out every way',
  'opt-out-link': 'Opt-out link',
  'return-visit': 'Return visit',
  markers: 'Markers',
};

const SCENARIO_ORDER: ScenarioId[] = ['do-nothing', 'browse', 'dismiss', 'reject', 'accept', 'partial', 'withdraw', 'return-visit', 'gpc', 'opt-out-all', 'opt-out-link', 'markers'];

export interface GridCell {
  status: 'tested' | 'not-tested' | 'not-applicable' | 'not-run';
  reason?: string;
  counts: Record<FindingKind, number>;
  banner?: string;
  choice?: string;
  /** Why the visitor choice this scenario depends on was not completed, in the owner's words (absent = completed or no choice). */
  choiceGap?: string;
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
  /** Plaintiff-view rank: lower = earlier. */
  plaintiffRank: number;
  /** Regulator-view rank. */
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
    /** Which model of rules the scan compared this location against, and the laws behind it (registry describeLocationRules). */
    rules: LocationRules;
  }>;
  scenarios: ScenarioId[];
  grid: Record<string, Partial<Record<ScenarioId, GridCell>>>;
  findings: ReportFinding[];
  totals: Record<FindingKind, number>;
  inventory: TrackingEvaluation['inventory'];
  notTested: TrackingEvaluation['notTested'];
  researchQueue: TrackingEvaluation['researchQueue'];
  researchWorkflow?: ResearchWorkflow;
  behaviorObservations?: TrackingEvaluation['behaviorObservations'];
  behaviorMatrix?: BehaviorMatrix;
  evidenceIndex: Array<{ location: string; scenario: ScenarioId; har?: string; timeline?: string; screenshots: string[] }>;
  /** The site workspace applied to this run (classifications used, tasks marked done). */
  siteWorkspace?: TrackingEvaluation['siteWorkspace'];
  /** What changed since the previous run of this site (set by the caller: consent-diff.ts). */
  since?: import('../../types/index.js').ConsentRunDiff;
  /** Per-tool compatibility rows, the owner's change list and the "outside your consent tool's reach" line (B2). Absent = the record has no verdicts. */
  compatibility?: CompatibilityReport;
  /** complykit's own tool, when installed: deployed config vs what ran (D10). Absent = the record predates the proof step. */
  consentToolProof?: ConsentToolProofReport;
  /** The guided checklist from the latest generated config (set by the caller: the run's generated output or the site workspace's config.value.tasks). Absent = no config generated yet. */
  remediation?: import('./consent-remediation.js').RemediationSection;
}


export function findingKind(f: Finding): FindingKind {
  const req = getRequirement(String(f.requirementId));
  if (req?.kind === 'exposure') return 'exposure';
  if (req?.kind === 'practice') return 'practice';
  return f.confidence === 'violation' ? 'violation' : 'needs-review';
}

const emptyCounts = (): Record<FindingKind, number> => ({ violation: 0, 'needs-review': 0, exposure: 0, practice: 0 });

const PLAINTIFF_STATES = new Set(['us-ca', 'us-fl', 'us-pa']);

const CHOICE_NAME: Record<string, string> = { reject: 'rejecting', accept: 'accepting', partial: 'accepting analytics only', withdraw: 'withdrawing consent', dismiss: 'closing the banner', 'opt-out-link': 'the opt-out link' };

/**
 * Why a visitor choice was not completed, from the opt-out walk when there is
 * one (older records: the "requires …" note on the choice method). One
 * sentence for the whole column — not a statement about any cookie or tool.
 */
export function choiceGap(s: TrackingEvaluation['locations'][number]['scenarios'][number]): string {
  const walk = s.optOutWalk;
  const legacy = /requires (.+?) — not submitted/.exec(s.choice?.method ?? '')?.[1];
  const fields = walk?.requiredFields.length ? walk.requiredFields : legacy ? legacy.split(', ') : [];
  if (s.scenario === 'opt-out-link' || s.choice?.kind === 'opt-out-link') {
    if (walk && !walk.found) return 'No opt-out link was found, so the opt-out could not be made.';
    const link = walk?.linkText ? `“${walk.linkText}”` : 'The opt-out link';
    if (fields.length) return `The opt-out was not completed: ${link} leads to a page that asks for ${fields.join(', ')}, and the scan does not submit personal data.`;
    if (walk && !walk.performed) return `The opt-out was not completed: ${link} leads to a page with no opt-out button or switch the scan could use.`;
    return `The opt-out through ${link} could not be confirmed.`;
  }
  return `The scan could not confirm ${CHOICE_NAME[s.choice?.kind ?? s.scenario] ?? 'this visitor choice'} worked.`;
}

export function buildConsentReportModel(evaluation: TrackingEvaluation, findings: Finding[]): ConsentReportModel {
  const scenarioSet = new Set<ScenarioId>();
  for (const l of evaluation.locations) for (const s of l.scenarios) scenarioSet.add(s.scenario);
  const scenarios = SCENARIO_ORDER.filter((s) => scenarioSet.has(s));

  const grid: ConsentReportModel['grid'] = {};
  for (const l of evaluation.locations) {
    const row: Partial<Record<ScenarioId, GridCell>> = {};
    if (l.verification.verdict !== 'verified') {
      for (const s of scenarios) row[s] = { status: 'not-tested', reason: `location ${l.verification.verdict}`, counts: emptyCounts() };
    } else {
      for (const s of scenarios) row[s] = { status: 'not-run', counts: emptyCounts() };
      for (const s of l.scenarios) {
        row[s.scenario] = {
          status: s.status,
          reason: s.reason,
          counts: emptyCounts(),
          banner: s.banner?.found ? s.banner.cmp ?? 'banner' : 'no banner',
          choice: s.choice ? `${s.choice.kind}${s.choice.ok ? '' : ' (failed)'}` : undefined,
          choiceGap: s.choice && !s.choice.ok ? choiceGap(s) : undefined,
          runs: s.runs,
        };
      }
    }
    grid[l.spec.id] = row;
  }

  const totals = emptyCounts();
  const out: ReportFinding[] = [];
  for (const f of findings) {
    const req = getRequirement(String(f.requirementId));
    const kind = findingKind(f);
    totals[kind]++;
    const details = (f.details ?? {}) as Record<string, unknown>;
    const occ = (details.occurrences as Array<{ location: string; scenario: ScenarioId; phases?: string[]; sent?: string[]; markers?: string[] }> | undefined) ?? [];
    const cells = occ.length ? occ.map((o) => [o.location, o.scenario] as const) : details.location ? [[String(details.location), (details.scenario as ScenarioId) ?? undefined] as const] : [];
    const counted = new Set<string>();
    for (const [loc, sc] of cells) {
      const key = `${loc}|${sc}`;
      if (counted.has(key)) continue;
      counted.add(key);
      const cell = sc ? grid[loc]?.[sc] : undefined;
      if (cell) cell.counts[kind]++;
    }
    const scope = f.subject.locator?.landmark ?? '';
    const preInteraction = occ.some((o) => (o.phases ?? []).some((p) => p === 'no-banner' || p === 'before-banner' || p === 'before-choice'));
    const contents = occ.some((o) => (o.markers ?? []).length > 0 || (o.sent ?? []).some((k) => k === 'form-input' || k === 'search-term' || k === 'page-title'));
    const plaintiffRank =
      (kind === 'exposure' ? 0 : 10) + (PLAINTIFF_STATES.has(scope) ? 0 : 5) + (preInteraction ? 0 : 2) + (contents ? 0 : 1);
    const regulatorRank = ({ violation: 0, 'needs-review': 1, practice: 3, exposure: 4 } as const)[kind] * 10 + (scope === 'eu' ? 0 : scope === 'uk' ? 1 : scope.startsWith('us') ? 2 : 3);
    out.push({
      fingerprint: String(f.fingerprint),
      kind,
      ruleId: String(f.ruleId),
      requirementId: String(f.requirementId),
      requirementTitle: req?.title ?? String(f.requirementId),
      citation: req ? citationLabel(req) : String(f.requirementId),
      sourceUrl: req?.urls[0]?.href,
      scope,
      party: (details.party as { label?: string } | undefined)?.label,
      message: f.message,
      severity: f.severity,
      details,
      evidence: f.evidence,
      plaintiffRank,
      regulatorRank,
    });
  }
  out.sort((a, b) => a.regulatorRank - b.regulatorRank || a.message.localeCompare(b.message));

  const evidenceIndex: ConsentReportModel['evidenceIndex'] = [];
  for (const l of evaluation.locations) {
    for (const s of l.scenarios) {
      if (s.status === 'not-applicable') continue;
      evidenceIndex.push({ location: l.spec.id, scenario: s.scenario, har: s.evidence.har, timeline: s.evidence.timeline, screenshots: s.evidence.screenshots });
    }
  }

  const model: ConsentReportModel = {
    site: evaluation.site,
    runId: evaluation.runId,
    property: evaluation.property,
    startedAt: evaluation.startedAt,
    finishedAt: evaluation.finishedAt,
    versions: evaluation.versions,
    redacted: evaluation.redacted,
    locations: evaluation.locations.map((l) => ({
      id: l.spec.id,
      label: l.spec.label ?? l.spec.id,
      verdict: l.verification.verdict,
      observed: [l.verification.observed.country, l.verification.observed.region].filter(Boolean).join('-') || 'unknown',
      jurisdictions: l.verification.jurisdictions,
      note: l.verification.note,
      siteReported: l.verification.siteReported,
      proxied: l.spec.proxied,
      rules: describeLocationRules(l.verification.jurisdictions, evaluation.startedAt.slice(0, 10), {
        verified: l.verification.verdict === 'verified',
        observed: [l.verification.observed.country, l.verification.observed.region].filter(Boolean).join('-') || undefined,
      }),
    })),
    scenarios,
    grid,
    findings: out,
    totals,
    inventory: evaluation.inventory,
    behaviorObservations: evaluation.behaviorObservations,
    notTested: evaluation.notTested,
    researchQueue: evaluation.researchQueue,
    evidenceIndex,
    ...(evaluation.siteWorkspace ? { siteWorkspace: evaluation.siteWorkspace } : {}),
    ...(evaluation.localCopy ? { localCopy: evaluation.localCopy } : {}),
  };
  model.behaviorMatrix = buildBehaviorMatrix(model);
  model.researchWorkflow = consentResearch(model);
  if (evaluation.compatibility) {
    const runs = Math.max(1, ...Object.values(grid).flatMap((row) => Object.values(row).map((c) => c?.runs ?? 1)));
    model.compatibility = buildCompatibilityReport(evaluation.compatibility, { inventory: evaluation.inventory, markup: evaluation.markup, locations: model.locations, runs, matrix: model.behaviorMatrix });
  }
  const proof = buildConsentToolProofReport(evaluation.consentToolProof);
  if (proof) model.consentToolProof = proof;
  return model;
}
