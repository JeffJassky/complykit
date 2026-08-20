import path from 'node:path';
import { parseArgs } from 'node:util';
import { runIdFromTimestamp } from '../../record/index.js';
import { coverage, renderCoverage } from '../../report/index.js';
import { buildCoverageIndex } from '../../coverage-index.js';
import { runStaticScan } from '../../pipeline.js';
import { assembleAndWrite } from '../write-run.js';
import { packageVersion } from '../pkg.js';

// `complykit static` — the static layer on its own: point it at a repo, get an
// in-PR run with no server and no browser. `scan` runs every configured layer.

export async function cmdStatic(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      property: { type: 'string' },
      cwd: { type: 'string' },
      ruleset: { type: 'string' },
    },
    allowPositionals: false,
  });
  const cwd = values.cwd ?? process.cwd();
  const repoDir = path.resolve(cwd, values.repo ?? '.');
  const property = values.property ?? path.basename(repoDir);
  const now = new Date().toISOString();
  const runId = runIdFromTimestamp(now);

  process.stdout.write(`static scan of ${property} (${repoDir})\n`);
  const res = await runStaticScan({ runId, property, repoDir, packageVersion: packageVersion() });

  const { run, written } = assembleAndWrite({
    runId, property, now, packageVersion: packageVersion(),
    findings: res.findings, engines: res.engineVersions, accessLevels: res.accessLevels,
    gitShaDir: repoDir, cwd,
  });

  process.stdout.write(`run ${String(run.id)}: ${written} finding(s) over ${res.fileCount} file(s)\n`);
  if (res.hasAiFeatures) {
    process.stdout.write(
      'note: AI framework imports detected. If this AI is user-facing, add the ' +
        '`has-ai-features` tag to the property config to enable EU AI Act Art. 50 checks.\n',
    );
  }
  if (res.unmapped.length) {
    process.stdout.write(`note: ${res.unmapped.length} unmapped engine rule(s) — \`complykit registry verify\`\n`);
  }
  process.stdout.write('\n' + renderCoverage(coverage(values.ruleset ?? 'wcag22aa', buildCoverageIndex(), run)) + '\n');
  return 0;
}
