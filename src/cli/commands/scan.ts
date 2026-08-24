import path from 'node:path';
import fs from 'node:fs';
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
import { filterFindings, partialStamp, splitList, type TargetingFlags } from '../targeting.js';

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
      quiet: { type: 'boolean' }, // suppress per-navigation trace
      // Targeting overrides (see cli/targeting.ts) — narrow the scan to verify
      // one fix fast. Any of these marks the run `partial`.
      routes: { type: 'string' }, // substrings; overrides routes.include
      'max-pages': { type: 'string' },
      viewports: { type: 'string' }, // preset ids, comma-separated
      schemes: { type: 'string' }, // light,dark
      only: { type: 'string' }, // static | browser
      rules: { type: 'string' }, // ruleId substrings — filters kept findings
      requirements: { type: 'string' }, // requirementId prefixes
      law: { type: 'string' }, // instrument prefix (wcag22 | gdpr | eu-ai-act)
    },
    allowPositionals: false,
  });
  const cwd = values.cwd ?? process.cwd();
  const pkg = packageVersion();

  // Per-navigation narration (crawl + scan). On by default: a browser scan that
  // silently discovers one route looks identical to one that's working, so the
  // trace is what makes "every URL landed on /app/aeo" visible without a probe
  // script. `--quiet` drops it.
  const trace = values.quiet ? undefined : (line: string) => process.stdout.write(`    ${line}\n`);

  const { config, source } = await loadConfig({ url: values.url, config: values.config }, cwd);
  const property: Property | undefined = values.property
    ? config.properties.find((p) => p.id === values.property)
    : config.properties[0];
  if (!property) {
    process.stderr.write(`property not found: ${values.property}\n`);
    return 2;
  }

  // Targeting overrides — validate early, narrate what's narrowed.
  const targeting: TargetingFlags = values;
  const partial = partialStamp(targeting);
  if (values.only && !['static', 'browser'].includes(values.only)) {
    process.stderr.write(`--only must be "static" or "browser", got: ${values.only}\n`);
    return 2;
  }
  const routeIncludes = splitList(values.routes);
  const vpOverride = splitList(values.viewports);
  const schemeOverride = splitList(values.schemes) as NonNullable<Property['colorSchemes']>;

  process.stdout.write(`scanning ${property.id} (config: ${source})\n`);
  if (partial) {
    process.stdout.write(
      `  TARGETED (partial) run — ${Object.entries(partial).map(([k, v]) => `${k}=${v}`).join(' ')}\n` +
        `  totals below are not comparable to a full run.\n`,
    );
  }
  const now = new Date().toISOString();
  const runId = runIdFromTimestamp(now);

  const repoDir = property.repo ? path.resolve(cwd, property.repo) : undefined;
  const publicUrl = property.targets.public?.url ?? values.url;

  let storageStatePath: string | undefined;
  if (property.auth?.kind === 'storage-state') {
    const resolved = path.resolve(cwd, property.auth.path);
    if (fs.existsSync(resolved)) {
      storageStatePath = resolved;
    } else {
      process.stdout.write(
        `  auth configured (storage-state) but not found at ${resolved} — scanning public-only, authed routes become a coverage gap.\n`,
      );
    }
  } else if (property.auth?.kind === 'form') {
    process.stdout.write('  auth kind "form" is not implemented yet — scanning public-only.\n');
  }

  const findings: Finding[] = [];
  const gaps: CoverageGap[] = [];
  const matrix: MatrixCell[] = [];
  const engines: Record<string, string> = {};
  const accessLevels: AccessLevel[] = [];

  if (repoDir && values.only !== 'browser') {
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

  if (publicUrl && !values['no-browser'] && values.only !== 'static') {
    process.stdout.write(`· browser layer (${publicUrl})…\n`);
    try {
      // Route/matrix narrowing: --routes replaces include (exclude still
      // applies), --max-pages caps the crawl, --viewports/--schemes shrink the
      // measurement matrix. Cell count is the cost driver, so this is where a
      // targeted verify gets its speed.
      // Path-shaped --routes entries also SEED the crawl directly — a deep
      // target stays reachable even when every intermediate page is filtered.
      const routeSeeds = routeIncludes
        .filter((r) => r.startsWith('/'))
        .map((r) => new URL(r, publicUrl).toString());
      const routes = routeIncludes.length || values['max-pages']
        ? {
            ...property.routes,
            ...(routeIncludes.length ? { include: routeIncludes, seeds: routeSeeds } : {}),
            ...(values['max-pages']
              ? { crawl: { sameOrigin: true, ...property.routes?.crawl, maxPages: Number(values['max-pages']) } }
              : {}),
          }
        : property.routes;
      const res = await runBrowserScan({
        runId, property: property.id, targetUrl: publicUrl, cwd, tags: property.tags, packageVersion: pkg,
        repoDir,
        viewports: vpOverride.length ? vpOverride : property.viewports,
        schemes: schemeOverride.length ? schemeOverride : property.colorSchemes,
        routes,
        storageStatePath, trace,
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

  // Finding-level targeting (--rules/--requirements/--law) applies at record
  // time: the narrowed run stores only the slice being verified.
  const kept = filterFindings(findings, targeting);
  if (kept.length !== findings.length) {
    process.stdout.write(`  targeting: kept ${kept.length} of ${findings.length} finding(s)\n`);
  }

  const { run, written } = assembleAndWrite({
    runId, property: property.id, now, packageVersion: pkg,
    findings: kept, engines, accessLevels, gaps, matrix,
    gitShaDir: repoDir, cwd, partial,
  });
  process.stdout.write(`\nrun ${String(run.id)}: ${written} finding(s) total\n\n`);
  for (const ruleset of property.rulesets) {
    process.stdout.write(renderCoverage(coverage(ruleset, buildCoverageIndex(), run)) + '\n');
  }
  return 0;
}
