import { parseArgs } from 'node:util';
import { coverage, renderCoverage, type CoverageIndex, type RuleLayer } from '../../report/index.js';
import { ALL_RULES } from '../../rules/index.js';

// Build the requirement -> layers index from the registered rules, then hand it
// to report/coverage (which may not import rules/ under the dependency law).
function buildCoverageIndex(): CoverageIndex {
  const index: CoverageIndex = new Map();
  for (const rule of ALL_RULES) {
    for (const reqId of rule.requirements) {
      const key = String(reqId);
      const layers = index.get(key) ?? new Set<RuleLayer>();
      layers.add(rule.layer);
      index.set(key, layers);
    }
  }
  return index;
}

export function cmdCoverage(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: { ruleset: { type: 'string', default: 'wcag22aa' }, json: { type: 'boolean' } },
    allowPositionals: false,
  });
  const matrix = coverage(values.ruleset as string, buildCoverageIndex());
  if (values.json) {
    process.stdout.write(JSON.stringify(matrix, null, 2) + '\n');
  } else {
    process.stdout.write(renderCoverage(matrix) + '\n');
  }
  return 0;
}
