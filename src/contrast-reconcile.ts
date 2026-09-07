import type { Artifact, Subject } from './record/index.js';

// Measured pixels outrank inferred colours (WCAG 1.4.3).
//
// axe computes contrast by walking the cascade. When something overlaps the
// text, or the background is an image/gradient, that walk cannot prove a colour
// and axe reports `incomplete` — "background color could not be determined
// because it is overlapped by another element". That is an INFERENCE FAILURE,
// not evidence of low contrast: the rendered pixels may read at 12:1.
//
// Our pixel-band pass already measures those exact pixels off the cell's
// screenshot (see collect/browser/pixel-band.ts). This module lets that
// measurement decide the axe finding's fate:
//
//   non-flat stack   -> drop; `contrast.text` owns non-flat and already reported
//   measured pass    -> the pixels clear the threshold. An axe `incomplete`
//                       becomes nothing; an axe `violation` (two methods
//                       disagreeing) drops to needs-review carrying both numbers
//   measured fail    -> violation, stated with the measured range
//   none             -> unchanged; nothing was measured, and the run says so as a gap
//
// Matching is geometric, not by selector: axe's `target` selector and our
// cssPath heuristic are different strings for the same element, but both boxes
// are document-absolute against the same capture.

export interface MeasuredContrast {
  box: { x: number; y: number; width: number; height: number };
  flat: boolean;
  /** An ancestor's overflow clips this element away: it lays out, but nothing
   *  of it is painted. */
  clipped?: boolean;
  measuredBand?: 'pass' | 'fail' | 'ambiguous';
  minRatio?: number;
  maxRatio?: number;
  required: number;
}

export type MeasuredIndex = Map<string, MeasuredContrast[]>;

/** Cell key — a measurement only speaks for the render it was taken from. */
export function cellKey(subject: Pick<Subject, 'routePattern' | 'instanceUrl' | 'viewport' | 'colorScheme'>): string {
  return [subject.routePattern ?? subject.instanceUrl ?? '', subject.viewport ?? '', subject.colorScheme ?? ''].join('|');
}

/** Collect every contrast candidate that carries a box, keyed by cell. */
export function indexMeasuredContrast(artifacts: Artifact[]): MeasuredIndex {
  const index: MeasuredIndex = new Map();
  for (const artifact of artifacts) {
    if (artifact.kind !== 'style-probe' || artifact.check !== 'contrast') continue;
    const key = cellKey(artifact.subject);
    const bucket = index.get(key) ?? [];
    for (const raw of artifact.results as Array<Record<string, unknown>>) {
      const box = raw.box as MeasuredContrast['box'] | undefined;
      if (!box || typeof box.x !== 'number' || !(box.width > 0) || !(box.height > 0)) continue;
      bucket.push({
        box,
        flat: raw.flat === true,
        clipped: raw.clipped === true,
        measuredBand: raw.measuredBand as MeasuredContrast['measuredBand'],
        minRatio: typeof raw.minRatio === 'number' ? raw.minRatio : undefined,
        maxRatio: typeof raw.maxRatio === 'number' ? raw.maxRatio : undefined,
        required: typeof raw.required === 'number' ? raw.required : 4.5,
      });
    }
    index.set(key, bucket);
  }
  return index;
}

/**
 * The measurement for the same element, if we took one. Same-element means the
 * boxes essentially coincide: centres within 2px and each dimension within 2px.
 * A loose match would let a parent's measurement speak for its child, which is
 * exactly the confusion (element vs the thing overlapping it) this resolves.
 */
export function matchMeasured(
  index: MeasuredIndex,
  subject: Pick<Subject, 'routePattern' | 'instanceUrl' | 'viewport' | 'colorScheme'>,
  box: MeasuredContrast['box'] | null | undefined,
): MeasuredContrast | undefined {
  if (!box) return undefined;
  const bucket = index.get(cellKey(subject));
  if (!bucket) return undefined;
  const TOL = 2;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  let best: MeasuredContrast | undefined;
  let bestDist = Infinity;
  for (const m of bucket) {
    if (Math.abs(m.box.width - box.width) > TOL || Math.abs(m.box.height - box.height) > TOL) continue;
    const dist = Math.hypot(m.box.x + m.box.width / 2 - cx, m.box.y + m.box.height / 2 - cy);
    if (dist <= TOL && dist < bestDist) {
      best = m;
      bestDist = dist;
    }
  }
  return best;
}

export type Reconciliation =
  | { action: 'drop'; reason: string }
  | { action: 'keep' }
  | { action: 'revise'; confidence: 'violation' | 'needs-review'; note: string };

/** Apply the precedence above to one axe color-contrast node. */
export function reconcileAxeContrast(
  measured: MeasuredContrast | undefined,
  axeConfidence: 'violation' | 'needs-review',
): Reconciliation {
  if (!measured) return { action: 'keep' };
  // Nothing of this element is drawn — an ancestor's overflow clips it away. A
  // contrast ratio for text no one can see is not a finding; whether hiding it
  // that way is itself a problem is a different rule's question.
  if (measured.clipped) {
    return { action: 'drop', reason: 'clipped out by an ancestor’s overflow — not painted' };
  }
  if (!measured.flat) return { action: 'drop', reason: 'non-flat background — contrast.text owns this element' };
  if (!measured.measuredBand) return { action: 'keep' };

  const range = `${measured.minRatio ?? '?'}–${measured.maxRatio ?? '?'}:1 (needs ${measured.required}:1)`;
  if (measured.measuredBand === 'pass') {
    if (axeConfidence === 'needs-review') {
      return { action: 'drop', reason: `pixel-measured ${range} — the rendered text clears the threshold` };
    }
    return {
      action: 'revise',
      confidence: 'needs-review',
      note: `axe inferred a failing ratio from the cascade, but the rendered pixels measure ${range} — confirm visually`,
    };
  }
  // 'fail' — and 'ambiguous' from runs recorded before the worst-pixel rule,
  // which meant part of the text failed, and part failing is failing.
  return { action: 'revise', confidence: 'violation', note: `pixel-measured ${range}; the worst pixel governs` };
}
