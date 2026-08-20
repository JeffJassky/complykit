import { asRuleId, type Artifact, type Subject, type Verdict, type VerdictValue } from '../record/index.js';
import { asRequirementId } from '../registry/index.js';
import { contentHash, perceptualHash } from './phash.js';
import { readVerdict, writeVerdict } from './cache.js';

// The mode-1 adjudication harness. Pure orchestration over an injected
// `adjudicator` (the real one calls the Anthropic API in client.ts; tests pass a
// stub). Economics: pHash dedupe collapses repeated regions to one call; the
// verdict cache makes an unchanged crop cost ZERO calls on a re-run. This is what
// makes C1 proportional to UI churn (the M4 DoD).

export interface AdjudicationRequest {
  fingerprint: string;
  ruleId: string; // the llm rule id to stamp on the verdict/finding
  requirementId: string;
  subject: Subject;
  cropBuffer: Buffer;
  rubric: string;
  rubricVersion: string;
}

/** The model call. Injectable — never touches the SDK in this module. */
export type Adjudicator = (input: {
  crop: Buffer;
  rubric: string;
  requirementId: string;
}) => Promise<{ verdict: VerdictValue; reason: string }>;

export interface AdjudicationStats {
  requests: number;
  deduped: number; // requests collapsed by pHash
  cacheHits: number;
  modelCalls: number; // == tokens spent proxy; 0 on a fully-cached re-run
}

export interface AdjudicationResult {
  artifacts: Artifact[]; // verdict artifacts
  stats: AdjudicationStats;
}

export interface AdjudicateOptions {
  adjudicator: Adjudicator;
  model: string;
  cwd?: string;
  capturedAt: string;
}

export async function adjudicateQueue(
  requests: AdjudicationRequest[],
  opts: AdjudicateOptions,
): Promise<AdjudicationResult> {
  const stats: AdjudicationStats = { requests: requests.length, deduped: 0, cacheHits: 0, modelCalls: 0 };
  const artifacts: Artifact[] = [];

  // 1. pHash dedupe: group requests whose crop looks identical AND that ask the
  //    same rule (a header judged for contrast is one judgment for all instances).
  const groups = new Map<string, AdjudicationRequest[]>();
  for (const req of requests) {
    const key = `${perceptualHash(req.cropBuffer)}:${req.ruleId}:${req.rubricVersion}`;
    const list = groups.get(key);
    if (list) list.push(req);
    else groups.set(key, [req]);
  }

  for (const group of groups.values()) {
    const rep = group[0];
    stats.deduped += group.length - 1;
    const cropHash = contentHash(rep.cropBuffer);

    // 2. Verdict cache: unchanged crop -> reuse, zero model calls.
    let verdict = readVerdict(cropHash, rep.ruleId, rep.rubricVersion, opts.model, opts.cwd);
    if (verdict) {
      stats.cacheHits++;
    } else {
      const raw = await opts.adjudicator({ crop: rep.cropBuffer, rubric: rep.rubric, requirementId: rep.requirementId });
      stats.modelCalls++;
      verdict = {
        verdict: raw.verdict,
        requirementId: asRequirementId(rep.requirementId),
        reason: raw.reason,
      } satisfies Verdict;
      writeVerdict(cropHash, rep.ruleId, rep.rubricVersion, opts.model, verdict, opts.cwd);
    }

    // 3. Emit a verdict artifact for every instance in the group (same verdict).
    for (const req of group) {
      artifacts.push({
        kind: 'verdict',
        subject: req.subject,
        capturedAt: opts.capturedAt,
        ruleId: asRuleId(req.ruleId),
        cropHash,
        result: verdict,
        model: opts.model,
      });
    }
  }

  return { artifacts, stats };
}
