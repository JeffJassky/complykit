import type { TrackingEvaluation } from '../record/index.js';
import type { KnowledgeBase } from '../registry/index.js';
import { mergeEvaluation, type MergeResult } from './queue.js';
import { RESEARCH_SYSTEM, PROPOSAL_JSON_SCHEMA, researchBrief } from './prompt.js';
import type { KbStore } from './store.js';
import type { Proposal, QueueItem } from './schema.js';

// The research workflow (plans/consent-design.md §4.2):
//   scan → queue (ingest) → proposal (research | packet + propose) → a person
//   confirms or rejects → confirmed entries join the KB on the next scan.

export * from './schema.js';
export * from './queue.js';
export * from './prompt.js';
export { KbStore, defaultKbDir, type ConfirmEdits } from './store.js';

/** Fold a finished scan into the store's queue. */
export function ingestEvaluation(store: KbStore, ev: TrackingEvaluation, kb?: KnowledgeBase, at = new Date().toISOString()): MergeResult {
  const res = mergeEvaluation(store.queue(), ev, at, kb);
  store.saveQueue(res.queue);
  return res;
}

/** Same call shape as judge's Researcher — injected, so this module never imports the SDK. */
export type ResearchFn = (req: { system: string; brief: string; schema: Record<string, unknown> }) => Promise<{ body: unknown; model: string; searches: number }>;

/** Research one queued domain and record the proposal. One retry when the
 *  result fails validation (most often: no sources), with the error in view. */
export async function researchItem(store: KbStore, item: QueueItem, research: ResearchFn): Promise<{ proposal: Proposal; searches: number }> {
  const prior = store.proposals();
  let brief = researchBrief(item, prior);
  let lastErr: unknown;
  let searches = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await research({ system: RESEARCH_SYSTEM, brief, schema: PROPOSAL_JSON_SCHEMA as unknown as Record<string, unknown> });
    searches += res.searches;
    try {
      return { proposal: store.propose(item.domain, res.body, `agent:${res.model}`), searches };
    } catch (err) {
      lastErr = err;
      brief = `${brief}\n\nYour previous proposal was rejected by validation: ${err instanceof Error ? err.message : String(err)}. Fix it and call propose_entry again.`;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
