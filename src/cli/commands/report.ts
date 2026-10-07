import { Timeline } from '../../record/index.js';
import { summarizeBehavior } from '../../rules/tracking/summary.js';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadRun, listRuns, asRunId, runDir, readTrackingEvaluation } from '../../record/index.js';
import {
  renderReport,
  renderHtmlReport,
  renderJsonReport,
  coverage,
  buildConsentReportModel,
  renderConsentHtml,
  renderConsentMarkdown,
  renderChangeListMarkdown,
  diffConsentModels,
  reportRenderInfo,
  CHANGE_LIST_FILE,
  type ReportFormat,
} from '../../report/index.js';
import { reconcileRecord } from '../../consent-compatibility.js';
import { applyWorkspaceToRecord, refuseNecessaryTrackers } from '../../consent-generator.js';
import { tracking } from '../../rules/index.js';
import { buildKnowledgeBase, type KnowledgeEntryInput } from '../../registry/index.js';
import { KbStore, defaultKbDir } from '../../research/index.js';
import { readWorkspaceFile, readConsentRunDir, findPreviousConsentRun, type PreviousRun } from '../previous-run.js';
import type { WorkspaceSnapshot } from '../../site-workspace.js';
import { readRunRemediation } from '../remediation-input.js';
import { buildCoverageIndex } from '../../coverage-index.js';
import { loadDispositions, applyDispositions } from '../../report/dispositions.js';
import { buildVueScopeMap, enrichFindingsWithVueSource } from '../../enrich/vue-scope.js';
import type { LoadedConfig } from '../config-load.js';

