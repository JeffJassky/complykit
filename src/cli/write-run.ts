import { execFileSync } from 'node:child_process';
import { writeRun, appendFinding, type Run, type Finding, type RunId, type RuleId, type CoverageGap, type MatrixCell, type AccessLevel } from '../record/index.js';
import { REGISTRY_VERSION } from '../registry/index.js';

// Assemble a Run from a set of findings + coverage facts and persist it.
// Findings are deduped by fingerprint here (resilience default: re-scans and
// confirm-on-new must not multiply counts). Kept out of the command modules so
// static, browser, and combined scans all write runs the same way.

export function gitSha(dir: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

export interface AssembleOptions {
  runId: RunId;
  property: string;
  now: string;
  packageVersion: string;
  findings: Finding[];
  engines: Record<string, string>;
  accessLevels: AccessLevel[];
  gaps?: CoverageGap[];
  matrix?: MatrixCell[];
  gitShaDir?: string;
  rulesExecuted?: RuleId[];
  cwd?: string;
}

export function assembleAndWrite(opts: AssembleOptions): { run: Run; written: number } {
  // Dedupe by fingerprint; keep the first (engine before rule ordering upstream).
  const seen = new Set<string>();
  const deduped: Finding[] = [];
  for (const f of opts.findings) {
    if (seen.has(f.fingerprint)) continue;
    seen.add(f.fingerprint);
    deduped.push(f);
  }

  const run: Run = {
    schemaVersion: 1,
    id: opts.runId,
    property: opts.property,
    startedAt: opts.now,
    finishedAt: new Date(opts.now).toISOString(),
    versions: { package: opts.packageVersion, registry: REGISTRY_VERSION, engines: opts.engines },
    gitSha: opts.gitShaDir ? gitSha(opts.gitShaDir) : undefined,
    accessLevels: [...new Set(opts.accessLevels)],
    matrix: opts.matrix ?? [],
    gaps: opts.gaps ?? [],
    rulesExecuted: opts.rulesExecuted ?? [...new Set(deduped.map((f) => f.ruleId))],
  };
  writeRun(run, opts.cwd);
  for (const f of deduped) appendFinding(run.id, f, opts.cwd);
  return { run, written: deduped.length };
}
