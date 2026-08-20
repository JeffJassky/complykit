import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { writeRun, runIdFromTimestamp, appendFinding, type Run } from '../../record/index.js';
import { REGISTRY_VERSION } from '../../registry/index.js';
import { coverage, renderCoverage } from '../../report/index.js';
import { buildCoverageIndex } from '../../coverage-index.js';
import { runStaticScan } from '../../pipeline.js';
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

  // Static layer runs when a repo is available (property.repo, or the cwd for a
  // config-driven scan). A pure `scan --url` with no repo has no static surface
  // yet — the browser layer (M2) handles it.
  const repoDir = property.repo ? path.resolve(cwd, property.repo) : values.url ? undefined : cwd;

  if (repoDir) {
    const result = await runStaticScan({
      cwd,
      property: property.id,
      repoDir,
      tags: property.tags,
      packageVersion: packageVersion(),
    });
    const run: Run = { ...result.run, gitSha: gitSha(repoDir) };
    writeRun(run, cwd);
    for (const f of result.findings) appendFinding(run.id, f, cwd);

    process.stdout.write(
      `run ${String(run.id)}: ${result.findings.length} finding(s) over ${result.fileCount} file(s)` +
        `${result.hasAiFeatures ? ' [has-ai-features derived]' : ''}\n`,
    );
    if (result.unmapped.length) {
      process.stdout.write(
        `note: ${result.unmapped.length} engine rule(s) the registry does not map (engine drift) — run \`complykit registry verify\`:\n`,
      );
      for (const u of result.unmapped.slice(0, 10)) {
        process.stdout.write(`  ${u.engine}/${u.engineRule} (${u.count})\n`);
      }
    }
    process.stdout.write('\n');
    for (const ruleset of property.rulesets) {
      process.stdout.write(renderCoverage(coverage(ruleset, buildCoverageIndex(), run)) + '\n');
    }
    return 0;
  }

  // No repo (pure --url): write a valid empty run; browser collection is M2.
  const now = new Date().toISOString();
  const run: Run = {
    schemaVersion: 1,
    id: runIdFromTimestamp(now),
    property: property.id,
    startedAt: now,
    finishedAt: now,
    versions: { package: packageVersion(), registry: REGISTRY_VERSION, engines: {} },
    accessLevels: [],
    matrix: [],
    gaps: [],
    rulesExecuted: [],
  };
  writeRun(run, cwd);
  process.stdout.write(`run ${String(run.id)} written (no repo configured; browser collection lands in M2).\n\n`);
  for (const ruleset of property.rulesets) {
    process.stdout.write(renderCoverage(coverage(ruleset, buildCoverageIndex(), run)) + '\n');
  }
  return 0;
}
