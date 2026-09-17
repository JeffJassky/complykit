import { z } from 'zod';
import type { Artifact, Subject } from './record/index.js';

// Measured pixels outrank inferred colours (WCAG 1.4.3).
//
// axe computes contrast by walking the cascade. When something overlaps the
// text, or the background is an image/gradient, that walk cannot prove a colour
// and axe reports `incomplete` — "background color could not be determined
// because it is overlapped by another element". That is an INFERENCE FAILURE,
// not evidence of low contrast: the rendered pixels may read at 12:1. And when
// axe DOES report a flat-colour violation, it is still only inference over the
// cascade — the glyph-mask measurement is ground truth for what a reader sees.
//
// The glyph-mask walk (glyph-measure.ts) measures every text subject on the
// page directly off the pixels, not just axe's targets. Wave 3 resolves each
// axe `color-contrast` node's element (and its text-owning descendants) to a
// list of `measureRefs`; this module looks those refs up against the
// MeasuredSubject index and settles the node:
//
//   any measured subject among measureRefs -> drop the node. `contrast.text`
//     is the SINGLE reporter for that element, whatever the measurement found
//     (pass = nothing to report; fail = contrast.text already reports it with
//     the measured range) — axe would otherwise duplicate or contradict it.
//   no measured subject (unmatched, or all still unmeasured) -> keep the node
//     exactly as axe declared it; the run's `contrast-unmeasured` coverage gap
//     already says why.
//
// Matching is by ref, not geometry: refs are page-side identities assigned by
// `__ck.register`, stable within one page load — the geometric box-matching
// this module used before (a) required both collectors to agree on a boxing
// convention and (b) still confused an element with whatever overlapped it,
// which is exactly the bug measurement was supposed to fix.

const MeasuredSubjectShape = z.object({
  ref: z.number(),
  status: z.enum(['measured', 'unmeasured']),
  verdict: z.enum(['pass', 'fail']).optional(),
  flat: z.boolean(),
  fgSource: z.enum(['css', 'rendered']).optional(),
  ratio: z.number().optional(),
  minRatio: z.number().optional(),
  medianRatio: z.number().optional(),
  maxRatio: z.number().optional(),
});
/** The subset of glyph-measure.ts's `MeasuredSubject` this module needs — kept
 *  loose (safeParse, extra fields ignored) so it never breaks when Wave 2's
 *  contract grows a field this reconciliation doesn't care about. */
export type MeasuredSubject = z.infer<typeof MeasuredSubjectShape>;

export type MeasuredIndex = Map<string, MeasuredSubject[]>;

/** Cell key — a measurement only speaks for the render it was taken from. */
export function cellKey(subject: Pick<Subject, 'routePattern' | 'instanceUrl' | 'viewport' | 'colorScheme'>): string {
  return [subject.routePattern ?? subject.instanceUrl ?? '', subject.viewport ?? '', subject.colorScheme ?? ''].join('|');
}

/** Collect every contrast subject (measured or not) from the style-probe
 *  artifacts, keyed by cell. */
export function indexMeasuredSubjects(artifacts: Artifact[]): MeasuredIndex {
  const index: MeasuredIndex = new Map();
  for (const artifact of artifacts) {
    if (artifact.kind !== 'style-probe' || artifact.check !== 'contrast') continue;
    const key = cellKey(artifact.subject);
    const bucket = index.get(key) ?? [];
    for (const raw of artifact.results as unknown[]) {
      const parsed = MeasuredSubjectShape.safeParse(raw);
      if (!parsed.success) continue; // old-shape (no `status`) result — not this pass's business
      bucket.push(parsed.data);
    }
    index.set(key, bucket);
  }
  return index;
}

export interface AxeContrastNode {
  /** For the disagreement example — axe's own selector string for the node. */
  selector: string;
  /** From `resolveAxeTargets`: the element's ref plus every text-owning
   *  descendant's ref. Missing/empty = axe's node couldn't be resolved to a
   *  page-side identity (e.g. a stale selector) — never matches. */
  measureRefs?: number[] | null;
  /** axe's own computed ratio for this node, when its check data carried one —
   *  used only to detect and record a disagreement, never to decide drop/keep. */
  axeRatio?: number;
}

export interface ContrastDisagreement {
  selector: string;
  axe: number;
  measured: number;
}

export type ContrastSettlement =
  | { action: 'drop'; disagreement?: ContrastDisagreement }
  | { action: 'keep' };

/**
 * Settle one axe `color-contrast` node against the glyph-mask measurements of
 * the same page cell. See the module comment for the precedence.
 */
export function settleAxeContrastNode(
  index: MeasuredIndex,
  subject: Pick<Subject, 'routePattern' | 'instanceUrl' | 'viewport' | 'colorScheme'>,
  node: AxeContrastNode,
): ContrastSettlement {
  const refs = node.measureRefs;
  if (!refs || refs.length === 0) return { action: 'keep' };
  const bucket = index.get(cellKey(subject));
  if (!bucket || bucket.length === 0) return { action: 'keep' };
  const refSet = new Set(refs);
  const matched = bucket.filter((m) => refSet.has(m.ref));
  const measured = matched.filter((m) => m.status === 'measured');
  if (measured.length === 0) return { action: 'keep' };

  // A disagreement is diagnostic, not a decision: axe's own flat-stack ratio
  // vs our measured median, when both exist for the same (flat, CSS-colour)
  // subject and differ by more than rounding — worth surfacing, never worth
  // keeping the node over (the glyph mask is ground truth either way).
  let disagreement: ContrastDisagreement | undefined;
  if (node.axeRatio != null) {
    for (const m of measured) {
      if (m.flat && m.fgSource === 'css' && m.medianRatio != null && Math.abs(node.axeRatio - m.medianRatio) > 0.1) {
        disagreement = { selector: node.selector, axe: node.axeRatio, measured: m.medianRatio };
        break;
      }
    }
  }
  return { action: 'drop', disagreement };
}
