import { z } from 'zod';
import { RequirementId, RuleId, Fingerprint, RunId, IsoDate } from './ids.js';

// Record shapes are zod schemas with inferred types (types-sketch.md): they
// cross process boundaries — agents write via `complykit finding add`, runs are
// read back from disk — so they must validate at runtime, not only compile-time.
// The published contract in types/ mirrors these; types/test-d.ts asserts the
// two are mutually assignable, which is the drift check (traps #21 by another
// mechanism: a zod-first package can't import its runtime shapes FROM types/).

/** Bumped only on a breaking record change; renderers refuse a newer major. */
export const SCHEMA_VERSION = 1;

export const Severity = z.enum(['critical', 'serious', 'moderate', 'minor']);
export type Severity = z.infer<typeof Severity>;

// severity ordering, high → low, for narrows-never-raises checks.
const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  serious: 1,
  moderate: 2,
  minor: 3,
};
/** True if `narrowed` is the same or lower severity than `base` (never raises). */
export function severityNarrows(base: Severity, narrowed: Severity): boolean {
  return SEVERITY_RANK[narrowed] >= SEVERITY_RANK[base];
}

export const Confidence = z.enum(['violation', 'needs-review']);
export type Confidence = z.infer<typeof Confidence>;

export const ConsentPhase = z.enum(['pre-consent', 'post-reject', 'post-accept']);
export type ConsentPhase = z.infer<typeof ConsentPhase>;

export const ColorScheme = z.enum(['light', 'dark']);
export type ColorScheme = z.infer<typeof ColorScheme>;

export const ViewportId = z.string().min(1); // "mobile" | "tablet" | "desktop" | custom
export type ViewportId = z.infer<typeof ViewportId>;

export const VerdictValue = z.enum(['violation', 'pass', 'unclear']);
export type VerdictValue = z.infer<typeof VerdictValue>;

export const AccessLevel = z.enum(['public', 'authed', 'repo', 'infra']);
export type AccessLevel = z.infer<typeof AccessLevel>;

export const Box = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
export type Box = z.infer<typeof Box>;

// --- Subject + structural locator ------------------------------------------

export const StructuralLocator = z.object({
  role: z.string(), // "button"
  name: z.string().optional(), // accessible name
  landmark: z.string().optional(), // "banner", "main"
  ordinal: z.number().int().nonnegative(), // nth match within landmark
  cssPath: z.string().optional(), // debugging evidence ONLY — never hashed
});
export type StructuralLocator = z.infer<typeof StructuralLocator>;

export const Subject = z.object({
  property: z.string(),
  // exactly one locus (presence findings); absence findings carry neither:
  routePattern: z.string().optional(), // "/product/:id" — never the instance URL
  file: z
    .object({ path: z.string(), line: z.number().int().optional() })
    .optional(),
  // refinement (browser findings) — evidence, never identity:
  instanceUrl: z.string().optional(),
  state: z.string().optional(), // interaction-state id ("nav-open")
  viewport: ViewportId.optional(),
  colorScheme: ColorScheme.optional(),
  locator: StructuralLocator.optional(),
});
export type Subject = z.infer<typeof Subject>;

// --- Evidence (discriminated union) ----------------------------------------

export const Evidence = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('screenshot'),
    path: z.string(),
    region: Box.optional(),
    pageState: z.string().optional(),
  }),
  z.object({
    kind: z.literal('dom-snippet'),
    html: z.string(),
    locator: StructuralLocator.optional(),
  }),
  z.object({
    kind: z.literal('computed-style'),
    properties: z.record(z.string()),
  }),
  z.object({
    kind: z.literal('network-request'),
    url: z.string(),
    initiatorChain: z.array(z.string()),
    phase: ConsentPhase.optional(),
    resourceType: z.string().optional(),
  }),
  z.object({
    kind: z.literal('cookie'),
    name: z.string(),
    domain: z.string(),
    phase: ConsentPhase,
    flags: z.object({
      secure: z.boolean(),
      httpOnly: z.boolean(),
      sameSite: z.string().optional(),
    }),
    classification: z.string().optional(),
  }),
  z.object({
    kind: z.literal('file'),
    path: z.string(),
    line: z.number().int(),
    snippet: z.string(),
  }),
  z.object({
    kind: z.literal('interaction-log'),
    steps: z.array(z.record(z.unknown())),
  }),
  z.object({
    kind: z.literal('verdict'),
    model: z.string(),
    rubricVersion: z.string(),
    cropPath: z.string(),
    verdict: VerdictValue,
    reason: z.string(),
  }),
]);
export type Evidence = z.infer<typeof Evidence>;
export type EvidenceKind = Evidence['kind'];

