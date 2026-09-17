import { z } from 'zod';
import type { RawFinding, Artifact } from '../../record/index.js';
import type { Rule, EvalContext } from '../types.js';
import { asRuleId, asRequirementId } from '../../registry/index.js';

// WCAG 1.4.3 contrast, from the collector's glyph-mask walk (glyph-measure.ts):
// every text subject on the page is measured directly off its rendered pixels
// — the glyph mask isolates exactly which pixels are ink (A vs B, the subject's
// glyphs made transparent) and what's behind each one, so the verdict never
// depends on inferring a background from the cascade. This rule is the SINGLE
// reporter for anything measured: axe's `color-contrast` is settled (dropped)
// against the same measurements in engines.ts/contrast-reconcile.ts, whatever
// this rule does or doesn't report for that element. A measured PASS is simply
// not reported; a measured FAIL is reported here, flat background or not — the
// old "skip flat, let axe own it" split is gone because axe no longer owns any
// measured element.
//
// Unmeasured subjects are never a pass: the collector emits a
// `contrast-unmeasured` coverage gap for them, and this rule stays silent
// (needs-review noise would just be a worse gap notice).
//
// Overlays (glyph-measure attributeOverlays): text that failed as rendered, or
// could not be seen at all, is re-measured with whatever is painted over it
// hidden. If it passes on its own background — or could not be seen as
// rendered — the finding is needs-review naming the overlay: whether a
// dismissible banner or scrim legitimately covers the text is a human call.
// Text that fails without the overlay too stays a plain violation.

const MeasuredSubject = z.object({
  status: z.enum(['measured', 'unmeasured']),
  verdict: z.enum(['pass', 'fail']).optional(),
  cssPath: z.string().optional(),
  sourceFile: z.string().nullable().optional(), // Vue __file from the dev runtime
  scopeId: z.string().nullable().optional(), // data-v style-scope fallback
  textSample: z.string().optional(),
  textColor: z.string().optional(),
  required: z.number(),
  ratio: z.number().optional(),
  minRatio: z.number().optional(),
  medianRatio: z.number().optional(),
  maxRatio: z.number().optional(),
  glyphPixels: z.number().optional(),
  failingPixels: z.number().optional(),
  fgSource: z.enum(['css', 'rendered']).optional(),
  fgColor: z.string().optional(),
  worstBgColor: z.string().optional(),
  bestBgColor: z.string().optional(),
  box: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
  cropPath: z.string().optional(),
  overlayPath: z.string().optional(),
  cropWidth: z.number().optional(),
  cropHeight: z.number().optional(),
  unmeasuredReason: z.string().optional(),
  obscuredBy: z.array(z.string()).optional(),
  unobscured: z
    .object({
      verdict: z.enum(['pass', 'fail']),
      ratio: z.number(),
      minRatio: z.number(),
      medianRatio: z.number(),
      glyphPixels: z.number(),
      fgColor: z.string().optional(),
      worstBgColor: z.string().optional(),
      cropPath: z.string().optional(),
      overlayPath: z.string().optional(),
      cropWidth: z.number().optional(),
      cropHeight: z.number().optional(),
    })
    .optional(),
});

type Shot = { path?: string; overlayPath?: string; cropWidth?: number; cropHeight?: number; fgColor?: string; worstBgColor?: string };

