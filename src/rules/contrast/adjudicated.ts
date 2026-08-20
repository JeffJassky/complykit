import type { LlmRule } from '../types.js';
import { asRuleId, asRequirementId } from '../../registry/index.js';

// The LLM rule that C1 contrast adjudication resolves to. Registered so a verdict
// finding's caps resolve (confidence max, requirement, severity) like any other
// rule — the deterministic core stays the sole gatekeeper of the record format,
// even for agent findings. Its rubricVersion matches judge/rubrics.ts.
export const contrastAdjudicated: LlmRule = {
  id: asRuleId('contrast.text-adjudicated'),
  requirements: [asRequirementId('wcag22.1.4.3')],
  layer: 'llm',
  mode: 'adjudicate',
  confidence: 'violation', // the model may confirm a clear contrast violation
  detects: 'presence',
  evidence: ['screenshot', 'verdict'],
  remediation:
    'Increase the contrast of text over its (non-flat) background — darken/lighten the text, add a scrim, or change the imagery behind it.',
  falsePositives:
    'Large display text over a deliberately low-contrast hero can still be legible; an "unclear" verdict stays in the manual slice rather than asserting a violation.',
  rubric:
    'Judge one crop for WCAG 1.4.3 text contrast where the background is not a flat colour. violation / pass / unclear.',
  rubricVersion: '2026-08-19.1',
  schemeSensitive: true,
  escalation: 'cheap-first',
};
