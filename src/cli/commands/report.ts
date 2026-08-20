import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { loadRun, listRuns, asRunId } from '../../record/index.js';
import { renderReport, renderHtmlReport, coverage, type ReportFormat } from '../../report/index.js';
import { buildCoverageIndex } from '../../coverage-index.js';

export function cmdReport(argv: string[]): number {
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

  const format = values.format as ReportFormat;
  if (!['jsonl', 'md', 'sarif', 'html'].includes(format)) {
    process.stderr.write(`unknown --format: ${format} (jsonl | md)\n`);
    return 2;
  }

  const { run, findings } = loadRun(runId, values.cwd);
  const output =
    format === 'html'
      ? renderHtmlReport(run, findings, {
          cwd: values.cwd,
          // Coverage over the common rulesets, actual-not-theoretical for this run.
          coverage: ['wcag22aa', 'gdpr', 'ai-act-50'].map((rs) => coverage(rs, buildCoverageIndex(), run)),
        })
      : renderReport(run, findings, format);

  if (values.out) {
    fs.writeFileSync(values.out, output);
    process.stdout.write(`wrote ${values.out}\n`);
  } else {
    process.stdout.write(output.endsWith('\n') ? output : output + '\n');
  }
  return 0;
}
