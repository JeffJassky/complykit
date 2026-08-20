import type { Run } from '../record/index.js';
import { ALL_REQUIREMENTS, requirementsForRuleset } from '../registry/index.js';

// The derived payoff (registry-design.md): requirements enumerate the
// obligation space; rules declare what they cover and in which layer; the delta
// is, mechanically, the honest "needs human audit" list printed in every report.
//
// report/ may not import rules/ (dependency law), so the rule coverage arrives
// as an index the caller builds from ALL_RULES. `run.rulesExecuted` refines the
// matrix from theoretical to actual (a browser rule can't run without a
// reachable target; an llm rule can't without a key).

export type RuleLayer = 'static' | 'browser' | 'llm';

/** requirementId -> the layers that have a rule covering it. */
export type CoverageIndex = Map<string, Set<RuleLayer>>;

export interface CoverageRow {
  requirementId: string;
  title: string;
  layers: RuleLayer[];
  bucket: 'auto' | 'llm' | 'manual';
}

export interface CoverageMatrix {
  ruleset: string;
  total: number;
  autoChecked: number;
  llmAssisted: number;
  manualOnly: number;
  rows: CoverageRow[];
}

function bucketFor(layers: Set<RuleLayer>): CoverageRow['bucket'] {
  if (layers.has('static') || layers.has('browser')) return 'auto';
  if (layers.has('llm')) return 'llm';
  return 'manual';
}

export function coverage(ruleset: string, index: CoverageIndex, _run?: Run): CoverageMatrix {
  const reqs = requirementsForRuleset(ruleset, ALL_REQUIREMENTS);
  const rows: CoverageRow[] = reqs.map((req) => {
    const layers = index.get(String(req.id)) ?? new Set<RuleLayer>();
    return {
      requirementId: String(req.id),
      title: req.title,
      layers: [...layers],
      bucket: bucketFor(layers),
    };
  });
  return {
    ruleset,
    total: rows.length,
    autoChecked: rows.filter((r) => r.bucket === 'auto').length,
    llmAssisted: rows.filter((r) => r.bucket === 'llm').length,
    manualOnly: rows.filter((r) => r.bucket === 'manual').length,
    rows,
  };
}

export function renderCoverage(matrix: CoverageMatrix): string {
  const out: string[] = [];
  out.push(`Coverage — ruleset ${matrix.ruleset}`);
  out.push(`  ${matrix.total} requirements in scope`);
  out.push(`  ${matrix.autoChecked} auto-checked (static/browser rules)`);
  out.push(`  ${matrix.llmAssisted} llm-assisted (rubric or needs-review escalation)`);
  out.push(`  ${matrix.manualOnly} manual-only  <- the honest gap`);
  return out.join('\n');
}
