import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addFinding,
  resolveFinding,
  resolveCapsFor,
  writeRun,
  readFindings,
  runIdFromTimestamp,
  asRunId,
  asRuleId,
  asRequirementId,
  REGISTRY_VERSION,
  type Run,
  type Producer,
  type RawFinding,
  type FindingCaps,
} from '../src/index.js';

// No producer can inflate its own authority. These are the tests behind
// build-plan's "confidence capped by rule metadata, severity narrows-never-raises".

let cwd: string;
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'complykit-'));
});
afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

const producer: Producer = { type: 'agent', model: 'claude', rubricVersion: '1' };
function run(): Run {
  const r: Run = {
    schemaVersion: 1,
    id: asRunId(runIdFromTimestamp('2026-08-19T10:00:00.000Z')),
    property: 'shop',
    startedAt: '2026-08-19T00:00:00.000Z',
    versions: { package: '0.0.0', registry: REGISTRY_VERSION, engines: {} },
    accessLevels: [],
    matrix: [],
    gaps: [],
    rulesExecuted: [],
  };
  writeRun(r, cwd);
  return r;
}

describe('finding authority', () => {
  it('caps a violation claim to the rule\'s needs-review maximum', () => {
    const r = run();
    // art50 rule may assert at most needs-review; the agent claims violation.
    const stored = addFinding(
      {
        ruleId: 'art50.ai-interaction-disclosure',
        requirementId: 'eu-ai-act.art50.1',
        subject: { property: 'shop', routePattern: '/assistant' },
        confidence: 'violation',
        message: 'claims a hard violation',
        evidence: [],
      },
      { runId: r.id, producer, cwd },
    );
    expect(stored.confidence).toBe('needs-review');
    expect(readFindings(r.id, cwd)[0].confidence).toBe('needs-review');
  });

  it('refuses a finding citing a requirement the rule does not declare', () => {
    const r = run();
    expect(() =>
      addFinding(
        {
          ruleId: 'art50.ai-interaction-disclosure',
          requirementId: 'wcag22.1.4.3', // real requirement, not this rule's hook
          subject: { property: 'shop', routePattern: '/assistant' },
          confidence: 'needs-review',
          message: 'wrong requirement',
          evidence: [],
        },
        { runId: r.id, producer, cwd },
      ),
    ).toThrow(/not among rule/);
  });

  it('throws when a rule severity would raise the requirement default', () => {
    const raw: RawFinding = {
      ruleId: asRuleId('x'),
      requirementId: asRequirementId('y'),
      subject: { property: 'p', routePattern: '/r' },
      confidence: 'needs-review',
      message: 'm',
      evidence: [],
    };
    const raising: FindingCaps = {
      detects: 'absence',
      maxConfidence: 'needs-review',
      requirementSeverity: 'minor',
      ruleSeverity: 'critical', // raises — illegal
      ruleRequirements: [asRequirementId('y')],
    };
    expect(() =>
      resolveFinding(raw, { caps: raising, runId: asRunId('run'), producer }),
    ).toThrow(/raises the requirement default/);
  });

  it('resolves severity from the requirement default when the rule does not narrow', () => {
    const r = run();
    const stored = addFinding(
      {
        ruleId: 'art50.ai-interaction-disclosure',
        requirementId: 'eu-ai-act.art50.1',
        subject: { property: 'shop', routePattern: '/assistant' },
        confidence: 'needs-review',
        message: 'm',
        evidence: [],
      },
      { runId: r.id, producer, cwd },
    );
    // art50.1 requirement default severity is "serious"; the rule declares none.
    expect(stored.severity).toBe('serious');
  });

  it('resolveCapsFor rejects an unknown rule', () => {
    expect(() => resolveCapsFor('nope.not-a-rule', 'eu-ai-act.art50.1')).toThrow(/unknown rule/);
  });
});