/** Without --workspace: the classifications the record says were applied (at scan time), as workspace entries. */
function appliedEntries(ws: { classifications: Array<{ key: string; at?: string }> } | undefined): { entries: Record<string, { value: unknown; at?: string }> } | undefined {
  if (!ws) return undefined;
  return { entries: Object.fromEntries(ws.classifications.map((c) => [c.key, { value: true, ...(c.at ? { at: c.at } : {}) }])) };
}

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
      // Consent formats (R2, recompute in place): the site workspace to apply,
      // the run to compare with for "Since", the knowledge-base store.
      workspace: { type: 'string' },
      previous: { type: 'string' },
      'kb-dir': { type: 'string' },
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

  const format = values.format as ReportFormat | 'json' | 'consent-html' | 'consent-md' | 'consent-json' | 'consent-changes';
  if (!['jsonl', 'md', 'sarif', 'html', 'json', 'consent-html', 'consent-md', 'consent-json', 'consent-changes'].includes(format)) {
    process.stderr.write(`unknown --format: ${format} (jsonl | md | sarif | html | json | consent-html | consent-md | consent-json | consent-changes)\n`);
    return 2;
  }

  const { run, findings: rawFindings } = loadRun(runId, values.cwd);

  // Consent evaluation runs carry tracking.json; their report has its own shape
  // (summary grid, inventory, not tested).
  if (format.startsWith('consent-')) {
    const dir = runDir(runId, values.cwd);
    const evaluation = readTrackingEvaluation(dir);
    if (!evaluation) {
      process.stderr.write(`run ${String(runId)} has no consent evaluation (tracking.json). Run \`complykit consent\` first.\n`);
      return 2;
    }
    let workspace: WorkspaceSnapshot | undefined;
    if (values.workspace) {
      try {
        workspace = readWorkspaceFile(path.resolve(values.cwd ?? process.cwd(), values.workspace));
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        return 2;
      }
    }
    let previous: PreviousRun | undefined;
    if (values.previous) {
      const prevDir = path.resolve(values.cwd ?? process.cwd(), values.previous);
      try {
        previous = readConsentRunDir(prevDir);
      } catch (err) {
        process.stderr.write(`--previous ${prevDir}: ${err instanceof Error ? err.message : String(err)}\n`);
        return 2;
      }
      if (!previous) {
        process.stderr.write(`--previous ${prevDir}: no consent evaluation (tracking.json) there\n`);
        return 2;
      }
    }
    const { findings: kept, excluded: ex } = applyDispositions(rawFindings, loadDispositions(values.cwd));
    if (ex) process.stderr.write(`${ex} finding(s) excluded by dispositions (false-positive)\n`);
    // Older runs can recover the matrix from their saved timelines, without a new scan.
    if (!evaluation.behaviorObservations) {
      const timelines = evaluation.locations.flatMap(l => l.scenarios.flatMap(s => {
        if (!s.evidence.timeline) return [];
        const file = path.resolve(dir, s.evidence.timeline);
        if (!file.startsWith(dir + path.sep)) return [];
        try { return [Timeline.parse(JSON.parse(fs.readFileSync(file, 'utf8')))]; } catch { return []; }
      }));
      evaluation.behaviorObservations = summarizeBehavior(timelines);
    }
    if (workspace) {
      // The site's classifications as of now, applied to the saved record the
      // way the generator applies them (consent-config), so the report, the
      // change list and the generated config agree. Same KB as the scan: the
      // seed plus the store's confirmed entries.
      const kbStore = new KbStore(values['kb-dir'] ? path.resolve(values.cwd ?? process.cwd(), values['kb-dir']) : defaultKbDir());
      let stored: KnowledgeEntryInput[] = [];
      try {
        stored = kbStore.confirmedEntries();
      } catch (err) {
        process.stderr.write(`knowledge-base store ${kbStore.dir}: ${err instanceof Error ? err.message : String(err)} — using the seed entries only\n`);
      }
      const kb = buildKnowledgeBase({ extra: stored });
      applyWorkspaceToRecord(evaluation, workspace, kb, new Date().toISOString());
      for (const n of refuseNecessaryTrackers(evaluation, kb)) process.stderr.write(`refused: ${n.message}\n`);
      // Is the deployed tool's config the workspace's latest (D10)? Re-read against the current workspace.
      reconcileRecord(evaluation, { kb, workspace });
    } else {
      // Compatibility as this build decides it, against this build's matrix (older
      // records have none; newer ones are re-decided the same way the scan does).
      reconcileRecord(evaluation);
    }
    const model = buildConsentReportModel(evaluation, kept);
    // R3: the checklist from the workspace's latest config, else this run's generated output.
    const remediation = readRunRemediation(dir, workspace);
    if (remediation) model.remediation = remediation;
    // "Since <date>", as the scan writes it: --previous, else the newest earlier run of the site here.
    if (!previous) {
      try {
        previous = findPreviousConsentRun({ cwd: values.cwd ?? process.cwd(), current: String(runId), site: evaluation.site.registrableDomain, before: evaluation.startedAt });
      } catch {
        previous = undefined;
      }
    }
    if (previous) model.since = diffConsentModels(buildConsentReportModel(previous.evaluation, previous.findings), model);
    const text =
      format === 'consent-html'
        ? renderConsentHtml(model, { runDir: dir, render: reportRenderInfo(String(runId), workspace ?? appliedEntries(evaluation.siteWorkspace)) })
        : format === 'consent-md'
          ? renderConsentMarkdown(model)
          : format === 'consent-changes'
            ? renderChangeListMarkdown(model)
            : JSON.stringify(model, null, 2);
    if (values.out) {
      fs.writeFileSync(values.out, text);
      process.stdout.write(`wrote ${values.out}\n`);
      // The HTML links the change list by name: write it beside the report,
      // with the model as JSON (what the scan writes beside its report).
      if (format === 'consent-html') {
        fs.writeFileSync(values.out.replace(/\.html?$/i, '') + '.json', JSON.stringify(model, null, 2));
        const cl = path.join(path.dirname(values.out), CHANGE_LIST_FILE);
        fs.writeFileSync(cl, renderChangeListMarkdown(model));
        process.stdout.write(`wrote ${cl}\n`);
      }
    } else process.stdout.write(text.endsWith('\n') ? text : text + '\n');
    return 0;
  }

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
        : renderReport(run, findings, format as ReportFormat);

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
