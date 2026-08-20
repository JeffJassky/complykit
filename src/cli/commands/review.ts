import { parseArgs } from 'node:util';
import {
  readFindings,
  appendFinding,
  resolveFinding,
  listRuns,
  asRunId,
  type Finding,
  type Producer,
} from '../../record/index.js';
import { getRule, resolveCapsFor, isLlmRule } from '../../rules/index.js';

// `complykit review` — the C1 pass. Drains the needs-review queue via mode-1
// crop adjudication (judge/, Anthropic SDK). The verdict cache makes a re-run of
// an unchanged site cost ~0 tokens. --dry builds the queue and reports its size
// without calling the API (works with no key).

export async function cmdReview(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      run: { type: 'string' },
      property: { type: 'string' },
      model: { type: 'string' },
      cwd: { type: 'string' },
      dry: { type: 'boolean' },
    },
    allowPositionals: false,
  });
  const cwd = values.cwd ?? process.cwd();

  const runId = values.run ? asRunId(values.run) : listRuns(values.property, cwd)[0]?.id;
  if (!runId) {
    process.stderr.write('no run to review. Run `complykit scan` first, or pass --run.\n');
    return 2;
  }
  const findings = readFindings(runId, cwd);

  // Load judge lazily so a key-less / SDK-less environment can still run --dry.
  const judge = await import('../../judge/index.js');
  const now = new Date().toISOString();

  if (values.dry) {
    const queue = judge.buildAdjudicationQueue(findings, { runId, cwd });
    process.stdout.write(`review (dry): ${queue.length} needs-review item(s) are adjudicable (have a crop + rubric).\n`);
    return 0;
  }

  let adjudicator, model: string;
  try {
    ({ adjudicator, model } = await judge.createAnthropicAdjudicator({ model: values.model }));
  } catch (err) {
    process.stderr.write(`review skipped: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  const { artifacts, stats, queued } = await judge.review(findings, { adjudicator, model, cwd, runId, capturedAt: now });

  // Convert verdict artifacts -> agent findings (the deterministic core stays the
  // gatekeeper: caps resolve through resolveCapsFor, producer stamped agent).
  let written = 0;
  for (const artifact of artifacts) {
    if (artifact.kind !== 'verdict') continue;
    const verdict = artifact.result.verdict;
    if (verdict === 'pass') continue; // cleared — no finding
    const ruleId = String(artifact.ruleId);
    const rule = getRule(ruleId);
    const rubricVersion = rule && isLlmRule(rule) ? rule.rubricVersion : 'unknown';
    const caps = resolveCapsFor(ruleId, String(artifact.result.requirementId));
    const producer: Producer = { type: 'agent', model: artifact.model, rubricVersion };
    const finding: Finding = resolveFinding(
      {
        ruleId,
        requirementId: String(artifact.result.requirementId),
        subject: artifact.subject,
        confidence: verdict === 'violation' ? 'violation' : 'needs-review',
        message: artifact.result.reason,
        evidence: [
          {
            kind: 'verdict',
            model: artifact.model,
            rubricVersion,
            cropPath: `evidence/${artifact.cropHash}.png`,
            verdict,
            reason: artifact.result.reason,
          },
        ],
      },
      { caps, runId, producer },
    );
    appendFinding(runId, finding, cwd);
    written++;
  }

  process.stdout.write(
    `review ${String(runId)}: ${queued} queued, ${stats.modelCalls} model call(s), ` +
      `${stats.cacheHits} cache hit(s), ${stats.deduped} deduped -> ${written} agent finding(s).\n`,
  );
  return 0;
}