function screenshotEvidence(s: Shot, label: string, extra: Array<{ label: string; color: string; ratio?: number }> = []) {
  if (!s.path || s.cropWidth == null || s.cropHeight == null) return [];
  return [
    {
      kind: 'screenshot' as const,
      path: s.path,
      region: { x: 0, y: 0, width: s.cropWidth, height: s.cropHeight },
      overlayPath: s.overlayPath,
      pageState: label,
      swatches: [
        ...(s.fgColor ? [{ label: 'text', color: s.fgColor }] : []),
        ...(s.worstBgColor ? [{ label: 'background (worst pixel)', color: s.worstBgColor }] : []),
        ...extra,
      ],
    },
  ];
}

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
    'Inactive controls, incidental text (pure decoration, or part of a picture with significant other content) and logotypes are exempt under 1.4.3 itself. Those are properties of the element, not of the pixels, so they are recorded once as dispositions rather than re-judged every run. There is no other human question here: each glyph pixel is measured directly against the exact background rendered behind it (A/B screenshot diff with the subject\'s own text made transparent), and the verdict is the 1st-percentile pixel — never an inferred cascade colour, never a guessed background.',
  consumes: ['style-probe'] as const,
  evaluate(input: { 'style-probe': Artifact[] }, ctx: EvalContext): RawFinding[] {
    const out: RawFinding[] = [];
    let ordinal = 0;
    for (const artifact of input['style-probe']) {
      if (artifact.kind !== 'style-probe' || artifact.check !== 'contrast') continue;
      for (const raw of artifact.results) {
        const parsed = MeasuredSubject.safeParse(raw);
        if (!parsed.success) continue; // old-shape result (pre glyph-mask run) — ignored, not re-judged
        const c = parsed.data;

        const subjectOf = () => ({
          property: ctx.property,
          routePattern: artifact.subject.routePattern,
          instanceUrl: artifact.subject.instanceUrl,
          viewport: artifact.subject.viewport,
          colorScheme: artifact.subject.colorScheme,
          locator: { role: 'text', name: c.textSample?.slice(0, 40), cssPath: c.cssPath, ordinal: ordinal++ },
          file: c.sourceFile ? { path: c.sourceFile } : undefined,
        });

        const u = c.unobscured;
        const over = c.obscuredBy?.length ? c.obscuredBy.join(', ') : null;
        const hidden = c.status === 'unmeasured' && c.unmeasuredReason === 'occluded';
        if (u && over && (hidden || (c.status === 'measured' && c.verdict === 'fail' && u.verdict === 'pass'))) {
          const own = `With it hidden, the text measures ${u.ratio}:1 against its own background (required ${c.required}:1, ${u.verdict}).`;
          out.push({
            ruleId: asRuleId('contrast.text'),
            requirementId: asRequirementId('wcag22.1.4.3'),
            subject: subjectOf(),
            confidence: 'needs-review',
            message: hidden
              ? `Text cannot be evaluated as rendered: it is covered by ${over}. ${own}`
              : `Text measures ${c.ratio}:1 as rendered, but ${over} is painted over it. ${own} Check whether that overlay legitimately covers this text.`,
            details: { cssPath: c.cssPath, textSample: c.textSample, box: c.box, obscuredBy: c.obscuredBy, ...(c.scopeId ? { vueScopeId: c.scopeId } : {}) },
            evidence: [
              {
                kind: 'computed-style',
                properties: {
                  ...(c.textSample ? { text: `"${c.textSample}"` } : {}),
                  'covered by': over,
                  ...(hidden ? { 'as rendered': 'not visible (hiding the text changed no pixels)' } : { 'as rendered': `${c.ratio}:1` }),
                  'without the overlay': `${u.ratio}:1 (median ${u.medianRatio}:1, ${u.glyphPixels} glyph pixels)`,
                  required: String(c.required),
                },
              },
              ...screenshotEvidence(
                { path: c.cropPath, overlayPath: c.overlayPath, cropWidth: c.cropWidth, cropHeight: c.cropHeight, fgColor: c.fgColor, worstBgColor: c.worstBgColor },
                'as rendered',
              ),
              ...screenshotEvidence({ path: u.cropPath, overlayPath: u.overlayPath, cropWidth: u.cropWidth, cropHeight: u.cropHeight, fgColor: u.fgColor, worstBgColor: u.worstBgColor }, 'overlay hidden'),
            ],
          });
          continue;
        }

        // Only a measured fail is a finding. A measured pass has nothing to
        // report; unmeasured is a coverage gap, not a verdict either way.
        if (c.status !== 'measured' || c.verdict !== 'fail') continue;
        if (c.ratio == null || c.minRatio == null || c.medianRatio == null || c.maxRatio == null || c.glyphPixels == null) continue;

        out.push({
          ruleId: asRuleId('contrast.text'),
          requirementId: asRequirementId('wcag22.1.4.3'),
          subject: {
            property: ctx.property,
            routePattern: artifact.subject.routePattern,
            instanceUrl: artifact.subject.instanceUrl,
            viewport: artifact.subject.viewport,
            colorScheme: artifact.subject.colorScheme,
            locator: { role: 'text', name: c.textSample?.slice(0, 40), cssPath: c.cssPath, ordinal: ordinal++ },
            // Raw runtime path — the pipeline relativizes it against the repo.
            file: c.sourceFile ? { path: c.sourceFile } : undefined,
          },
          confidence: 'violation',
          message: `Text contrast ${c.ratio}:1 is below the required ${c.required}:1 — measured over ${c.glyphPixels} glyph pixels (worst ${c.minRatio}:1, median ${c.medianRatio}:1).`,
          details: { cssPath: c.cssPath, textSample: c.textSample, box: c.box, ...(c.scopeId ? { vueScopeId: c.scopeId } : {}) },
          evidence: [
            {
              kind: 'computed-style',
              properties: {
                ...(c.textSample ? { text: `"${c.textSample}"` } : {}),
                color: c.textColor ?? '',
                'text colour used': `${c.fgColor ?? '?'} (${c.fgSource === 'css' ? 'CSS colour' : 'rendered pixels'})`,
                'background at worst pixel': c.worstBgColor ?? '',
                ratio: `${c.ratio}:1 (1st percentile of ${c.glyphPixels} glyph pixels)`,
                range: `${c.minRatio}–${c.maxRatio}:1, median ${c.medianRatio}:1`,
                required: String(c.required),
                'failing pixels': `${c.failingPixels ?? '?'} of ${c.glyphPixels}`,
              },
            },
            // Croppable evidence for C1 adjudication and human review: the crop
            // around the measured glyphs, plus the glyph-mask overlay stacked
            // on top by the report, plus colour swatches for text/worst/best.
            ...(c.cropPath && c.cropWidth != null && c.cropHeight != null
              ? [
                  {
                    kind: 'screenshot' as const,
                    path: c.cropPath,
                    region: { x: 0, y: 0, width: c.cropWidth, height: c.cropHeight },
                    overlayPath: c.overlayPath,
                    swatches: [
                      ...(c.fgColor ? [{ label: 'text', color: c.fgColor }] : []),
                      ...(c.worstBgColor
                        ? [{ label: 'background (worst pixel)', color: c.worstBgColor, ratio: c.minRatio }]
                        : []),
                      ...(c.bestBgColor
                        ? [{ label: 'background (best pixel)', color: c.bestBgColor, ratio: c.maxRatio }]
                        : []),
                    ],
                  },
                ]
              : []),
          ],
        });
      }
    }
    return out;
  },
};
