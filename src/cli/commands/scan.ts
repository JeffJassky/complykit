import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  runIdFromTimestamp,
  type Finding,
  type CoverageGap,
  type MatrixCell,
  type AccessLevel,
} from '../../record/index.js';
import { coverage, renderCoverage } from '../../report/index.js';
import { buildCoverageIndex } from '../../coverage-index.js';
import { runStaticScan, runBrowserScan } from '../../pipeline.js';
import { assembleAndWrite } from '../write-run.js';
import type { LoadedConfig } from '../config-load.js';
import { packageVersion } from '../pkg.js';
import type { Property } from '../../config.js';

type LoadConfig = (opts: { url?: string; config?: string }, cwd?: string) => Promise<LoadedConfig>;

export async function cmdScan(argv: string[], loadConfig: LoadConfig): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: 'string' },
      config: { type: 'string' },
      property: { type: 'string' },
      cwd: { type: 'string' },
      'no-browser': { type: 'boolean' },
    },
    allowPositionals: false,
  });
  const cwd = values.cwd ?? process.cwd();
  const pkg = packageVersion();

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
  const runId = runIdFromTimestamp(now);

  const repoDir = property.repo ? path.resolve(cwd, property.repo) : undefined;
  const publicUrl = property.targets.public?.url ?? values.url;

  const findings: Finding[] = [];
  const gaps: CoverageGap[] = [];
  const matrix: MatrixCell[] = [];
  const engines: Record<string, string> = {};
  const accessLevels: AccessLevel[] = [];

  if (repoDir) {
    process.stdout.write('· static layer…\n');
    const res = await runStaticScan({ runId, property: property.id, repoDir, tags: property.tags, packageVersion: pkg });
    findings.push(...res.findings);
    Object.assign(engines, res.engineVersions);
    accessLevels.push(...res.accessLevels);
    process.stdout.write(`  ${res.findings.length} static finding(s) over ${res.fileCount} file(s)\n`);
    if (res.hasAiFeatures && !property.tags?.includes('has-ai-features')) {
      process.stdout.write('  note: AI framework imports detected — add the `has-ai-features` tag to enable EU AI Act Art. 50 checks.\n');
    }
  }

  if (publicUrl && !values['no-browser']) {
    process.stdout.write(`· browser layer (${publicUrl})…\n`);
    try {
      const res = await runBrowserScan({
        runId, property: property.id, targetUrl: publicUrl, cwd, tags: property.tags, packageVersion: pkg,
        viewports: property.viewports, schemes: property.colorSchemes, routes: property.routes,
      });
      findings.push(...res.findings);
      gaps.push(...res.gaps);
      matrix.push(...res.matrix);
      Object.assign(engines, res.engineVersions);
      accessLevels.push(...res.accessLevels);
      process.stdout.write(`  ${res.findings.length} browser finding(s) over ${res.scanned.length} route(s); ${res.gaps.length} gap(s)\n`);
      if (res.spike.closedShadowHosts) {
        process.stdout.write(`  closed-shadow spike: ${res.spike.closedShadowHosts} host(s), pierced=${res.spike.piercedClosedShadow}\n`);
      }
    } catch (err) {
      process.stderr.write(`  browser layer skipped: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  } else if (!repoDir) {
    process.stdout.write('nothing to scan: no repo and no public target.\n');
  }

  const { run, written } = assembleAndWrite({
    runId, property: property.id, now, packageVersion: pkg,
    findings, engines, accessLevels, gaps, matrix,
    gitShaDir: repoDir, cwd,
  });
  process.stdout.write(`\nrun ${String(run.id)}: ${written} finding(s) total\n\n`);
  for (const ruleset of property.rulesets) {
    process.stdout.write(renderCoverage(coverage(ruleset, buildCoverageIndex(), run)) + '\n');
  }
  return 0;
}
