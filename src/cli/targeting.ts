import type { Finding } from '../record/index.js';

// CLI scan targeting — the agentic verify loop. A full matrix scan is the
// baseline instrument; when an agent has just changed one token or one
// component it needs a 30-second answer to "did MY bucket move", not a
// 7-minute re-measure of everything. These helpers narrow WHAT is crawled
// (routes/pages), WHERE it is measured (viewports/schemes), and WHICH findings
// are kept (rules/requirements/law) — and the run is stamped `partial` so its
// totals are never mistaken for a full baseline.

export interface TargetingFlags {
  routes?: string; // comma-separated substrings → overrides routes.include
  'max-pages'?: string;
  viewports?: string; // comma-separated preset ids
  schemes?: string; // comma-separated color schemes
  only?: string; // 'static' | 'browser'
  rules?: string; // comma-separated ruleId substrings
  requirements?: string; // comma-separated requirementId prefixes
  law?: string; // instrument prefix, e.g. wcag22 | gdpr | eu-ai-act
}

export function splitList(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The subset of flags actually passed, verbatim — stamped onto run.partial. */
export function partialStamp(flags: TargetingFlags): Record<string, string> | undefined {
  const keys: Array<keyof TargetingFlags> = ['routes', 'max-pages', 'viewports', 'schemes', 'only', 'rules', 'requirements', 'law'];
  const out: Record<string, string> = {};
  for (const k of keys) if (flags[k]) out[k] = String(flags[k]);
  return Object.keys(out).length ? out : undefined;
}

/**
 * Keep only findings matching the finding-level filters. Matching is
 * case-insensitive; rules match as substrings (`color-contrast` hits
 * `axe-core:color-contrast`), requirements and law match as prefixes
 * (`wcag22.1.4` hits `wcag22.1.4.3`; `gdpr` hits `gdpr.art13`).
 */
export function filterFindings(findings: Finding[], flags: TargetingFlags): Finding[] {
  const rules = splitList(flags.rules).map((s) => s.toLowerCase());
  const reqs = [...splitList(flags.requirements), ...splitList(flags.law)].map((s) => s.toLowerCase());
  if (!rules.length && !reqs.length) return findings;
  return findings.filter((f) => {
    const rule = String(f.ruleId).toLowerCase();
    const req = String(f.requirementId).toLowerCase();
    const ruleOk = !rules.length || rules.some((r) => rule.includes(r));
    const reqOk = !reqs.length || reqs.some((r) => req.startsWith(r));
    return ruleOk && reqOk;
  });
}
