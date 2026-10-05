import { describe, it, expect } from 'vitest';
import {
  renderJsonReport,
  asRunId,
  asRuleId,
  asRequirementId,
  fingerprint,
  REGISTRY_VERSION,
  type Run,
  type Finding,
} from '../src/index.js';

const run: Run = {
  schemaVersion: 1,
  id: asRunId('2026-08-19T10-00-00.000Z'),
  property: 'shop',
  startedAt: 'now',
  versions: { package: '0.0.0', registry: REGISTRY_VERSION, engines: {} },
  accessLevels: ['public'],
  matrix: [],
  gaps: [{ reason: 'bot-blocked', subject: { property: 'shop', routePattern: '/admin' } }],
  rulesExecuted: [],
};

function finding(routePattern: string, viewport?: string): Finding {
  const sub = {
    property: 'shop',
    routePattern,
    viewport: viewport as Finding['subject']['viewport'],
    colorScheme: 'light' as const,
    locator: { role: 'text', cssPath: '.hero > p', ordinal: 0 },
  };
  return {
    schemaVersion: 1,
    ruleId: asRuleId('axe-core:color-contrast'),
    requirementId: asRequirementId('wcag22.1.4.3'),
    subject: sub,
    confidence: 'violation',
    severity: 'serious',
    message: 'Text contrast is below 4.5:1.',
    evidence: [
      { kind: 'dom-snippet', html: '<p class="dim">hello</p>' },
      { kind: 'computed-style', properties: { color: '#999', 'color-var': 'var(--muted)' } },
      {
        kind: 'screenshot',
        path: 'screens/desktop-light-home.png',
        region: { x: 10, y: 20, width: 300, height: 40 },
        swatches: [{ label: 'text', color: '#999999' }],
      },
    ],
    fingerprint: fingerprint({ detects: 'presence', ruleId: asRuleId('axe-core:color-contrast'), subject: sub }),
    producer: { type: 'engine', name: 'axe-core', version: '4.10.3' },
    runId: asRunId('2026-08-19T10-00-00.000Z'),
  };
}

describe('JSON report sidecar', () => {
  const doc = JSON.parse(renderJsonReport(run, [finding('/', 'desktop'), finding('/about', 'mobile')]));

  it('emits verbose-keyed defects with run and requirement context', () => {
    expect(doc.schemaVersion).toBe(1);
    expect(doc.run.property).toBe('shop');
    expect(doc.requirements['wcag22.1.4.3'].title).toBeTruthy();
    const d = doc.defects[0];
    expect(d.severity).toBe('serious');
    expect(d.ruleId).toBe('axe-core:color-contrast');
    expect(d.detectedBy).toBe('engine:axe-core');
    expect(d.cssPath).toBe('.hero > p');
    expect(d.snippets[0]).toContain('<p class="dim">');
  });

  it('aggregates identical sightings across routes and cells into one defect', () => {
    expect(doc.defects).toHaveLength(1);
    expect(doc.defects[0].sightings).toBe(2);
    expect(doc.defects[0].routes).toEqual(['/', '/about']);
    expect(doc.defects[0].cells).toEqual(['desktop/light', 'mobile/light']);
    expect(doc.counts.defects).toBe(1);
    expect(doc.counts.sightings).toBe(2);
    expect(doc.counts.serious).toBe(1);
  });

  it('relabels stored computed-style keys to the current vocabulary', () => {
    expect(doc.defects[0].computedStyle['matching color vars']).toBe('var(--muted)');
    expect(doc.defects[0].computedStyle['color-var']).toBeUndefined();
  });

  it('exposes agent questions, evidence references and a separate answer contract', () => {
    const workflow = doc.researchWorkflow;
    expect(workflow.schemaVersion).toBe(1);
    expect(workflow.items[0].target.pointer).toBe('/defects/0');
    expect(workflow.items[0].evidencePointers).toContain('/gaps');
    expect(workflow.items[0].questions.find((q: any) => q.id === 'implementation').prompt).toContain('contrast');
    expect(workflow.items[0].questions.find((q: any) => q.id === 'assignee').responsibility).toBe('human');
    expect(workflow.answerSchema.properties.reportId.const).toBe(workflow.reportId);
    expect(doc.counts.defects).toBe(1);
  });

  it('includes individual storage research from cookie evidence', () => {
    const f = finding('/');
    f.evidence.push({kind:'cookie',name:'visitor',domain:'tracker.example',phase:'pre-consent',flags:{httpOnly:false,secure:true}});
    const result = JSON.parse(renderJsonReport(run, [f]));
    const item = result.researchWorkflow.items.find((i: any) => i.target.kind === 'storage');
    expect(item.context.storageName).toBe('visitor');
    expect(item.evidencePointers).toContain('/defects/0/evidence/1');
    expect(item.questions.find((q: any) => q.id === 'recipients')).toBeDefined();
  });

  it('carries coverage gaps', () => {
    expect(doc.gaps[0].reason).toBe('bot-blocked');
  });

  it('references image evidence by path with crop region, resolvable via evidenceDir', () => {
    expect(doc.evidenceDir).toContain('2026-08-19T10-00-00.000Z');
    const ev = doc.defects[0].evidence;
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      type: 'screenshot',
      path: 'screens/desktop-light-home.png',
      region: { x: 10, y: 20, width: 300, height: 40 },
    });
    expect(ev[0].swatches[0].color).toBe('#999999');
  });
});

describe('JSON report sidecar — glyph-mask overlay evidence', () => {
  it('passes overlayPath through screenshot evidence', () => {
    const f = finding('/pricing', 'desktop');
    f.evidence.push({
      kind: 'screenshot',
      path: 'evidence/crop-1.png',
      region: { x: 0, y: 0, width: 224, height: 64 },
      overlayPath: 'evidence/overlay-1.png',
      swatches: [{ label: 'text', color: '#000000' }],
    });
    const doc = JSON.parse(renderJsonReport(run, [f]));
    const shots = doc.defects[0].evidence.filter((e: { type: string }) => e.type === 'screenshot');
    expect(shots).toHaveLength(2);
    expect(shots[1].overlayPath).toBe('evidence/overlay-1.png');
  });

  it('omits overlayPath when absent (old-run evidence)', () => {
    const doc = JSON.parse(renderJsonReport(run, [finding('/', 'desktop')]));
    expect(doc.defects[0].evidence[0].overlayPath).toBeUndefined();
  });
});
