// judge — the C1 harness: crops, pHash dedupe, verdict cache, batch
// adjudication. The ONLY place the Anthropic SDK is imported (dependency law,
// in client.js). Emits VerdictArtifacts that a pure rule (and the review
// command) turn into agent findings. This module is the `./judge` subpath export
// (SDK peer). Mode 2 (tiled visual sweep) lands in M5.

import fs from 'node:fs';
import path from 'node:path';
import { runDir, putEvidence, type Finding, type RunId } from '../record/index.js';
import { cropRegion } from './crop.js';
import { rubricFor } from './rubrics.js';
import { adjudicateQueue, type AdjudicationRequest, type AdjudicateOptions, type AdjudicationResult } from './adjudicate.js';

export * from './crop.js';
export * from './phash.js';
export * from './cache.js';
export * from './rubrics.js';
export * from './adjudicate.js';
export { createAnthropicAdjudicator } from './client.js';

/**
 * Build the mode-1 queue from a run's needs-review findings. A finding is
 * adjudicable when it (a) is needs-review, (b) carries a screenshot+region
 * evidence to crop, and (c) cites a requirement with an adjudication rubric.
 * The DOM localizes (region); the model only ever judges the handed crop.
 */
export function buildAdjudicationQueue(
  findings: Finding[],
  opts: { runId: RunId; cwd?: string },
): AdjudicationRequest[] {
  const dir = runDir(opts.runId, opts.cwd);
  const queue: AdjudicationRequest[] = [];
  for (const f of findings) {
    if (f.confidence !== 'needs-review') continue;
    const rubric = rubricFor(String(f.requirementId));
    if (!rubric) continue;
    const shot = f.evidence.find((e) => e.kind === 'screenshot' && e.region);
    if (!shot || shot.kind !== 'screenshot' || !shot.region) continue;
    const pngPath = path.join(dir, shot.path);
    if (!fs.existsSync(pngPath)) continue;
    try {
      const crop = cropRegion(fs.readFileSync(pngPath), shot.region);
      // Persist the crop content-addressed — the sha matches adjudicate's
      // contentHash, so the verdict evidence can reference evidence/<cropHash>.png
      // and a human sees exactly what the model saw.
      putEvidence(opts.runId, crop.buffer, 'png', opts.cwd);
      queue.push({
        fingerprint: String(f.fingerprint),
        ruleId: rubric.ruleId,
        requirementId: rubric.requirementId,
        subject: f.subject,
        cropBuffer: crop.buffer,
        rubric: rubric.prompt,
        rubricVersion: rubric.rubricVersion,
      });
    } catch {
      // Undecodable crop — leave the finding in the manual slice.
    }
  }
  return queue;
}

/** Build the queue and adjudicate it. Returns verdict artifacts + economics stats. */
export async function review(
  findings: Finding[],
  opts: AdjudicateOptions & { runId: RunId },
): Promise<AdjudicationResult & { queued: number }> {
  const queue = buildAdjudicationQueue(findings, { runId: opts.runId, cwd: opts.cwd });
  const result = await adjudicateQueue(queue, opts);
  return { ...result, queued: queue.length };
}
