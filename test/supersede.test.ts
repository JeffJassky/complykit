import { describe, it, expect } from 'vitest';
import { supersedeByMeasurement } from '../src/enrich/supersede.js';
import { asRuleId, asRequirementId, asRunId, fingerprint, type Finding, type Artifact } from '../src/index.js';

const CELL = { property: 'app', routePattern: '/x', instanceUrl: 'http://x/', viewport: 'desktop', colorScheme: 'light' as const };

function finding(
  ruleId: string,
  confidence: 'violation' | 'needs-review',
  box?: { x: number; y: number; width: number; height: number },
): Finding {
  const subject = { ...CELL, locator: { role: 'element', ordinal: 0 } };
  return {
    schemaVersion: 1,
    ruleId: asRuleId(ruleId),
    requirementId: asRequirementId('wcag22.1.4.3'),
    subject,
    confidence,
    severity: 'serious',
    message: 'm',
    details: box ? { box } : undefined,
    evidence: [],
    fingerprint: fingerprint({ detects: 'presence', ruleId: asRuleId(ruleId), subject }),
    producer: { type: 'engine', name: 'axe-core', version: '4' },
    runId: asRunId('2026-08-20T00-00-00.000Z'),
  };
}

function probe(results: Array<Record<string, unknown>>): Artifact {
  return { kind: 'style-probe', subject: CELL, capturedAt: 'now', check: 'contrast', results };
}

const BOX = { x: 100, y: 200, width: 300, height: 40 };

// NOTE: axe's `color-contrast` no longer reaches this pass in the real
// pipeline — engines.ts settles it earlier by ref against MeasuredSubjects
// (contrast-reconcile.ts). These tests exercise the general mechanism in
// enrich/supersede.ts directly (any needs-review finding with a `box`, from
// any producer, over a `status === 'measured'` glyph-mask subject), using
// `axe-core:color-contrast` findings only as a convenient stand-in shape.
describe('measurement supersede (signal fusion)', () => {
  it('drops a needs-review finding whose element the glyph-mask walk measured', () => {
    const f = finding('axe-core:color-contrast', 'needs-review', BOX);
    const art = probe([{ status: 'measured', verdict: 'pass', box: { ...BOX, x: 101 } }]); // near-identical geometry
    const res = supersedeByMeasurement([f], [art]);
    expect(res.superseded).toBe(1);
    expect(res.findings).toHaveLength(0);
    expect(res.byProvider['glyph-contrast']).toBe(1);
  });

  it('supersedes regardless of measured verdict (the measuring rule owns fail)', () => {
    for (const verdict of ['pass', 'fail']) {
      const res = supersedeByMeasurement(
        [finding('axe-core:color-contrast', 'needs-review', BOX)],
        [probe([{ status: 'measured', verdict, box: BOX }])],
      );
      expect(res.superseded).toBe(1);
    }
  });

  it('keeps violations (computed math), unmeasured elements, and box-less findings', () => {
    const violation = finding('axe-core:color-contrast', 'violation', BOX);
    const farAway = finding('axe-core:color-contrast', 'needs-review', { x: 900, y: 900, width: 50, height: 20 });
    const noBox = finding('axe-core:color-contrast', 'needs-review');
    const art = probe([{ status: 'measured', verdict: 'pass', box: BOX }, { status: 'unmeasured', box: BOX }]); // second candidate: never measured
    const res = supersedeByMeasurement([violation, farAway, noBox], [art]);
    expect(res.superseded).toBe(0);
    expect(res.findings).toHaveLength(3);
  });

  it('never eats the provider\'s own report of the same measurement', () => {
    const own = finding('contrast.text', 'needs-review', BOX); // the fail report itself
    const res = supersedeByMeasurement([own], [probe([{ status: 'measured', verdict: 'fail', box: BOX }])]);
    expect(res.superseded).toBe(0);
    expect(res.findings).toHaveLength(1);
  });

  it('matches only within the same page cell (viewport/scheme)', () => {
    const f = finding('axe-core:color-contrast', 'needs-review', BOX);
    const darkProbe: Artifact = {
      ...probe([{ status: 'measured', verdict: 'pass', box: BOX }]),
      subject: { ...CELL, colorScheme: 'dark' },
    } as Artifact;
    const res = supersedeByMeasurement([f], [darkProbe]);
    expect(res.superseded).toBe(0);
  });

  it('an unmeasured subject never supersedes anything, even with a matching box', () => {
    const f = finding('axe-core:color-contrast', 'needs-review', BOX);
    const res = supersedeByMeasurement([f], [probe([{ status: 'unmeasured', box: BOX }])]);
    expect(res.superseded).toBe(0);
    expect(res.findings).toHaveLength(1);
  });
});
