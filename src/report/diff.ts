import type { Finding, Fingerprint, Run } from '../record/index.js';

// diff compares two runs by fingerprint — the whole point of a stable
// fingerprint. `new` findings are what a CI budget gate keys on (fail on NEW
// criticals, not absolute zero — build-plan §budget).

export interface RunDiff {
  base: { runId: string; property: string };
  head: { runId: string; property: string };
  added: Finding[]; // in head, not in base
  resolved: Finding[]; // in base, not in head
  persisting: Finding[]; // in both (head's copy)
}

function byFingerprint(findings: Finding[]): Map<Fingerprint, Finding> {
  const m = new Map<Fingerprint, Finding>();
  for (const f of findings) m.set(f.fingerprint, f);
  return m;
}

export function diffRuns(
  base: { run: Run; findings: Finding[] },
  head: { run: Run; findings: Finding[] },
): RunDiff {
  const baseMap = byFingerprint(base.findings);
  const headMap = byFingerprint(head.findings);

  const added: Finding[] = [];
  const persisting: Finding[] = [];
  for (const [fp, f] of headMap) {
    if (baseMap.has(fp)) persisting.push(f);
    else added.push(f);
  }
  const resolved: Finding[] = [];
  for (const [fp, f] of baseMap) {
    if (!headMap.has(fp)) resolved.push(f);
  }

  return {
    base: { runId: String(base.run.id), property: base.run.property },
    head: { runId: String(head.run.id), property: head.run.property },
    added,
    resolved,
    persisting,
  };
}

export type BudgetGate = 'new-critical' | 'new-serious' | 'none';

/**
 * The CI gate. Returns the findings that trip the budget — new findings at or
 * above the configured severity floor. `none` never trips. Default is
 * new-critical (build-plan §11).
 */
export function budgetBreaches(diff: RunDiff, failOn: BudgetGate = 'new-critical'): Finding[] {
  if (failOn === 'none') return [];
  const floor = failOn === 'new-critical' ? new Set(['critical']) : new Set(['critical', 'serious']);
  return diff.added.filter((f) => floor.has(f.severity));
}
