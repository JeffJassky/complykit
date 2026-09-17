import type { Finding, Artifact } from '../record/index.js';

// Signal fusion (the "combined intelligence" pass): several producers look at
// the same element, and a measurement must beat a shrug. The evidence hierarchy:
//
//   measured   (a probe physically measured the element — pixel-band, a walk)
//   computed   (deterministic math over the cascade/DOM — axe flat contrast)
//   heuristic  (an engine flagged "could not determine" / needs-review)
//
// The rule: a needs-review finding is DROPPED when a measurement-grade provider
// physically measured that same element (same page cell, same geometry) for the
// same requirement — whatever the measurement said. Measured-pass ⇒ the flag is
// a false alarm; measured-fail/ambiguous ⇒ the provider's own rule already
// reports it with the measurement attached, so the flag is a duplicate.
//
// NOTE: axe's `color-contrast` no longer reaches this pass — engines.ts settles
// it earlier against the same glyph-mask measurements (contrast-reconcile.ts):
// any measured subject drops the axe node outright, because `contrast.text` is
// the single reporter for a measured element (fail is already reported there;
// pass has nothing to report). This pass remains the general rule for every
// other producer's shrug.
//
// What NEVER supersedes: absence of evidence. A page state that simply wasn't
// rendered, an element the probe never reached — those keep their heuristic
// findings. Only a positive measurement of the specific element clears it.
// Violations (confidence 'violation') are never suppressed either — a
// deterministic computation is not a shrug.
//
// Matching is geometric: producers' selectors come from different generators,
// but all collectors record document-absolute boxes on the same page load. Same
// element ⇒ near-identical box; centre-containment either way tolerates
// text-node/parent disagreement.
//
// Providers are the extension point: each declares which requirements its
// measurement can clear and extracts the measured geometry per page cell from
// the run's artifacts. Today glyph-mask contrast is the only one; a future
// focus-screenshot differ or target-size prober plugs in beside it.

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function centerIn(a: Box, b: Box): boolean {
  const cx = a.x + a.width / 2;
  const cy = a.y + a.height / 2;
  return cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height;
}

function sameElement(a: Box, b: Box): boolean {
  return centerIn(a, b) && centerIn(b, a);
}

/** Cell key: one page load = one geometry space. */
function cellKey(s: { instanceUrl?: string; routePattern?: string; viewport?: string; colorScheme?: string }): string {
  return `${s.instanceUrl ?? s.routePattern ?? ''}|${s.viewport ?? ''}|${s.colorScheme ?? ''}`;
}

export interface MeasurementProvider {
  id: string;
  /** Requirements this measurement can clear a needs-review flag for. */
  requirements: readonly string[];
  /** Rules that REPORT this provider's own measurements — never suppressed by it. */
  ownRules: readonly string[];
  /** Document-absolute boxes of the elements physically measured, per page cell. */
  measured(artifacts: Artifact[]): Map<string, Box[]>;
}

/** Glyph-mask contrast: the collector's glyph walk measures every text
 *  subject's rendered pixels directly (glyph-measure.ts), not just axe's
 *  targets. Anything it actually measured (`status === 'measured'`) supersedes
 *  an engine's "background could not be determined" shrug on the same
 *  element — `unmeasured` subjects carry no evidence and must NOT supersede
 *  anything (see the "what never supersedes" note above). */
export const glyphContrast: MeasurementProvider = {
  id: 'glyph-contrast',
  requirements: ['wcag22.1.4.3'],
  ownRules: ['contrast.text'],
  measured(artifacts) {
    const byCell = new Map<string, Box[]>();
    for (const a of artifacts) {
      if (a.kind !== 'style-probe' || a.check !== 'contrast') continue;
      const key = cellKey(a.subject);
      for (const raw of a.results) {
        const c = raw as { status?: unknown; box?: Box };
        if (c.status !== 'measured' || !c.box) continue;
        let list = byCell.get(key);
        if (!list) byCell.set(key, (list = []));
        list.push(c.box);
      }
    }
    return byCell;
  },
};

export const DEFAULT_PROVIDERS: readonly MeasurementProvider[] = [glyphContrast];

export interface SupersedeResult {
  findings: Finding[];
  superseded: number; // needs-review findings removed
  measured: number; // measured elements considered, across providers
  byProvider: Record<string, number>;
}

/** Drop needs-review findings whose element a measurement provider physically
 *  measured (same requirement, same page cell, same geometry). See the module
 *  comment for what supersedes and what never does. */
export function supersedeByMeasurement(
  findings: Finding[],
  artifacts: Artifact[],
  providers: readonly MeasurementProvider[] = DEFAULT_PROVIDERS,
): SupersedeResult {
  const active = providers
    .map((p) => ({ p, cells: p.measured(artifacts) }))
    .filter((e) => e.cells.size > 0);
  let measured = 0;
  for (const e of active) for (const boxes of e.cells.values()) measured += boxes.length;
  const byProvider: Record<string, number> = {};
  if (!active.length) return { findings, superseded: 0, measured, byProvider };

  let superseded = 0;
  const kept = findings.filter((f) => {
    if (f.confidence !== 'needs-review') return true; // computed violations stand
    const box = (f.details as { box?: Box } | undefined)?.box;
    if (!box) return true; // no geometry — cannot prove it's the same element
    const req = String(f.requirementId);
    const rule = String(f.ruleId);
    for (const { p, cells } of active) {
      if (!p.requirements.includes(req)) continue;
      if (p.ownRules.includes(rule)) continue; // a provider never eats its own report
      const boxes = cells.get(cellKey(f.subject));
      if (boxes?.some((b) => sameElement(box, b))) {
        superseded++;
        byProvider[p.id] = (byProvider[p.id] ?? 0) + 1;
        return false;
      }
    }
    return true;
  });
  return { findings: kept, superseded, measured, byProvider };
}
