import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import {
  cropRegion,
  perceptualHash,
  contentHash,
  adjudicateQueue,
  buildAdjudicationQueue,
  review,
  type Adjudicator,
  type AdjudicationRequest,
} from '../src/judge/index.js';
import {
  writeRun,
  appendFinding,
  runDir,
  putEvidence,
  fingerprint,
  asRunId,
  asRuleId,
  asRequirementId,
  REGISTRY_VERSION,
  type Run,
  type Finding,
} from '../src/index.js';

// A synthetic PNG so crop/pHash/cache are exercised without a browser.
function makePng(w: number, h: number, fill: (x: number, y: number) => [number, number, number]): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (w * y + x) << 2;
      const [r, g, b] = fill(x, y);
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

const gradient = makePng(200, 200, (x) => [x, 128, 255 - x]);
// A structured image (checkerboard) whose regions differ in local pattern.
const checker = makePng(200, 200, (x, y) => {
  const on = (Math.floor(x / 10) + Math.floor(y / 10)) % 2 === 0;
  return on ? [10, 10, 10] : [245, 245, 245];
});

describe('crop + pHash', () => {
  it('crops a region with padding, bounded to the image', () => {
    const c = cropRegion(gradient, { x: 50, y: 50, width: 40, height: 40 }, 10);
    expect(c.width).toBe(60); // 40 + 2*10 padding
    expect(c.height).toBe(60);
  });

  it('gives identical crops the same perceptual + content hash', () => {
    const a = cropRegion(gradient, { x: 20, y: 20, width: 50, height: 50 });
    const b = cropRegion(gradient, { x: 20, y: 20, width: 50, height: 50 });
    expect(perceptualHash(a.buffer)).toBe(perceptualHash(b.buffer));
    expect(contentHash(a.buffer)).toBe(contentHash(b.buffer));
  });

  it('gives visibly different images different perceptual hashes', () => {
    const a = cropRegion(gradient, { x: 20, y: 20, width: 60, height: 60 });
    const b = cropRegion(checker, { x: 20, y: 20, width: 60, height: 60 });
    expect(perceptualHash(a.buffer)).not.toBe(perceptualHash(b.buffer));
  });
});

describe('adjudicateQueue economics', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'complykit-j-'));
  });
  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

  function request(crop: Buffer): AdjudicationRequest {
    return {
      fingerprint: contentHash(crop),
      ruleId: 'contrast.text-adjudicated',
      requirementId: 'wcag22.1.4.3',
      subject: { property: 'shop', routePattern: '/' },
      cropBuffer: crop,
      rubric: 'judge contrast',
      rubricVersion: '2026-08-19.1',
    };
  }

  it('pHash-dedupes identical crops to a single model call', async () => {
    let calls = 0;
    const stub: Adjudicator = async () => {
      calls++;
      return { verdict: 'violation', reason: 'low contrast' };
    };
    const crop = cropRegion(gradient, { x: 10, y: 10, width: 40, height: 40 }).buffer;
    const res = await adjudicateQueue([request(crop), request(crop), request(crop)], { adjudicator: stub, model: 'test-model', cwd, capturedAt: 'now' });
    expect(calls).toBe(1); // three identical crops -> one call
    expect(res.stats.deduped).toBe(2);
    expect(res.artifacts).toHaveLength(3); // but a verdict per instance
  });

  it('the second run of an unchanged crop costs ZERO model calls (the DoD)', async () => {
    let calls = 0;
    const stub: Adjudicator = async () => {
      calls++;
      return { verdict: 'violation', reason: 'low contrast' };
    };
    const crop = cropRegion(gradient, { x: 30, y: 30, width: 40, height: 40 }).buffer;

    const first = await adjudicateQueue([request(crop)], { adjudicator: stub, model: 'test-model', cwd, capturedAt: 'now' });
    expect(first.stats.modelCalls).toBe(1);
    expect(calls).toBe(1);

    const second = await adjudicateQueue([request(crop)], { adjudicator: stub, model: 'test-model', cwd, capturedAt: 'now' });
    expect(second.stats.modelCalls).toBe(0); // fully cached
    expect(second.stats.cacheHits).toBe(1);
    expect(calls).toBe(1); // the stub was never called again
  });

  it('a changed rubric version invalidates the cache', async () => {
    let calls = 0;
    const stub: Adjudicator = async () => {
      calls++;
      return { verdict: 'pass', reason: 'fine' };
    };
    const crop = cropRegion(gradient, { x: 5, y: 5, width: 30, height: 30 }).buffer;
    await adjudicateQueue([request(crop)], { adjudicator: stub, model: 'test-model', cwd, capturedAt: 'now' });
    const bumped = { ...request(crop), rubricVersion: '2026-09-01.2' };
    await adjudicateQueue([bumped], { adjudicator: stub, model: 'test-model', cwd, capturedAt: 'now' });
    expect(calls).toBe(2); // different rubric version -> not a cache hit
  });
});

