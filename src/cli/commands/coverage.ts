import { parseArgs } from 'node:util';
import { coverage, renderCoverage } from '../../report/index.js';
import { buildCoverageIndex } from '../../coverage-index.js';

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
