import { z } from 'zod';
import type { RawFinding, Artifact } from '../../record/index.js';
import type { Rule, EvalContext } from '../types.js';
import { asRuleId, asRequirementId } from '../../registry/index.js';

// Family C keyboard rules over the focus-walk artifact. A trap (focus that won't
// advance) is a hard violation of WCAG 2.1.2. A stop with no detectable visible
// focus indicator is needs-review (the style heuristic can miss custom rings, so
// it routes to human/LLM review rather than asserting 2.4.7).

const Stop = z.object({
  index: z.number(),
  tag: z.string(),
  name: z.string().optional(),
  hasVisibleFocus: z.boolean(),
  lostToBody: z.boolean(),
});
const Trap = z.object({ atIndex: z.number(), reason: z.string() });

export const keyboardTrap: Rule<readonly ['focus-walk']> = {
  id: asRuleId('keyboard.trap'),
  requirements: [asRequirementId('wcag22.2.1.2')],
  layer: 'browser',
  confidence: 'violation',
  detects: 'presence',
  evidence: ['interaction-log'],
  remediation: 'Ensure focus can always be moved away from a component using the keyboard alone (no focus trap outside a purposely-modal dialog with an Esc exit).',
  falsePositives: 'A modal dialog that traps focus on purpose is correct while open, provided Esc or a close control releases it.',
  consumes: ['focus-walk'] as const,
  evaluate(input: { 'focus-walk': Artifact[] }, ctx: EvalContext): RawFinding[] {
    const out: RawFinding[] = [];
    for (const artifact of input['focus-walk']) {
      if (artifact.kind !== 'focus-walk') continue;
      for (const rawTrap of artifact.traps) {
        const t = Trap.safeParse(rawTrap);
        if (!t.success) continue;
        out.push({
          ruleId: asRuleId('keyboard.trap'),
          requirementId: asRequirementId('wcag22.2.1.2'),
          subject: {
            property: ctx.property,
            routePattern: artifact.subject.routePattern,
            instanceUrl: artifact.subject.instanceUrl,
            locator: { role: 'focus', ordinal: t.data.atIndex },
          },
          confidence: 'violation',
          message: `Keyboard focus is trapped at tab stop ${t.data.atIndex} (${t.data.reason}); it cannot be moved on with the keyboard.`,
          details: t.data,
          evidence: [{ kind: 'interaction-log', steps: [{ trapAt: t.data.atIndex, reason: t.data.reason }] }],
        });
      }
    }
    return out;
  },
};

export const focusVisible: Rule<readonly ['focus-walk']> = {
  id: asRuleId('keyboard.focus-visible'),
  requirements: [asRequirementId('wcag22.2.4.7')],
  layer: 'browser',
  confidence: 'needs-review',
  detects: 'presence',
  evidence: ['interaction-log', 'screenshot'],
  remediation: 'Give every keyboard-focusable control a visible focus indicator (an outline or equivalent). Do not remove the outline without a replacement.',
  falsePositives: 'A custom focus style (background change, custom ring) the style heuristic did not recognise will read as missing — confirm visually.',
  consumes: ['focus-walk'] as const,
  evaluate(input: { 'focus-walk': Artifact[] }, ctx: EvalContext): RawFinding[] {
    const out: RawFinding[] = [];
    let ordinal = 0;
    for (const artifact of input['focus-walk']) {
      if (artifact.kind !== 'focus-walk') continue;
      for (const rawStop of artifact.stops) {
        const s = Stop.safeParse(rawStop);
        if (!s.success) continue;
        if (s.data.lostToBody || s.data.hasVisibleFocus) continue;
        out.push({
          ruleId: asRuleId('keyboard.focus-visible'),
          requirementId: asRequirementId('wcag22.2.4.7'),
          subject: {
            property: ctx.property,
            routePattern: artifact.subject.routePattern,
            instanceUrl: artifact.subject.instanceUrl,
            locator: { role: 'focus', name: s.data.name?.slice(0, 40), ordinal: ordinal++ },
          },
          confidence: 'needs-review',
          message: `A focusable ${s.data.tag}${s.data.name ? ` ("${s.data.name}")` : ''} may have no visible focus indicator.`,
          details: s.data,
          evidence: [{ kind: 'interaction-log', steps: [{ tag: s.data.tag, name: s.data.name }] }],
        });
      }
    }
    return out;
  },
};
