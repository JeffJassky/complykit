import {
  resolveFinding,
  runIdFromTimestamp,
  type Run,
  type Finding,
  type RunId,
  type Artifact,
} from './record/index.js';
import { REGISTRY_VERSION } from './registry/index.js';
import { ALL_RULES, evaluate, resolveCapsFor } from './rules/index.js';
import { normalizeEngineArtifacts } from './engines.js';
import { collectStatic } from './collect/static/index.js';

// The scan pipeline: collect artifacts, normalize engine output, evaluate our
// pure rules, and resolve everything into stored Findings. Kept OUT of the root
// export (it pulls the static collector's lint deps) and out of cli/ (which is
// wiring only). cli calls this and writes the result.

export interface StaticScanOptions {
  cwd: string;
  property: string;
  repoDir: string;
  tags?: string[];
  packageVersion: string;
  now?: string; // injectable for deterministic tests
}

export interface StaticScanResult {
  run: Run;
  findings: Finding[];
  unmapped: Array<{ engine: string; engineRule: string; count: number }>;
  hasAiFeatures: boolean;
  fileCount: number;
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

export async function runStaticScan(opts: StaticScanOptions): Promise<StaticScanResult> {
  const now = opts.now ?? new Date().toISOString();
  const runId = runIdFromTimestamp(now);

  const collection = await collectStatic({ cwd: opts.repoDir, property: opts.property });
  const artifacts: Artifact[] = collection.artifacts;

  // has-ai-features is derived from repo evidence, not human assertion.
  const tags = [...new Set([...(opts.tags ?? []), ...(collection.hasAiFeatures ? ['has-ai-features'] : [])])];

  // Engine a11y output -> findings (producer: engine).
  const engine = normalizeEngineArtifacts(artifacts, { runId, engineVersions: collection.engineVersions });

  // Our pure rules (inventories, etc.) -> findings (producer: rule).
  const raws = evaluate(artifacts, ALL_RULES, { property: opts.property, tags });
  const ruleFindings = resolveRuleFindings(raws, runId, opts.packageVersion);

  const findings = [...engine.findings, ...ruleFindings];

  const run: Run = {
    schemaVersion: 1,
    id: runId,
    property: opts.property,
    startedAt: now,
    finishedAt: new Date(now).toISOString(),
    versions: {
      package: opts.packageVersion,
      registry: REGISTRY_VERSION,
      engines: collection.engineVersions,
    },
    accessLevels: ['repo'],
    matrix: [],
    gaps: [],
    rulesExecuted: [...new Set(findings.map((f) => f.ruleId))],
  };

  return {
    run,
    findings,
    unmapped: engine.unmapped,
    hasAiFeatures: collection.hasAiFeatures,
    fileCount: collection.fileCount,
  };
}
