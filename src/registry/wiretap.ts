import type { Requirement } from './schema.js';
import { ALL_REQUIREMENTS } from './requirements/index.js';

// Wiretap-litigation states, derived from the registry itself: the states whose
// wiretap requirements (kind 'exposure', one instrument per state statute) are
// scoped to them. Adding a researched wiretap statute for a new state extends
// the posture, the wiretap rule and its theory label without a second list.
// Washington and Montana are researched and deliberately absent
// (plans/research-consent-law.md §2.5: Baker 2026; no civil remedy).
const WIRETAP_INSTRUMENTS = new Set(['cipa', 'fsca', 'wesca', 'mdwa', 'ilea']);

/** The wiretap-theory requirements, in registry order (CA first). */
export const WIRETAP_REQUIREMENTS: readonly Requirement[] = (ALL_REQUIREMENTS as Requirement[]).filter((r) => WIRETAP_INSTRUMENTS.has(String(r.instrument)));

export const WIRETAP_STATES: ReadonlySet<string> = new Set(WIRETAP_REQUIREMENTS.flatMap((r) => (r.jurisdictions ?? []).map((j) => j.code)));

/** Does a visitor from these jurisdiction codes carry wiretap-litigation exposure? */
export function isWiretapJurisdiction(codes: readonly string[]): boolean {
  return codes.some((c) => WIRETAP_STATES.has(c));
}
