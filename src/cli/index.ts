#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';

import { loadConfigFor } from './config-load.js';
import { cmdInit } from './commands/init.js';
import { cmdScan } from './commands/scan.js';
import { cmdStatic } from './commands/static.js';
import { cmdReport } from './commands/report.js';
import { cmdReview } from './commands/review.js';
import { cmdDiff } from './commands/diff.js';
import { cmdCoverage } from './commands/coverage.js';
import { cmdFindingAdd } from './commands/finding-add.js';
import { cmdRegistryVerify } from './commands/registry-verify.js';
import { cmdFixturesRecord } from './commands/fixtures-record.js';
import { cmdRuns } from './commands/runs.js';
import { cmdConsent } from './commands/consent.js';
import { cmdConsentConfig } from './commands/consent-config.js';
import { cmdKb } from './commands/kb.js';
import { cmdVerifyChange } from './commands/verify-change.js';

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
                           Targeting (marks the run partial, for fast fix-verify):
                             --routes <substr,…>   crawl only matching routes
                             --max-pages N         cap the crawl
                             --viewports a,b       subset of configured presets
                             --schemes light,dark  subset of color schemes
                             --only static|browser one layer only
                             --rules <substr,…>    keep findings matching ruleId
                             --requirements <p,…>  keep by requirementId prefix
                             --law <prefix>        keep one instrument (wcag22|gdpr|…)
  consent                  Consent & tracking evaluation by visitor location: real
                           browser, verified locations, consent scenarios, HAR
                           evidence (zero-config: complykit consent --url …;
                           see complykit consent --help)
  consent-config <run-dir> The consent tool's config from a consent run:
                           complykit-config.json, snippet.html, change-list.md
                           (see complykit consent-config --help)
  verify-change            Verify ONE remediation task: fetch its page / GTM
                           container (or a one-page reject-then-accept spot
                           check) and run its checker (see verify-change --help)
  static                   Static layer only: point at a repo, get an in-PR run
  report                   Render a run (--format jsonl|md|sarif|html|json;
                           html also writes a .json sidecar next to --out;
                           consent runs: --format consent-html|consent-md|consent-json|consent-changes;
                           --workspace <file> re-renders with the site's current
                           classifications, no rescan; --previous <run dir> for "Since")
  review                   Adjudicate the needs-review queue with C1 (LLM); --dry to preview
  diff                     Compare two runs by fingerprint
  coverage                 Requirement coverage for a ruleset
  finding add              Validate + fingerprint a finding into a run
  fixtures record          Record collector artifacts as rule test fixtures
  registry verify          Validate the registry; list items needing a human check
  runs                     List recorded runs

  routes | auth            (land in later milestones)

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
    case 'consent':
      return cmdConsent(joinArgs(sub, rest), loadConfigFor);
    case 'consent-config':
      return cmdConsentConfig(joinArgs(sub, rest));
    case 'kb':
      return cmdKb(joinArgs(sub, rest));
    case 'verify-change':
      return cmdVerifyChange(joinArgs(sub, rest));
    case 'static':
      return cmdStatic(joinArgs(sub, rest));
    case 'report':
      return cmdReport(joinArgs(sub, rest), loadConfigFor);
    case 'review':
      return cmdReview(joinArgs(sub, rest));
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
// crashed at random — print the message, exit non-zero. Set exitCode rather
// than calling process.exit(): exit() drops un-flushed stdout on pipes, which
// truncates large reports (`--format json | jq` died at 64KB).
main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`complykit: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });

export { parseArgs };
