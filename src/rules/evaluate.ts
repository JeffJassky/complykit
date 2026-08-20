import type { Artifact, ArtifactKind, RawFinding } from '../record/index.js';
import type { AnyRule, Rule, EvalContext, PropertyContext } from './types.js';
import { isLlmRule } from './types.js';

// The pure evaluation stage. Deterministic rules only — llm rules are executed
// by judge/, which emits verdict artifacts a built-in rule then evaluates like
// any other. Grouping artifacts by kind is the whole contract: a rule receives
// values, never a live collector (ArtifactsOf<K> makes the alternative a type
// error).

function groupByKind(artifacts: Artifact[]): Record<ArtifactKind, Artifact[]> {
  const groups = {} as Record<ArtifactKind, Artifact[]>;
  for (const a of artifacts) {
    (groups[a.kind] ??= []).push(a);
  }
  return groups;
}

/** Run every applicable deterministic rule over the artifacts. Pure. */
export function evaluate(
  artifacts: Artifact[],
  rules: AnyRule[],
  ctx: EvalContext & { tags?: string[] },
): RawFinding[] {
  const groups = groupByKind(artifacts);
  const propertyCtx: PropertyContext = { property: ctx.property, tags: ctx.tags ?? [] };
  const out: RawFinding[] = [];

  for (const rule of rules) {
    if (isLlmRule(rule)) continue; // judge/ runs these
    const det = rule as Rule<readonly ArtifactKind[]>;
    if (det.applies && !det.applies(propertyCtx)) continue;
    // Only run when at least one consumed kind is present, and hand the rule a
    // slice for every kind it declared (empty arrays for absent kinds).
    const input = {} as Record<ArtifactKind, Artifact[]>;
    let anyPresent = false;
    for (const kind of det.consumes) {
      const slice = groups[kind] ?? [];
      input[kind] = slice;
      if (slice.length) anyPresent = true;
    }
    if (!anyPresent && det.detects === 'presence') continue; // nothing to inspect
    out.push(...det.evaluate(input as never, ctx));
  }
  return out;
}
