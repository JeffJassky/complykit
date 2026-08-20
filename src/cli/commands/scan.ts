import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { writeRun, runIdFromTimestamp, type Run } from '../../record/index.js';
import { REGISTRY_VERSION } from '../../registry/index.js';
import { coverage, renderCoverage, type CoverageIndex, type RuleLayer } from '../../report/index.js';
import { ALL_RULES } from '../../rules/index.js';
import type { LoadedConfig } from '../config-load.js';
import { packageVersion } from '../pkg.js';
import type { Property } from '../../config.js';

type LoadConfig = (opts: { url?: string; config?: string }, cwd?: string) => Promise<LoadedConfig>;

function gitSha(cwd: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function coverageIndex(): CoverageIndex {
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

export async function cmdScan(argv: string[], loadConfig: LoadConfig): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: 'string' },
      config: { type: 'string' },
      property: { type: 'string' },
      cwd: { type: 'string' },
    },
    allowPositionals: false,
  });
  const cwd = values.cwd ?? process.cwd();

  const { config, source } = await loadConfig({ url: values.url, config: values.config }, cwd);
  const property: Property | undefined = values.property
    ? config.properties.find((p) => p.id === values.property)
    : config.properties[0];
  if (!property) {
    process.stderr.write(`property not found: ${values.property}\n`);
    return 2;
  }

  process.stdout.write(`scanning ${property.id} (config: ${source})\n`);

  const now = new Date().toISOString();
  const run: Run = {
    schemaVersion: 1,
    id: runIdFromTimestamp(now),
    property: property.id,
    startedAt: now,
    finishedAt: new Date().toISOString(),
    versions: {
      package: packageVersion(),
      registry: REGISTRY_VERSION,
      engines: {},
    },
    gitSha: gitSha(cwd),
    // Collection lands in M1 (static) and M2 (browser). Until then a scan
    // produces a valid, empty run — the zero-config path works end to end and
    // grows real findings as the collectors arrive.
    accessLevels: [],
    matrix: [],
    gaps: [],
    rulesExecuted: [],
  };
  const dir = writeRun(run, cwd);
  process.stdout.write(`run ${String(run.id)} written to ${dir}\n`);
  process.stdout.write('note: collectors land in M1 (static) and M2 (browser); this run has no findings yet.\n\n');

  for (const ruleset of property.rulesets) {
    process.stdout.write(renderCoverage(coverage(ruleset, coverageIndex(), run)) + '\n');
  }
  return 0;
}
