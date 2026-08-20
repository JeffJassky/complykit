import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addFinding,
  writeRun,
  loadRun,
  readFindings,
  renderReport,
  diffRuns,
  budgetBreaches,
  runIdFromTimestamp,
  asRunId,
  asRuleId,
  asRequirementId,
  REGISTRY_VERSION,
  type Run,
  type RawFinding,
  type Producer,
} from '../src/index.js';

// M0 definition of done: a hand-written finding round-trips through jsonl ->
// report -> diff.

let cwd: string;
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'complykit-'));
});
afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

function makeRun(id: string, property = 'shop'): Run {
  return {
    schemaVersion: 1,
    id: asRunId(id),
    property,
    startedAt: '2026-08-19T00:00:00.000Z',
    versions: { package: '0.0.0', registry: REGISTRY_VERSION, engines: {} },
    accessLevels: ['public'],
    matrix: [],
    gaps: [],
    rulesExecuted: [],
  };
}

const producer: Producer = { type: 'agent', model: 'claude', rubricVersion: '2026-08-19.1' };

const raw: RawFinding = {
  ruleId: asRuleId('art50.ai-interaction-disclosure'),
  requirementId: asRequirementId('eu-ai-act.art50.1'),
  subject: { property: 'shop', routePattern: '/assistant' },
  confidence: 'needs-review',
  message: 'No notice that the assistant is an AI system was found.',
  evidence: [{ kind: 'dom-snippet', html: '<div class="chat">' }],
};

describe('finding round-trip', () => {
  it('writes a finding to jsonl and reads it back identically', () => {
    const run = makeRun(runIdFromTimestamp('2026-08-19T10:00:00.000Z'));
    writeRun(run, cwd);
    const stored = addFinding(raw, { runId: run.id, producer, cwd });

    const readBack = readFindings(run.id, cwd);
    expect(readBack).toHaveLength(1);
    expect(readBack[0]).toEqual(stored);
    expect(readBack[0].fingerprint).toBe(stored.fingerprint);
    expect(readBack[0].producer).toEqual(producer);
  });

  it('renders the run to markdown and jsonl without the word "compliant"', () => {
    const run = makeRun(runIdFromTimestamp('2026-08-19T10:00:00.000Z'));
    writeRun(run, cwd);
    addFinding(raw, { runId: run.id, producer, cwd });
    const { run: loaded, findings } = loadRun(run.id, cwd);

    const md = renderReport(loaded, findings, 'md');
    expect(md).toContain('eu-ai-act.art50.1');
    expect(md).toContain('findings');
    expect(md.toLowerCase()).not.toContain('compliant');

    const jsonl = renderReport(loaded, findings, 'jsonl');
    expect(jsonl.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(jsonl.trim())).toEqual(findings[0]);
  });

  it('diffs two runs by fingerprint: the finding is added, then persists', () => {
    const base = makeRun(runIdFromTimestamp('2026-08-19T10:00:00.000Z'));
    const head = makeRun(runIdFromTimestamp('2026-08-19T11:00:00.000Z'));
    writeRun(base, cwd);
    writeRun(head, cwd);
    addFinding(raw, { runId: head.id, producer, cwd });

    const diff = diffRuns(loadRun(base.id, cwd), loadRun(head.id, cwd));
    expect(diff.added).toHaveLength(1);
    expect(diff.resolved).toHaveLength(0);
    expect(diff.persisting).toHaveLength(0);

    // Same finding present in both -> persisting, not added.
    addFinding(raw, { runId: base.id, producer, cwd });
    const diff2 = diffRuns(loadRun(base.id, cwd), loadRun(head.id, cwd));
    expect(diff2.added).toHaveLength(0);
    expect(diff2.persisting).toHaveLength(1);
  });

  it('the budget gate ignores a new needs-review finding under new-critical', () => {
    const base = makeRun(runIdFromTimestamp('2026-08-19T10:00:00.000Z'));
    const head = makeRun(runIdFromTimestamp('2026-08-19T11:00:00.000Z'));
    writeRun(base, cwd);
    writeRun(head, cwd);
    addFinding(raw, { runId: head.id, producer, cwd });
    const diff = diffRuns(loadRun(base.id, cwd), loadRun(head.id, cwd));
    // art50 requirement default severity is "serious", so new-critical does not trip.
    expect(budgetBreaches(diff, 'new-critical')).toHaveLength(0);
    expect(budgetBreaches(diff, 'new-serious')).toHaveLength(1);
  });
});
