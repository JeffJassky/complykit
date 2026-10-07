import fs from 'node:fs';
import path from 'node:path';
import { Finding, listRuns, readTrackingEvaluation, runDir, type TrackingEvaluation } from '../record/index.js';
import { parseWorkspaceSnapshot, type WorkspaceSnapshot } from '../site-workspace.js';

// The consent command's two links to earlier work on a site (ticket C3): the
// site workspace file (--workspace) and the previous run to diff against
// (--previous, else the newest earlier consent run of the same site in
// .comply/runs).

export function readWorkspaceFile(file: string): WorkspaceSnapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`could not read workspace ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return parseWorkspaceSnapshot(raw);
  } catch (err) {
    throw new Error(`${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface PreviousRun {
  dir: string;
  evaluation: TrackingEvaluation;
  findings: Finding[];
}

/** A run directory's evaluation and findings, or undefined when it has no consent evaluation. */
export function readConsentRunDir(dir: string): PreviousRun | undefined {
  const evaluation = readTrackingEvaluation(dir);
  if (!evaluation) return undefined;
  const findings: Finding[] = [];
  const file = path.join(dir, 'findings.jsonl');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (line.trim()) findings.push(Finding.parse(JSON.parse(line)));
    }
  }
  return { dir, evaluation, findings };
}

/**
 * The newest consent run in cwd's .comply/runs for the same site (registrable
 * domain) that started before this one, other than `current`. Unreadable runs
 * are skipped: a missing comparison is reported as such, never invented.
 */
export function findPreviousConsentRun(opts: { cwd: string; current: string; site: string; before: string }): PreviousRun | undefined {
  let best: PreviousRun | undefined;
  for (const run of listRuns(undefined, opts.cwd)) {
    if (String(run.id) === opts.current) continue;
    let prev: PreviousRun | undefined;
    try {
      prev = readConsentRunDir(runDir(run.id, opts.cwd));
    } catch {
      continue;
    }
    if (!prev || prev.evaluation.site.registrableDomain !== opts.site || prev.evaluation.startedAt >= opts.before) continue;
    if (!best || prev.evaluation.startedAt > best.evaluation.startedAt) best = prev;
  }
  return best;
}
