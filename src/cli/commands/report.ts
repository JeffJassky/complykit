import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadRun, listRuns, asRunId } from '../../record/index.js';
import { renderReport, renderHtmlReport, renderJsonReport, coverage, type ReportFormat } from '../../report/index.js';
import { buildCoverageIndex } from '../../coverage-index.js';
import { loadDispositions, applyDispositions } from '../../report/dispositions.js';
import { buildVueScopeMap, enrichFindingsWithVueSource } from '../../enrich/vue-scope.js';
import type { LoadedConfig } from '../config-load.js';

type LoadConfig = (opts: { url?: string; config?: string }, cwd?: string) => Promise<LoadedConfig>;

export async function cmdReport(argv: string[], loadConfig?: LoadConfig): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      run: { type: 'string' },
      property: { type: 'string' },
      format: { type: 'string', default: 'md' },
      out: { type: 'string' },
      cwd: { type: 'string' },
    },
    allowPositionals: false,
  });

  const runId = values.run
    ? asRunId(values.run)
    : listRuns(values.property, values.cwd)[0]?.id;
  if (!runId) {
    process.stderr.write('no run to report. Pass --run <id> or run `complykit scan` first.\n');
    return 2;
  }

  const format = values.format as ReportFormat | 'json';
  if (!['jsonl', 'md', 'sarif', 'html', 'json'].includes(format)) {
    process.stderr.write(`unknown --format: ${format} (jsonl | md | sarif | html | json)\n`);
    return 2;
  }

  const { run, findings: rawFindings } = loadRun(runId, values.cwd);

  // Triage ledger: render-time only — stored findings stay granular. Only
  // false-positive dispositions are removed; everything else stays visible.
  const { findings, excluded } = applyDispositions(rawFindings, loadDispositions(values.cwd));
  if (excluded) process.stderr.write(`${excluded} finding(s) excluded by dispositions (false-positive)\n`);

  // Retroactive source mapping: runs stored before scan-time enrichment (or by
  // an older version) get their browser findings mapped to .vue files here,
  // in-memory, when the config declares a repo for this property.
  if (loadConfig && findings.length) {
    try {
      const { config } = await loadConfig({}, values.cwd);
      const prop = config.properties.find((p) => p.id === run.property);
      if (prop?.repo) {
        const repoDir = path.resolve(values.cwd ?? process.cwd(), prop.repo);
        enrichFindingsWithVueSource(findings, buildVueScopeMap(repoDir), repoDir);
      }
    } catch {
      /* no config reachable — render as stored */
    }
  }

  // Coverage over the common rulesets, actual-not-theoretical for this run.
  const cov = ['wcag22aa', 'gdpr', 'ai-act-50'].map((rs) => coverage(rs, buildCoverageIndex(), run));

  const output =
    format === 'html'
      ? renderHtmlReport(run, findings, { cwd: values.cwd, coverage: cov })
      : format === 'json'
        ? renderJsonReport(run, findings, { coverage: cov, cwd: values.cwd })
        : renderReport(run, findings, format);

  if (values.out) {
    fs.writeFileSync(values.out, output);
    process.stdout.write(`wrote ${values.out}\n`);
    // The HTML report always gets its machine-readable sibling: the same
    // aggregated defect model as JSON, so scripts (or an LLM writing one) can
    // find/filter/group without parsing HTML.
    if (format === 'html') {
      const jsonOut = values.out.replace(/\.html?$/i, '') + '.json';
      fs.writeFileSync(jsonOut, renderJsonReport(run, findings, { coverage: cov, cwd: values.cwd }));
      process.stdout.write(`wrote ${jsonOut}\n`);
    }
  } else {
    process.stdout.write(output.endsWith('\n') ? output : output + '\n');
  }
  return 0;
}
