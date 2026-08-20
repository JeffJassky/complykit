import type { Requirement } from '../schema.js';
import { WCAG_REQUIREMENTS } from './wcag.js';
import { GDPR_REQUIREMENTS } from './gdpr.js';
import { EU_AI_ACT_REQUIREMENTS } from './eu-ai-act.js';

// The obligation space. One flat list; verify.ts asserts ids are unique and
// every entry validates. Reports enumerate this to derive the honest
// "manual-only" coverage gap.
export const ALL_REQUIREMENTS: Requirement[] = [
  ...WCAG_REQUIREMENTS,
  ...GDPR_REQUIREMENTS,
  ...EU_AI_ACT_REQUIREMENTS,
];
