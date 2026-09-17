import { describe, it, expect } from 'vitest';
import { normalizeEngineArtifacts } from '../src/engines.js';
import { asRunId, type Artifact } from '../src/record/index.js';

// engines.ts settles axe `color-contrast` nodes against the glyph-mask walk's
// MeasuredSubjects (contrast-reconcile.ts) by ref, not geometry — see
// plans/glyph-contrast-plan.md §4.5. These tests exercise that wiring end to
// end through normalizeEngineArtifacts, which is what pipeline.ts calls.

const cell = { property: 'shop', routePattern: '/app/aeo/topics', instanceUrl: 'http://x/app/aeo/topics', viewport: 'desktop', colorScheme: 'light' as const };

function axeResult(nodes: Record<string, unknown>[], kind: 'violations' | 'incomplete' = 'violations'): Artifact {
  return {
    kind: 'axe-result',
    subject: cell,
    capturedAt: '2026-09-16T00:00:00.000Z',
    results: { [kind]: [{ id: 'color-contrast', help: 'Elements must meet contrast ratio thresholds', nodes }] },
  } as unknown as Artifact;
}

function probe(results: Record<string, unknown>[]): Artifact {
  return { kind: 'style-probe', check: 'contrast', subject: cell, capturedAt: '2026-09-16T00:00:00.000Z', results } as unknown as Artifact;
}

const node = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  target: ['.cta'],
  box: { x: 10, y: 10, width: 100, height: 20 },
  measureRefs: [1],
  ...over,
});

describe('engines.ts axe color-contrast settlement', () => {
  it('drops a node whose measureRefs match a measured pass', () => {
    const art = [
      axeResult([node()]),
      probe([{ ref: 1, status: 'measured', verdict: 'pass', flat: true, fgSource: 'css', ratio: 9.1, minRatio: 9.1, medianRatio: 9.3, maxRatio: 9.4 }]),
    ];
    const { findings, superseded } = normalizeEngineArtifacts(art, { runId: asRunId('r') });
    expect(findings).toHaveLength(0);
    expect(superseded.settled).toBe(1);
    expect(superseded.unmatched).toBe(0);
  });

  it('drops a node whose measureRefs match a measured fail — contrast.text is the reporter, not axe', () => {
    const art = [
      axeResult([node()]),
      probe([{ ref: 1, status: 'measured', verdict: 'fail', flat: true, fgSource: 'css', ratio: 1.9, minRatio: 1.9, medianRatio: 2.1, maxRatio: 2.4 }]),
    ];
    const { findings, superseded } = normalizeEngineArtifacts(art, { runId: asRunId('r') });
    expect(findings).toHaveLength(0);
    expect(superseded.settled).toBe(1);
  });

  it('keeps a node whose measureRefs match only unmeasured subjects', () => {
    const art = [axeResult([node()]), probe([{ ref: 1, status: 'unmeasured', flat: true }])];
    const { findings, superseded } = normalizeEngineArtifacts(art, { runId: asRunId('r') });
    expect(findings).toHaveLength(1);
    expect(superseded.settled).toBe(0);
    expect(superseded.unmatched).toBe(1);
  });

  it('keeps a node with no measureRefs', () => {
    const art = [axeResult([node({ measureRefs: undefined })])];
    const { findings, superseded } = normalizeEngineArtifacts(art, { runId: asRunId('r') });
    expect(findings).toHaveLength(1);
    expect(superseded.unmatched).toBe(1);
  });

  it('never matches a subject from a different cell', () => {
    const otherCell = { ...cell, routePattern: '/somewhere/else' };
    const art = [
      axeResult([node()]),
      { kind: 'style-probe', check: 'contrast', subject: otherCell, capturedAt: '2026-09-16T00:00:00.000Z', results: [{ ref: 1, status: 'measured', verdict: 'pass', flat: true }] } as unknown as Artifact,
    ];
    const { findings, superseded } = normalizeEngineArtifacts(art, { runId: asRunId('r') });
    expect(findings).toHaveLength(1); // measurement from another cell never speaks for this one
    expect(superseded.unmatched).toBe(1);
  });

  it('counts a disagreement and records an example when axe and the measured median differ', () => {
    const art = [
      axeResult([
        node({
          any: [{ id: 'color-contrast', data: { fgColor: '#000000', bgColor: '#c3fd34', contrastRatio: 2.8, expectedContrastRatio: '4.5:1' } }],
        }),
      ]),
      probe([{ ref: 1, status: 'measured', verdict: 'fail', flat: true, fgSource: 'css', ratio: 2.1, minRatio: 2.1, medianRatio: 2.1, maxRatio: 2.4 }]),
    ];
    const { superseded } = normalizeEngineArtifacts(art, { runId: asRunId('r') });
    expect(superseded.settled).toBe(1);
    expect(superseded.disagreements).toBe(1);
    expect(superseded.examples).toEqual([{ selector: '.cta', axe: 2.8, measured: 2.1 }]);
  });

  it('does not count a disagreement within rounding tolerance', () => {
    const art = [
      axeResult([
        node({
          any: [{ id: 'color-contrast', data: { fgColor: '#000', bgColor: '#fff', contrastRatio: 2.15 } }],
        }),
      ]),
      probe([{ ref: 1, status: 'measured', verdict: 'fail', flat: true, fgSource: 'css', ratio: 2.1, minRatio: 2.1, medianRatio: 2.1, maxRatio: 2.4 }]),
    ];
    const { superseded } = normalizeEngineArtifacts(art, { runId: asRunId('r') });
    expect(superseded.settled).toBe(1);
    expect(superseded.disagreements).toBe(0);
    expect(superseded.examples).toHaveLength(0);
  });

  it('caps disagreement examples at 5', () => {
    const nodes = Array.from({ length: 7 }, (_, i) =>
      node({
        target: [`.cta${i}`],
        measureRefs: [i],
        any: [{ id: 'color-contrast', data: { fgColor: '#000', bgColor: '#fff', contrastRatio: 5 } }],
      }),
    );
    const results = Array.from({ length: 7 }, (_, i) => ({
      ref: i,
      status: 'measured',
      verdict: 'fail',
      flat: true,
      fgSource: 'css',
      ratio: 2,
      minRatio: 2,
      medianRatio: 2,
      maxRatio: 2,
    }));
    const art = [axeResult(nodes), probe(results)];
    const { superseded } = normalizeEngineArtifacts(art, { runId: asRunId('r') });
    expect(superseded.settled).toBe(7);
    expect(superseded.disagreements).toBe(7);
    expect(superseded.examples).toHaveLength(5);
  });

  it('non-contrast axe rules are unaffected by measurement settlement', () => {
    const art: Artifact[] = [
      {
        kind: 'axe-result',
        subject: cell,
        capturedAt: '2026-09-16T00:00:00.000Z',
        results: { violations: [{ id: 'button-name', help: 'Buttons must have discernible text', nodes: [{ target: ['button'] }] }], incomplete: [] },
      } as unknown as Artifact,
    ];
    const { findings, superseded } = normalizeEngineArtifacts(art, { runId: asRunId('r') });
    expect(findings).toHaveLength(1);
    expect(superseded.settled).toBe(0);
    expect(superseded.unmatched).toBe(0);
  });
});
