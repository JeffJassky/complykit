import { z } from 'zod';
import { resolveFinding, type Artifact, type Finding, type RunId, type Subject } from './record/index.js';
import { getEngineMapping, getRequirement } from './registry/index.js';
import { indexMeasuredContrast, matchMeasured, reconcileAxeContrast } from './contrast-reconcile.js';

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
  snippet: z.string().optional(),
  ordinal: z.number().int().default(0),
});

const AxeNode = z.object({
  target: z.array(z.string()).optional(),
  html: z.string().optional(),
  failureSummary: z.string().optional(),
  sourceFile: z.string().nullable().optional(), // Vue __file, when the dev runtime exposed it
  scopeId: z.string().nullable().optional(), // data-v style-scope hash fallback
  box: z
    .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
    .nullable()
    .optional(), // document-absolute geometry, for cross-collector matching
  // The element's visible text, captured post-run — a text-level finding quotes
  // what reads badly instead of only pointing at it.
  text: z.string().nullable().optional(),
  // CSS variables that resolve, on this element, to the judged colours.
  fgVars: z.array(z.string()).nullable().optional(),
  bgVars: z.array(z.string()).nullable().optional(),
  // axe's per-check results — the data blobs carry computed values (fg/bg
  // colours, ratios) that make the finding's evidence visual, not just prose.
  any: z.array(z.record(z.unknown())).default([]),
  all: z.array(z.record(z.unknown())).default([]),
});

// axe's computed colour data (color-contrast and friends): the exact
// foreground/background it judged, the ratio it calculated, and what was
// required — surfaced as structured evidence instead of staying buried in the
// failure-summary prose.
interface AxeColorData {
  fgColor: string;
  bgColor: string;
  contrastRatio?: number;
  expectedContrastRatio?: string;
  fontSize?: string;
  fontWeight?: string;
}

