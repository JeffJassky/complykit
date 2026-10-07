import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runConsentScan, type ConsentScanResult } from '../src/pipeline.js';
import { throttledBudget, type EvaluationEvent } from '../src/collect/browser/evaluation/index.js';
import { asRunId, type LocationSpec } from '../src/record/index.js';
import { buildConsentReportModel, renderConsentHtml, renderConsentMarkdown } from '../src/report/index.js';
import { startRaceSite, type RaceSite } from './fixtures/race-site.js';

// A7: a tracker that fires only when the consent tool loads slowly. One normal
// run misses it; the throttled second run catches it, and the record, the
// summary and the matrix tooltips say "active in 1 of 2 runs".

let chromiumAvailable = false;
try {
  const { chromium } = await import('playwright');
  chromiumAvailable = fs.existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}
// COMPLYKIT_BROWSER_CHANNEL (an installed Chrome / Edge) counts as a browser too.
const suite = chromiumAvailable || process.env.COMPLYKIT_BROWSER_CHANNEL ? describe : describe.skip;

const STUB = [
  { name: 'stub-a', lookup: async (_f: unknown, spec: LocationSpec) => ({ ip: '198.51.100.1', country: spec.country, region: spec.region }) },
  { name: 'stub-b', lookup: async (_f: unknown, spec: LocationSpec) => ({ ip: '198.51.100.1', country: spec.country, region: spec.region }) },
];

suite('consent runs: throttled repeat visit (timing race fixture)', () => {
  let site: RaceSite;
  let cwd: string;
  let single: ConsentScanResult;
  let double: ConsentScanResult;
  const events: Record<number, EvaluationEvent[]> = { 1: [], 2: [] };

  const scan = (runs: number): Promise<ConsentScanResult> =>
    runConsentScan({
      runId: asRunId(`race${runs}`),
      property: 'fixture',
      targetUrl: site.url,
      cwd,
      packageVersion: '0.0.0-test',
      locations: [{ id: 'de', country: 'DE', scenarios: ['browse'] }],
      journey: { dwellMs: 1500, pageDwellMs: 600, scrollSteps: 1, maxPages: 1 },
      bannerWaitMs: 1000,
      geoSources: STUB,
      launchArgs: site.launchArgs,
      runs,
      onEvent: (e) => events[runs].push(e),
    });
  const tracker = (r: ConsentScanResult) => r.evaluation.inventory.find((p) => p.domain === 'racetracker.test');

  beforeAll(async () => {
    site = await startRaceSite();
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'complykit-runs-'));
    single = await scan(1);
    double = await scan(2);
  }, 300000);

  afterAll(async () => {
    await site?.close();
    if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('a single normal run does not see the tracker (the race is invisible to one clean run)', () => {
    expect(tracker(single)).toBeUndefined();
    const cell = single.evaluation.locations[0].scenarios[0];
    expect(cell.runs).toBeUndefined();
    expect(single.evaluation.behaviorObservations?.every((o) => o.run === undefined)).toBe(true);
  });

  it('the throttled second run catches it and the scenario records two completed runs', () => {
    expect(tracker(double)).toBeDefined();
    expect(double.evaluation.locations[0].scenarios[0].runs).toBe(2);
    const obs = double.evaluation.behaviorObservations ?? [];
    expect(obs.map((o) => [o.run, o.throttled])).toEqual([[1, undefined], [2, true]]);
    const active = (run: number) => obs.find((o) => o.run === run)?.parties.some((p) => p.partyId === tracker(double)!.partyId && p.dataRequests > 0);
    expect(active(1)).toBeFalsy();
    expect(active(2)).toBe(true);
  });

  it('the matrix cell stores runs { total, active } and says "active in 1 of 2 runs"', () => {
    const model = buildConsentReportModel(double.evaluation, double.findings);
    const row = model.behaviorMatrix!.rows.find((r) => r.kind === 'tool' && r.partyId === tracker(double)!.partyId)!;
    expect(row.cells[0].runs).toEqual({ total: 2, active: 1 });
    expect(row.cells[0].observed).toContain('Active in 1 of 2 runs');
    const html = renderConsentHtml(model);
    expect(html).toContain('active in 1 of 2 runs');
    // The summary prints run counts and names the timing-dependent tool.
    const md = renderConsentMarkdown(model);
    expect(md).toContain('(2 runs)');
    expect(md).toContain('active in 1 of 2 runs');
  });

  it('progress events: the location plans scenarios x runs; the repeat has its own start/done carrying run 2', () => {
    const shape = (list: EvaluationEvent[]) => list.map((e) => (e.type === 'location' ? [e.type, e.scenarios.length, e.runs] : [e.type, e.scenario, e.run, e.type === 'scenario-done' ? e.status : undefined]));
    expect(shape(events[1])).toEqual([
      ['location', 1, 1],
      ['scenario-start', 'browse', undefined, undefined],
      ['scenario-done', 'browse', undefined, 'tested'],
    ]);
    expect(shape(events[2])).toEqual([
      ['location', 1, 2],
      ['scenario-start', 'browse', undefined, undefined],
      ['scenario-done', 'browse', undefined, 'tested'],
      ['scenario-start', 'browse', 2, undefined],
      ['scenario-done', 'browse', 2, 'tested'],
    ]);
    const repeat = events[2].at(-1) as Extract<EvaluationEvent, { type: 'scenario-done' }>;
    expect(repeat.requests).toBeGreaterThan(0);
    expect(repeat.durationMs).toBeGreaterThan(0);
  });

  it('a single run stores runs { total: 1 } and prints no run qualifier', () => {
    const model = buildConsentReportModel(single.evaluation, single.findings);
    for (const row of model.behaviorMatrix!.rows) for (const c of row.cells) if (c.runs) expect(c.runs.total).toBe(1);
    expect(renderConsentMarkdown(model)).not.toContain('runs)');
  });
});

