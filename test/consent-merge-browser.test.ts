import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeConsentScan, collectConsentScan, runConsentScan, type ConsentScanOptions, type ConsentScanResult } from '../src/pipeline.js';
import { COLLECTION_FILE, COLLECTION_KIND, COLLECTION_SCHEMA_VERSION, mergeCollections, writeCollectionHandoff, type ConsentCollectionHandoff } from '../src/consent-collection.js';
import { asRunId, runDir, type Finding, type LocationSpec } from '../src/record/index.js';
import { buildKnowledgeBase } from '../src/registry/index.js';
import { cmdConsent } from '../src/cli/commands/consent.js';
import { loadConfigFor } from '../src/cli/config-load.js';
import { startTrackingSite, type TrackingSite } from './fixtures/tracking-site.js';

// PR 1 contract (plans/multi-region-contract.md §1c–1d), browser half: a
// regional worker collects one location, the primary merges and analyzes.
// Two single-location collections merged must give the same findings as one
// two-location scan; the CLI's --merge must write a normal run. Geolocation is
// stubbed as in consent-pipeline.test.ts.

let chromiumAvailable = false;
try {
  const { chromium } = await import('playwright');
  chromiumAvailable = fs.existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}
const suite = chromiumAvailable || process.env.COMPLYKIT_BROWSER_CHANNEL ? describe : describe.skip;

const STUB = [
  { name: 'stub-a', lookup: async (_f: unknown, spec: LocationSpec) => ({ ip: '198.51.100.1', country: spec.country, region: spec.region }) },
  { name: 'stub-b', lookup: async (_f: unknown, spec: LocationSpec) => ({ ip: '198.51.100.1', country: spec.country, region: spec.region }) },
];
const DE: LocationSpec = { id: 'de', country: 'DE', scenarios: ['browse', 'reject', 'accept'] };
const CA: LocationSpec = { id: 'us-ca', country: 'US', region: 'CA', scenarios: ['browse', 'gpc'] };

const sig = (fs_: Finding[]): string[] =>
  fs_.map((f) => [String(f.ruleId), f.subject.locator?.landmark ?? '', f.subject.locator?.name ?? '', String(f.requirementId ?? ''), f.confidence].join('|')).sort();

