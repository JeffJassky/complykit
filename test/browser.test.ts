import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { collectBrowser } from '../src/collect/browser/index.js';
import { normalizeEngineArtifacts } from '../src/engines.js';
import { evaluate, ALL_RULES, resolveCapsFor } from '../src/rules/index.js';
import { resolveFinding, asRunId, AXE_VERSION, type Artifact, type Finding } from '../src/index.js';

// The browser passive pass against a deterministic local page (no network, so
// no flake source). Skips itself when Chromium is not installed (`npx playwright
// install chromium`), so a browser-less environment stays green; CI installs it.

const PAGE_URL = pathToFileURL(fileURLToPath(new URL('./fixtures/pages/sample.html', import.meta.url))).href;

let chromiumAvailable = false;
try {
  const { chromium } = await import('playwright');
  chromiumAvailable = fs.existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}
const suite = chromiumAvailable ? describe : describe.skip;

function allFindings(artifacts: Artifact[]): Finding[] {
  const engine = normalizeEngineArtifacts(artifacts, { runId: asRunId('t'), engineVersions: { 'axe-core': AXE_VERSION } }).findings;
  const raws = evaluate(artifacts, ALL_RULES, { property: 'sample', tags: [] });
  const rules = raws.map((r) =>
    resolveFinding(r, { caps: resolveCapsFor(r.ruleId, r.requirementId), runId: asRunId('t'), producer: { type: 'rule', packageVersion: '0' } }),
  );
  return [...engine, ...rules];
}

suite('collect/browser passive pass', () => {
  let cwd: string;
  let artifacts: Artifact[];
  let findings: Finding[];

  beforeAll(async () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'complykit-b-'));
    const collection = await collectBrowser({
      property: 'sample',
      targetUrl: PAGE_URL,
      runId: asRunId('t'),
      cwd,
      routes: { sitemap: false },
    });
    artifacts = collection.artifacts;
    findings = allFindings(artifacts);
  }, 60000);

  afterAll(() => {
    if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('captures a screenshot, an axe result, a contrast probe, and a snapshot', () => {
    const kinds = new Set(artifacts.map((a) => a.kind));
    expect(kinds.has('screenshot')).toBe(true);
    expect(kinds.has('axe-result')).toBe(true);
    expect(kinds.has('style-probe')).toBe(true);
    expect(kinds.has('dom-snapshot')).toBe(true);
  });

  it('stores the screenshot as content-addressed evidence', () => {
    const shot = artifacts.find((a) => a.kind === 'screenshot');
    expect(shot?.kind).toBe('screenshot');
    if (shot?.kind === 'screenshot') {
      expect(fs.existsSync(path.join(cwd, '.comply', 'runs', 't', shot.path))).toBe(true);
    }
  });

  it('axe finds the missing alt, empty button, and missing lang', () => {
    const reqs = new Set(findings.filter((f) => f.producer.type === 'engine').map((f) => String(f.requirementId)));
    expect(reqs.has('wcag22.1.1.1')).toBe(true); // image-alt
    expect(reqs.has('wcag22.4.1.2')).toBe(true); // button-name
    expect(reqs.has('wcag22.3.1.1')).toBe(true); // html-has-lang
  });

  it('the contrast rule flags the low-contrast paragraph as a flat-colour violation', () => {
    const contrast = findings.filter((f) => String(f.ruleId) === 'contrast.text');
    expect(contrast.length).toBeGreaterThanOrEqual(1);
    const violation = contrast.find((f) => f.confidence === 'violation');
    expect(violation).toBeDefined();
    expect(String(violation?.requirementId)).toBe('wcag22.1.4.3');
  });

  it('does not flag the good-contrast paragraph', () => {
    const contrastMsgs = findings.filter((f) => String(f.ruleId) === 'contrast.text').map((f) => JSON.stringify(f.details));
    // The good paragraph text should not appear among contrast findings.
    expect(contrastMsgs.some((m) => m.includes('Good contrast'))).toBe(false);
  });

  it('is deterministic across two runs (no flake on a static page)', async () => {
    const cwd2 = fs.mkdtempSync(path.join(os.tmpdir(), 'complykit-b2-'));
    try {
      const c2 = await collectBrowser({ property: 'sample', targetUrl: PAGE_URL, runId: asRunId('t'), cwd: cwd2, routes: { sitemap: false } });
      const f2 = allFindings(c2.artifacts);
      const set1 = new Set(findings.map((f) => f.fingerprint));
      const set2 = new Set(f2.map((f) => f.fingerprint));
      expect([...set2].sort()).toEqual([...set1].sort());
    } finally {
      fs.rmSync(cwd2, { recursive: true, force: true });
    }
  }, 60000);
});
