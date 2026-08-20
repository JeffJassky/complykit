import type { Artifact, ArtifactKind, RawFinding, EvidenceKind, Severity, Confidence } from '../record/index.js';
import type { RequirementId, RuleId, ApplicabilityTag } from '../registry/index.js';

// The executable rule interfaces. rules/ may import record + registry (never a
// collector — that boundary is dependency-cruiser-enforced). The `consumes`
// tuple TYPES the evaluator's input, which is the compile-time proof that a
// rule never touches a live page: an evaluator asking for a Playwright handle
// has no artifact kind to ask through.

/** Metadata uniform across layers. */
export interface RuleMeta {
  id: RuleId;
  requirements: [RequirementId, ...RequirementId[]]; // >=1 legal hook
  layer: 'static' | 'browser' | 'llm';
  confidence: Confidence; // the MAX this rule may assert
  detects: 'presence' | 'absence'; // absence → fingerprint on requirement+subject
  severity?: Severity; // narrows the requirement default only, never raises
  evidence: EvidenceKind[]; // kinds evaluate() MUST attach
  remediation: string;
  falsePositives?: string;
}

/** Map an artifact-kind tuple to the shape the evaluator receives. */
export type ArtifactsOf<K extends readonly ArtifactKind[]> = {
  [P in K[number]]: Extract<Artifact, { kind: P }>[];
};

export interface PropertyContext {
  property: string;
  tags: ApplicabilityTag[];
}

export interface EvalContext {
  property: string;
}

/** A deterministic rule: pure `(artifacts) => RawFinding[]`. */
export interface Rule<K extends readonly ArtifactKind[] = readonly ArtifactKind[]>
  extends RuleMeta {
  consumes: K;
  applies?(ctx: PropertyContext): boolean;
  evaluate(input: ArtifactsOf<K>, ctx: EvalContext): RawFinding[];
}

/** An LLM rule: the implementation IS data. judge/ executes these; a built-in
 *  rule converts the resulting verdict artifacts into findings. */
export interface LlmRule extends RuleMeta {
  layer: 'llm';
  mode: 'adjudicate' | 'sweep';
  rubric: string; // prompt template
  rubricVersion: string; // part of the verdict cache key
  schemeSensitive?: boolean;
  escalation?: 'cheap-first' | 'strong-only';
}

export type AnyRule = Rule<readonly ArtifactKind[]> | LlmRule;

export function isLlmRule(rule: AnyRule): rule is LlmRule {
  return rule.layer === 'llm';
}
