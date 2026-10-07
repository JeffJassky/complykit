import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runConsentScan, type ConsentScanResult } from '../src/pipeline.js';
import { asRunId, type LocationSpec } from '../src/record/index.js';
import { buildKnowledgeBase } from '../src/registry/index.js';
import { buildConsentReportModel, renderConsentHtml, renderConsentMarkdown } from '../src/report/index.js';
import { startProofSite, clientBuilt, type ProofSite } from './fixtures/proof-site.js';

// D10 "done when", the browser half: a fixture site with the BUILT tool
// installed (client/dist) is rescanned from a verified German location. The
// scanner must detect the tool, drive it by its exact hooks (no heuristics),
// and compare the deployed config with what ran:
//   - the deliberately ungated vendor (stats.test, tag never rewritten) is
//     reported NOT controlled, and as a gate rule never rewritten in the HTML;
//   - the correctly gated vendor (adpixel.test) is 'controlled' only because it
//     was held after reject / withdraw AND ran after accept;
//   - the stale config (the workspace holds a newer one) is flagged;
//   - a refused config (wrong major) and a tool loaded after GTM are flagged.
//
// Skips without Chromium or when client/dist has not been built
// (`npm --prefix client run build`); the skip is visible in the test output.

let chromiumAvailable = false;
try {
  const { chromium } = await import('playwright');
  chromiumAvailable = fs.existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}
const suite = chromiumAvailable && clientBuilt() ? describe : describe.skip;

const STUB = { name: 'stub', lookup: async (_f: unknown, spec: LocationSpec) => ({ ip: '198.51.100.1', country: spec.country, region: spec.region }) };
const KB = buildKnowledgeBase({
  extra: [
    { id: 'fixture.ads', vendor: 'Fixture Ads', match: { hosts: ['adpixel.test'] }, categories: ['advertising'], provenance: { proposedBy: 'test', proposedAt: '2026-10-02', confirmedBy: 'test', confirmedAt: '2026-10-02', sources: [] } },
    { id: 'fixture.stats', vendor: 'Fixture Stats', match: { hosts: ['stats.test'] }, categories: ['analytics'], provenance: { proposedBy: 'test', proposedAt: '2026-10-02', confirmedBy: 'test', confirmedAt: '2026-10-02', sources: [] } },
  ],
});

