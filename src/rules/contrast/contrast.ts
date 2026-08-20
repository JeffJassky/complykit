import { z } from 'zod';
import type { RawFinding, Artifact } from '../../record/index.js';
import type { Rule, EvalContext } from '../types.js';
import { asRuleId, asRequirementId } from '../../registry/index.js';

// WCAG 1.4.3 contrast, from the collector's computed-style probe (family B).
// This rule is the value-ADD OVER axe: axe already reports flat-colour contrast
// violations reliably, so this rule deliberately SKIPS flat stacks (letting axe
// own them, no duplicate findings) and handles only the cases axe punts to
// `incomplete` — a non-flat background (image/gradient/overlap). The collector's
// pixel-band pass measured those; here a measured fail is a violation and an
// ambiguous band is needs-review routed to C1. It never recomputes a ratio.

const Candidate = z.object({
  cssPath: z.string().optional(),
  textSample: z.string().optional(),
  textColor: z.string().optional(),
  bgColor: z.string().nullable().optional(),
  flat: z.boolean(),
  ratio: z.number().nullable().optional(),
  required: z.number(),
  measuredBand: z.enum(['pass', 'fail', 'ambiguous']).optional(),
  minRatio: z.number().optional(),
  maxRatio: z.number().optional(),
  box: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
});

export const contrastText: Rule<readonly ['style-probe']> = {
  id: asRuleId('contrast.text'),
  requirements: [asRequirementId('wcag22.1.4.3')],
  layer: 'browser',
  confidence: 'violation',
  detects: 'presence',
  evidence: ['computed-style', 'screenshot'],
  remediation:
    'Increase the contrast between the text and its background to at least 4.5:1 (3:1 for large text), or change the text/background colours.',
  falsePositives:
    'Disabled controls, pure decoration, and logotypes are exempt. Text over a busy image may read fine to humans even at a low measured ratio — the ambiguous band routes to human/LLM review rather than asserting a violation.',
  consumes: ['style-probe'] as const,
  evaluate(input: { 'style-probe': Artifact[] }, ctx: EvalContext): RawFinding[] {
    const out: RawFinding[] = [];
    let ordinal = 0;
    for (const artifact of input['style-probe']) {
      if (artifact.kind !== 'style-probe' || artifact.check !== 'contrast') continue;
      const screenshotPath = artifact.screenshotPath;
      for (const raw of artifact.results) {
        const parsed = Candidate.safeParse(raw);
        if (!parsed.success) continue;
        const c = parsed.data;

        // Flat-colour stacks are axe's job (axe color-contrast handles them
        // reliably) — skip them here so the two engines don't double-report 1.4.3.
        if (c.flat) continue;

        // Non-flat only: decide the verdict from the pixel-band measurement.
        let confidence: 'violation' | 'needs-review' | null = null;
        let detail: string;
        if (c.measuredBand === 'pass') {
          continue; // pixel-band cleared it
        } else if (c.measuredBand === 'fail') {
          confidence = 'violation';
          detail = `pixel-measured ${c.minRatio}–${c.maxRatio}:1 (needs ${c.required}:1)`;
        } else {
          confidence = 'needs-review'; // ambiguous or unresolved -> C1
          detail = c.measuredBand
            ? `pixel-measured band ${c.minRatio}–${c.maxRatio}:1 spans the ${c.required}:1 threshold`
            : `background is not a flat colour; ratio could not be proven`;
        }
        if (!confidence) continue;

        out.push({
          ruleId: asRuleId('contrast.text'),
          requirementId: asRequirementId('wcag22.1.4.3'),
          subject: {
            property: ctx.property,
            routePattern: artifact.subject.routePattern,
            instanceUrl: artifact.subject.instanceUrl,
            viewport: artifact.subject.viewport,
            colorScheme: artifact.subject.colorScheme,
            locator: { role: 'text', name: c.textSample?.slice(0, 40), ordinal: ordinal++ },
          },
          confidence,
          message: `Text may not meet ${c.required}:1 contrast — ${detail}.`,
          details: { cssPath: c.cssPath, textSample: c.textSample },
          evidence: [
            {
              kind: 'computed-style',
              properties: {
                color: c.textColor ?? '',
                background: c.bgColor ?? '(non-flat)',
                ratio: c.ratio != null ? String(c.ratio) : `${c.minRatio ?? '?'}-${c.maxRatio ?? '?'}`,
                required: String(c.required),
              },
            },
            // Croppable evidence for C1 adjudication: the DOM localizes (region),
            // the model only judges the handed crop.
            ...(screenshotPath && c.box
              ? [{ kind: 'screenshot' as const, path: screenshotPath, region: c.box }]
              : []),
          ],
        });
      }
    }
    return out;
  },
};
