import {
  resolveFinding,
  appendFinding,
  type Finding,
  type Producer,
  type RunId,
} from './record/index.js';
import { resolveCapsFor } from './rules/index.js';

// `addFinding` is the one door every finding walks through (options-arch: agents
// never write findings.jsonl directly). It resolves the rule's authority caps
// from the registry, validates + fingerprints via record/normalize, and
// appends to the run. The CLI `finding add` and the v2 SDK tool both call this.

export interface AddFindingOptions {
  runId: RunId;
  producer: Producer;
  cwd?: string;
  /** When false, resolve + return the Finding without writing (dry run / preview). */
  persist?: boolean;
}

export function addFinding(raw: unknown, opts: AddFindingOptions): Finding {
  // The raw must at least name a rule + requirement to resolve caps; record's
  // parse enforces the full shape.
  const r = raw as { ruleId?: string; requirementId?: string };
  if (!r || typeof r.ruleId !== 'string' || typeof r.requirementId !== 'string') {
    throw new Error('finding must include a ruleId and requirementId');
  }
  const caps = resolveCapsFor(r.ruleId, r.requirementId);
  const finding = resolveFinding(raw, { caps, runId: opts.runId, producer: opts.producer });
  if (opts.persist !== false) appendFinding(opts.runId, finding, opts.cwd);
  return finding;
}
