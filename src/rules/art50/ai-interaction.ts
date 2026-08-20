import type { LlmRule } from '../types.js';
import { asRuleId, asRequirementId } from '../../registry/index.js';

// EU AI Act Art. 50(1): a user interacting directly with an AI system must be
// informed of that, unless obvious. Verified-greenfield — no rendered-page tool
// checks this. The implementation IS data (registry-design.md): judge/ runs the
// rubric over page screenshots + the ai-framework inventory; a built-in rule
// turns the verdict into an absence finding. Caps: needs-review (a screenshot
// can't prove intent), severity narrows nothing.

export const art50AiInteraction: LlmRule = {
  id: asRuleId('art50.ai-interaction-disclosure'),
  requirements: [asRequirementId('eu-ai-act.art50.1')],
  layer: 'llm',
  mode: 'adjudicate',
  confidence: 'needs-review',
  detects: 'absence',
  evidence: ['screenshot', 'verdict'],
  remediation:
    'Add a clear, visible notice that the user is interacting with an AI system (e.g. a chat header or first-message disclosure), unless it is obvious from the context.',
  falsePositives:
    'A prominent "AI assistant" label or an obvious bot context (clearly branded assistant) satisfies the obligation — the adjudicator should pass those.',
  rubric: [
    'You are auditing a web page for EU AI Act Article 50(1) transparency.',
    'The page appears to offer an AI-driven interaction (chat, assistant, generator).',
    'Question: is a user plainly informed they are interacting with an AI system,',
    'or is it obvious from the circumstances? Answer "pass" if disclosed or obvious,',
    '"violation" if a reasonable user could believe they are talking to a human,',
    '"unclear" if the evidence is insufficient.',
  ].join(' '),
  rubricVersion: '2026-08-19.1',
  schemeSensitive: false,
  escalation: 'strong-only',
};
