import { parseArgs } from 'node:util';
import { verifyRegistry } from '../../registry/index.js';

export function cmdRegistryVerify(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: { since: { type: 'string' }, json: { type: 'boolean' } },
    allowPositionals: false,
  });
  const report = verifyRegistry(values.since);

  if (values.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return report.ok ? 0 : 1;
  }

  process.stdout.write(
    `registry: ${report.counts.requirements} requirements, ${report.counts.instruments} instruments, ${report.counts.mappings} mappings\n`,
  );
  for (const w of report.warnings) process.stdout.write(`  warn: ${w}\n`);
  for (const e of report.errors) process.stderr.write(`  error: ${e}\n`);
  if (report.needsHumanCheck.length) {
    process.stdout.write('\nNeeds a human check before release:\n');
    for (const item of report.needsHumanCheck) {
      process.stdout.write(`  ${item.id}: ${item.reason}\n`);
    }
  }
  process.stdout.write(report.ok ? '\nregistry OK\n' : '\nregistry has errors\n');
  return report.ok ? 0 : 1;
}
