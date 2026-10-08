import type { Requirement } from './schema.js';
import { ALL_REQUIREMENTS } from './requirements/index.js';

// Wiretap-litigation states, derived from the registry itself: the states whose
// wiretap requirements (CIPA, Fla. ch. 934, WESCA — kind 'exposure', instrument
// cipa/fsca/wesca) are scoped to them. Adding a wiretap statute for a new state
// extends the posture without a second list to keep in sync.
const WIRETAP_INSTRUMENTS = new Set(['cipa', 'fsca', 'wesca']);

export const WIRETAP_STATES: ReadonlySet<string> = new Set(
  (ALL_REQUIREMENTS as Requirement[])
    .filter((r) => WIRETAP_INSTRUMENTS.has(String(r.instrument)))
    .flatMap((r) => (r.jurisdictions ?? []).map((j) => j.code)),
);

/** Does a visitor from these jurisdiction codes carry wiretap-litigation exposure (CA, FL, PA)? */
export function isWiretapJurisdiction(codes: readonly string[]): boolean {
  return codes.some((c) => WIRETAP_STATES.has(c));
}
