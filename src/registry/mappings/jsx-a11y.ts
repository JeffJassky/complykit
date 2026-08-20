import type { EngineRuleMapping } from '../schema.js';
import { asRequirementId } from '../ids.js';

// eslint-plugin-jsx-a11y rule -> WCAG requirement(s). Exhaustive against the
// pinned version (verify.ts): an upgrade that adds a rule breaks CI until it is
// mapped. Confidence follows the static reliability policy — a defect provable
// from a literal in a single file is `violation`; an inferential/interaction
// heuristic is `needs-review`, routed to the browser or LLM layer.

export const JSX_A11Y_VERSION = '6.10.2';

type Row = [rule: string, requirement: string, confidence: 'violation' | 'needs-review'];

const ROWS: Row[] = [
  ['accessible-emoji', 'wcag22.1.1.1', 'needs-review'],
  ['alt-text', 'wcag22.1.1.1', 'violation'],
  ['anchor-ambiguous-text', 'wcag22.2.4.4', 'needs-review'],
  ['anchor-has-content', 'wcag22.4.1.2', 'violation'],
  ['anchor-is-valid', 'wcag22.2.1.1', 'needs-review'],
  ['aria-activedescendant-has-tabindex', 'wcag22.4.1.2', 'violation'],
  ['aria-props', 'wcag22.4.1.2', 'violation'],
  ['aria-proptypes', 'wcag22.4.1.2', 'violation'],
  ['aria-role', 'wcag22.4.1.2', 'violation'],
  ['aria-unsupported-elements', 'wcag22.4.1.2', 'violation'],
  ['autocomplete-valid', 'wcag22.1.3.5', 'violation'],
  ['click-events-have-key-events', 'wcag22.2.1.1', 'needs-review'],
  ['control-has-associated-label', 'wcag22.4.1.2', 'needs-review'],
  ['heading-has-content', 'wcag22.1.3.1', 'violation'],
  ['html-has-lang', 'wcag22.3.1.1', 'violation'],
  ['iframe-has-title', 'wcag22.4.1.2', 'violation'],
  ['img-redundant-alt', 'wcag22.1.1.1', 'needs-review'],
  ['interactive-supports-focus', 'wcag22.2.1.1', 'needs-review'],
  ['label-has-associated-control', 'wcag22.4.1.2', 'needs-review'],
  ['label-has-for', 'wcag22.4.1.2', 'needs-review'],
  ['lang', 'wcag22.3.1.1', 'violation'],
  ['media-has-caption', 'wcag22.1.2.2', 'needs-review'],
  ['mouse-events-have-key-events', 'wcag22.2.1.1', 'needs-review'],
  ['no-access-key', 'wcag22.2.1.1', 'needs-review'],
  ['no-aria-hidden-on-focusable', 'wcag22.4.1.2', 'violation'],
  ['no-autofocus', 'wcag22.2.4.3', 'needs-review'],
  ['no-distracting-elements', 'wcag22.2.2.2', 'violation'],
  ['no-interactive-element-to-noninteractive-role', 'wcag22.4.1.2', 'needs-review'],
  ['no-noninteractive-element-interactions', 'wcag22.2.1.1', 'needs-review'],
  ['no-noninteractive-element-to-interactive-role', 'wcag22.4.1.2', 'needs-review'],
  ['no-noninteractive-tabindex', 'wcag22.2.4.3', 'needs-review'],
  ['no-onchange', 'wcag22.3.2.2', 'needs-review'],
  ['no-redundant-roles', 'wcag22.4.1.2', 'violation'],
  ['no-static-element-interactions', 'wcag22.2.1.1', 'needs-review'],
  ['prefer-tag-over-role', 'wcag22.4.1.2', 'needs-review'],
  ['role-has-required-aria-props', 'wcag22.4.1.2', 'violation'],
  ['role-supports-aria-props', 'wcag22.4.1.2', 'violation'],
  ['scope', 'wcag22.1.3.1', 'violation'],
  ['tabindex-no-positive', 'wcag22.2.4.3', 'violation'],
];

export const JSX_A11Y_MAPPINGS: EngineRuleMapping[] = ROWS.map(([engineRule, req, confidence]) => ({
  engine: 'eslint-plugin-jsx-a11y',
  engineVersion: JSX_A11Y_VERSION,
  engineRule,
  requirements: [asRequirementId(req)],
  confidence,
}));

export const JSX_A11Y_PINNED_RULES: string[] = ROWS.map(([rule]) => rule);
