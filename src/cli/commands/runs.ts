import { parseArgs } from 'node:util';
import { listRuns, readFindings } from '../../record/index.js';

export function cmdRuns(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: { property: { type: 'string' }, cwd: { type: 'string' } },
    allowPositionals: false,
  });
  const runs = listRuns(values.property, values.cwd);
  if (!runs.length) {
    process.stdout.write('no runs recorded. Run `complykit scan`.\n');
    return 0;
  }
  for (const run of runs) {
    const n = readFindings(run.id, values.cwd).length;
    process.stdout.write(
      `${String(run.id)}  ${run.property}  ${n} finding(s)  ${run.gaps.length} gap(s)\n`,
    );
  }
  return 0;
}
