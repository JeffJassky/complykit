import { z } from 'zod';
import { resolveFinding, type Artifact, type Finding, type RunId } from './record/index.js';
import { getEngineMapping, getRequirement } from './registry/index.js';

// Engine normalization: turn `static-scan` artifacts (raw a11y-linter output)
// into canonical Findings with `producer: engine`. This is NOT a rule — engine
// findings are "axe said" / "eslint said", not our own evaluator — but it must
// live where both record and registry are importable, which a collector is not
// (dependency law). A top-level module fits: it maps data, imports no heavy dep.
//
// A rule the installed engine reports but the registry does not map is returned
// as `unmapped` so the caller records a coverage gap — the runtime side of the
// build-time exhaustiveness gate.

const StaticScanItem = z.object({
  engineRule: z.string(),
  file: z.string(),
  line: z.number().int().optional(),
  column: z.number().int().optional(),
  message: z.string(),
  ordinal: z.number().int().default(0),
});

export interface NormalizeEngineOptions {
  runId: RunId;
  engineVersions?: Record<string, string>;
}

export interface EngineNormalization {
  findings: Finding[];
  unmapped: Array<{ engine: string; engineRule: string; count: number }>;
}

export function normalizeEngineArtifacts(
  artifacts: Artifact[],
  opts: NormalizeEngineOptions,
): EngineNormalization {
  const findings: Finding[] = [];
  const unmappedCounts = new Map<string, number>();

  for (const artifact of artifacts) {
    if (artifact.kind !== 'static-scan') continue;
    const engine = artifact.engine;
    const version = opts.engineVersions?.[engine] ?? 'unknown';

    for (const rawItem of artifact.results) {
      const parsed = StaticScanItem.safeParse(rawItem);
      if (!parsed.success) continue;
      const item = parsed.data;

      const mapping = getEngineMapping(engine, item.engineRule);
      if (!mapping) {
        const key = `${engine}::${item.engineRule}`;
        unmappedCounts.set(key, (unmappedCounts.get(key) ?? 0) + 1);
        continue;
      }
      const requirementId = mapping.requirements[0];
      const requirement = getRequirement(String(requirementId));
      if (!requirement) continue; // verify.ts prevents this; guard anyway.

      const finding = resolveFinding(
        {
          ruleId: `${engine}:${item.engineRule}`,
          requirementId,
          subject: {
            property: artifact.subject.property,
            file: { path: item.file, line: item.line },
            // Ordinal anchor so two same-rule findings in one file stay distinct;
            // role is generic since the linter does not hand us the element role.
            locator: { role: 'element', ordinal: item.ordinal },
          },
          confidence: mapping.confidence,
          message: item.message,
          evidence: [{ kind: 'file', path: item.file, line: item.line ?? 1, snippet: item.message }],
        },
        {
          caps: {
            detects: 'presence',
            maxConfidence: mapping.confidence,
            requirementSeverity: requirement.severity,
            ruleRequirements: mapping.requirements,
          },
          runId: opts.runId,
          producer: { type: 'engine', name: engine, version },
        },
      );
      findings.push(finding);
    }
  }

  const unmapped = [...unmappedCounts.entries()].map(([key, count]) => {
    const [engine, engineRule] = key.split('::');
    return { engine, engineRule, count };
  });
  return { findings, unmapped };
}
