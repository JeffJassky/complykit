import type { RequirementId, RunId } from './ids.js';
import {
  RawFinding,
  Finding,
  type Severity,
  type Confidence,
  type Producer,
  severityNarrows,
  SCHEMA_VERSION,
} from './schema.js';
import { fingerprint } from './fingerprint.js';

// The single gatekeeper of the record format (options-architecture.md): every
// finding — from axe, from a rule, from an agent — becomes a Finding HERE.
// No producer can inflate its own authority: confidence is capped by the rule's
// declared max, and severity narrows the requirement default, never raises it.
//
// record/ imports nothing from registry/ (dependency law), so the rule and
// requirement facts arrive as `caps` — the caller (cli/finding-add, the
// evaluate pipeline) resolves them from the registry and passes them in.

const CONFIDENCE_RANK: Record<Confidence, number> = {
  violation: 0, // strongest authority
  'needs-review': 1,
};

/** Lower authority wins the cap: violation capped to needs-review stays needs-review. */
function capConfidence(raw: Confidence, max: Confidence): Confidence {
  return CONFIDENCE_RANK[raw] >= CONFIDENCE_RANK[max] ? raw : max;
}

export interface FindingCaps {
  /** Whether the rule detects presence or absence — selects the fingerprint branch. */
  detects: 'presence' | 'absence';
  /** The rule's declared maximum confidence. */
  maxConfidence: Confidence;
  /** The cited requirement's default severity. */
  requirementSeverity: Severity;
  /** A rule may narrow severity; it must not raise it. */
  ruleSeverity?: Severity;
  /** The rule's declared requirements — the cited one must be among them. */
  ruleRequirements: readonly RequirementId[];
}

export interface NormalizeContext {
  caps: FindingCaps;
  runId: RunId;
  producer: Producer;
}

/**
 * Validate a raw finding and resolve it into a stored Finding. Throws on any
 * authority violation — an out-of-set requirement, or a rule severity that
 * raises rather than narrows (a build failure in disguise, per build-plan).
 */
export function resolveFinding(rawInput: unknown, ctx: NormalizeContext): Finding {
  const raw = RawFinding.parse(rawInput);
  const { caps, runId, producer } = ctx;

  if (!caps.ruleRequirements.includes(raw.requirementId)) {
    throw new Error(
      `finding cites ${raw.requirementId}, which is not among rule ${raw.ruleId}'s requirements ` +
        `[${caps.ruleRequirements.join(', ')}]`,
    );
  }

  if (caps.ruleSeverity && !severityNarrows(caps.requirementSeverity, caps.ruleSeverity)) {
    throw new Error(
      `rule ${raw.ruleId} severity "${caps.ruleSeverity}" raises the requirement default ` +
        `"${caps.requirementSeverity}" — rules may narrow severity, never raise it`,
    );
  }

  const confidence = capConfidence(raw.confidence, caps.maxConfidence);
  const severity = caps.ruleSeverity ?? caps.requirementSeverity;

  const fp =
    caps.detects === 'absence'
      ? fingerprint({ detects: 'absence', requirementId: raw.requirementId, subject: raw.subject })
      : fingerprint({ detects: 'presence', ruleId: raw.ruleId, subject: raw.subject });

  return Finding.parse({
    ...raw,
    schemaVersion: SCHEMA_VERSION,
    confidence,
    severity,
    fingerprint: fp,
    producer,
    runId,
  });
}
