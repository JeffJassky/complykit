import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { describe, it, expect, afterEach } from 'vitest';
import {
  renderHtmlReport,
  containsBannedVocabulary,
  coverage,
  buildCoverageIndex,
  asRunId,
  asRuleId,
  asRequirementId,
  fingerprint,
  putEvidence,
  writeRun,
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
  accessLevels: ['public', 'repo'],
  matrix: [],
  gaps: [{ reason: 'bot-blocked', subject: { property: 'shop', routePattern: '/admin' } }],
  rulesExecuted: [],
};

const sub = { property: 'shop', routePattern: '/', locator: { role: 'text', ordinal: 0 } };
const finding: Finding = {
  schemaVersion: 1,
  ruleId: asRuleId('axe-core:color-contrast'),
  requirementId: asRequirementId('wcag22.1.4.3'),
  subject: sub,
  confidence: 'violation',
  severity: 'serious',
  message: 'Text contrast is below 4.5:1.',
  evidence: [{ kind: 'computed-style', properties: { color: '#999', background: '#fff', ratio: '2.8', required: '4.5' } }],
  fingerprint: fingerprint({ detects: 'presence', ruleId: asRuleId('axe-core:color-contrast'), subject: sub }),
  producer: { type: 'engine', name: 'axe-core', version: '4.10.3' },
  runId: asRunId('2026-08-19T10-00-00.000Z'),
};

describe('static HTML report', () => {
  const html = renderHtmlReport(run, [finding], { coverage: [coverage('wcag22aa', buildCoverageIndex(), run)] });

  it('is a self-contained document with no external fetches', () => {
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<style>'); // inline CSS
    expect(html).not.toMatch(/<link[^>]+href=|<script[^>]+src=/); // no external assets
    expect(html).not.toMatch(/https?:\/\/[^"']*\.(css|js)/);
  });

  it('states the finding, its requirement, and the coverage gap', () => {
    expect(html).toContain('wcag22.1.4.3');
    expect(html).toContain('Text contrast is below');
    expect(html).toContain('bot-blocked');
    expect(html).toContain('manual-only');
  });

  it('never says "compliant"', () => {
    expect(containsBannedVocabulary(html)).toBe(false);
    expect(html).toContain('does not assert conformance');
  });

  it('renders the power controls: group-by, facets, display toggles, copy', () => {
    expect(html).toContain('id="groupBy"');
    expect(html).toContain('id="facets"');
    expect(html).toContain('id="showMenu"');
    expect(html).toContain('id="copyBtn"');
    // the client-side model is embedded (grouping/copy read it, not the DOM)
    expect(html).toContain('id="fdata"');
  });

  it('embeds a finding model whose JSON cannot break out of its script tag', () => {
    const evil: Finding = { ...finding, message: 'x</script><script>alert(1)</script>' };
    const out = renderHtmlReport(run, [evil]);
    // inside the JSON payload every < is <-escaped
    expect(out).not.toContain('x</script>');
    expect(out).toContain('x\\u003c/script');
  });

  it('escapes finding text (no raw HTML injection)', () => {
    const evil: Finding = { ...finding, message: '<img src=x onerror=alert(1)>' };
    const out = renderHtmlReport(run, [evil]);
    expect(out).not.toContain('<img src=x onerror=alert(1)>');
    expect(out).toContain('&lt;img src=x');
  });
});

// Glyph-mask overlay: a same-size RGBA mask stacked exactly over the crop
// (see glyph-contrast-plan.md §4.5). Uses real PNGs on disk under a temp
// runDir, the same way inlineImage reads them in a real run.
describe('static HTML report — glyph-mask overlay evidence', () => {
  let cwd: string;

  afterEach(() => {
    if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
  });

  function png(w: number, h: number, rgba: [number, number, number, number]): Buffer {
    const p = new PNG({ width: w, height: h });
    for (let i = 0; i < w * h; i++) {
      p.data[i * 4] = rgba[0];
      p.data[i * 4 + 1] = rgba[1];
      p.data[i * 4 + 2] = rgba[2];
      p.data[i * 4 + 3] = rgba[3];
    }
    return PNG.sync.write(p);
  }

  it('stacks the inlined overlay image over the inlined crop and adds the legend', () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'complykit-html-'));
    writeRun(run, cwd);
    const cropPath = putEvidence(run.id, png(40, 40, [0, 0, 0, 255]), 'png', cwd);
    const overlayPath = putEvidence(run.id, png(40, 40, [255, 0, 200, 235]), 'png', cwd);
    const f: Finding = {
      ...finding,
      evidence: [
        {
          kind: 'screenshot',
          path: cropPath,
          region: { x: 0, y: 0, width: 40, height: 40 },
          overlayPath,
          swatches: [{ label: 'text', color: '#000000' }],
        },
      ],
    };
    const html = renderHtmlReport(run, [f], { cwd });
    expect(html).toContain('ov-mask');
    expect(html).toContain('hover to see raw pixels');
    // both images inlined as data URIs, not external file references
    expect(html.match(/data:image\/png;base64,/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('renders old-shape `samples` dot evidence unchanged when there is no overlayPath', () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'complykit-html-'));
    writeRun(run, cwd);
    const shotPath = putEvidence(run.id, png(40, 40, [0, 0, 0, 255]), 'png', cwd);
    const f: Finding = {
      ...finding,
      evidence: [
        {
          kind: 'screenshot',
          path: shotPath,
          region: { x: 0, y: 0, width: 40, height: 40 },
          samples: [{ x: 5, y: 5 }],
          swatches: [{ label: 'text', color: '#000000' }],
        },
      ],
    };
    const html = renderHtmlReport(run, [f], { cwd });
    expect(html).not.toContain('class="ov-mask"');
    expect(html).not.toContain('hover to see raw pixels');
    expect(html).toContain('class="ov"');
  });
});