suite('rescan of a site running complykit’s own consent tool (fixture, DE)', () => {
  let site: ProofSite;
  let cwd: string;
  let main: ConsentScanResult;
  let refused: ConsentScanResult;
  let afterGtm: ConsentScanResult;

  const scan = (id: string, url: string, scenarios: LocationSpec['scenarios'], workspace?: Parameters<typeof runConsentScan>[0]['workspace']): Promise<ConsentScanResult> =>
    runConsentScan({
      runId: asRunId(id),
      property: 'fixture',
      targetUrl: url,
      cwd,
      packageVersion: '0.0.0-test',
      locations: [{ id: 'de', country: 'DE', scenarios }],
      journey: { dwellMs: 1500, pageDwellMs: 600, scrollSteps: 1, maxPages: 1 },
      bannerWaitMs: 2500,
      geoSources: [STUB, { ...STUB, name: 'stub-b' }],
      launchArgs: site.launchArgs,
      knowledgeBase: KB,
      workspace,
      trace: process.env.CK_TRACE ? (l) => console.log(l) : undefined,
    });

  beforeAll(async () => {
    site = await startProofSite('proof-shop.test');
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'complykit-proof-'));
    main = await scan('proof-main', site.url, ['browse', 'reject', 'accept', 'withdraw'], {
      entries: {},
      config: { value: { config: site.workspaceConfig, snippet: '', changeList: '', notes: [] }, at: '2026-10-07T10:01:00Z', runId: 'run-b' },
    });
    refused = await scan('proof-refused', `${site.url}refused`, ['browse']);
    afterGtm = await scan('proof-after-gtm', `${site.url}after-gtm`, ['browse']);
  }, 600000);

  afterAll(async () => {
    await site?.close();
    if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('detects the tool on every landing: global, config element, state, diagnostics, gate markers', () => {
    const de = main.evaluation.locations[0];
    for (const s of de.scenarios) {
      expect(s.status, `${s.scenario}: ${s.reason ?? ''}`).toBe('tested');
      expect(s.complykit).toMatchObject({ present: true, global: true, configElement: true, running: true, bannerShown: true });
      expect(s.complykit?.state).toMatchObject({ status: 'unset', regime: 'opt-in', categories: { necessary: true, analytics: false, advertising: false } });
      expect(s.complykit?.diagnostics?.gtm).toMatchObject({ orderOk: true });
      expect(s.complykit?.gate).toMatchObject({ held: 1, released: 0, heldCategories: ['advertising'] });
      expect(s.banner).toMatchObject({ found: true, cmp: 'complykit' });
    }
    const p = main.evaluation.consentToolProof!;
    expect(p.detected).toBe(true);
    expect(p.version).toBe('0.0.0');
    expect(p.config).toMatchObject({ status: 'ok', hashMatches: true, hash: site.config.hash, generatedFrom: { site: 'proof-shop.test', runId: 'run-a' } });
  });

  it('drives the tool by its exact hooks, never by text matching', () => {
    const choice = (scenario: string) => main.evaluation.locations[0].scenarios.find((s) => s.scenario === scenario)!.choice!;
    expect(choice('reject')).toMatchObject({ kind: 'reject', ok: true, method: 'selector:complykit' });
    expect(choice('accept')).toMatchObject({ kind: 'accept', ok: true, method: 'selector:complykit' });
    const w = choice('withdraw');
    expect(w.ok, w.method).toBe(true);
    expect(w.method).toContain('complykit:click(.ck-choices)');
    expect(w.method).toContain('complykit:click(settings reject)');
    expect(main.evaluation.consentToolProof!.driven.map((d) => d.scenario).sort()).toEqual(['accept', 'reject', 'withdraw']);
  });

  it('the deliberately ungated vendor is NOT controlled; the gated one is controlled only with both observations', () => {
    const p = main.evaluation.consentToolProof!;
    const stats = p.vendors.find((v) => v.id === 'fixture.stats')!;
    const ads = p.vendors.find((v) => v.id === 'fixture.ads')!;
    expect(stats.result).toBe('not-controlled');
    expect(stats.observations.filter((o) => !o.expectedGranted && o.observed === 'fired').map((o) => o.scenario)).toEqual(expect.arrayContaining(['browse', 'reject']));
    expect(ads.result, ads.reason).toBe('controlled');
    expect(ads.observations.filter((o) => !o.expectedGranted).every((o) => o.observed === 'held')).toBe(true);
    expect(ads.observations.some((o) => o.expectedGranted && o.scenario === 'accept' && o.observed === 'fired')).toBe(true);
    expect(p.totals).toEqual({ controlled: 1, notControlled: 1, notObserved: 0 });
    // Its tag in the served HTML: executable, matching the gate rule, never rewritten.
    const unrewritten = p.findings.find((f) => f.code === 'gate-rule-unrewritten')!;
    expect(unrewritten.message).toContain('Fixture Stats');
    expect(unrewritten.details).toMatchObject({ category: 'analytics', vendor: 'fixture.stats' });
    expect(p.findings.find((f) => f.code === 'vendor-not-controlled')!.message).toContain('Fixture Stats');
  });

  it('the stale config is flagged against the workspace', () => {
    const p = main.evaluation.consentToolProof!;
    expect(p.config.workspace).toMatchObject({ same: false, hash: site.workspaceConfig.hash, runId: 'run-b' });
    const f = p.findings.find((x) => x.code === 'config-behind')!;
    expect(f.message).toContain('run run-a');
    expect(f.message).toContain('run run-b');
  });

  it('feeds the compatibility verdict: the ungated vendor is a behavior mismatch naming the deployed config', () => {
    const stats = main.evaluation.compatibility!.parties.find((c) => c.partyId === 'fixture.stats')!;
    expect(stats.behaviorMismatch).toBe(true);
    expect(stats.reasons.some((r) => r.source === 'behavior' && /deployed complykit config denies analytics/.test(r.note))).toBe(true);
    const ads = main.evaluation.compatibility!.parties.find((c) => c.partyId === 'fixture.ads')!;
    expect(ads.behaviorMismatch).toBe(false);
  });

  it('a refused config: the tool does nothing, the report says so, nothing is judged controlled', () => {
    const p = refused.evaluation.consentToolProof!;
    expect(p.detected).toBe(true);
    expect(p.seenIn[0]).toMatchObject({ running: false, bannerShown: false });
    expect(p.config).toMatchObject({ status: 'refused', guard: { ok: false, reason: 'newer-major' } });
    expect(p.findings.map((f) => f.code)).toContain('config-refused');
    expect(p.totals.controlled).toBe(0);
    expect(refused.evaluation.locations[0].scenarios[0].banner?.found).toBe(false);
  });

  it('a tool loaded after GTM is flagged from its own diagnostics', () => {
    const p = afterGtm.evaluation.consentToolProof!;
    const f = p.findings.find((x) => x.code === 'tool-after-gtm')!;
    expect(f.message).toContain('GTM-XXXX01');
    expect(f.details).toMatchObject({ containersLoadedBefore: ['GTM-XXXX01'], gtmEventBefore: true });
  });

  it('the report carries the section in HTML, Markdown and the JSON model', () => {
    const model = buildConsentReportModel(main.evaluation, main.findings);
    const r = model.consentToolProof!;
    expect(r.headline).toMatch(/^complykit consent tool detected — version 0\.0\.0, config generated 2026-10-06: 1 vendor controlled, 1 not \(Fixture Stats\), 0 not observed\. In this scan only: \d+ pages?, 1 location, logged out, 1 run each\.$/);
    const html = renderConsentHtml(model);
    expect(html).toContain('id="consent-tool-proof"');
    expect(html).toContain('data-proof-vendor="fixture.stats" data-result="not-controlled"');
    expect(html).toContain('data-proof-finding="config-behind"');
    expect(html).toContain('data-proof-finding="gate-rule-unrewritten"');
    expect(renderConsentMarkdown(model)).toContain(r.headline);
  });
});