describe('throttled runs get their own budget (#50)', () => {
  it('the scenario budget times the factor (default 3); a bad factor falls back to the default', () => {
    expect(throttledBudget({})).toBe(900000);
    expect(throttledBudget({ scenarioTimeoutMs: 10000 })).toBe(30000);
    expect(throttledBudget({ scenarioTimeoutMs: 10000, throttledBudgetFactor: 5 })).toBe(50000);
    expect(throttledBudget({ scenarioTimeoutMs: 10000, throttledBudgetFactor: 0 })).toBe(30000);
    expect(throttledBudget({ scenarioTimeoutMs: 10000, throttledBudgetFactor: Number.NaN })).toBe(30000);
  });
});

// A slow fixture: the race site's padded consent tool under Slow 3G takes several
// seconds; the normal run finishes well inside the budget, the throttled one does not.
suite('throttled runs: budget (#50, slow fixture)', () => {
  let site: RaceSite;
  let cwd: string;
  const BUDGET = 9000;
  const scan = (id: string, throttledBudgetFactor: number, events?: EvaluationEvent[]): Promise<ConsentScanResult> =>
    runConsentScan({
      runId: asRunId(id),
      property: 'fixture',
      targetUrl: site.url,
      cwd,
      packageVersion: '0.0.0-test',
      locations: [{ id: 'de', country: 'DE', scenarios: ['browse'] }],
      journey: { dwellMs: 1500, pageDwellMs: 600, scrollSteps: 1, maxPages: 1 },
      bannerWaitMs: 1000,
      geoSources: STUB,
      launchArgs: site.launchArgs,
      runs: 2,
      scenarioTimeoutMs: BUDGET,
      throttledBudgetFactor,
      onEvent: events ? (e) => events.push(e) : undefined,
    });

  beforeAll(async () => {
    site = await startRaceSite();
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'complykit-budget-'));
  });
  afterAll(async () => {
    await site?.close();
    if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('a throttled run cut short by its budget is a not-tested item for that run; the first run stands', async () => {
    const events: EvaluationEvent[] = [];
    const r = await scan('budget1', 0.3, events); // throttled budget 2.7 s: too short for Slow 3G
    // The cut-short repeat still closes its progress step, as not tested.
    expect(events.filter((e) => e.type === 'scenario-done').map((e) => [e.type === 'scenario-done' && e.run, e.type === 'scenario-done' && e.status])).toEqual([
      [undefined, 'tested'],
      [2, 'not-tested'],
    ]);
    const cell = r.evaluation.locations[0].scenarios[0];
    expect(cell.status).toBe('tested');
    expect(cell.runs).toBe(1);
    const gap = r.evaluation.notTested.find((n) => n.scope === 'scenario' && n.id === 'browse');
    expect(gap?.reason).toMatch(/throttled run 2 of 2 did not complete: scenario exceeded its 3s budget/);
    expect(r.evaluation.behaviorObservations?.map((o) => o.run)).toEqual([1]);
  }, 120000);

  it('a first visit that is not applicable skips its repeat, and the skipped repeat still closes its progress step', async () => {
    const events: EvaluationEvent[] = [];
    const r = await runConsentScan({
      runId: asRunId('skip1'),
      property: 'fixture',
      targetUrl: site.url,
      cwd,
      packageVersion: '0.0.0-test',
      locations: [{ id: 'de', country: 'DE', scenarios: ['reject'] }], // the race site shows no banner
      journey: { dwellMs: 500, pageDwellMs: 300, scrollSteps: 1, maxPages: 1 },
      bannerWaitMs: 500,
      geoSources: STUB,
      launchArgs: site.launchArgs,
      runs: 2,
      onEvent: (e) => events.push(e),
    });
    expect(r.evaluation.locations[0].scenarios[0].status).toBe('not-applicable');
    const done = events.filter((e): e is Extract<EvaluationEvent, { type: 'scenario-done' }> => e.type === 'scenario-done');
    expect(done.map((e) => [e.run, e.status])).toEqual([
      [undefined, 'not-applicable'],
      [2, 'not-applicable'],
    ]);
    expect(done[1].reason).toBe('repeat skipped: the first visit was not applicable');
    // No visit started for it.
    expect(events.filter((e) => e.type === 'scenario-start')).toHaveLength(1);
  }, 120000);

  it('with the scaled budget the throttled run completes', async () => {
    const r = await scan('budget3', 3); // 27 s
    expect(r.evaluation.locations[0].scenarios[0].runs).toBe(2);
    expect(r.evaluation.notTested.some((n) => n.scope === 'scenario' && /throttled run/.test(n.reason))).toBe(false);
  }, 120000);
});
