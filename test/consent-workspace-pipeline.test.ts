import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runConsentScan, type ConsentScanResult } from '../src/pipeline.js';
import { asRunId, runDir, writeTrackingEvaluation, type LocationSpec } from '../src/record/index.js';
import { buildConsentReportModel, diffConsentModels, renderConsentHtml, type ConsentReportModel } from '../src/report/index.js';
import { workspaceId } from '../src/report/workspace.js';
import { assembleAndWrite } from '../src/cli/write-run.js';
import { findPreviousConsentRun, readWorkspaceFile } from '../src/cli/previous-run.js';
import { startTrackingSite, type TrackingSite } from './fixtures/tracking-site.js';

// C3 "done when", fixture half: scan the fixture storefront, classify its
// unrecognized widget's cookie (and the widget) in the site workspace, scan
// again with --workspace: the cookie comes out classified, and the second run's
// report lists what changed since the first (found in .comply/runs).

let chromiumAvailable = false;
try {
  const { chromium } = await import('playwright');
  chromiumAvailable = fs.existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}
const suite = chromiumAvailable ? describe : describe.skip;

const STUB = { name: 'stub', lookup: async (_f: unknown, spec: LocationSpec) => ({ ip: '198.51.100.1', country: spec.country, region: spec.region }) };

suite('rescan with the site workspace (fixture storefront, DE)', () => {
  let site: TrackingSite;
  let cwd: string;
  let first: ConsentScanResult;
  let second: ConsentScanResult;
  let head: ConsentReportModel;

  const scan = async (id: string, startedAfter?: string, workspaceFile?: string): Promise<ConsentScanResult> => {
    const res = await runConsentScan({
      runId: asRunId(id),
      property: 'fixture',
      targetUrl: site.url,
      cwd,
      packageVersion: '0.0.0-test',
      locations: [{ id: 'de', country: 'DE', scenarios: ['browse', 'reject'] }],
      journey: { dwellMs: 1500, pageDwellMs: 600, scrollSteps: 1, maxPages: 1 },
      bannerWaitMs: 1500,
      geoSources: [STUB, { ...STUB, name: 'stub-b' }],
      launchArgs: site.launchArgs,
      workspace: workspaceFile ? readWorkspaceFile(workspaceFile) : undefined,
    });
    if (startedAfter) expect(res.evaluation.startedAt > startedAfter).toBe(true);
    // As the CLI writes a run.
    const { run } = assembleAndWrite({ runId: asRunId(id), property: 'fixture', now: res.evaluation.startedAt, packageVersion: '0.0.0-test', findings: res.findings, engines: {}, accessLevels: ['public'], matrix: res.matrix, rulesExecuted: res.rulesExecuted, cwd });
    writeTrackingEvaluation(runDir(run.id, cwd), res.evaluation);
    return res;
  };

  beforeAll(async () => {
    site = await startTrackingSite();
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'complykit-consent-ws-'));
    first = await scan('run-1');
    const widget = first.evaluation.inventory.find((p) => p.partyId === 'unknown:widget.test')!;
    // What the workbench (C2) writes: class:<data-class-key> → { value, at, by }.
    const ws = {
      version: 1,
      domain: first.evaluation.site.registrableDomain,
      entries: {
        ['class:' + workspaceId('storage', [widget.partyId, widget.domain, 'cookie', '_uw'])]: { value: { category: 'advertising', categoryChosen: true, purpose: 'visitor id for ads' }, at: '2026-10-06T10:00:00Z', by: 'Dana' },
        ['class:' + workspaceId('tool', [widget.partyId, widget.domain])]: { value: { category: 'advertising', categoryChosen: true }, at: '2026-10-06T10:00:00Z', by: 'Dana' },
        'task:some-action': { value: { status: 'done' }, at: '2026-10-06T10:05:00Z', by: 'Dana' },
      },
      runs: [],
    };
    const file = path.join(cwd, 'workspace.json');
    fs.writeFileSync(file, JSON.stringify(ws));
    second = await scan('run-2', first.evaluation.startedAt, file);
    head = buildConsentReportModel(second.evaluation, second.findings);
    const prev = findPreviousConsentRun({ cwd, current: 'run-2', site: second.evaluation.site.registrableDomain, before: second.evaluation.startedAt });
    expect(prev?.evaluation.runId).toBe('run-1');
    head.since = diffConsentModels(buildConsentReportModel(prev!.evaluation, prev!.findings), head);
  }, 300000);

  afterAll(async () => {
    await site?.close();
    if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('first run: the widget and its cookie are unclassified', () => {
    const widget = first.evaluation.inventory.find((p) => p.partyId === 'unknown:widget.test')!;
    expect(widget.recognized).toBe(false);
    const model = buildConsentReportModel(first.evaluation, first.findings);
    expect(model.behaviorMatrix!.rows.find((r) => r.kind === 'storage' && r.label === '_uw')?.categories).toEqual([]);
    expect(first.evaluation.researchQueue.some((q) => q.partyId === 'unknown:widget.test')).toBe(true);
  });

  it('second run: the classified cookie and tool come out classified, and are not asked again', () => {
    const widget = second.evaluation.inventory.find((p) => p.partyId === 'unknown:widget.test')!;
    expect(widget).toMatchObject({ recognized: true, categories: ['advertising'] });
    expect(second.evaluation.researchQueue.some((q) => q.partyId === 'unknown:widget.test')).toBe(false);
    expect(second.evaluation.versions.kb).toMatch(/\+site\.1$/);
    expect(second.evaluation.siteWorkspace?.classifications.map((c) => c.kind).sort()).toEqual(['storage', 'tool']);
    expect(second.evaluation.siteWorkspace?.doneTasks).toEqual([{ key: 'some-action', at: '2026-10-06T10:05:00Z', by: 'Dana' }]);
    const row = head.behaviorMatrix!.rows.find((r) => r.kind === 'storage' && r.label === '_uw')!;
    expect(row).toMatchObject({ categories: ['advertising'], categorySource: 'your team’s site classification' });
  });

  it('second run: the report lists what changed since the first', () => {
    const d = head.since!;
    expect(d.base.runId).toBe('run-1');
    expect(d.parties.recategorized).toEqual([expect.objectContaining({ partyId: 'unknown:widget.test', from: ['unknown'], categories: ['advertising'] })]);
    expect(d.classified.some((c) => c.row === '_uw' && c.to.includes('advertising'))).toBe(true);
    expect(d.cells.length).toBeGreaterThan(0);
    const html = renderConsentHtml(head);
    expect(html).toContain('id="since-last-run"');
    expect(html).toContain('_uw: unclassified → advertising');
    expect(html).toContain('Tasks your team marked done');
  });
});
