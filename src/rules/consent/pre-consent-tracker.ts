import { z } from 'zod';
import type { RawFinding, Artifact } from '../../record/index.js';
import type { Rule, EvalContext } from '../types.js';
import { asRuleId, asRequirementId, classifyCookie, requiresConsent } from '../../registry/index.js';

// A tracker cookie set BEFORE any consent interaction — the pre-consent baseline
// capture (browser-analysis-design D). Non-necessary cookies (analytics /
// advertising) present pre-consent are set without a lawful basis. A cookie we
// can attribute to a known vendor is a violation; an unknown/heuristic match is
// needs-review. Fingerprints collapse the same cookie across route instances.

const Cookie = z.object({ name: z.string(), domain: z.string().optional() });

export const preConsentTracker: Rule<readonly ['cookie-capture']> = {
  id: asRuleId('consent.pre-consent-tracker'),
  requirements: [asRequirementId('gdpr.art7.4')],
  layer: 'browser',
  confidence: 'violation',
  detects: 'presence',
  evidence: ['cookie'],
  remediation:
    'Do not set analytics or advertising cookies until the user has given consent. Gate their scripts behind the CMP so nothing non-essential fires pre-consent.',
  falsePositives:
    'A cookie our classifier calls a tracker may be strictly necessary in context (e.g. a first-party balancer). Verify the classification before treating an unknown-vendor match as conclusive.',
  consumes: ['cookie-capture'] as const,
  evaluate(input: { 'cookie-capture': Artifact[] }, ctx: EvalContext): RawFinding[] {
    const out: RawFinding[] = [];
    const seen = new Set<string>();
    for (const artifact of input['cookie-capture']) {
      if (artifact.kind !== 'cookie-capture' || artifact.phase !== 'pre-consent') continue;
      for (const raw of artifact.cookies) {
        const parsed = Cookie.safeParse(raw);
        if (!parsed.success) continue;
        const { name } = parsed.data;
        const cls = classifyCookie(name);
        if (!requiresConsent(cls.category)) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({
          ruleId: asRuleId('consent.pre-consent-tracker'),
          requirementId: asRequirementId('gdpr.art7.4'),
          subject: {
            property: ctx.property,
            locator: { role: 'cookie', name, ordinal: 0 },
          },
          // Vendor-attributed -> violation; heuristic/unknown vendor -> needs-review.
          confidence: cls.vendor ? 'violation' : 'needs-review',
          message: `${cls.category} cookie "${name}"${cls.vendor ? ` (${cls.vendor})` : ''} is set before consent.`,
          details: { name, category: cls.category, vendor: cls.vendor },
          evidence: [
            {
              kind: 'cookie',
              name,
              domain: parsed.data.domain ?? '',
              phase: 'pre-consent',
              flags: { secure: false, httpOnly: false },
              classification: cls.category,
            },
          ],
        });
      }
    }
    return out;
  },
};
