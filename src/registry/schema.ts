import { z } from 'zod';
import { RequirementId, InstrumentId, IsoDate, Severity } from './ids.js';

// Requirement + Instrument + engine-mapping schemas. Pure data, zod-validated
// in CI (registry-design.md). Entries live as typed TS literals — reviewable in
// PRs, greppable, no YAML-loader indirection.
//
// The executable Rule interface (RuleMeta, evaluate, consumes) is NOT here: it
// references record's EvidenceKind and ArtifactKind, and registry/ imports
// nothing internal. It lives in rules/, which may import both record and
// registry. Registry holds only the legal facts and the engine mapping tables.

export const ApplicabilityTag = z.string().min(1); // "targets-eu", "has-ai-features", …
export type ApplicabilityTag = z.infer<typeof ApplicabilityTag>;

export const VerifiedUrl = z.object({
  href: z.string().url(),
  verified: IsoDate.optional(),
  botBlocked: z.boolean().optional(),
});
export type VerifiedUrl = z.infer<typeof VerifiedUrl>;

// Citation shape varies per instrument family — a finding's type reads as its
// legal reference (README: "the citation is the type").
export const Citation = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('article'), // GDPR, AI Act
    article: z.number().int(),
    paragraph: z.number().int().optional(),
    point: z.string().optional(),
  }),
  z.object({
    kind: z.literal('sc'), // WCAG success criterion
    principle: z.number().int(),
    guideline: z.number().int(),
    sc: z.number().int(),
    level: z.enum(['A', 'AA', 'AAA']),
  }),
  z.object({
    kind: z.literal('clause'), // EN 301 549 "9.1.4.3"
    clause: z.string(),
  }),
  z.object({
    kind: z.literal('section'), // US code
    title: z.number().int(),
    section: z.string(),
  }),
]);
export type Citation = z.infer<typeof Citation>;

export const AuthorityRef = z.object({
  ref: z.string(),
  note: z.string().optional(),
});
export type AuthorityRef = z.infer<typeof AuthorityRef>;

export const Requirement = z.object({
  id: RequirementId,
  instrument: InstrumentId,
  citation: Citation,
  title: z.string().min(1),
  text: z.string(), // normative excerpt
  authority: z.array(AuthorityRef).optional(),
  urls: z.array(VerifiedUrl).default([]),
  effective: z.object({ from: IsoDate, until: IsoDate.optional() }),
  version: z.string().nullable().optional(), // WCAG "2.1" | "2.2"
  appliesIf: z.array(ApplicabilityTag).optional(),
  // Default guidance; a rule may narrow this, never raise it (see record/normalize).
  // Divergence recorded in plans/DIVERGENCES.md: types-sketch names this
  // `severity`, registry-design's prose example named it `severityGuidance`.
  // types-sketch (the types doc) wins; record/normalize consumes it as the
  // requirement default severity.
  severity: Severity,
  supersedes: RequirementId.optional(), // append-mostly: reinterpretation = new entry
  volatile: z.boolean().optional(), // recheck-each-release flag
});
export type Requirement = z.infer<typeof Requirement>;

export const RequirementFilter = z.object({
  version: z.string().optional(),
  maxLevel: z.enum(['A', 'AA', 'AAA']).optional(),
  idPrefix: z.string().optional(),
});
export type RequirementFilter = z.infer<typeof RequirementFilter>;

export const Instrument = z.object({
  id: InstrumentId,
  name: z.string(),
  jurisdiction: z.array(z.string()),
  textLicense: z.string(),
  incorporates: z
    .array(z.object({ instrument: InstrumentId, filter: RequirementFilter }))
    .optional(),
});
export type Instrument = z.infer<typeof Instrument>;

// External engines (axe, jsx-a11y, equal-access) map IN — the registry holds
// mapping tables, not re-encodings. Unmapped engine rules fail CI (verify.ts).
export const EngineRuleMapping = z.object({
  engine: z.string(), // "axe-core"
  engineVersion: z.string(), // pinned; unmapped-on-upgrade breaks CI
  engineRule: z.string(), // "color-contrast"
  requirements: z.array(RequirementId).min(1),
  confidence: z.enum(['violation', 'needs-review']),
});
export type EngineRuleMapping = z.infer<typeof EngineRuleMapping>;
