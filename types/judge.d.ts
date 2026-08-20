// Public types for `@jeffjassky/complykit/judge` — the C1 harness (crops, pHash
// dedupe, verdict cache, batch adjudication). Behind the @anthropic-ai/sdk peer.
// Emits VerdictArtifacts that a pure rule + the review command turn into agent
// findings. Mode-2 tiled sweep lands in M5.

import type { Box, Verdict, VerdictValue, Subject, Finding, RunId, Artifact } from './index.js';

// --- crop -------------------------------------------------------------------
export interface CroppedImage {
  buffer: Buffer;
  width: number;
  height: number;
}
export function cropRegion(pngBuffer: Buffer, box: Box, padding?: number): CroppedImage;

// --- perceptual hash --------------------------------------------------------
export function perceptualHash(pngBuffer: Buffer): string;
export function contentHash(pngBuffer: Buffer): string;

// --- verdict cache ----------------------------------------------------------
export function verdictCacheDir(cwd?: string): string;
export function readVerdict(cropHash: string, ruleId: string, rubricVersion: string, model: string, cwd?: string): Verdict | undefined;
export function writeVerdict(cropHash: string, ruleId: string, rubricVersion: string, model: string, verdict: Verdict, cwd?: string): void;

// --- rubrics ----------------------------------------------------------------
export interface AdjudicationRubric {
  requirementId: string;
  ruleId: string;
  rubricVersion: string;
  prompt: string;
}
export const ADJUDICATION_RUBRICS: Record<string, AdjudicationRubric>;
export function rubricFor(requirementId: string): AdjudicationRubric | undefined;

// --- adjudication harness ---------------------------------------------------
export interface AdjudicationRequest {
  fingerprint: string;
  ruleId: string;
  requirementId: string;
  subject: Subject;
  cropBuffer: Buffer;
  rubric: string;
  rubricVersion: string;
}
export type Adjudicator = (input: {
  crop: Buffer;
  rubric: string;
  requirementId: string;
}) => Promise<{ verdict: VerdictValue; reason: string }>;
export interface AdjudicationStats {
  requests: number;
  deduped: number;
  cacheHits: number;
  modelCalls: number;
}
export interface AdjudicationResult {
  artifacts: Artifact[];
  stats: AdjudicationStats;
}
export interface AdjudicateOptions {
  adjudicator: Adjudicator;
  model: string;
  cwd?: string;
  capturedAt: string;
}
export function adjudicateQueue(requests: AdjudicationRequest[], opts: AdjudicateOptions): Promise<AdjudicationResult>;

// --- Anthropic adjudicator (SDK peer) --------------------------------------
export interface AnthropicAdjudicatorOptions {
  apiKey?: string;
  model?: string;
}
export function createAnthropicAdjudicator(opts?: AnthropicAdjudicatorOptions): Promise<{ adjudicator: Adjudicator; model: string }>;

// --- mode-2 tiled visual sweep ---------------------------------------------
export interface Tile {
  index: number;
  buffer: Buffer;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface TileOptions {
  tileWidth?: number;
  tileHeight?: number;
  overlap?: number;
}
export function sliceTiles(pngBuffer: Buffer, opts?: TileOptions): Tile[];

export interface MarkElement {
  fingerprint: string;
  role: string;
  name?: string;
  bbox: Box;
}
export interface TileSidecar {
  tileIndex: number;
  marks: Array<{ mark: number } & MarkElement>;
}
export function buildSidecars(tiles: Tile[], elements: MarkElement[]): TileSidecar[];

export interface SweepLead {
  fingerprint: string;
  mark: number;
  tileIndex: number;
  suspicion: string;
  pass: string;
}
export type Sweeper = (input: {
  tile: Tile;
  sidecar: TileSidecar;
  pass: string;
}) => Promise<Array<{ mark: number; suspicion: string }>>;
export const SWEEP_PASSES: readonly ['perception', 'affordance-order'];
export function sweep(tiles: Tile[], sidecars: TileSidecar[], sweeper: Sweeper, passes?: readonly string[]): Promise<SweepLead[]>;

// --- orchestration ----------------------------------------------------------
export function buildAdjudicationQueue(findings: Finding[], opts: { runId: RunId; cwd?: string }): AdjudicationRequest[];
export function review(
  findings: Finding[],
  opts: AdjudicateOptions & { runId: RunId },
): Promise<AdjudicationResult & { queued: number }>;
