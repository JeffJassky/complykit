import { z } from 'zod';
import type { RawFinding, Artifact } from '../../record/index.js';
import type { Rule, EvalContext } from '../types.js';
import { asRuleId, asRequirementId } from '../../registry/index.js';

// Consent dark patterns (EDPB 03/2022, attached to GDPR Art. 7.3): refusing must
// be as easy as accepting. From the consent-flow artifact we detect: no reject
// path at all (buried/absent), reject taking more clicks than accept, and
// prominence asymmetry (the accept button far louder than reject).

const ButtonMetric = z.object({
  role: z.enum(['accept', 'reject', 'manage']),
  area: z.number(),
  fontSizePx: z.number(),
  background: z.string(),
  visible: z.boolean(),
});

export const consentAsymmetry: Rule<readonly ['consent-flow']> = {
  id: asRuleId('consent.click-asymmetry'),
  requirements: [asRequirementId('gdpr.art7.3')],
  layer: 'browser',
  confidence: 'violation',
  detects: 'presence',
  evidence: ['screenshot', 'interaction-log'],
  remediation:
    'Provide a reject-all control as prominent and as few clicks away as accept-all. Do not bury refusal behind a "manage" step or make it visually quieter.',
  falsePositives:
    'A banner with only an accept for strictly-necessary cookies (no non-essential processing) may not need a reject. Confirm what is actually set before treating a missing reject as a violation.',
  consumes: ['consent-flow'] as const,
  evaluate(input: { 'consent-flow': Artifact[] }, ctx: EvalContext): RawFinding[] {
    const out: RawFinding[] = [];
    for (const artifact of input['consent-flow']) {
      if (artifact.kind !== 'consent-flow') continue;
      if (!artifact.cmp) continue; // no banner detected -> nothing to judge here

      const subject = { property: ctx.property, locator: { role: 'consent-banner', ordinal: 0 } };
      const metrics = artifact.buttonMetrics
        .map((m) => ButtonMetric.safeParse(m))
        .filter((r): r is { success: true; data: z.infer<typeof ButtonMetric> } => r.success)
        .map((r) => r.data);
      const accept = metrics.find((m) => m.role === 'accept');
      const reject = metrics.find((m) => m.role === 'reject');

      const mk = (confidence: 'violation' | 'needs-review', message: string, pattern: string): RawFinding => ({
        ruleId: asRuleId('consent.click-asymmetry'),
        requirementId: asRequirementId('gdpr.art7.3'),
        subject: { ...subject, locator: { role: 'consent-banner', name: pattern, ordinal: 0 } },
        confidence,
        message,
        details: { pattern, cmp: artifact.cmp, clicksToAccept: artifact.clicksToAccept, clicksToReject: artifact.clicksToReject },
        evidence: [{ kind: 'interaction-log', steps: [{ clicksToAccept: artifact.clicksToAccept, clicksToReject: artifact.clicksToReject }] }],
      });

      // 1. No reject path at all.
      if (artifact.clicksToReject === null) {
        out.push(mk('needs-review', 'The consent banner offers no reject-all control; refusing appears impossible or buried.', 'no-reject'));
        continue;
      }
      // 2. Reject costs more clicks than accept.
      if (artifact.clicksToReject > artifact.clicksToAccept) {
        out.push(mk('needs-review', `Refusing takes ${artifact.clicksToReject} click(s) vs ${artifact.clicksToAccept} to accept — refusal is not as easy as consent.`, 'click-asymmetry'));
      }
      // 3. Prominence asymmetry — accept much larger than reject.
      if (accept && reject && accept.visible && reject.visible && accept.area > reject.area * 2.5) {
        out.push(mk('needs-review', 'The accept button is far more prominent than reject (prominence asymmetry).', 'prominence-asymmetry'));
      }
    }
    return out;
  },
};
