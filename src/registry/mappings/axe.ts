import type { EngineRuleMapping } from '../schema.js';
import { asRequirementId } from '../ids.js';

// axe-core rule → WCAG requirement(s). The mapping table is EXHAUSTIVE against
// the pinned engine version (registry-design.md): an axe upgrade that adds
// rules breaks CI until someone maps them — engine drift becomes a reviewable
// diff, not a silent coverage change. verify.ts checks completeness against
// AXE_PINNED_RULES.
//
// Seed set covering the rules our M2 axe inject reports most. Expanded when the
// browser layer pins the full axe ruleset.

export const AXE_VERSION = '4.10.0';

const req = (id: string) => asRequirementId(id);

export const AXE_MAPPINGS: EngineRuleMapping[] = [
  { engine: 'axe-core', engineVersion: AXE_VERSION, engineRule: 'color-contrast',
    requirements: [req('wcag22.1.4.3')], confidence: 'violation' },
  { engine: 'axe-core', engineVersion: AXE_VERSION, engineRule: 'image-alt',
    requirements: [req('wcag22.1.1.1')], confidence: 'violation' },
  { engine: 'axe-core', engineVersion: AXE_VERSION, engineRule: 'label',
    requirements: [req('wcag22.3.3.2'), req('wcag22.4.1.2')], confidence: 'violation' },
  { engine: 'axe-core', engineVersion: AXE_VERSION, engineRule: 'button-name',
    requirements: [req('wcag22.4.1.2')], confidence: 'violation' },
  { engine: 'axe-core', engineVersion: AXE_VERSION, engineRule: 'link-name',
    requirements: [req('wcag22.4.1.2')], confidence: 'violation' },
  { engine: 'axe-core', engineVersion: AXE_VERSION, engineRule: 'aria-required-attr',
    requirements: [req('wcag22.4.1.2')], confidence: 'violation' },
  { engine: 'axe-core', engineVersion: AXE_VERSION, engineRule: 'aria-roles',
    requirements: [req('wcag22.4.1.2')], confidence: 'violation' },
  { engine: 'axe-core', engineVersion: AXE_VERSION, engineRule: 'list',
    requirements: [req('wcag22.1.3.1')], confidence: 'violation' },
  { engine: 'axe-core', engineVersion: AXE_VERSION, engineRule: 'heading-order',
    requirements: [req('wcag22.1.3.1')], confidence: 'needs-review' },
];

// The pinned engine's full rule id set. verify.ts fails if a rule here is
// unmapped above (upgrade added a rule) or a mapping references a rule not here
// (typo / stale mapping). Seed subset — completed when M2 pins the ruleset.
export const AXE_PINNED_RULES: string[] = [
  'color-contrast',
  'image-alt',
  'label',
  'button-name',
  'link-name',
  'aria-required-attr',
  'aria-roles',
  'list',
  'heading-order',
];
