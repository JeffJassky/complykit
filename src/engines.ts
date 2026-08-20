import { z } from 'zod';
import { resolveFinding, type Artifact, type Finding, type RunId, type Subject } from './record/index.js';
import { getEngineMapping, getRequirement } from './registry/index.js';

// Engine normalization: turn engine-output artifacts (a11y-linter `static-scan`,
// axe `axe-result`) into canonical Findings with `producer: engine` — "eslint
// said" / "axe said", not our own evaluator. Lives where both record and
// registry are importable, which a collector is not (dependency law). A rule the
// installed engine reports but the registry does not map is returned as
// `unmapped` so the caller records a coverage gap — the runtime side of the
// build-time exhaustiveness gate.

const StaticScanItem = z.object({
  engineRule: z.string(),
  file: z.string(),
  line: z.number().int().optional(),
  column: z.number().int().optional(),
  message: z.string(),
  ordinal: z.number().int().default(0),
});

const AxeNode = z.object({
  target: z.array(z.string()).optional(),
  html: z.string().optional(),
  failureSummary: z.string().optional(),
});
const AxeRuleResult = z.object({
  id: z.string(),
  help: z.string().optional(),
  nodes: z.array(AxeNode).default([]),
});
const AxeResults = z.object({
  violations: z.array(AxeRuleResult).default([]),
  incomplete: z.array(AxeRuleResult).default([]),
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
  // ordinal per (engine, rule, routePattern|file) so repeated hits stay distinct.
  const ordinals = new Map<string, number>();

  const emit = (
    engine: string,
    engineRule: string,
    subject: Subject,
    message: string,
    confidence: 'violation' | 'needs-review',
    evidence: Finding['evidence'],
  ): void => {
    const mapping = getEngineMapping(engine, engineRule);
    if (!mapping) {
      const key = `${engine}::${engineRule}`;
      unmappedCounts.set(key, (unmappedCounts.get(key) ?? 0) + 1);
      return;
    }
    const requirementId = mapping.requirements[0];
    const requirement = getRequirement(String(requirementId));
    if (!requirement) return;
    findings.push(
      resolveFinding(
        {
          ruleId: `${engine}:${engineRule}`,
          requirementId,
          subject,
          confidence,
          message,
          evidence,
        },
        {
          caps: {
            detects: 'presence',
            maxConfidence: mapping.confidence,
            requirementSeverity: requirement.severity,
            ruleRequirements: mapping.requirements,
          },
          runId: opts.runId,
          producer: { type: 'engine', name: engine, version: opts.engineVersions?.[engine] ?? 'unknown' },
        },
      ),
    );
  };

  const nextOrdinal = (key: string): number => {
    const n = ordinals.get(key) ?? 0;
    ordinals.set(key, n + 1);
    return n;
  };

  for (const artifact of artifacts) {
    if (artifact.kind === 'static-scan') {
      const engine = artifact.engine;
      for (const rawItem of artifact.results) {
        const parsed = StaticScanItem.safeParse(rawItem);
        if (!parsed.success) continue;
        const item = parsed.data;
        emit(
          engine,
          item.engineRule,
          {
            property: artifact.subject.property,
            file: { path: item.file, line: item.line },
            locator: { role: 'element', ordinal: item.ordinal },
          },
          item.message,
          'violation',
          [{ kind: 'file', path: item.file, line: item.line ?? 1, snippet: item.message }],
        );
      }
    } else if (artifact.kind === 'axe-result') {
      const parsed = AxeResults.safeParse(artifact.results);
      if (!parsed.success) continue;
      const engine = 'axe-core';
      const routeKey = artifact.subject.routePattern ?? artifact.subject.instanceUrl ?? '';
      const handle = (rule: z.infer<typeof AxeRuleResult>, confidence: 'violation' | 'needs-review'): void => {
        for (const node of rule.nodes) {
          const ordinal = nextOrdinal(`${engine}:${rule.id}:${routeKey}:${confidence}`);
          const message = [rule.help, node.failureSummary].filter(Boolean).join(' — ').slice(0, 300) || rule.id;
          emit(
            engine,
            rule.id,
            {
              property: artifact.subject.property,
              routePattern: artifact.subject.routePattern,
              instanceUrl: artifact.subject.instanceUrl,
              viewport: artifact.subject.viewport,
              colorScheme: artifact.subject.colorScheme,
              locator: { role: 'element', name: node.target?.join(' '), ordinal },
            },
            message,
            confidence,
            node.html ? [{ kind: 'dom-snippet', html: node.html.slice(0, 400) }] : [],
          );
        }
      };
      for (const rule of parsed.data.violations) handle(rule, 'violation');
      for (const rule of parsed.data.incomplete) handle(rule, 'needs-review');
    }
  }

  const unmapped = [...unmappedCounts.entries()].map(([key, count]) => {
    const [engine, engineRule] = key.split('::');
    return { engine, engineRule, count };
  });
  return { findings, unmapped };
}
