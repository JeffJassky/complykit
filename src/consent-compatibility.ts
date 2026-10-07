import type { CompatibilitySection, TrackingEvaluation } from './record/index.js';
import type { KnowledgeBase } from './registry/index.js';
import type { WorkspaceSnapshot } from './site-workspace.js';
import { compatibilityFor, consentToolDefaultFinding, type BehaviorCell } from './rules/tracking/compatibility.js';
import { configBehaviorCells, evaluateConsentToolProof } from './rules/tracking/consent-tool-proof.js';
import { buildConsentReportModel } from './report/consent-model.js';

// The compatibility verdict, re-decided against the report's own behavior
// matrix (ticket B2). buildTrackingEvaluation decides compatibility from B1's
// narrower behavior cells, before the site workspace (C3) is stamped on the
// record — but the workspace's storage classifications change the matrix the
// reader sees. So the verdict is recomputed here, from the matrix's tool rows,
// after the workspace is applied: the report's grid and the change list's
// "observed running where it should be off" then say the same thing.
//
// Lives outside rules/ and report/ because it needs both (rules may not
// import report; report may not import rules). Pure over the record.
//
// Matrix cell → behavior cell:
//   mismatch        → mismatch
//   match / allowed → no-mismatch-observed (nothing contradicted the expectation)
//   review / unknown / not-tested → not-established (never a pass)

const STATUS: Record<string, BehaviorCell['status']> = {
  mismatch: 'mismatch',
  match: 'no-mismatch-observed',
  allowed: 'no-mismatch-observed',
};

/** Behavior cells for every tool row of the evaluation's report matrix. */
export function matrixBehaviorCells(evaluation: TrackingEvaluation): BehaviorCell[] {
  if (!evaluation.behaviorObservations) return [];
  const model = buildConsentReportModel(evaluation, []);
  const matrix = model.behaviorMatrix;
  if (!matrix) return [];
  const out: BehaviorCell[] = [];
  for (const row of matrix.rows) {
    if (row.kind !== 'tool') continue;
    row.cells.forEach((c, i) => {
      const col = matrix.columns[i];
      const ref = c.evidencePointers.find((p) => p.startsWith('/behaviorObservations/'));
      out.push({ partyId: row.partyId, location: col.location, scenario: col.scenario, status: STATUS[c.status] ?? 'not-established', reason: c.reason, ...(ref ? { ref } : {}) });
    });
  }
  return out;
}

/**
 * The compatibility section for this record as the report shows it (call after
 * the site workspace is applied). `extraBehavior`: cells from another expected
 * side — the deployed complykit config's (D10, configBehaviorCells) — so a vendor
 * the config says is gated but fires is a behavior mismatch too.
 */
export function reconcileCompatibility(evaluation: TrackingEvaluation, opts: { kb?: KnowledgeBase; extraBehavior?: BehaviorCell[] } = {}): CompatibilitySection {
  const behavior = [...matrixBehaviorCells(evaluation), ...(opts.extraBehavior ?? [])];
  const parties = evaluation.inventory.map((p, i) =>
    compatibilityFor(p, {
      markup: evaluation.markup,
      containers: evaluation.containers,
      consentApi: evaluation.consentApi,
      platform: evaluation.platform,
      behavior,
      kb: opts.kb,
      partyIndex: i,
    }),
  );
  return {
    parties,
    consentTool: consentToolDefaultFinding(evaluation.locations),
    inputs: {
      markup: evaluation.markup !== undefined,
      containers: evaluation.containers !== undefined,
      consentApi: evaluation.consentApi !== undefined,
      consentTool: evaluation.locations.some((l) => l.scenarios.some((s) => s.consentTool)),
      behavior: behavior.some((c) => c.status !== 'not-established'),
    },
  };
}

/**
 * The one reconcile every consumer runs after the site workspace is applied
 * (the scan, `report --workspace`, the config generator, the remediation
 * checklist), so the report's change list and the checklist never disagree:
 * the deployed complykit tool's denied-state misfires (D10, configBehaviorCells)
 * count as behavior mismatches. With a workspace, the proof is re-read against
 * its latest generated config first (as the rescan does); without one, the
 * record's stored proof is used (computed when an older record has none). Mutates `evaluation` (consentToolProof when
 * re-read, compatibility).
 */
export function reconcileRecord(evaluation: TrackingEvaluation, opts: { kb?: KnowledgeBase; workspace?: Pick<WorkspaceSnapshot, 'config'> } = {}): CompatibilitySection {
  if (opts.workspace) evaluation.consentToolProof = evaluateConsentToolProof(evaluation, { workspaceConfig: opts.workspace.config });
  else if (!evaluation.consentToolProof) evaluation.consentToolProof = evaluateConsentToolProof(evaluation);
  evaluation.compatibility = reconcileCompatibility(evaluation, { kb: opts.kb, extraBehavior: configBehaviorCells(evaluation.consentToolProof) });
  return evaluation.compatibility;
}
