import { parseArgs } from 'node:util';
import { loadRun, asRunId } from '../../record/index.js';
import { diffRuns, budgetBreaches, type BudgetGate } from '../../report/index.js';

export function cmdDiff(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      base: { type: 'string' },
      head: { type: 'string' },
      'fail-on': { type: 'string', default: 'new-critical' },
      json: { type: 'boolean' },
      cwd: { type: 'string' },
    },
    allowPositionals: false,
  });
  if (!values.base || !values.head) {
    process.stderr.write('diff needs --base <runId> and --head <runId>\n');
    return 2;
  }

  const base = loadRun(asRunId(values.base), values.cwd);
  const head = loadRun(asRunId(values.head), values.cwd);
  const diff = diffRuns(base, head);
  const failOn = values['fail-on'] as BudgetGate;
  const breaches = budgetBreaches(diff, failOn);

  if (values.json) {
    process.stdout.write(JSON.stringify({ diff, breaches }, null, 2) + '\n');
  } else {
    process.stdout.write(
      `diff ${diff.base.runId} -> ${diff.head.runId}\n` +
        `  added:      ${diff.added.length}\n` +
        `  resolved:   ${diff.resolved.length}\n` +
        `  persisting: ${diff.persisting.length}\n`,
    );
    if (breaches.length) {
      process.stdout.write(`\nbudget (${failOn}) tripped by ${breaches.length} new finding(s):\n`);
      for (const f of breaches) {
        process.stdout.write(`  [${f.severity}] ${String(f.requirementId)} — ${f.message}\n`);
      }
    }
  }
  // The CI gate: new findings at/above the severity floor fail the build.
  return breaches.length ? 1 : 0;
}
