// judge — the C1 harness: crop, pHash dedupe, verdict cache, tiler, SoM
// overlay, batch adjudication. The ONLY place the Anthropic SDK exists
// (dependency law). Emits VerdictArtifacts that rules/ evaluate like any other.
// Lands in M4. This module is the `./judge` subpath export (SDK peer).

export const JUDGE_MILESTONE = 'M4' as const;
