import path from 'node:path';
import { parseArgs } from 'node:util';
import { writeRun, appendFinding, type Run } from '../../record/index.js';
import { coverage, renderCoverage } from '../../report/index.js';
import { buildCoverageIndex } from '../../coverage-index.js';
import { runStaticScan } from '../../pipeline.js';
import { packageVersion } from '../pkg.js';

// `complykit static` — the static layer on its own: point it at a repo, get an
// in-PR run with no server and no browser. `scan` runs every configured layer;
// `static` is the fast provable slice.

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

  process.stdout.write(`static scan of ${property} (${repoDir})\n`);
  const result = await runStaticScan({ cwd, property, repoDir, packageVersion: packageVersion() });
  const run: Run = result.run;
  writeRun(run, cwd);
  for (const f of result.findings) appendFinding(run.id, f, cwd);

  process.stdout.write(
    `run ${String(run.id)}: ${result.findings.length} finding(s) over ${result.fileCount} file(s)` +
      `${result.hasAiFeatures ? ' [has-ai-features]' : ''}\n`,
  );
  if (result.unmapped.length) {
    process.stdout.write(`note: ${result.unmapped.length} unmapped engine rule(s) — \`complykit registry verify\`\n`);
  }
  process.stdout.write('\n' + renderCoverage(coverage(values.ruleset ?? 'wcag22aa', buildCoverageIndex(), run)) + '\n');
  return 0;
}
