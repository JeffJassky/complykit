import { makeInventoryRule } from './inventory-rule.js';

// A tracker SDK or third-party analytics domain in the code is a lead for GDPR
// Art. 13: personal data shared with a recipient must be disclosed, and (for
// non-essential trackers) consented before firing. The static layer sees the
// dependency; the browser layer's pre-consent capture confirms whether it loads
// before consent. needs-review.
export const inventoryTrackers = makeInventoryRule({
  id: 'inventory.tracker',
  category: 'tracker',
  requirement: 'gdpr.art13',
  remediation:
    'Disclose this third-party recipient in the privacy notice, and gate non-essential trackers behind consent so they do not fire pre-consent.',
  falsePositives:
    'A strictly-necessary tracker (e.g. error monitoring with no personal data, first-party only) may be exempt — dispose with the basis.',
  message: (name, count) =>
    `Third-party tracker "${name}" referenced (${count} site${count === 1 ? '' : 's'} in code) — verify GDPR Art. 13 disclosure and consent gating.`,
});