suite('collect on workers, merge on the primary', () => {
  let site: TrackingSite;
  const dirs: string[] = [];
  const mk = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-merge-'));
    dirs.push(d);
    return d;
  };
  let base: Omit<ConsentScanOptions, 'runId' | 'cwd' | 'locations'>;
  let whole: ConsentScanResult;
  let merged: ConsentScanResult;
  const handoffDirs: string[] = [];

  beforeAll(async () => {
    site = await startTrackingSite();
    base = {
      property: 'fixture',
      targetUrl: site.url,
      packageVersion: '0.0.0-test',
      journey: { dwellMs: 1500, pageDwellMs: 600, scrollSteps: 1, maxPages: 1 },
      bannerWaitMs: 1500,
      geoSources: STUB,
      launchArgs: site.launchArgs,
      knowledgeBase: buildKnowledgeBase({
        extra: [
          {
            id: 'fixture.ads',
            vendor: 'Fixture Ads',
            match: { hosts: ['adpixel.test'] },
            categories: ['advertising'],
            decoder: 'meta',
            provenance: { proposedBy: 'test', proposedAt: '2026-10-02', confirmedBy: 'test', confirmedAt: '2026-10-02', sources: [] },
          },
        ],
      }),
    };
    whole = await runConsentScan({ ...base, runId: asRunId('whole'), cwd: mk(), locations: [DE, CA] });

    const handoffs: ConsentCollectionHandoff[] = [];
    for (const loc of [DE, CA]) {
      const cwd = mk();
      const runId = asRunId(`worker-${loc.id}`);
      const { artifacts: _a, ...collection } = await collectConsentScan({ ...base, runId, cwd, locations: [loc] });
      const h: ConsentCollectionHandoff = { kind: COLLECTION_KIND, schemaVersion: COLLECTION_SCHEMA_VERSION, packageVersion: '0.0.0-test', property: 'fixture', targetUrl: site.url, runId: String(runId), collection };
      const dir = runDir(runId, cwd);
      writeCollectionHandoff(dir, h);
      handoffDirs.push(dir);
      handoffs.push(JSON.parse(JSON.stringify(h)) as ConsentCollectionHandoff); // as it would arrive over the wire
    }
    merged = analyzeConsentScan(mergeCollections(handoffs), { ...base, runId: asRunId('merged'), cwd: mk(), locations: [DE, CA] });
  }, 600000);

  afterAll(async () => {
    await site?.close();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it('collect-only writes evidence but no findings, report or evaluation', () => {
    for (const d of handoffDirs) {
      expect(fs.existsSync(path.join(d, COLLECTION_FILE))).toBe(true);
      expect(fs.existsSync(path.join(d, 'evidence', 'tracking'))).toBe(true);
      for (const f of ['findings.jsonl', 'run.json', 'tracking.json', 'consent-report.html']) expect(fs.existsSync(path.join(d, f)), f).toBe(false);
    }
  });

  it('merged collections give the same locations and findings as one two-location scan', () => {
    expect(merged.evaluation.locations.map((l) => [l.spec.id, l.verification.verdict])).toEqual(whole.evaluation.locations.map((l) => [l.spec.id, l.verification.verdict]));
    expect(sig(merged.findings)).toEqual(sig(whole.findings));
    expect(merged.findings.length).toBeGreaterThan(0);
    expect(merged.rulesExecuted).toEqual(whole.rulesExecuted);
  });

  it('CLI --merge writes a normal run with both locations and no raw collection', async () => {
    const cwd = mk();
    const events = path.join(cwd, 'events.ndjson');
    const code = await cmdConsent(
      ['--merge', handoffDirs.join(','), '--url', site.url, '--cwd', cwd, '--kb-dir', path.join(cwd, 'kb'), '--events', events, '--quiet', '--failed', 'us-tx=worker in dfw failed: boom'],
      loadConfigFor,
    );
    expect(code).toBe(0);
    const runs = fs.readdirSync(path.join(cwd, '.comply', 'runs'));
    expect(runs).toHaveLength(1);
    const run = path.join(cwd, '.comply', 'runs', runs[0]);
    for (const f of ['run.json', 'findings.jsonl', 'tracking.json', 'consent-report.html', 'change-list.md']) expect(fs.existsSync(path.join(run, f)), f).toBe(true);
    expect(fs.existsSync(path.join(run, COLLECTION_FILE))).toBe(false);
    expect(fs.existsSync(path.join(run, 'evidence', 'tracking', 'de'))).toBe(true);
    expect(fs.existsSync(path.join(run, 'evidence', 'tracking', 'us-ca'))).toBe(true);
    const tracking = JSON.parse(fs.readFileSync(path.join(run, 'tracking.json'), 'utf8')) as { locations: Array<{ spec: { id: string } }>; notTested: Array<{ scope: string; id: string; reason: string }> };
    expect(tracking.locations.map((l) => l.spec.id)).toEqual(['de', 'us-ca']);
    expect(tracking.notTested).toContainEqual(expect.objectContaining({ scope: 'location', id: 'us-tx', reason: 'worker in dfw failed: boom' }));
    const last = JSON.parse(fs.readFileSync(events, 'utf8').trim().split('\n').pop()!) as { type: string };
    expect(last.type).toBe('done');
    for (const d of handoffDirs) expect(fs.existsSync(path.join(d, COLLECTION_FILE))).toBe(true); // inputs untouched
  }, 120000);

  it('CLI --merge refuses another site', async () => {
    const code = await cmdConsent(['--merge', handoffDirs.join(','), '--url', 'https://other.example/', '--cwd', mk(), '--quiet', '--no-kb-queue'], loadConfigFor);
    expect(code).toBe(2);
  });
});

describe('CLI --merge / --collect-only flag rules (no browser)', () => {
  const run = (args: string[]): Promise<number> => cmdConsent([...args, '--url', 'https://shop.example/', '--cwd', fs.mkdtempSync(path.join(os.tmpdir(), 'ck-flags-')), '--quiet', '--no-kb-queue'], loadConfigFor);

  it.each([
    ['--collect-only'],
    ['--locations', 'de'],
    ['--proxy', 'de=socks5://127.0.0.1:1'],
    ['--scenarios', 'browse'],
    ['--quick'],
    ['--runs', '2'],
    ['--concurrency', '2'],
    ['--local-copy', 'x.json'],
  ])('--merge with %s is refused', async (...flag) => {
    expect(await run(['--merge', '/nonexistent', ...flag])).toBe(2);
  });

  it('--merge needs a dir; a dir without a collection is an error; --failed needs id=reason; --failed needs --merge', async () => {
    expect(await run(['--merge', ''])).toBe(2);
    expect(await run(['--merge', fs.mkdtempSync(path.join(os.tmpdir(), 'ck-empty-'))])).toBe(2);
    expect(await run(['--merge', '/nonexistent', '--failed', 'no-equals-sign'])).toBe(2);
    expect(await run(['--failed', 'de=x'])).toBe(2);
  });
});
