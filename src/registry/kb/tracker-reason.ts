import { kbEntryOf, type KnowledgeBase } from './index.js';
import { CONSENT_CATEGORIES } from './schema.js';

/**
 * Why this party is a known tracker, or undefined. Decided from the knowledge base and behavior — never
 * from a site classification. Lives in the registry so the generator and the owner report (report/ may
 * import only record + registry) share one rule. Internal: not part of the public registry surface.
 */
export function knownTrackerReason(p: { partyId: string; behavesLikeTracker: boolean; trackerSignals: readonly string[] }, kb: KnowledgeBase): string | undefined {
  const e = kbEntryOf(kb, p.partyId);
  const consent = (e?.categories ?? []).filter((c) => CONSENT_CATEGORIES.has(c));
  if (consent.length) return `its knowledge-base entry classifies it as ${consent.join(', ')}`;
  if (!e && p.behavesLikeTracker) return `it is not in the knowledge base and behaved like a tracker (${p.trackerSignals.join(', ') || 'tracker signals'})`;
  return undefined;
}
