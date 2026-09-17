import { describe, it, expect } from 'vitest';
import {
  indexMeasuredSubjects,
  settleAxeContrastNode,
  cellKey,
  type MeasuredSubject,
} from '../src/contrast-reconcile.js';
import type { Artifact } from '../src/record/index.js';

const subject = { routePattern: '/app/aeo/topics', instanceUrl: 'http://x/app/aeo/topics', viewport: 'desktop', colorScheme: 'light' as const };

function probe(results: Array<Record<string, unknown>>, over: Partial<typeof subject> = {}): Artifact {
  return { kind: 'style-probe', check: 'contrast', subject: { ...subject, ...over }, capturedAt: '', results } as unknown as Artifact;
}

const passSubject = (ref: number, over: Partial<MeasuredSubject> = {}): Record<string, unknown> => ({
  ref,
  status: 'measured',
  verdict: 'pass',
  flat: true,
  fgSource: 'css',
  ratio: 9.1,
  minRatio: 9.1,
  medianRatio: 9.3,
  maxRatio: 9.4,
  ...over,
});

const failSubject = (ref: number, over: Partial<MeasuredSubject> = {}): Record<string, unknown> => ({
  ref,
  status: 'measured',
  verdict: 'fail',
  flat: true,
  fgSource: 'css',
  ratio: 1.9,
  minRatio: 1.9,
  medianRatio: 2.1,
  maxRatio: 2.4,
  ...over,
});

const unmeasuredSubject = (ref: number): Record<string, unknown> => ({ ref, status: 'unmeasured', flat: true });

describe('contrast reconciliation', () => {
  it('indexes valid MeasuredSubject results and drops old-shape ones', () => {
    const index = indexMeasuredSubjects([
      probe([passSubject(1), { flat: true, required: 4.5 } /* old shape: no status/ref */]),
    ]);
    expect(index.get(cellKey(subject))).toHaveLength(1);
  });

  it('does not speak for another viewport or scheme', () => {
    const index = indexMeasuredSubjects([probe([passSubject(1)])]);
    expect(index.get(cellKey({ ...subject, colorScheme: 'dark' }))).toBeUndefined();
  });

  it('keeps a node with no measureRefs', () => {
    const index = indexMeasuredSubjects([probe([passSubject(1)])]);
    expect(settleAxeContrastNode(index, subject, { selector: '.x' })).toEqual({ action: 'keep' });
    expect(settleAxeContrastNode(index, subject, { selector: '.x', measureRefs: [] })).toEqual({ action: 'keep' });
  });

  it('drops a node whose measureRefs match a measured pass', () => {
    const index = indexMeasuredSubjects([probe([passSubject(1)])]);
    const r = settleAxeContrastNode(index, subject, { selector: '.x', measureRefs: [1] });
    expect(r).toMatchObject({ action: 'drop' });
  });

  it('drops a node whose measureRefs match a measured fail (contrast.text reports it)', () => {
    const index = indexMeasuredSubjects([probe([failSubject(2)])]);
    const r = settleAxeContrastNode(index, subject, { selector: '.x', measureRefs: [2] });
    expect(r).toMatchObject({ action: 'drop' });
  });

  it('keeps a node whose measureRefs match only unmeasured subjects', () => {
    const index = indexMeasuredSubjects([probe([unmeasuredSubject(3)])]);
    const r = settleAxeContrastNode(index, subject, { selector: '.x', measureRefs: [3] });
    expect(r).toEqual({ action: 'keep' });
  });

  it('keeps a node whose measureRefs match nothing in this cell (different cell never matches)', () => {
    const index = indexMeasuredSubjects([probe([passSubject(1)], { routePattern: '/other' })]);
    const r = settleAxeContrastNode(index, subject, { selector: '.x', measureRefs: [1] });
    expect(r).toEqual({ action: 'keep' });
  });

  it('counts a disagreement when axe and the measured median differ by more than rounding, on a flat CSS-colour subject', () => {
    const index = indexMeasuredSubjects([probe([failSubject(4, { medianRatio: 2.1 })])]);
    const r = settleAxeContrastNode(index, subject, { selector: '.cta', measureRefs: [4], axeRatio: 2.8 });
    expect(r).toMatchObject({
      action: 'drop',
      disagreement: { selector: '.cta', axe: 2.8, measured: 2.1 },
    });
  });

  it('does not report a disagreement within rounding tolerance', () => {
    const index = indexMeasuredSubjects([probe([failSubject(5, { medianRatio: 2.1 })])]);
    const r = settleAxeContrastNode(index, subject, { selector: '.cta', measureRefs: [5], axeRatio: 2.15 });
    expect(r).toMatchObject({ action: 'drop' });
    expect((r as { disagreement?: unknown }).disagreement).toBeUndefined();
  });

  it('does not report a disagreement for a non-flat or rendered-ink subject', () => {
    const index = indexMeasuredSubjects([
      probe([failSubject(6, { flat: false, medianRatio: 2.1 }), failSubject(7, { fgSource: 'rendered', medianRatio: 2.1 })]),
    ]);
    const r1 = settleAxeContrastNode(index, subject, { selector: '.a', measureRefs: [6], axeRatio: 5 });
    const r2 = settleAxeContrastNode(index, subject, { selector: '.b', measureRefs: [7], axeRatio: 5 });
    expect((r1 as { disagreement?: unknown }).disagreement).toBeUndefined();
    expect((r2 as { disagreement?: unknown }).disagreement).toBeUndefined();
  });
});
