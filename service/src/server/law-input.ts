// Validation of the multi-region request fields (`laws`, `authorized`) shared
// by batch creation and rescan. Laws are consent-only and need the submitter's
// confirmation that they are authorized to scan the site.

import { LAWS, isLawId, type LawId } from '../shared/laws.js';

export type LawsInput = { ok: true; laws?: LawId[]; authorizedAt?: string } | { ok: false; error: string };

/**
 * `laws` absent/null → ok with no laws. Otherwise: consent must be one of the
 * checks, `laws` a non-empty array of valid ids (deduped, in catalog order),
 * and `authorized` exactly true.
 */
export function parseLaws(laws: unknown, authorized: unknown, consentEnabled: boolean): LawsInput {
  if (laws === undefined || laws === null) return { ok: true };
  if (!consentEnabled) return { ok: false, error: '`laws` only applies to the consent check: enable the consent check or drop `laws`' };
  if (!Array.isArray(laws) || !laws.length) return { ok: false, error: '`laws` must be a non-empty array of law ids' };
  const bad = laws.find((l) => !isLawId(l));
  if (bad !== undefined) return { ok: false, error: `unknown law ${JSON.stringify(bad)}; valid laws: ${LAWS.map((l) => l.id).join(', ')}` };
  if (authorized !== true) return { ok: false, error: 'scanning under laws requires `authorized: true` (confirmation that you are authorized to scan this site)' };
  const wanted = new Set(laws as LawId[]);
  return { ok: true, laws: LAWS.filter((l) => wanted.has(l.id)).map((l) => l.id), authorizedAt: new Date().toISOString() };
}