describe('buildAdjudicationQueue + review from a run', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'complykit-r-'));
  });
  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

  function runWithNeedsReview(): { run: Run; finding: Finding } {
    const runId = asRunId('2026-08-19T10-00-00.000Z');
    const run: Run = {
      schemaVersion: 1,
      id: runId,
      property: 'shop',
      startedAt: 'now',
      versions: { package: '0', registry: REGISTRY_VERSION, engines: {} },
      accessLevels: ['public'],
      matrix: [],
      gaps: [],
      rulesExecuted: [],
    };
    writeRun(run, cwd);
    // Store a screenshot in evidence and a needs-review contrast finding pointing at it.
    const shotPath = putEvidence(runId, gradient, 'png', cwd);
    const subject = { property: 'shop', routePattern: '/', locator: { role: 'text', ordinal: 0 } };
    const finding: Finding = {
      schemaVersion: 1,
      ruleId: asRuleId('contrast.text'),
      requirementId: asRequirementId('wcag22.1.4.3'),
      subject,
      confidence: 'needs-review',
      severity: 'serious',
      message: 'non-flat contrast ambiguous',
      evidence: [{ kind: 'screenshot', path: shotPath, region: { x: 20, y: 20, width: 60, height: 40 } }],
      fingerprint: fingerprint({ detects: 'presence', ruleId: asRuleId('contrast.text'), subject }),
      producer: { type: 'rule', packageVersion: '0' },
      runId,
    };
    appendFinding(runId, finding, cwd);
    return { run, finding };
  }

  it('builds a queue from a needs-review finding with a crop + rubric', () => {
    const { run, finding } = runWithNeedsReview();
    const queue = buildAdjudicationQueue([finding], { runId: run.id, cwd });
    expect(queue).toHaveLength(1);
    expect(queue[0].requirementId).toBe('wcag22.1.4.3');
    // The crop was persisted content-addressed under the run's evidence dir.
    const cropHash = contentHash(queue[0].cropBuffer);
    expect(fs.existsSync(path.join(runDir(run.id, cwd), 'evidence', `${cropHash}.png`))).toBe(true);
  });

  it('review adjudicates the queue and caches (second review = 0 calls)', async () => {
    const { run, finding } = runWithNeedsReview();
    let calls = 0;
    const stub: Adjudicator = async () => {
      calls++;
      return { verdict: 'violation', reason: 'text hard to read on the gradient' };
    };
    const first = await review([finding], { adjudicator: stub, model: 'test-model', cwd, runId: run.id, capturedAt: 'now' });
    expect(first.queued).toBe(1);
    expect(first.stats.modelCalls).toBe(1);

    const second = await review([finding], { adjudicator: stub, model: 'test-model', cwd, runId: run.id, capturedAt: 'now' });
    expect(second.stats.modelCalls).toBe(0);
    expect(calls).toBe(1);
  });
});
