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
  cssPath: z.string().optional(),
  href: z.string().optional(),
  html: z.string().optional(),
  box: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
});
const Trap = z.object({ atIndex: z.number(), reason: z.string() });

// The stop's crop out of the cell's full-page capture — every localizable
// finding SHOWS its element (report-quality invariant). Degenerate or
// page-sized boxes are skipped: a crop of everything shows nothing.
function stopCrop(
  screenshotPath: string | undefined,
  box: z.infer<typeof Stop>['box'],
): Array<{ kind: 'screenshot'; path: string; region: NonNullable<z.infer<typeof Stop>['box']> }> {
  if (!screenshotPath || !box || box.width <= 0 || box.height <= 0 || box.width * box.height > 1_500_000) return [];
  return [{ kind: 'screenshot', path: screenshotPath, region: box }];
}

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
      // Index the stops so a trap can name the exact element it caught on.
      const stopAt = new Map<number, z.infer<typeof Stop>>();
      for (const rawStop of artifact.stops) {
        const s = Stop.safeParse(rawStop);
        if (s.success) stopAt.set(s.data.index, s.data);
      }
      for (const rawTrap of artifact.traps) {
        const t = Trap.safeParse(rawTrap);
        if (!t.success) continue;
        // A no-advance trap repeats the previous stop's element by definition,
        // so fall back one index — walks recorded before the collector learned
        // to push the trapped stop itself still get a named element.
        const at = stopAt.get(t.data.atIndex) ?? stopAt.get(t.data.atIndex - 1);
        out.push({
          ruleId: asRuleId('keyboard.trap'),
          requirementId: asRequirementId('wcag22.2.1.2'),
          subject: {
            property: ctx.property,
            routePattern: artifact.subject.routePattern,
            instanceUrl: artifact.subject.instanceUrl,
            viewport: artifact.subject.viewport,
            colorScheme: artifact.subject.colorScheme,
            locator: { role: 'focus', name: at?.name?.slice(0, 40), cssPath: at?.cssPath, ordinal: t.data.atIndex },
          },
          confidence: 'violation',
          message: `Keyboard focus is trapped at tab stop ${t.data.atIndex}${at ? ` on ${at.tag}${at.name ? ` ("${at.name}")` : ''}` : ''} (${t.data.reason}); it cannot be moved on with the keyboard.`,
          details: { ...t.data, element: at },
          evidence: [
            { kind: 'interaction-log', steps: [{ trapAt: t.data.atIndex, reason: t.data.reason, tag: at?.tag, cssPath: at?.cssPath }] },
            ...(at?.html ? [{ kind: 'dom-snippet' as const, html: at.html }] : []),
            ...stopCrop(artifact.screenshotPath, at?.box),
          ],
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
            viewport: artifact.subject.viewport,
            colorScheme: artifact.subject.colorScheme,
            locator: { role: 'focus', name: s.data.name?.slice(0, 40), cssPath: s.data.cssPath, ordinal: ordinal++ },
          },
          confidence: 'needs-review',
          message: `A focusable ${s.data.tag}${s.data.name ? ` ("${s.data.name}")` : ''}${s.data.href ? ` → ${s.data.href}` : ''} may have no visible focus indicator.`,
          details: s.data,
          evidence: [
            { kind: 'interaction-log', steps: [{ tabStop: s.data.index, tag: s.data.tag, name: s.data.name, href: s.data.href }] },
            ...(s.data.html ? [{ kind: 'dom-snippet' as const, html: s.data.html }] : []),
            ...stopCrop(artifact.screenshotPath, s.data.box),
          ],
        });
      }
    }
    return out;
  },
};
