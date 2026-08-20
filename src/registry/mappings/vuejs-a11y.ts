import type { EngineRuleMapping } from '../schema.js';
import { asRequirementId } from '../ids.js';

// eslint-plugin-vuejs-accessibility rule -> WCAG requirement(s). Same discipline
// as jsx-a11y: exhaustive vs the pinned version, confidence per the reliability
// policy. vue-eslint-parser compiles <template> into a template AST, so
// `:alt` / `v-bind` are understood.

export const VUE_A11Y_VERSION = '2.4.1';

type Row = [rule: string, requirement: string, confidence: 'violation' | 'needs-review'];

const ROWS: Row[] = [
  ['alt-text', 'wcag22.1.1.1', 'violation'],
  ['anchor-has-content', 'wcag22.4.1.2', 'violation'],
  ['aria-props', 'wcag22.4.1.2', 'violation'],
  ['aria-role', 'wcag22.4.1.2', 'violation'],
  ['aria-unsupported-elements', 'wcag22.4.1.2', 'violation'],
  ['click-events-have-key-events', 'wcag22.2.1.1', 'needs-review'],
  ['form-control-has-label', 'wcag22.4.1.2', 'needs-review'],
  ['heading-has-content', 'wcag22.1.3.1', 'violation'],
  ['iframe-has-title', 'wcag22.4.1.2', 'violation'],
  ['interactive-supports-focus', 'wcag22.2.1.1', 'needs-review'],
  ['label-has-for', 'wcag22.4.1.2', 'needs-review'],
  ['media-has-caption', 'wcag22.1.2.2', 'needs-review'],
  ['mouse-events-have-key-events', 'wcag22.2.1.1', 'needs-review'],
  ['no-access-key', 'wcag22.2.1.1', 'needs-review'],
  ['no-aria-hidden-on-focusable', 'wcag22.4.1.2', 'violation'],
  ['no-autofocus', 'wcag22.2.4.3', 'needs-review'],
  ['no-distracting-elements', 'wcag22.2.2.2', 'violation'],
  ['no-onchange', 'wcag22.3.2.2', 'needs-review'],
  ['no-redundant-roles', 'wcag22.4.1.2', 'violation'],
  ['no-role-presentation-on-focusable', 'wcag22.4.1.2', 'violation'],
  ['no-static-element-interactions', 'wcag22.2.1.1', 'needs-review'],
  ['role-has-required-aria-props', 'wcag22.4.1.2', 'violation'],
  ['tabindex-no-positive', 'wcag22.2.4.3', 'violation'],
];

export const VUE_A11Y_MAPPINGS: EngineRuleMapping[] = ROWS.map(([engineRule, req, confidence]) => ({
  engine: 'eslint-plugin-vuejs-accessibility',
  engineVersion: VUE_A11Y_VERSION,
  engineRule,
  requirements: [asRequirementId(req)],
  confidence,
}));

export const VUE_A11Y_PINNED_RULES: string[] = ROWS.map(([rule]) => rule);
