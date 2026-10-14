import type { OwnerCell, OwnerReport } from './api.js';

// The report's compliance score and severity (one rule for the server's
// first-scan baseline and the page): the share of a scan's tool checks that
// passed. A check is one tool in one visit (a cell of a tool row; its cookies'
// cells are part of the tool, so a tool with many cookies doesn't weigh more).
// Checks the scan could not run or that had nothing to test don't count.

export type Severity = 'problem' | 'warning' | 'ok';

const COUNTED: ReadonlySet<OwnerCell['state']> = new Set(['ok', 'mismatch', 'blocked', 'needs-decision']);

export interface ScoreSummary {
  /** 0–100; absent when no check could be scored. */
  score?: number;
  /** Tools with a problem (✕ or ⊘) in any visit. */
  problems: number;
  /** Tools whose purpose isn't known yet (?). */
  decisions: number;
  /** Checks that passed / checks scored. */
  passed: number;
  scored: number;
}

export function scoreReport(report: Pick<OwnerReport, 'matrix'> | null | undefined): ScoreSummary {
  let passed = 0;
  let scored = 0;
  let problems = 0;
  let decisions = 0;
  for (const t of report?.matrix.tools ?? []) {
    let problem = false;
    let decide = false;
    for (const c of t.cells) {
      if (!COUNTED.has(c.state)) continue;
      scored += 1;
      if (c.state === 'ok') passed += 1;
      if (c.state === 'mismatch' || c.state === 'blocked') problem = true;
      if (c.state === 'needs-decision') decide = true;
    }
    if (problem) problems += 1;
    else if (decide) decisions += 1;
  }
  return { ...(scored ? { score: Math.round((100 * passed) / scored) } : {}), problems, decisions, passed, scored };
}

/** The worst thing a report shows: a problem (✕ ⊘), else a warning (? or a check that couldn't run), else ok. Null when nothing was checked yet. */
export function reportSeverity(report: Pick<OwnerReport, 'matrix'> | null | undefined): Severity | null {
  let worst: Severity | null = null;
  const see = (s: OwnerCell['state']) => {
    if (s === 'mismatch' || s === 'blocked') worst = 'problem';
    else if ((s === 'needs-decision' || s === 'not-checked') && worst !== 'problem') worst = 'warning';
    else if (s === 'ok' && worst === null) worst = 'ok';
  };
  for (const t of report?.matrix.tools ?? []) {
    for (const c of t.cells) see(c.state);
    for (const k of t.cookies) for (const c of k.cells) see(c.state);
  }
  // A column the scan couldn't run is a gap even when no tool appeared in it.
  for (const c of report?.matrix.columns ?? []) if (c.state === 'not-checked' || c.state === 'blocked') see(c.state);
  return worst;
}