// --- Producer ---------------------------------------------------------------

export const Producer = z.discriminatedUnion('type', [
  z.object({ type: z.literal('engine'), name: z.string(), version: z.string() }),
  z.object({ type: z.literal('rule'), packageVersion: z.string() }),
  z.object({ type: z.literal('agent'), model: z.string(), rubricVersion: z.string() }),
]);
export type Producer = z.infer<typeof Producer>;

// --- Finding ----------------------------------------------------------------

export const RawFinding = z.object({
  ruleId: RuleId,
  requirementId: RequirementId, // must be one of the rule's requirements
  subject: Subject,
  confidence: Confidence, // <= rule's declared max (enforced at normalization)
  message: z.string().min(1), // one sentence, human-first
  details: z.unknown().optional(), // unconstrained blob (thin-schema decision)
  evidence: z.array(Evidence).default([]),
});
export type RawFinding = z.infer<typeof RawFinding>;

export const Finding = RawFinding.extend({
  schemaVersion: z.number().int().default(SCHEMA_VERSION),
  fingerprint: Fingerprint,
  severity: Severity, // resolved: rule narrow ?? requirement default
  producer: Producer,
  runId: RunId,
});
export type Finding = z.infer<typeof Finding>;

// --- Verdict (C1 structured output) ----------------------------------------

export const Verdict = z.object({
  verdict: VerdictValue,
  requirementId: RequirementId, // constrained to the rule under test
  reason: z.string(),
  leads: z
    .array(z.object({ mark: z.number().int(), suspicion: z.string() }))
    .optional(), // sweep only → adjudication queue
});
export type Verdict = z.infer<typeof Verdict>;

// --- Run + coverage + disposition ------------------------------------------

export const MatrixCell = z.object({
  family: z.enum(['passive', 'probes', 'evidence', 'sweep']),
  routePatterns: z.number().int(),
  instances: z.number().int(),
  viewports: z.array(ViewportId),
  schemes: z.array(ColorScheme),
  states: z.number().int(),
});
export type MatrixCell = z.infer<typeof MatrixCell>;

export const CoverageGap = z.object({
  reason: z.enum([
    'cross-origin-iframe',
    'closed-shadow-root',
    'page-timeout',
    'bot-blocked',
    'scroll-cap',
    'no-key',
    'crash',
  ]),
  subject: Subject,
  note: z.string().optional(),
});
export type CoverageGap = z.infer<typeof CoverageGap>;

export const Run = z.object({
  schemaVersion: z.number().int().default(SCHEMA_VERSION),
  id: RunId,
  property: z.string(),
  startedAt: IsoDate,
  finishedAt: IsoDate.optional(),
  versions: z.object({
    package: z.string(),
    registry: z.string(), // stamped — findings mean what this version meant
    engines: z.record(z.string()).default({}),
    models: z.record(z.string()).optional(),
  }),
  gitSha: z.string().optional(),
  accessLevels: z.array(AccessLevel).default([]), // exercised, not configured
  matrix: z.array(MatrixCell).default([]),
  gaps: z.array(CoverageGap).default([]),
  rulesExecuted: z.array(RuleId).default([]),
});
export type Run = z.infer<typeof Run>;

export const Disposition = z.object({
  fingerprint: Fingerprint,
  status: z.enum(['open', 'fixed', 'accepted-risk', 'false-positive', 'wont-fix']),
  by: z.string(),
  at: IsoDate,
  why: z.string(),
});
export type Disposition = z.infer<typeof Disposition>;
