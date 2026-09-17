import { describe, it, expect } from 'vitest';
import { contrastText } from '../src/rules/contrast/contrast.js';
import type { Artifact } from '../src/record/index.js';

// contrast.text is the SINGLE reporter for anything the glyph-mask walk
// measured (see plans/glyph-contrast-plan.md §4.5): it reports every measured
// fail — flat background or not, since the old "let axe own flat" split is
// gone now that axe's color-contrast node is settled (dropped) whenever a
// measurement exists at all.

const cell = { property: 'shop', routePattern: '/app/aeo/topics', instanceUrl: 'http://x/app/aeo/topics', viewport: 'desktop' as const, colorScheme: 'light' as const };

type StyleProbe = Extract<Artifact, { kind: 'style-probe' }>;

function probe(results: Record<string, unknown>[], screenshotPath?: string): StyleProbe {
  return {
    kind: 'style-probe',
    check: 'contrast',
    subject: cell,
    capturedAt: '2026-09-16T00:00:00.000Z',
    screenshotPath,
    results,
  } as unknown as StyleProbe;
}

const failResult = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  status: 'measured',
  verdict: 'fail',
  cssPath: '.cta',
  textSample: 'START THE 10-DAY TRIAL',
  textColor: 'rgb(0, 0, 0)',
  required: 4.5,
  ratio: 2.8,
  minRatio: 2.8,
  medianRatio: 2.9,
  maxRatio: 3.1,
  glyphPixels: 412,
  failingPixels: 380,
  fgSource: 'css',
  fgColor: 'rgb(0, 0, 0)',
  worstBgColor: 'rgb(195, 253, 52)',
  bestBgColor: 'rgb(200, 255, 60)',
  box: { x: 10, y: 20, width: 200, height: 40 },
  cropPath: 'evidence/crop-1.png',
  overlayPath: 'evidence/overlay-1.png',
  cropWidth: 224,
  cropHeight: 64,
  ...over,
});

describe('contrast.text', () => {
  it('reports a measured fail with the exact message, evidence, and details', () => {
    const findings = contrastText.evaluate({ 'style-probe': [probe([failResult()])] }, { property: 'shop' });
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.message).toBe(
      'Text contrast 2.8:1 is below the required 4.5:1 — measured over 412 glyph pixels (worst 2.8:1, median 2.9:1).',
    );
    expect(f.details).toEqual({ cssPath: '.cta', textSample: 'START THE 10-DAY TRIAL', box: { x: 10, y: 20, width: 200, height: 40 } });
    expect(f.confidence).toBe('violation');
    const style = f.evidence.find((e) => e.kind === 'computed-style');
    expect(style).toMatchObject({
      kind: 'computed-style',
      properties: {
        text: '"START THE 10-DAY TRIAL"',
        color: 'rgb(0, 0, 0)',
        'text colour used': 'rgb(0, 0, 0) (CSS colour)',
        'background at worst pixel': 'rgb(195, 253, 52)',
        ratio: '2.8:1 (1st percentile of 412 glyph pixels)',
        range: '2.8–3.1:1, median 2.9:1',
        required: '4.5',
        'failing pixels': '380 of 412',
      },
    });
    const shot = f.evidence.find((e) => e.kind === 'screenshot');
    expect(shot).toMatchObject({
      kind: 'screenshot',
      path: 'evidence/crop-1.png',
      region: { x: 0, y: 0, width: 224, height: 64 },
      overlayPath: 'evidence/overlay-1.png',
      swatches: [
        { label: 'text', color: 'rgb(0, 0, 0)' },
        { label: 'background (worst pixel)', color: 'rgb(195, 253, 52)', ratio: 2.8 },
        { label: 'background (best pixel)', color: 'rgb(200, 255, 60)', ratio: 3.1 },
      ],
    });
  });

  it('reports a flat-background fail (no more skip-flat-let-axe-own-it)', () => {
    const findings = contrastText.evaluate({ 'style-probe': [probe([failResult({ flat: true })])] }, { property: 'shop' });
    expect(findings).toHaveLength(1);
  });

  it('reports nothing for a measured pass', () => {
    const findings = contrastText.evaluate(
      { 'style-probe': [probe([failResult({ verdict: 'pass', ratio: 9.1, minRatio: 9.1, medianRatio: 9.3, maxRatio: 9.4 })])] },
      { property: 'shop' },
    );
    expect(findings).toHaveLength(0);
  });

  it('reports nothing for an unmeasured subject', () => {
    const findings = contrastText.evaluate(
      { 'style-probe': [probe([{ status: 'unmeasured', unmeasuredReason: 'cap', cssPath: '.x', required: 4.5 }])] },
      { property: 'shop' },
    );
    expect(findings).toHaveLength(0);
  });

  it('ignores an old-shape result (no `status` field, pre glyph-mask run)', () => {
    const oldShape = { flat: true, required: 4.5, measuredBand: 'fail', minRatio: 1.9, maxRatio: 2.4, cssPath: '.old' };
    const findings = contrastText.evaluate({ 'style-probe': [probe([oldShape])] }, { property: 'shop' });
    expect(findings).toHaveLength(0);
  });

  it('skips a style-probe artifact for a different check', () => {
    const art = { kind: 'style-probe', check: 'target-size', subject: cell, capturedAt: '', results: [failResult()] } as unknown as StyleProbe;
    const findings = contrastText.evaluate({ 'style-probe': [art] }, { property: 'shop' });
    expect(findings).toHaveLength(0);
  });
});
