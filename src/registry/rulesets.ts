import type { Requirement } from './schema.js';

// Rulesets are queries over the registry, not hand-maintained ID lists that
// drift (registry-design.md). `wcag22aa` = instrument wcag, level <= AA,
// version <= 2.2. The config-surface names resolve through here.

const LEVEL_RANK = { A: 0, AA: 1, AAA: 2 } as const;

export interface RuleSet {
  id: string;
  description: string;
  match(req: Requirement): boolean;
}

function wcagMaxLevel(req: Requirement, max: 'A' | 'AA' | 'AAA'): boolean {
  if (req.citation.kind !== 'sc') return false;
  return LEVEL_RANK[req.citation.level] <= LEVEL_RANK[max];
}

export const RULESETS: RuleSet[] = [
  {
    id: 'wcag22aa',
    description: 'WCAG 2.2, Levels A and AA',
    match: (req) => String(req.instrument) === 'wcag' && wcagMaxLevel(req, 'AA'),
  },
  {
    id: 'wcag22a',
    description: 'WCAG 2.2, Level A only',
    match: (req) => String(req.instrument) === 'wcag' && wcagMaxLevel(req, 'A'),
  },
  {
    id: 'gdpr',
    description: 'GDPR — all encoded requirements',
    match: (req) => String(req.instrument) === 'gdpr',
  },
  {
    id: 'gdpr-consent',
    description: 'GDPR consent obligations (Article 7)',
    match: (req) => String(req.instrument) === 'gdpr' && req.citation.kind === 'article' && req.citation.article === 7,
  },
  {
    id: 'ai-act-50',
    description: 'EU AI Act Article 50 transparency obligations',
    match: (req) =>
      String(req.instrument) === 'eu-ai-act' &&
      req.citation.kind === 'article' &&
      req.citation.article === 50,
  },
];

export function findRuleSet(id: string): RuleSet | undefined {
  return RULESETS.find((r) => r.id === id);
}

/** Requirements selected by a named ruleset. Unknown id → empty (caller warns). */
export function requirementsForRuleset(id: string, requirements: Requirement[]): Requirement[] {
  const rs = findRuleSet(id);
  if (!rs) return [];
  return requirements.filter((r) => rs.match(r));
}