function axeColorData(node: z.infer<typeof AxeNode>): AxeColorData | undefined {
  for (const chk of [...node.any, ...node.all]) {
    const d = (chk as { data?: unknown }).data as Record<string, unknown> | undefined;
    if (d && typeof d.fgColor === 'string' && typeof d.bgColor === 'string') {
      return {
        fgColor: d.fgColor,
        bgColor: d.bgColor,
        contrastRatio: typeof d.contrastRatio === 'number' ? d.contrastRatio : undefined,
        expectedContrastRatio: typeof d.expectedContrastRatio === 'string' ? d.expectedContrastRatio : undefined,
        fontSize: typeof d.fontSize === 'string' ? d.fontSize : undefined,
        fontWeight: typeof d.fontWeight === 'string' ? d.fontWeight : undefined,
      };
    }
  }
  return undefined;
}
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
  /** How the pixel measurement overrode axe's inferred contrast verdicts. A
   *  suppressed finding must be COUNTED — an instrument that silently deletes
   *  its own output is one nobody can audit. */
  superseded: { cleared: number; upgraded: number; downgraded: number; ceded: number;
    /** axe contrast nodes we took no measurement for. A measurement pass that
     *  silently covers half the nodes is indistinguishable from one that covers
     *  all of them, so the miss is counted and reported. */
    unmatched: number };
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
    details?: unknown,
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
          details,
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

  // Pixel measurements from the same captures, so axe's cascade-inferred
  // contrast verdicts can be reconciled against what actually rendered.
  const measuredContrast = indexMeasuredContrast(artifacts);
  const superseded = { cleared: 0, upgraded: 0, downgraded: 0, ceded: 0, unmatched: 0 };

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
            locator: {
              role: 'element',
              // First line of the offending source, trimmed — a human-readable
              // handle for the element (e.g. `<div @click="...">`) shown next to
              // the file:line, so the finding names WHAT is wrong, not just where.
              name: item.snippet?.split('\n')[0]?.trim().slice(0, 100) || undefined,
              ordinal: item.ordinal,
            },
          },
          item.message,
          'violation',
          // The `file` evidence carries the real source line(s) with a caret, not
          // the rule message repeated — that's the element in context.
          [{ kind: 'file', path: item.file, line: item.line ?? 1, snippet: item.snippet ?? item.message }],
        );
      }
    } else if (artifact.kind === 'axe-result') {
      const parsed = AxeResults.safeParse(artifact.results);
      if (!parsed.success) continue;
      const engine = 'axe-core';
      const routeKey = artifact.subject.routePattern ?? artifact.subject.instanceUrl ?? '';
      const screenshotPath = artifact.screenshotPath;
      const handle = (rule: z.infer<typeof AxeRuleResult>, declaredConfidence: 'violation' | 'needs-review'): void => {
        for (const node of rule.nodes) {
          // Measurement beats inference: axe cannot resolve a background it
          // cannot walk to (overlap, gradient, image), and says so as
          // `incomplete`. Where our pixel-band read those same pixels, its
          // verdict governs — clearing, confirming, or re-grading this node.
          let confidence = declaredConfidence;
          let measuredNote = '';
          if (rule.id === 'color-contrast') {
            const match = matchMeasured(measuredContrast, artifact.subject, node.box);
            if (!match) superseded.unmatched++;
            const verdict = reconcileAxeContrast(match, confidence);
            if (verdict.action === 'drop') {
              if (verdict.reason.startsWith('non-flat')) superseded.ceded++;
              else superseded.cleared++;
              continue;
            }
            if (verdict.action === 'revise') {
              if (verdict.confidence === 'violation' && confidence === 'needs-review') superseded.upgraded++;
              else if (verdict.confidence === 'needs-review' && confidence === 'violation') superseded.downgraded++;
              confidence = verdict.confidence;
              measuredNote = verdict.note;
            }
          }
          const ordinal = nextOrdinal(`${engine}:${rule.id}:${routeKey}:${confidence}`);
          const message = (
            [rule.help, measuredNote || node.failureSummary].filter(Boolean).join(' — ') || rule.id
          ).slice(0, 300);
          // The element's crop out of the cell's full-page capture — the same
          // "show, don't tell" evidence the contrast rule carries.
          // Skip degenerate or page-sized boxes — a crop of everything shows nothing.
          const b = node.box;
          const cropWorthy = b && b.width > 0 && b.height > 0 && b.width * b.height <= 1_500_000;
          const cd = axeColorData(node);
          const swatches = cd
            ? [
                { label: 'text', color: cd.fgColor },
                { label: 'background', color: cd.bgColor, ratio: cd.contrastRatio },
              ]
            : undefined;
          const crop =
            screenshotPath && cropWorthy
              ? [{ kind: 'screenshot' as const, path: screenshotPath, region: b, swatches }]
              : [];
          // Structured computed values — text, colours, calculated vs required
          // ratio — mirroring the contrast rule's evidence block.
          const cstyle = cd
            ? [
                {
                  kind: 'computed-style' as const,
                  properties: {
                    ...(node.text ? { text: `"${node.text}"` } : {}),
                    color: cd.fgColor,
                    // The variable(s) behind the colour — a fix targets the
                    // token, not the literal.
                    ...(node.fgVars?.length ? { 'matching color vars': node.fgVars.map((v) => `var(${v})`).join(', ') } : {}),
                    background: cd.bgColor,
                    ...(node.bgVars?.length ? { 'matching bg color vars': node.bgVars.map((v) => `var(${v})`).join(', ') } : {}),
                    ...(cd.contrastRatio != null ? { ratio: String(cd.contrastRatio) } : {}),
                    ...(cd.expectedContrastRatio ? { required: cd.expectedContrastRatio } : {}),
                    ...(cd.fontSize ? { 'font-size': cd.fontSize } : {}),
                    ...(cd.fontWeight ? { 'font-weight': cd.fontWeight } : {}),
                  },
                },
              ]
            : [];
          emit(
            engine,
            rule.id,
            {
              property: artifact.subject.property,
              routePattern: artifact.subject.routePattern,
              instanceUrl: artifact.subject.instanceUrl,
              viewport: artifact.subject.viewport,
              colorScheme: artifact.subject.colorScheme,
              // axe's target IS a CSS selector — put it in the structured cssPath
              // (what an agent keys off) as well as the display name.
              locator: { role: 'element', name: node.target?.join(' '), cssPath: node.target?.join(' '), ordinal },
              // Source file from the framework runtime (Vue __file); raw path —
              // the pipeline relativizes it against the configured repo.
              file: node.sourceFile ? { path: node.sourceFile } : undefined,
            },
            message,
            confidence,
            [...(node.html ? [{ kind: 'dom-snippet' as const, html: node.html.slice(0, 400) }] : []), ...cstyle, ...crop],
            node.scopeId || node.box
              ? { ...(node.scopeId ? { vueScopeId: node.scopeId } : {}), ...(node.box ? { box: node.box } : {}) }
              : undefined,
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
  return { findings, unmapped, superseded };
}
