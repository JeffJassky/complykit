import { describe, it, expect } from 'vitest';
import { indexMeasuredContrast, matchMeasured, reconcileAxeContrast, type MeasuredContrast } from '../src/contrast-reconcile.js';
import type { Artifact } from '../src/record/index.js';

const subject = { routePattern: '/app/aeo/topics', instanceUrl: 'http://x/app/aeo/topics', viewport: 'desktop', colorScheme: 'light' as const };
const box = { x: 100, y: 200, width: 40, height: 26 };

function probe(results: Array<Record<string, unknown>>): Artifact {
  return { kind: 'style-probe', check: 'contrast', subject, capturedAt: '', results } as unknown as Artifact;
}

const measured = (over: Partial<MeasuredContrast> = {}): MeasuredContrast => ({ box, flat: true, required: 4.5, ...over });

describe('contrast reconciliation', () => {
  it('indexes candidates that carry a box, skipping degenerate ones', () => {
    const index = indexMeasuredContrast([probe([
      { box, flat: true, required: 4.5, measuredBand: 'pass' },
      { box: { x: 0, y: 0, width: 0, height: 10 }, flat: true, required: 4.5 },
      { flat: false, required: 3 },
    ])]);
    expect(index.get('/app/aeo/topics|desktop|light')).toHaveLength(1);
  });

  it('matches the same element and refuses a differently-sized box', () => {
    const index = indexMeasuredContrast([probe([{ box, flat: true, required: 4.5, measuredBand: 'fail' }])]);
    expect(matchMeasured(index, subject, { x: 101, y: 201, width: 40, height: 26 })?.measuredBand).toBe('fail');
    // A parent wrapping the same text must not inherit the child's measurement.
    expect(matchMeasured(index, subject, { x: 100, y: 200, width: 400, height: 26 })).toBeUndefined();
    expect(matchMeasured(index, subject, undefined)).toBeUndefined();
  });

  it('does not speak for another viewport or scheme', () => {
    const index = indexMeasuredContrast([probe([{ box, flat: true, required: 4.5, measuredBand: 'pass' }])]);
    expect(matchMeasured(index, { ...subject, colorScheme: 'dark' as const }, box)).toBeUndefined();
  });

  it('drops an unprovable axe finding when the pixels clear the threshold', () => {
    expect(reconcileAxeContrast(measured({ measuredBand: 'pass', minRatio: 9.1, maxRatio: 9.4 }), 'needs-review'))
      .toMatchObject({ action: 'drop' });
  });

  it('downgrades rather than drops when axe asserted a violation the pixels contradict', () => {
    const r = reconcileAxeContrast(measured({ measuredBand: 'pass', minRatio: 9.1, maxRatio: 9.4 }), 'violation');
    expect(r).toMatchObject({ action: 'revise', confidence: 'needs-review' });
  });

  it('keeps a measured failure as a violation with the measured range', () => {
    const r = reconcileAxeContrast(measured({ measuredBand: 'fail', minRatio: 1.9, maxRatio: 2.4 }), 'needs-review');
    expect(r).toMatchObject({ action: 'revise', confidence: 'violation' });
    expect(r).toHaveProperty('note', expect.stringContaining('1.9'));
  });

  it('leaves an ambiguous band as needs-review for C1', () => {
    expect(reconcileAxeContrast(measured({ measuredBand: 'ambiguous', minRatio: 4.1, maxRatio: 5.2 }), 'needs-review'))
      .toMatchObject({ action: 'revise', confidence: 'needs-review' });
  });

  it('yields non-flat elements to contrast.text instead of double-reporting', () => {
    expect(reconcileAxeContrast(measured({ flat: false, measuredBand: 'fail' }), 'violation')).toMatchObject({ action: 'drop' });
  });

  it('changes nothing when no measurement exists or the band is missing', () => {
    expect(reconcileAxeContrast(undefined, 'violation')).toEqual({ action: 'keep' });
    expect(reconcileAxeContrast(measured(), 'violation')).toEqual({ action: 'keep' });
  });
});
