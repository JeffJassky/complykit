import { z } from 'zod';
import { RuleId, IsoDate } from './ids.js';
import { Subject, ConsentPhase, ViewportId, ColorScheme, Verdict } from './schema.js';

// Artifacts are what collectors emit and rules consume — the ONLY thing that
// crosses a stage boundary (package-structure.md). Heavy payloads live in
// evidence/ on disk (payloadPath); the artifact carries the structured slice a
// rule evaluates. Inner payload shapes (axe results, snapshot nodes, request
// logs) stay loose here and tighten as the collectors that emit them land.

const ArtifactBase = {
  subject: Subject,
  capturedAt: IsoDate,
  payloadPath: z.string().optional(),
};

// Loose inner shapes — a collector fills these; a rule reads them. Kept as
// permissive records until the emitting collector pins the exact structure.
const Loose = z.record(z.unknown());

export const Artifact = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('dom-snapshot'),
    ...ArtifactBase,
    nodes: z.array(Loose),
  }),
  z.object({
    kind: z.literal('axe-result'),
    ...ArtifactBase,
    results: Loose,
  }),
  z.object({
    kind: z.literal('static-scan'),
    ...ArtifactBase,
    engine: z.string(),
    results: z.array(Loose),
  }),
  z.object({
    // Computed-style probe output (contrast, target-size, …) — the collector
    // measures in-page; a pure rule evaluates the results. screenshotPath is the
    // full-page capture this probe was measured against, so a rule can attach a
    // croppable screenshot+region evidence for C1 adjudication (the DOM side
    // localizes; the model only judges the handed crop).
    kind: z.literal('style-probe'),
    ...ArtifactBase,
    check: z.string(),
    screenshotPath: z.string().optional(),
    results: z.array(Loose),
  }),
  z.object({
    kind: z.literal('inventory'),
    ...ArtifactBase,
    category: z.enum(['tracker', 'ai-framework', 'pii']),
    items: z.array(Loose),
  }),
  z.object({
    kind: z.literal('cookie-capture'),
    ...ArtifactBase,
    phase: ConsentPhase,
    cookies: z.array(Loose),
    storage: z.array(Loose),
  }),
  z.object({
    kind: z.literal('network-log'),
    ...ArtifactBase,
    phase: ConsentPhase,
    requests: z.array(Loose),
  }),
  z.object({
    kind: z.literal('consent-flow'),
    ...ArtifactBase,
    cmp: z.string().optional(),
    clicksToAccept: z.number().int(),
    clicksToReject: z.number().int().nullable(),
    buttonMetrics: z.array(Loose),
  }),
  z.object({
    kind: z.literal('focus-walk'),
    ...ArtifactBase,
    stops: z.array(Loose),
    traps: z.array(Loose),
  }),
  z.object({
    kind: z.literal('screenshot'),
    ...ArtifactBase,
    path: z.string(),
    viewport: ViewportId,
    scheme: ColorScheme,
    pageState: z.string().optional(),
  }),
  z.object({
    kind: z.literal('verdict'),
    ...ArtifactBase,
    ruleId: RuleId,
    cropHash: z.string(),
    result: Verdict,
    model: z.string(),
  }),
]);
export type Artifact = z.infer<typeof Artifact>;
export type ArtifactKind = Artifact['kind'];
