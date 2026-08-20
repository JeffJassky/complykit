import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { collectBrowser } from '../src/collect/browser/index.js';
import { asRunId, type Artifact } from '../src/index.js';

// M3 integration: consent evidence + keyboard probes against a fixture with a
// mock CMP banner (prominent Accept, tiny Reject). Skips without Chromium.

const PAGE_URL = pathToFileURL(fileURLToPath(new URL('./fixtures/pages/consent.html', import.meta.url))).href;

let chromiumAvailable = false;
try {
  const { chromium } = await import('playwright');
  chromiumAvailable = fs.existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}
const suite = chromiumAvailable ? describe : describe.skip;

suite('collect/browser M3 evidence + probes', () => {
  let cwd: string;
  let artifacts: Artifact[];

  beforeAll(async () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'complykit-m3-'));
    const collection = await collectBrowser({
      property: 'shop',
      targetUrl: PAGE_URL,
      runId: asRunId('t'),
      cwd,
      routes: { sitemap: false },
    });
    artifacts = collection.artifacts;
  }, 90000);

  afterAll(() => {
    if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('detects the CMP and records a consent-flow artifact', () => {
    const flow = artifacts.find((a) => a.kind === 'consent-flow');
    expect(flow?.kind).toBe('consent-flow');
    if (flow?.kind === 'consent-flow') {
      expect(flow.cmp).toBeTruthy(); // heuristic banner detected
      expect(flow.clicksToAccept).toBe(1);
      expect(flow.clicksToReject).toBe(1); // a direct reject exists
      const roles = flow.buttonMetrics.map((m) => (m as { role: string }).role);
      expect(roles).toContain('accept');
      expect(roles).toContain('reject');
    }
  });

  it('captures the three consent phases', () => {
    const phases = new Set(
      artifacts.filter((a): a is Extract<Artifact, { kind: 'cookie-capture' }> => a.kind === 'cookie-capture').map((a) => a.phase),
    );
    expect(phases.has('pre-consent')).toBe(true);
    expect(phases.has('post-reject')).toBe(true);
    expect(phases.has('post-accept')).toBe(true);
  });

  it('walks the keyboard and records a focus-walk artifact with stops', () => {
    const walk = artifacts.find((a) => a.kind === 'focus-walk');
    expect(walk?.kind).toBe('focus-walk');
    if (walk?.kind === 'focus-walk') {
      expect(walk.stops.length).toBeGreaterThan(0);
    }
  });
});
