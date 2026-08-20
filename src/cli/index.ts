#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';

import { loadConfigFor } from './config-load.js';
import { cmdInit } from './commands/init.js';
import { cmdScan } from './commands/scan.js';
import { cmdStatic } from './commands/static.js';
import { cmdReport } from './commands/report.js';
import { cmdDiff } from './commands/diff.js';
import { cmdCoverage } from './commands/coverage.js';
import { cmdFindingAdd } from './commands/finding-add.js';
import { cmdRegistryVerify } from './commands/registry-verify.js';
import { cmdFixturesRecord } from './commands/fixtures-record.js';
import { cmdRuns } from './commands/runs.js';

// cli/ is command wiring ONLY — parse args, sequence stages, print progress. No
// logic worth testing lives here; every command delegates to a tested module.
// Nothing imports cli/ (dependency law).

const require = createRequire(import.meta.url);
function version(): string {
  try {
    return (require('../package.json') as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

const HELP = `complykit — compliance-audit toolkit

Usage: complykit <command> [options]

Commands
  init                     Write a starter config + dispositions file
  scan                     Collect artifacts, evaluate rules, write a run
                           (zero-config: complykit scan --url https://example.com)
  static                   Static layer only: point at a repo, get an in-PR run
  report                   Render a run (--format jsonl|md|sarif)
  diff                     Compare two runs by fingerprint
  coverage                 Requirement coverage for a ruleset
  finding add              Validate + fingerprint a finding into a run
  fixtures record          Record collector artifacts as rule test fixtures
  registry verify          Validate the registry; list items needing a human check
  runs                     List recorded runs

  routes | review | auth   (land in later milestones)

Run 'complykit <command> --help' for command options.`;

async function main(argv: string[]): Promise<number> {
  const [command, sub, ...rest] = argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    process.stdout.write(version() + '\n');
    return 0;
  }

  switch (command) {
    case 'init':
      return cmdInit(rest.length ? [sub, ...rest] : sub ? [sub] : []);
    case 'scan':
      return cmdScan(joinArgs(sub, rest), loadConfigFor);
    case 'static':
      return cmdStatic(joinArgs(sub, rest));
    case 'report':
      return cmdReport(joinArgs(sub, rest));
    case 'diff':
      return cmdDiff(joinArgs(sub, rest));
    case 'coverage':
      return cmdCoverage(joinArgs(sub, rest));
    case 'runs':
      return cmdRuns(joinArgs(sub, rest));
    case 'finding':
      if (sub !== 'add') return unknown(`finding ${sub ?? ''}`);
      return cmdFindingAdd(rest);
    case 'fixtures':
      if (sub !== 'record') return unknown(`fixtures ${sub ?? ''}`);
      return cmdFixturesRecord(rest, loadConfigFor);
    case 'registry':
      if (sub !== 'verify') return unknown(`registry ${sub ?? ''}`);
      return cmdRegistryVerify(rest);
    case 'routes':
    case 'review':
    case 'auth':
      process.stderr.write(`'${command}' lands in a later milestone — see plans/build-plan.md build order.\n`);
      return 2;
    default:
      return unknown(command);
  }
}

function joinArgs(sub: string | undefined, rest: string[]): string[] {
  return sub === undefined ? rest : [sub, ...rest];
}

function unknown(what: string): number {
  process.stderr.write(`unknown command: ${what}\nRun 'complykit help'.\n`);
  return 2;
}

// A thrown handler must not print a raw stack to a CI log as if the tool
// crashed at random — print the message, exit non-zero.
main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`complykit: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });

export { parseArgs };
