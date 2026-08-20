import { createHash } from 'node:crypto';
import type { RequirementId, RuleId, Fingerprint } from './ids.js';
import type { Subject } from './schema.js';

// FINGERPRINT ALGORITHM — v1, FROZEN (build-plan §7).
//
// A finding's identity must survive a CSS refactor and collapse variants of one
// defect onto one line. The canonical tuple below is the closed list of inputs;
// what is EXCLUDED is as load-bearing as what is included:
//
//   presence:  ruleId + property + (routePattern | file.path) + locator(role,
//              name, landmark, ordinal)
//   absence:   requirementId + property + routePattern?
//
// Deliberately excluded: instanceUrl, file line numbers, locator.cssPath,
// viewport, colorScheme, interaction state. A contrast failure in dark mode is
// the SAME finding as in light — the variants land in evidence, not identity.
//
// The leading "v1" tag is part of the hashed input: any future change ships a
// new tag AND a migration that re-keys comply.dispositions.yaml, so a v2 never
// silently collides with or masquerades as a v1 key.

export const FINGERPRINT_VERSION = 'v1';

export type FingerprintInput =
  | { detects: 'presence'; ruleId: RuleId; subject: Subject }
  | { detects: 'absence'; requirementId: RequirementId; subject: Subject };

/** Ordered, closed tuple → the only thing hashed. Field order is frozen. */
function canonicalTuple(input: FingerprintInput): unknown[] {
  const { subject } = input;
  if (input.detects === 'absence') {
    return [
      FINGERPRINT_VERSION,
      'absence',
      String(input.requirementId),
      subject.property,
      subject.routePattern ?? null,
    ];
  }
  // presence: route pattern wins as the locus; else the source file path.
  let locus: [string, string] | ['none'];
  if (subject.routePattern != null) locus = ['route', subject.routePattern];
  else if (subject.file != null) locus = ['file', subject.file.path];
  else locus = ['none'];

  const loc = subject.locator;
  const locator = loc
    ? [loc.role, loc.name ?? '', loc.landmark ?? '', loc.ordinal]
    : null;

  return [
    FINGERPRINT_VERSION,
    'presence',
    String(input.ruleId),
    subject.property,
    locus,
    locator,
  ];
}

/** sha256 (64 hex chars) over the canonical tuple. Stable across releases. */
export function fingerprint(input: FingerprintInput): Fingerprint {
  const canonical = JSON.stringify(canonicalTuple(input));
  return createHash('sha256').update(canonical, 'utf8').digest('hex') as Fingerprint;
}
