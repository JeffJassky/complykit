import { describe, it, expect } from 'vitest';
import { TrackingEvaluation, Timeline, withConsentConfigHash, type ComplykitToolSnapshot, type ConsentToolConfig, type ConsentToolConfigInput, type PartyInventoryItem, type ScenarioSummary } from '../src/record/index.js';
import { evaluateConsentToolProof, configBehaviorCells, expectedGrantedFor, behaviorCellsFrom } from '../src/rules/tracking/index.js';
import { summarizeBehavior } from '../src/rules/tracking/summary.js';
import { reconcileCompatibility, reconcileRecord } from '../src/consent-compatibility.js';
import { generateConsentConfig } from '../src/consent-generator.js';
import { buildRemediationTasks } from '../src/remediation.js';
import { buildConsentReportModel, buildConsentToolProofReport, renderConsentHtml, renderConsentMarkdown, renderConsentToolProofHtml, renderConsentToolProofMarkdown } from '../src/report/index.js';
import { PROOF_CSS } from '../src/report/consent-tool-proof.js';
import { parseWorkspaceSnapshot } from '../src/site-workspace.js';

// D10, the pure half: the decision rules in src/rules/tracking/consent-tool-proof.ts,
// over fixture records (no browser). The one contract that matters most: a
// vendor is 'controlled' only on a denied-state visit that held it AND a
// granted-state visit that ran it; everything else is not-controlled (it fired)
// or not-observed. No combination of missing evidence yields 'controlled'.

const PAGE = 'https://www.example-shop.test/';
const SITE = 'example-shop.test';

function configInput(over: Partial<ConsentToolConfigInput> = {}): Omit<ConsentToolConfigInput, 'hash'> {
  return {
    version: '1.0',
    generatedFrom: { runId: 'run-a', at: '2026-10-06T10:00:00.000Z', site: SITE, complykit: '0.0.0-test' },
    regimeSource: { kind: 'fixed', regime: 'opt-in' },
    categories: [
      { id: 'necessary', label: 'Necessary', description: 'Required.', defaultByRegime: { 'opt-in': true, 'opt-out-signal': true, 'opt-out': true } },
      { id: 'analytics', label: 'Analytics', description: 'Usage.', defaultByRegime: { 'opt-in': false, 'opt-out-signal': true, 'opt-out': true } },
      { id: 'advertising', label: 'Advertising', description: 'Ads.', defaultByRegime: { 'opt-in': false, 'opt-out-signal': false, 'opt-out': true } },
    ],
    vendors: [
      { id: 'fixture.ads', label: 'Fixture Ads', category: 'advertising', control: 'gate', stores: [] },
      { id: 'fixture.stats', label: 'Fixture Stats', category: 'analytics', control: 'gate', stores: [] },
    ],
    gate: [
      { category: 'advertising', src: 'adpixel\\.test/ads\\.js', vendor: 'fixture.ads' },
      { category: 'analytics', src: 'stats\\.test/s\\.js', vendor: 'fixture.stats' },
    ],
    platform: 'none',
    theme: {},
    strings: {},
    consent: { lifetimeDays: 365 },
    layout: 'bar',
    ...over,
  };
}
const config = (over: Partial<ConsentToolConfigInput> = {}): ConsentToolConfig => {
  const input = configInput(over);
  // A vendor override drops the gate rules that name vendors no longer listed (the schema refuses dangling ones).
  if (over.vendors && !over.gate) input.gate = (input.gate ?? []).filter((g) => !g.vendor || over.vendors!.some((v) => v.id === g.vendor));
  return withConsentConfigHash(input);
};

function party(partyId: string, label: string, categories: string[], over: Partial<PartyInventoryItem> = {}): PartyInventoryItem {
  return { partyId, label, domain: `${partyId.split('.')[1]}.test`, hosts: [`${partyId.split('.')[1]}.test`], recognized: true, kbStatus: 'confirmed', categories, behavesLikeTracker: true, trackerSignals: ['sends-page-address'], sends: ['page-address'], stores: [], sources: [], loadedBy: [], samples: [], seenIn: [], ...over };
}

function snapshot(cfg: unknown, over: Partial<ComplykitToolSnapshot> = {}): ComplykitToolSnapshot {
  return {
    present: true,
    global: true,
    version: '0.0.0-test',
    configElement: cfg !== undefined,
    configJson: cfg === undefined ? undefined : typeof cfg === 'string' ? cfg : JSON.stringify(cfg),
    cookiePresent: false,
    running: true,
    state: { status: 'unset', regime: 'opt-in', gpc: false, categories: { necessary: true, analytics: false, advertising: false } },
    diagnostics: { gtm: { orderOk: true, containersLoadedBefore: [], gtmEventBefore: false, containerScriptsBefore: [], warnings: [] }, location: { source: 'fixed', regime: 'opt-in', pending: false, gpc: false }, ui: { state: 'loaded', url: 'https://www.example-shop.test/complykit-consent-ui.js' } },
    gate: { released: 0, held: 1, heldCategories: ['advertising'] },
    bannerShown: true,
    reopenControl: false,
    ...over,
  };
}

// partyId → phase → data requests (a number), restricted-mode-only requests ({ limited }) or load-only requests ({ loads }).
type Obs = Record<string, Record<string, number | { limited: number } | { loads: number }>>;
const ALL_PHASES = ['no-banner', 'before-banner', 'before-choice', 'after-accept', 'after-reject', 'after-dismiss', 'after-partial', 'after-withdraw', 'after-opt-out-link'];
type Journey = Record<string, { pageIndexes: number[]; steps: string[] }>;
/** Default: every phase walked the same journey (two pages, navigation and scrolling, no site search). */
const SAME_JOURNEY: Journey = Object.fromEntries(ALL_PHASES.map((ph) => [ph, { pageIndexes: [0, 1], steps: ['navigate', 'scroll'] }]));
function observation(location: string, scenario: string, parties: Obs, known: string[], run?: number, journey: Journey | null = SAME_JOURNEY) {
  const data = (v: Obs[string][string]): number => (typeof v === 'number' ? v : 'limited' in v ? v.limited : 0);
  return {
    location,
    scenario,
    ...(run ? { run } : {}),
    durationMs: 5000,
    knownPartyIds: known,
    ...(journey ? { journey } : {}),
    parties: Object.entries(parties).map(([partyId, phases]) => ({
      partyId,
      dataRequests: Object.values(phases).reduce<number>((n, v) => n + data(v), 0),
      requestPhases: Object.keys(phases).filter((ph) => data(phases[ph]) > 0),
      dataRequestPhases: Object.fromEntries(Object.entries(phases).map(([ph, v]) => [ph, data(v)])),
      limitedRequestsByPhase: Object.fromEntries(Object.entries(phases).map(([ph, v]) => [ph, typeof v === 'object' && 'limited' in v ? v.limited : 0])),
      loadRequestsByPhase: Object.fromEntries(Object.entries(phases).map(([ph, v]) => [ph, typeof v === 'object' && 'loads' in v ? v.loads : 0])),
      stores: [],
    })),
  };
}

interface Build {
  cfg?: unknown;
  snap?: Partial<ComplykitToolSnapshot>;
  scenarios?: Array<Partial<ScenarioSummary> & { scenario: ScenarioSummary['scenario'] }>;
  observations?: ReturnType<typeof observation>[];
  inventory?: PartyInventoryItem[];
  jurisdictions?: string[];
  markup?: TrackingEvaluation['markup'];
  noTool?: boolean;
}

const INVENTORY = [party('fixture.ads', 'Fixture Ads', ['advertising']), party('fixture.stats', 'Fixture Stats', ['analytics'])];
const KNOWN = INVENTORY.map((p) => p.partyId);

function evaluation(b: Build = {}): TrackingEvaluation {
  const cfg = 'cfg' in b ? b.cfg : config();
  const snap = b.noTool ? undefined : snapshot(cfg, b.snap);
  const scenarios = (b.scenarios ?? [
    { scenario: 'reject', choice: { kind: 'reject', ok: true, method: 'selector:complykit' } },
    { scenario: 'accept', choice: { kind: 'accept', ok: true, method: 'selector:complykit' } },
  ]).map((s) => ({ status: 'tested', evidence: { screenshots: [] }, ...(snap ? { complykit: snap } : {}), ...s }));
  return TrackingEvaluation.parse({
    runId: 'd10-fixture',
    property: 'Example shop',
    site: { url: PAGE, host: 'www.example-shop.test', registrableDomain: SITE },
    versions: { kb: '0', registry: '0', package: '0' },
    startedAt: '2026-10-06T10:00:00Z',
    finishedAt: '2026-10-06T10:05:00Z',
    redacted: true,
    locations: [
      {
        spec: { id: 'de', label: 'Germany', country: 'DE', proxied: false },
        verification: { verdict: 'verified', expected: { country: 'DE' }, observed: { country: 'DE' }, sources: [], jurisdictions: b.jurisdictions ?? ['eu'], checkedAt: '2026-10-06T10:00:00Z' },
        scenarios,
      },
    ],
    inventory: b.inventory ?? INVENTORY,
    behaviorObservations: b.observations ?? [
      observation('de', 'reject', { 'fixture.stats': { 'after-reject': 2 } }, KNOWN),
      observation('de', 'accept', { 'fixture.ads': { 'after-accept': 1 }, 'fixture.stats': { 'after-accept': 2 } }, KNOWN),
    ],
    ...(b.markup ? { markup: b.markup } : {}),
    notTested: [],
    researchQueue: [],
  });
}

const vendor = (ev: TrackingEvaluation, id: string) => evaluateConsentToolProof(ev).vendors.find((v) => v.id === id)!;
const codes = (ev: TrackingEvaluation, input?: Parameters<typeof evaluateConsentToolProof>[1]) => evaluateConsentToolProof(ev, input).findings.map((f) => f.code);

describe('D10 proof: detection and the per-vendor decision', () => {
  it('not detected: an empty section, no behavior cells', () => {
    const p = evaluateConsentToolProof(evaluation({ noTool: true }));
    expect(p.detected).toBe(false);
    expect(p.vendors).toEqual([]);
    expect(configBehaviorCells(p)).toEqual([]);
  });

  it('the fixture: ads held when rejected and ran when accepted → controlled; stats ran when rejected → not-controlled', () => {
    const p = evaluateConsentToolProof(evaluation());
    expect(p.detected).toBe(true);
    expect(p.version).toBe('0.0.0-test');
    expect(p.config).toMatchObject({ status: 'ok', hashMatches: true, version: '1.0', versionStatus: 'current', generatedFrom: { site: SITE } });
    expect(vendor(evaluation(), 'fixture.ads')).toMatchObject({ result: 'controlled' });
    expect(vendor(evaluation(), 'fixture.stats')).toMatchObject({ result: 'not-controlled' });
    expect(p.totals).toEqual({ controlled: 1, notControlled: 1, notObserved: 0 });
    expect(p.findings.map((f) => f.code)).toEqual(['vendor-not-controlled']);
    expect(p.findings[0].message).toContain('Fixture Stats (analytics, control: gate)');
    expect(p.driven.map((d) => d.scenario)).toEqual(['reject', 'accept']);
  });

  it('held when denied but never seen running when granted → not-observed (holding nothing proves nothing)', () => {
    const ev = evaluation({ observations: [observation('de', 'reject', {}, KNOWN), observation('de', 'accept', { 'fixture.stats': { 'after-accept': 1 } }, KNOWN)] });
    const v = vendor(ev, 'fixture.ads');
    expect(v.result).toBe('not-observed');
    expect(v.reason).toMatch(/never seen running in a granted state/);
  });

  it('only granted-state visits → not-observed, never controlled', () => {
    const ev = evaluation({ scenarios: [{ scenario: 'accept', choice: { kind: 'accept', ok: true, method: 'selector:complykit' } }], observations: [observation('de', 'accept', { 'fixture.ads': { 'after-accept': 1 } }, KNOWN)] });
    expect(vendor(ev, 'fixture.ads')).toMatchObject({ result: 'not-observed' });
    expect(vendor(ev, 'fixture.ads').reason).toMatch(/no tested scenario put advertising in a denied state for a whole visit/);
    // The moments before the accept click were a denied state (opt-in) and it held there: alone that proves nothing.
    expect(vendor(ev, 'fixture.ads').reason).toMatch(/held before the choice in de\/accept/);
  });

  it('a choice that did not take is skipped, not compared', () => {
    const ev = evaluation({ scenarios: [{ scenario: 'reject', choice: { kind: 'reject', ok: false, method: 'selector:complykit' } }, { scenario: 'accept', choice: { kind: 'accept', ok: true, method: 'selector:complykit' } }] });
    const p = evaluateConsentToolProof(ev);
    expect(p.vendors.every((v) => v.result === 'not-observed')).toBe(true);
    expect(p.notTested.some((n) => /de\/reject: the visitor choice was not confirmed/.test(n))).toBe(true);
  });

  it('one misfire in any denied-state run outranks every held one (throttled run 2 fired)', () => {
    const ev = evaluation({
      observations: [observation('de', 'reject', {}, KNOWN, 1), observation('de', 'reject', { 'fixture.ads': { 'after-reject': 1 } }, KNOWN, 2), observation('de', 'accept', { 'fixture.ads': { 'after-accept': 1 } }, KNOWN, 1)],
    });
    const v = vendor(ev, 'fixture.ads');
    expect(v.result).toBe('not-controlled');
    expect(v.reason).toContain('de/reject#2');
  });

  it('restricted-mode-only requests when denied: not-controlled for a gate; for api control only outside opt-in (design §9.3)', () => {
    const obs = [observation('de', 'reject', { 'fixture.ads': { 'after-reject': { limited: 2 } } }, KNOWN), observation('de', 'accept', { 'fixture.ads': { 'after-accept': 1 } }, KNOWN)];
    expect(vendor(evaluation({ observations: obs }), 'fixture.ads').result).toBe('not-controlled');
    const api = config({ vendors: [{ id: 'fixture.ads', label: 'Fixture Ads', category: 'advertising', control: 'api', adapter: 'google-consent-mode', stores: [] }] });
    // Opt-in: the API is additive to gating, never instead — cookieless pings mean the load was not held.
    const optIn = vendor(evaluation({ cfg: api, observations: obs }), 'fixture.ads');
    expect(optIn.result).toBe('not-controlled');
    expect(optIn.reason).toMatch(/under opt-in rules the load must be held/);
    // Opt-out (the tool decided opt-out, from a US opt-out state): the consent API is the control.
    const optOut = vendor(
      evaluation({ cfg: api, observations: obs, jurisdictions: ['us', 'us-fl'], snap: { state: { status: 'unset', regime: 'opt-out', gpc: false, categories: { necessary: true, analytics: true, advertising: true } } } }),
      'fixture.ads',
    );
    expect(optOut.result).toBe('controlled');
    expect(optOut.reason).toMatch(/restricted-mode pings only/);
  });

  it('a granted-state visit with restricted pings only is not "ran when granted"', () => {
    const obs = [observation('de', 'reject', {}, KNOWN), observation('de', 'accept', { 'fixture.ads': { 'after-accept': { limited: 1 } } }, KNOWN)];
    expect(vendor(evaluation({ observations: obs }), 'fixture.ads').result).toBe('not-observed');
  });

  it('control none, or a DNS-alias / server-side implementation, is never "controlled" (what held it is not established)', () => {
    const none = config({ vendors: [{ id: 'fixture.ads', label: 'Fixture Ads', category: 'advertising', control: 'none', stores: [] }] });
    const v = vendor(evaluation({ cfg: none }), 'fixture.ads');
    expect(v.result).toBe('not-observed');
    expect(v.reason).toMatch(/lists no control for it/);
    const cname = INVENTORY.map((p) => (p.partyId === 'fixture.ads' ? { ...p, implementation: { class: 'cname' as const, evidence: [], alsoSeen: [] } } : p));
    const c = vendor(evaluation({ inventory: cname }), 'fixture.ads');
    expect(c.result).toBe('not-observed');
    expect(c.reason).toMatch(/first-party DNS alias/);
    const ss = INVENTORY.map((p) => (p.partyId === 'fixture.ads' ? { ...p, implementation: { class: 'gtm' as const, evidence: [], alsoSeen: ['server-side-suspected' as const] } } : p));
    expect(vendor(evaluation({ inventory: ss }), 'fixture.ads').result).toBe('not-observed');
  });

  it('firing before the choice in a choice scenario (opt-in) is not-controlled, and feeds a mismatch', () => {
    const obs = [observation('de', 'reject', {}, KNOWN), observation('de', 'accept', { 'fixture.ads': { 'before-choice': 1, 'after-accept': 1 } }, KNOWN)];
    const p = evaluateConsentToolProof(evaluation({ observations: obs }));
    const v = p.vendors.find((x) => x.id === 'fixture.ads')!;
    expect(v.result).toBe('not-controlled');
    expect(v.reason).toContain('de/accept (before the choice)');
    expect(configBehaviorCells(p).find((c) => c.partyId === 'fixture.ads')?.reason).toContain('(before the choice)');
  });

  it('a choice the tool was running in but that was not made through its own controls is not compared', () => {
    const ev = evaluation({
      scenarios: [
        { scenario: 'reject', choice: { kind: 'reject', ok: true, method: 'heuristic' } },
        { scenario: 'accept', choice: { kind: 'accept', ok: true, method: 'selector:complykit' } },
      ],
    });
    const p = evaluateConsentToolProof(ev);
    expect(p.vendors.find((v) => v.id === 'fixture.ads')!.result).toBe('not-observed');
    expect(p.notTested.some((n) => /de\/reject: the choice was not made through the tool’s own controls \(heuristic\)/.test(n))).toBe(true);
  });

  it('a tracker the config does not list that ran after reject is a finding; a restricted-only one is not', () => {
    const inv = [...INVENTORY, party('fixture.pixel', 'Fixture Pixel', ['advertising'])];
    const known = inv.map((p) => p.partyId);
    const obs = [observation('de', 'reject', { 'fixture.pixel': { 'after-reject': 1 } }, known), observation('de', 'accept', { 'fixture.ads': { 'after-accept': 1 } }, known)];
    const p = evaluateConsentToolProof(evaluation({ inventory: inv, observations: obs }));
    const f = p.findings.find((x) => x.code === 'vendor-not-in-config')!;
    expect(f.message).toContain('Fixture Pixel (de/reject)');
    expect(f.refs).toEqual(['/behaviorObservations/0']);
    expect(buildConsentToolProofReport(p)!.headline).toContain('1 tracker not in the config ran while denied');
    const limited = [observation('de', 'reject', { 'fixture.pixel': { 'after-reject': { limited: 1 } } }, known), obs[1]];
    expect(codes(evaluation({ inventory: inv, observations: limited }))).not.toContain('vendor-not-in-config');
  });

  it('gpc: expected denied for every non-necessary category; a running tool that did not record the signal is a finding', () => {
    const ev = evaluation({
      jurisdictions: ['us', 'us-ca'],
      snap: { state: { status: 'unset', regime: 'opt-out-signal', gpc: false, categories: { necessary: true, analytics: true, advertising: false } } },
      scenarios: [{ scenario: 'gpc' }],
      observations: [observation('de', 'gpc', { 'fixture.stats': { 'before-choice': 1 } }, KNOWN)],
    });
    const p = evaluateConsentToolProof(ev);
    expect(p.vendors.find((v) => v.id === 'fixture.stats')!.result).toBe('not-controlled');
    expect(p.findings.map((f) => f.code)).toContain('gpc-not-honored');
  });

  it('a necessary vendor is never judged controlled, and a tracker under necessary is a finding', () => {
    const cfg = config({ vendors: [{ id: 'fixture.stats', label: 'Fixture Stats', category: 'necessary', control: 'none', stores: [] }] });
    const ev = evaluation({ cfg });
    expect(vendor(ev, 'fixture.stats')).toMatchObject({ result: 'not-observed' });
    expect(codes(ev)).toContain('necessary-tracker');
  });

  it("the proof uses the regime the TOOL decided; a weaker one than the location's rules is a finding", () => {
    // Tool says opt-out from Germany: analytics defaults ON, so stats firing in 'browse' is expected — and the regime is flagged.
    const ev = evaluation({
      snap: { state: { status: 'unset', regime: 'opt-out', gpc: false, categories: { necessary: true, analytics: true, advertising: true } } },
      scenarios: [{ scenario: 'browse' }, { scenario: 'accept', choice: { kind: 'accept', ok: true, method: 'selector:complykit' } }],
      observations: [observation('de', 'browse', { 'fixture.stats': { 'before-choice': 1 } }, KNOWN), observation('de', 'accept', { 'fixture.stats': { 'after-accept': 1 } }, KNOWN)],
    });
    expect(vendor(ev, 'fixture.stats').observations[0]).toMatchObject({ regime: 'opt-out', expectedGranted: true, observed: 'fired' });
    expect(codes(ev)).toContain('regime-mismatch');
    // Stricter than the law is not a finding (opt-in from a US opt-out state).
    expect(codes(evaluation({ jurisdictions: ['us', 'us-fl'] }))).not.toContain('regime-mismatch');
  });

  it('expected-state table', () => {
    const c = config();
    expect(expectedGrantedFor(c, 'necessary', 'opt-in', 'reject', false)).toBe(true);
    expect(expectedGrantedFor(c, 'advertising', 'opt-in', 'accept', false)).toBe(true);
    expect(expectedGrantedFor(c, 'analytics', 'opt-in', 'partial', false)).toBe(true);
    expect(expectedGrantedFor(c, 'advertising', 'opt-in', 'partial', false)).toBe(false);
    for (const s of ['reject', 'withdraw', 'return-visit', 'opt-out-all']) expect(expectedGrantedFor(c, 'analytics', 'opt-out', s, false)).toBe(false);
    expect(expectedGrantedFor(c, 'analytics', 'opt-out', 'gpc', true)).toBe(false);
    expect(expectedGrantedFor(c, 'analytics', 'opt-out', 'gpc', false)).toBe(false);
    expect(expectedGrantedFor(c, 'analytics', 'opt-out-link' as never, 'opt-out-link', false)).toBeUndefined();
    expect(expectedGrantedFor(c, 'analytics', 'opt-in', 'browse', false)).toBe(false);
    expect(expectedGrantedFor(c, 'analytics', 'opt-out-signal', 'browse', false)).toBe(true);
    expect(expectedGrantedFor(c, 'advertising', 'opt-out-signal', 'browse', false)).toBe(false);
    expect(expectedGrantedFor(c, 'unlisted', 'opt-out', 'browse', false)).toBe(false);
  });
});

describe('D10 proof: the deployed config', () => {
  it('edited by hand since generation: the hash does not match', () => {
    const c = { ...config(), layout: 'box' };
    const p = evaluateConsentToolProof(evaluation({ cfg: c }));
    expect(p.config).toMatchObject({ status: 'ok', hashMatches: false });
    expect(p.findings.map((f) => f.code)).toContain('config-edited');
  });

  it('a regeneration that changed nothing (new run, new hash, same settings) is not behind', () => {
    const regen = config({ generatedFrom: { runId: 'run-b', at: '2026-10-07T10:00:00.000Z', site: SITE, complykit: '0.0.0-test' } });
    expect(regen.hash).not.toBe(config().hash);
    const p = evaluateConsentToolProof(evaluation(), { workspaceConfig: { value: { config: regen } } });
    expect(p.config.workspace).toMatchObject({ same: true, sameContent: true, hash: regen.hash });
    expect(p.findings.map((f) => f.code)).not.toContain('config-behind');
    expect(buildConsentToolProofReport(p)!.configLine).toContain('the workspace’s latest in content');
    // An edited deployed config is never "same content": its header does not describe its body.
    const edited = { ...config(), layout: 'box' };
    expect(codes(evaluation({ cfg: edited }), { workspaceConfig: { value: { config: { ...regen, layout: 'box' } } } })).toContain('config-behind');
  });

  it('behind the workspace: the workspace holds a newer config with other settings', () => {
    const newer = config({ layout: 'box', generatedFrom: { runId: 'run-b', at: '2026-10-07T10:00:00.000Z', site: SITE, complykit: '0.0.0-test' } });
    const ws = parseWorkspaceSnapshot({ entries: {}, config: { value: { config: newer, snippet: '', changeList: '', notes: [] }, at: '2026-10-07T10:01:00Z', runId: 'run-b' } });
    expect(ws.config?.runId).toBe('run-b');
    const p = evaluateConsentToolProof(evaluation(), { workspaceConfig: ws.config });
    expect(p.config.workspace).toMatchObject({ same: false, hash: newer.hash, runId: 'run-b' });
    const f = p.findings.find((x) => x.code === 'config-behind')!;
    expect(f.message).toContain('deployed 2026-10-06 10:00 (run run-a), workspace 2026-10-07 10:00 (run run-b)');
    // The same config deployed: no finding.
    expect(codes(evaluation(), { workspaceConfig: { value: { config: config() } } })).not.toContain('config-behind');
    // No workspace: said, not implied.
    expect(evaluateConsentToolProof(evaluation()).notTested).toContain('whether the deployed config is the workspace’s latest (the scan had no workspace config to compare with)');
  });

  it('a different major is refused by the tool and behind this build', () => {
    const c = { ...config(), version: '2.0' };
    const p = evaluateConsentToolProof(evaluation({ cfg: c, snap: { running: false, bannerShown: false } }));
    expect(p.config).toMatchObject({ status: 'refused', guard: { ok: false, reason: 'newer-major' }, versionStatus: 'newer-major' });
    expect(p.findings.map((f) => f.code)).toContain('config-refused');
    expect(p.findings.map((f) => f.code)).not.toContain('tool-not-running');
    expect(codes(evaluation({ cfg: { ...config(), version: '0.9' }, snap: { running: false } }))).toEqual(expect.arrayContaining(['config-refused', 'config-behind']));
    // A refused config is not an expected side: no vendor is judged against it, and the finding says the tool does nothing.
    expect(p.vendors).toEqual([]);
    expect(p.totals).toEqual({ controlled: 0, notControlled: 0, notObserved: 0 });
    expect(p.findings.find((f) => f.code === 'config-refused')!.message).toContain('gated scripts stay inert and no banner is shown');
  });

  it('guard accepts, store never started → tool-not-running; not JSON → refused; no element → missing', () => {
    expect(codes(evaluation({ snap: { running: false, state: undefined } }))).toContain('tool-not-running');
    expect(evaluateConsentToolProof(evaluation({ cfg: '{not json' })).config.status).toBe('not-json');
    expect(codes(evaluation({ cfg: '{not json' }))).toContain('config-refused');
    const missing = evaluateConsentToolProof(evaluation({ cfg: undefined, snap: { configElement: false, configJson: undefined, running: false } }));
    expect(missing.config.status).toBe('missing');
    expect(missing.findings.map((f) => f.code)).toEqual(['config-missing']);
  });

  it('the guard is narrower than the schema: a config the tool runs but the schema refuses is "invalid", still judged', () => {
    const c = { ...config(), privacyPolicyUrl: 'http://insecure.example' }; // schema wants https; the guard does not look
    const p = evaluateConsentToolProof(evaluation({ cfg: c }));
    expect(p.config.status).toBe('invalid');
    expect(p.config.issues.length).toBeGreaterThan(0);
    expect(p.findings.map((f) => f.code)).toContain('config-invalid');
    expect(p.vendors.length).toBe(2);
  });

  it('generated for another site', () => {
    const c = config({ generatedFrom: { runId: 'run-a', at: '2026-10-06T10:00:00.000Z', site: 'other-shop.test', complykit: '0.0.0-test' } });
    expect(codes(evaluation({ cfg: c }))).toContain('config-other-site');
  });
});

describe('D10 proof: install diagnostics and the served HTML', () => {
  it('tool after GTM, banner file failed', () => {
    const snap: Partial<ComplykitToolSnapshot> = {
      diagnostics: { gtm: { orderOk: false, containersLoadedBefore: ['GTM-XXXX01'], gtmEventBefore: true, containerScriptsBefore: [], warnings: ['x'] }, ui: { state: 'failed', error: 'failed to load' } },
    };
    const p = evaluateConsentToolProof(evaluation({ snap }));
    const gtm = p.findings.find((f) => f.code === 'tool-after-gtm')!;
    expect(gtm.message).toContain('container GTM-XXXX01 already loaded');
    expect(gtm.details).toMatchObject({ containersLoadedBefore: ['GTM-XXXX01'] });
    expect(p.findings.map((f) => f.code)).toContain('ui-not-loaded');
  });

  it('a gate rule whose script is still executable in the served HTML', () => {
    const url = 'https://stats.test/s.js';
    const markup: TrackingEvaluation['markup'] = {
      pages: [{ url: PAGE, status: 'inspected', locations: ['de'], elements: 2 }],
      findings: [
        { partyId: 'fixture.stats', label: 'Fixture Stats', recognized: true, verdict: 'gateable', trigger: 'page-load', kind: 'script', context: 'document', page: PAGE, line: 9, url, inline: false, attributes: { src: url }, matchedBy: 'host', match: 'stats.test', locations: ['de'], alsoOn: [], occurrences: 1 },
        { partyId: 'fixture.ads', label: 'Fixture Ads', recognized: true, verdict: 'held', trigger: 'page-load', kind: 'script', context: 'document', page: PAGE, line: 11, url: 'https://adpixel.test/ads.js', inline: false, attributes: { type: 'text/plain', 'data-category': 'advertising' }, matchedBy: 'host', match: 'adpixel.test', locations: ['de'], alsoOn: [], occurrences: 1 },
      ],
      unexplained: [],
    };
    const p = evaluateConsentToolProof(evaluation({ markup }));
    const f = p.findings.filter((x) => x.code === 'gate-rule-unrewritten');
    expect(f).toHaveLength(1);
    expect(f[0].message).toContain('Fixture Stats');
    expect(f[0].message).toContain('/:9');
    expect(f[0].refs).toEqual(['/markup/findings/0']);
    // Not inspected: said, never implied rewritten.
    expect(evaluateConsentToolProof(evaluation()).notTested).toContain('whether the gate rules’ scripts were rewritten (the served HTML was not inspected)');
  });
});

describe('D10 proof: feeding the compatibility verdict', () => {
  it('the generator and the remediation checklist reconcile the same way the report does: a denied-state misfire is a behavior mismatch the checklist carries', () => {
    // A US visit: the law allows analytics before a choice (opt-out), but the deployed config
    // decided opt-in and denies it — only the D10 cells call that a mismatch.
    const obs = [observation('us', 'reject', {}, KNOWN), observation('us', 'accept', { 'fixture.ads': { 'after-accept': 1 }, 'fixture.stats': { 'before-choice': 2, 'after-accept': 2 } }, KNOWN)];
    const ev = evaluation({ observations: obs, jurisdictions: ['us', 'us-fl'] });
    ev.locations[0].spec.id = 'us';
    // Without the deployed tool's cells the matrix alone does not flag it (the gap this closes).
    expect(reconcileCompatibility(ev).parties.find((p) => p.partyId === 'fixture.stats')!.behaviorMismatch).toBe(false);
    const reported = structuredClone(ev);
    reconcileRecord(reported);
    const model = buildConsentReportModel(reported, []);
    const reportIds = [...model.compatibility!.groups.flatMap((g) => g.items), ...model.compatibility!.otherChanges].map((i) => i.id).sort();
    const g = generateConsentConfig(ev, { complykitVersion: '0.0.0-test', now: '2026-10-06T12:00:00.000Z' });
    // The generator's change list has the same mismatch; the checklist carries it as its own task or
    // folded into the task(s) that fix the tool (the id kept as an alias), never dropped.
    const mismatchIds = (c: typeof g.compatibility) => c.groups.flatMap((x) => x.items).filter((i) => i.kind === 'behavior-mismatch' && i.partyIds.includes('fixture.stats')).map((i) => i.id);
    const [mid] = mismatchIds(g.compatibility);
    expect(mid).toBeDefined();
    const carries = (ts: typeof g.tasks, id: string) => ts.some((t) => t.id === id || t.aliases?.includes(id));
    expect(carries(g.tasks, mid)).toBe(true);
    // Every change-list item the report shows is a checklist task or folded into one (and nothing else, beyond install / remove-existing-tool / confirm-in-browser).
    const known = g.tasks.flatMap((t) => [t.id, ...(t.aliases ?? [])]);
    for (const id of reportIds) expect(known).toContain(id);
    const taskIds = g.tasks.filter((t) => !['install', 'remove-existing-tool', 'confirm-in-browser'].includes(t.kind)).map((t) => t.id);
    for (const id of taskIds) expect(reportIds).toContain(id);
    // A standalone build (a stored value without the compatibility section) agrees.
    const { compatibility: _c, ...stored } = g;
    expect(buildRemediationTasks(stored, ev).map((t) => t.id)).toEqual(g.tasks.map((t) => t.id));
    // With a workspace, the proof is re-read against its config (as `report --workspace` does) and still agrees.
    const ws = parseWorkspaceSnapshot({ domain: SITE, entries: {}, config: { value: { config: config() }, at: '2026-10-06T10:00:00.000Z' } });
    const gw = generateConsentConfig(ev, { complykitVersion: '0.0.0-test', now: '2026-10-06T12:00:00.000Z', workspace: ws });
    expect(carries(gw.tasks, mismatchIds(gw.compatibility)[0])).toBe(true);
  });

  it('a vendor the config says is gated but fires is a behavior mismatch in the reconciled verdict', () => {
    const ev = evaluation();
    const proof = evaluateConsentToolProof(ev);
    const cells = configBehaviorCells(proof);
    expect(cells).toEqual([expect.objectContaining({ partyId: 'fixture.stats', location: 'de', scenario: 'reject', status: 'mismatch', ref: '/behaviorObservations/0' })]);
    expect(cells[0].reason).toContain('deployed complykit config denies analytics under opt-in rules');
    const section = reconcileCompatibility(ev, { extraBehavior: cells });
    const stats = section.parties.find((p) => p.partyId === 'fixture.stats')!;
    expect(stats.behaviorMismatch).toBe(true);
    expect(stats.changes[0].kind).toBe('behavior-mismatch');
    expect(stats.reasons.some((r) => r.source === 'behavior' && /deployed complykit config/.test(r.note))).toBe(true);
    expect(section.parties.find((p) => p.partyId === 'fixture.ads')!.behaviorMismatch).toBe(false);
  });

  it('restricted-mode pings feed a mismatch under a gate, and under api control in opt-in; nothing for api outside opt-in', () => {
    const obs = [observation('de', 'reject', { 'fixture.ads': { 'after-reject': { limited: 2 } } }, KNOWN), observation('de', 'accept', { 'fixture.ads': { 'after-accept': 1 } }, KNOWN)];
    expect(configBehaviorCells(evaluateConsentToolProof(evaluation({ observations: obs })))).toHaveLength(1);
    const api = config({ vendors: [{ id: 'fixture.ads', label: 'Fixture Ads', category: 'advertising', control: 'api', adapter: 'google-consent-mode', stores: [] }] });
    expect(configBehaviorCells(evaluateConsentToolProof(evaluation({ cfg: api, observations: obs })))).toHaveLength(1);
    const optOut = evaluation({ cfg: api, observations: obs, jurisdictions: ['us', 'us-fl'], snap: { state: { status: 'unset', regime: 'opt-out', gpc: false, categories: { necessary: true, analytics: true, advertising: true } } } });
    expect(configBehaviorCells(evaluateConsentToolProof(optOut))).toEqual([]);
  });
});

describe('D10 proof: the report section', () => {
  it('headline, HTML and Markdown carry version, config date and the counts; never "compliant"', () => {
    const ev = evaluation();
    ev.consentToolProof = evaluateConsentToolProof(ev);
    const r = buildConsentToolProofReport(ev.consentToolProof)!;
    expect(r.headline).toBe('complykit consent tool detected — version 0.0.0-test, config generated 2026-10-06: 1 vendor controlled, 1 not (Fixture Stats), 0 not observed. In this scan only: an unrecorded number of pages, 1 location, logged out, 1 run each.');
    expect(r.tone).toBe('red');
    expect(r.vendors.map((v) => v.result)).toEqual(['not-controlled', 'controlled']);
    const html = renderConsentToolProofHtml(r);
    expect(html).toContain('id="consent-tool-proof"');
    expect(html).toContain('data-not-controlled="1"');
    expect(html).toContain('data-proof-vendor="fixture.stats" data-result="not-controlled"');
    expect(html).toContain('data-proof-finding="vendor-not-controlled"');
    expect(html).not.toMatch(/compliant/i);
    // The vendor column keeps whole words (a minimum width; names don't split mid-word); only a hostname-as-name may break.
    expect(html).toContain('<th scope="row">Fixture Stats<br>');
    expect(PROOF_CSS).toMatch(/\.ck-proof-table th\[scope=row\]\{min-width:12em;overflow-wrap:break-word;word-break:normal\}/);
    expect(PROOF_CSS).toContain('.ck-proof-table .ck-proof-host{overflow-wrap:anywhere}');
    const hostRow = renderConsentToolProofHtml({ ...r, vendors: [{ ...r.vendors[0], label: 'e2e-widgets.test' }] });
    expect(hostRow).toContain('<th scope="row"><span class="ck-proof-host">e2e-widgets.test</span><br>');
    const md = renderConsentToolProofMarkdown(r).join('\n');
    expect(md).toContain('## complykit consent tool');
    expect(md).toContain('| Fixture Stats | analytics | script gate | NOT controlled');
    // Through the whole report model and both renderers.
    const model = buildConsentReportModel(ev, []);
    expect(model.consentToolProof?.headline).toBe(r.headline);
    expect(renderConsentHtml(model)).toContain('href="#consent-tool-proof"');
    expect(renderConsentMarkdown(model)).toContain(r.headline);
  });

  it('not detected: one line, no nav link; no section on a record without the proof', () => {
    const ev = evaluation({ noTool: true });
    ev.consentToolProof = evaluateConsentToolProof(ev);
    const model = buildConsentReportModel(ev, []);
    expect(model.consentToolProof?.detected).toBe(false);
    const html = renderConsentHtml(model);
    expect(html).toContain('data-detected="false"');
    expect(html).not.toContain('href="#consent-tool-proof"');
    expect(renderConsentToolProofHtml(undefined)).toBe('');
    expect(buildConsentReportModel(evaluation({ noTool: true }), []).consentToolProof).toBeUndefined();
  });
});

// --- D10 follow-up (review): loads, journey parity, weaker regime, withdraw grace, document.write ---

const optOutSnap: Partial<ComplykitToolSnapshot> = { state: { status: 'unset', regime: 'opt-out', gpc: false, categories: { necessary: true, analytics: true, advertising: true } } };
const withControl = (control: 'gate' | 'api' | 'platform') =>
  config({ vendors: [{ id: 'fixture.ads', label: 'Fixture Ads', category: 'advertising', control, ...(control === 'api' ? { adapter: 'google-consent-mode' as const } : {}), stores: [] }], ...(control === 'platform' ? { platform: 'shopify' as const } : {}) });

describe('D10 follow-up: a vendor’s own script load in a denied state', () => {
  const loadedObs = [observation('de', 'reject', { 'fixture.ads': { 'after-reject': { loads: 2 } } }, KNOWN), observation('de', 'accept', { 'fixture.ads': { 'after-accept': 1 } }, KNOWN)];

  it('a gated vendor whose script loaded (nothing sent) where denied is not controlled — the gate exists to prevent the load', () => {
    const p = evaluateConsentToolProof(evaluation({ observations: loadedObs }));
    const v = p.vendors.find((x) => x.id === 'fixture.ads')!;
    expect(v.observations.find((o) => o.scenario === 'reject')).toMatchObject({ observed: 'loaded', requests: 0, loads: 2 });
    expect(v.result).toBe('not-controlled');
    expect(v.reason).toMatch(/script \/ resources loaded where the config denies advertising \(de\/reject\).*a gate exists to prevent the load itself/);
    expect(configBehaviorCells(p)).toEqual([expect.objectContaining({ partyId: 'fixture.ads', scenario: 'reject', status: 'mismatch' })]);
  });

  it('a consent-API vendor may load outside opt-in (it is meant to load and be told), never under opt-in; a platform bridge under opt-in is unproven', () => {
    const optOut = (control: 'api' | 'platform') => vendor(evaluation({ cfg: withControl(control), observations: loadedObs, jurisdictions: ['us', 'us-fl'], snap: optOutSnap }), 'fixture.ads');
    expect(optOut('api')).toMatchObject({ result: 'controlled' });
    expect(optOut('api').reason).toMatch(/its script loaded but sent nothing in de\/reject/);
    expect(optOut('platform').result).toBe('controlled');
    expect(vendor(evaluation({ cfg: withControl('api'), observations: loadedObs }), 'fixture.ads').result).toBe('not-controlled');
    const platformOptIn = vendor(evaluation({ cfg: withControl('platform'), observations: loadedObs }), 'fixture.ads');
    expect(platformOptIn.result).toBe('not-observed');
    expect(platformOptIn.reason).toMatch(/neither held nor shown running/);
  });

  it("control 'none' (#49: a stylesheet / font vendor) whose resources loaded where denied is capped at not-observed — no gate is claimed", () => {
    const cfg = config({ vendors: [{ id: 'fixture.ads', label: 'Fixture Ads', category: 'advertising', control: 'none', stores: [] }] });
    const v = vendor(evaluation({ cfg, observations: loadedObs }), 'fixture.ads');
    expect(v.result).toBe('not-observed');
    expect(v.reason).not.toMatch(/a gate exists/);
  });

  it('a record that did not count loads cannot show "held" for a pass', () => {
    const ev = evaluation({ observations: [observation('de', 'reject', { 'fixture.ads': { 'after-reject': 0 } }, KNOWN), observation('de', 'accept', { 'fixture.ads': { 'after-accept': 1 } }, KNOWN)] });
    for (const o of ev.behaviorObservations!) for (const f of o.parties) delete f.loadRequestsByPhase;
    const v = vendor(ev, 'fixture.ads');
    expect(v.result).toBe('not-observed');
    expect(v.reason).toMatch(/did not count script loads/);
    // No facts at all for the party in the denied visit = no request of any kind: zero loads, a real 'held'.
    expect(vendor(evaluation(), 'fixture.ads').result).toBe('controlled');
  });

  it('B1 cells: a load-only visit is never a pass under opt-in for a party with a consent purpose; a CDN loading changes nothing', () => {
    const inv = [...INVENTORY, party('fixture.cdn', 'Fixture CDN', ['cdn'], { behavesLikeTracker: false })];
    const known = inv.map((p) => p.partyId);
    const obs = [observation('de', 'reject', { 'fixture.ads': { 'after-reject': { loads: 1 } }, 'fixture.cdn': { 'after-reject': { loads: 5 } } }, known), observation('de', 'accept', {}, known)];
    const cell = (ev: TrackingEvaluation, id: string) => behaviorCellsFrom(ev).find((c) => c.partyId === id && c.scenario === 'reject')!;
    const de = evaluation({ inventory: inv, observations: obs });
    expect(cell(de, 'fixture.ads')).toMatchObject({ status: 'not-established' });
    expect(cell(de, 'fixture.ads').reason).toMatch(/loaded \(1 request\(s\)\).*does not load at all/);
    expect(cell(de, 'fixture.cdn').status).toBe('no-mismatch-observed');
    const us = evaluation({ inventory: inv, observations: obs, jurisdictions: ['us', 'us-fl'] });
    expect(cell(us, 'fixture.ads')).toMatchObject({ status: 'no-mismatch-observed' });
    expect(cell(us, 'fixture.ads').reason).toMatch(/only its script \/ resources loaded/);
  });
});

describe('D10 follow-up: journey parity', () => {
  const searched: Journey = Object.fromEntries(ALL_PHASES.map((ph) => [ph, { pageIndexes: [0, 1, 2], steps: ['navigate', 'scroll', 'search'] }]));

  it('a vendor that ran only in a visit that searched is not "controlled" by a held visit that never searched', () => {
    const ev = evaluation({ observations: [observation('de', 'reject', {}, KNOWN), observation('de', 'accept', { 'fixture.ads': { 'after-accept': 1 } }, KNOWN, undefined, searched)] });
    const v = vendor(ev, 'fixture.ads');
    expect(v.result).toBe('not-observed');
    expect(v.reason).toMatch(/no held visit walked the journey of a granted visit that ran it \(granted: de\/accept: 3 page\(s\), site search; held: de\/reject: 2 page\(s\), no site search\)/);
    // The held visit walked the same steps: controlled.
    const same = evaluation({ observations: [observation('de', 'reject', {}, KNOWN, undefined, searched), observation('de', 'accept', { 'fixture.ads': { 'after-accept': 1 } }, KNOWN, undefined, searched)] });
    expect(vendor(same, 'fixture.ads').result).toBe('controlled');
  });

  it('fewer pages in every held visit, or no journey recorded, is no parity', () => {
    const onePage: Journey = Object.fromEntries(ALL_PHASES.map((ph) => [ph, { pageIndexes: [0], steps: ['navigate', 'scroll'] }]));
    expect(vendor(evaluation({ observations: [observation('de', 'reject', {}, KNOWN, undefined, onePage), observation('de', 'accept', { 'fixture.ads': { 'after-accept': 1 } }, KNOWN)] }), 'fixture.ads').result).toBe('not-observed');
    const none = vendor(evaluation({ observations: [observation('de', 'reject', {}, KNOWN, undefined, null), observation('de', 'accept', { 'fixture.ads': { 'after-accept': 1 } }, KNOWN, undefined, null)] }), 'fixture.ads');
    expect(none.result).toBe('not-observed');
    expect(none.reason).toMatch(/journey not recorded/);
  });

  it('one held visit with parity is enough (withdraw walked less, reject walked it all)', () => {
    const lessJ: Journey = Object.fromEntries(ALL_PHASES.map((ph) => [ph, { pageIndexes: [0], steps: ['scroll'] }]));
    const ev = evaluation({
      scenarios: [
        { scenario: 'reject', choice: { kind: 'reject', ok: true, method: 'selector:complykit' } },
        { scenario: 'withdraw', choice: { kind: 'withdraw', ok: true, method: 'complykit:click(.ck-choices)' } },
        { scenario: 'accept', choice: { kind: 'accept', ok: true, method: 'selector:complykit' } },
      ],
      observations: [observation('de', 'reject', {}, KNOWN, undefined, searched), observation('de', 'withdraw', {}, KNOWN, undefined, lessJ), observation('de', 'accept', { 'fixture.ads': { 'after-accept': 1 } }, KNOWN, undefined, searched)],
    });
    expect(vendor(ev, 'fixture.ads').result).toBe('controlled');
  });
});

describe('D10 follow-up: the tool decided a weaker regime than the law', () => {
  // Germany (opt-in law); the tool decided opt-out: under its own setting analytics AND advertising default granted.
  const weak = (observations: ReturnType<typeof observation>[]) =>
    evaluation({
      snap: optOutSnap,
      scenarios: [{ scenario: 'browse' }, { scenario: 'reject', choice: { kind: 'reject', ok: true, method: 'selector:complykit' } }, { scenario: 'accept', choice: { kind: 'accept', ok: true, method: 'selector:complykit' } }],
      observations,
    });
  const obs = [
    observation('de', 'browse', { 'fixture.stats': { 'no-banner': 1 } }, KNOWN),
    observation('de', 'reject', {}, KNOWN),
    observation('de', 'accept', { 'fixture.ads': { 'after-accept': 1 }, 'fixture.stats': { 'after-accept': 1 } }, KNOWN),
  ];

  it('a vendor the weaker setting grants but the law denies, that ran, is not controlled — and feeds a mismatch', () => {
    const p = evaluateConsentToolProof(weak(obs));
    const stats = p.vendors.find((v) => v.id === 'fixture.stats')!;
    expect(stats.observations.find((o) => o.scenario === 'browse')).toMatchObject({ regime: 'opt-out', expectedGranted: true, lawRegime: 'opt-in', expectedGrantedByLaw: false, observed: 'fired' });
    expect(stats.result).toBe('not-controlled');
    expect(stats.reason).toMatch(/location’s “opt-in” rules expect analytics denied \(de\/browse\); the tool decided the weaker “opt-out” setting/);
    const cell = configBehaviorCells(p).find((c) => c.partyId === 'fixture.stats')!;
    expect(cell).toMatchObject({ scenario: 'browse', status: 'mismatch' });
    expect(cell.reason).toMatch(/opt-in rules deny analytics; the deployed complykit config grants it only under the weaker opt-out setting/);
  });

  it('the headline marks the controlled count as measured against the tool’s weaker setting', () => {
    const p = evaluateConsentToolProof(weak(obs));
    expect(p.vendors.find((v) => v.id === 'fixture.ads')!.result).toBe('controlled');
    const r = buildConsentToolProofReport(p)!;
    expect(r.headline).toContain('1 vendor controlled (measured against the tool’s weaker “opt-out” setting, not the “opt-in” rules of de), 1 not (Fixture Stats)');
    // No mismatch: no qualifier.
    expect(buildConsentToolProofReport(evaluateConsentToolProof(evaluation()))!.headline).toContain('1 vendor controlled, 1 not');
  });
});

describe('D10 follow-up: withdraw grace', () => {
  const scen = [
    { scenario: 'withdraw' as const, choice: { kind: 'withdraw' as const, ok: true, method: 'complykit:click(.ck-choices)+complykit:click(settings reject)' } },
    { scenario: 'accept' as const, choice: { kind: 'accept' as const, ok: true, method: 'selector:complykit' } },
  ];

  it('sends between the withdraw click and the reload are noted, not counted; anything after the reload counts', () => {
    const graced = evaluation({ scenarios: scen, observations: [observation('de', 'withdraw', { 'fixture.ads': { 'withdraw-grace': 2 } }, KNOWN), observation('de', 'accept', { 'fixture.ads': { 'after-accept': 1 } }, KNOWN)] });
    const v = vendor(graced, 'fixture.ads');
    expect(v.result).toBe('controlled');
    const w = v.observations.find((o) => o.scenario === 'withdraw' && !o.beforeChoice)!;
    expect(w).toMatchObject({ observed: 'held', graceRequests: 2 });
    expect(w.note).toMatch(/2 request\(s\) sent on the choice’s page within 1 s of the choice, or as page-exit sends while it reloaded, not counted/);
    const after = evaluation({ scenarios: scen, observations: [observation('de', 'withdraw', { 'fixture.ads': { 'withdraw-grace': 2, 'after-withdraw': 1 } }, KNOWN), observation('de', 'accept', { 'fixture.ads': { 'after-accept': 1 } }, KNOWN)] });
    expect(vendor(after, 'fixture.ads').result).toBe('not-controlled');
  });

  it('summarizeBehavior: ≤ 1 s after the click and page-exit sends before the reload commits are grace; the middle and after the reload are not', () => {
    const ev = evaluation();
    const req = (t: number, pageIndex: number, url: string, over: Record<string, unknown> = {}) => ({ type: 'request', t, id: `r${t}`, url, method: 'GET', resourceType: 'image', origin: 'page', pageUrl: PAGE, pageIndex, initiator: { type: 'other', chain: [] }, ...over });
    const data = 'https://www.facebook.com/tr/';
    const timeline = Timeline.parse({
      location: ev.locations[0].spec,
      verification: ev.locations[0].verification,
      snapshot: { site: ev.site, scenario: 'withdraw', locationId: 'de', startedAt: '2026-10-05T00:00:00Z', durationMs: 10000, gpc: false, browser: { name: 'chromium' }, pages: [], cookies: [], storage: [], frames: [] },
      events: [
        { type: 'banner', t: 0, state: 'shown', pageIndex: 0 },
        { type: 'choice', t: 100, choice: 'accept', ok: true, method: 'test', pageIndex: 0 },
        { type: 'choice', t: 1000, choice: 'withdraw', ok: true, method: 'test', pageIndex: 0 },
        req(1500, 0, data, { postData: 'ev=PageView' }), // ≤ 1 s after the click: grace
        req(2500, 0, data, { postData: 'ev=Timer' }), // still on the page, 1.5 s later: counts
        { type: 'action', t: 3000, action: 'reload', url: PAGE, pageIndex: 0 },
        req(3100, 0, data, { postData: 'ev=Exit', origin: 'exit-beacon', resourceType: 'ping' }), // page exit, before the reload commits: grace
        req(3500, 1, data, { postData: 'ev=PageView' }), // after the reload: counts
        req(3600, 1, 'https://connect.facebook.net/en_US/fbevents.js', { resourceType: 'script' }), // a load after the reload
        { type: 'action', t: 3700, action: 'type', detail: 'search marker', pageIndex: 1 },
      ],
    });
    const [o] = summarizeBehavior([timeline]);
    const meta = o.parties.find((f) => f.partyId === 'meta.pixel')!;
    expect(meta.dataRequestPhases).toEqual({ 'after-withdraw': 2, 'withdraw-grace': 2 });
    expect(meta.loadRequestsByPhase).toEqual({ 'after-withdraw': 1, 'withdraw-grace': 0 });
    expect(o.journey!['after-withdraw']).toEqual({ pageIndexes: [0, 1], steps: ['navigate', 'search'] });
  });

  it('#52: the choice is stamped with the next page — grace is the withdraw page’s first 1 s plus page-exit sends once the reload started; a send at +1.3 s counts', () => {
    const ev = evaluation();
    const req = (t: number, pageIndex: number, url: string, over: Record<string, unknown> = {}) => ({ type: 'request', t, id: `r${t}`, url, method: 'GET', resourceType: 'image', origin: 'page', pageUrl: PAGE, pageIndex, initiator: { type: 'other', chain: [] }, ...over });
    const data = 'https://www.facebook.com/tr/';
    const T = 5000;
    const timeline = Timeline.parse({
      location: ev.locations[0].spec,
      verification: ev.locations[0].verification,
      snapshot: { site: ev.site, scenario: 'withdraw', locationId: 'de', startedAt: '2026-10-05T00:00:00Z', durationMs: 12000, gpc: false, browser: { name: 'chromium' }, pages: [], cookies: [], storage: [], frames: [] },
      events: [
        { type: 'banner', t: 0, state: 'shown', pageIndex: 0 },
        { type: 'choice', t: 100, choice: 'accept', ok: true, method: 'test', pageIndex: 0 },
        { type: 'action', t: 3000, action: 'wait', detail: '3000ms', pageIndex: 0 },
        // Stamped at the step's start, but with the pageIndex of the page after the tool's reload.
        { type: 'choice', t: T, choice: 'withdraw', ok: true, method: 'test', pageIndex: 1 },
        req(T + 400, 0, data, { postData: 'ev=Flush1', resourceType: 'ping' }),
        req(T + 430, 0, PAGE, { resourceType: 'document', initiator: { type: 'script', chain: ['https://www.example-shop.test/complykit/v1/complykit-consent.js'] } }), // the tool's reload
        req(T + 800, 0, data, { postData: 'ev=Flush2', resourceType: 'ping' }),
        req(T + 1200, 0, data, { postData: 'ev=Exit', origin: 'exit-beacon', resourceType: 'ping' }), // page exit after the reload started: grace
        req(T + 1300, 0, data, { postData: 'ev=Timer' }), // > 1 s after the choice, still on the page: counts
        req(T + 1330, 1, 'https://www.example-shop.test/complykit/v1/complykit-consent.js', { resourceType: 'script' }), // the reloaded page commits
        req(T + 1400, 0, data, { postData: 'ev=Late' }), // still attributed to the old page, after the commit: counts
        req(T + 1500, 1, data, { postData: 'ev=PageView' }), // on the reloaded page: counts
        { type: 'action', t: T + 2600, action: 'reload', url: PAGE, pageIndex: 1 }, // the scanner's own reload
        req(T + 3000, 2, data, { postData: 'ev=PageView' }),
      ],
    });
    const [o] = summarizeBehavior([timeline]);
    const meta = o.parties.find((f) => f.partyId === 'meta.pixel')!;
    expect(meta.dataRequestPhases).toEqual({ 'withdraw-grace': 3, 'after-withdraw': 4 });
  });

  it('#57: a reject that revokes a granted default gets the bounded grace for a vendor active before it; a vendor held until then gets none', () => {
    const ev = evaluation();
    const req = (t: number, pageIndex: number, url: string, over: Record<string, unknown> = {}) => ({ type: 'request', t, id: `r${t}`, url, method: 'GET', resourceType: 'image', origin: 'page', pageUrl: PAGE, pageIndex, initiator: { type: 'other', chain: [] }, ...over });
    const meta = 'https://www.facebook.com/tr/';
    const tiktok = 'https://analytics.tiktok.com/api/v2/pixel';
    const T = 4000;
    const timeline = Timeline.parse({
      location: ev.locations[0].spec,
      verification: ev.locations[0].verification,
      snapshot: { site: ev.site, scenario: 'reject', locationId: 'de', startedAt: '2026-10-05T00:00:00Z', durationMs: 9000, gpc: false, browser: { name: 'chromium' }, pages: [], cookies: [], storage: [], frames: [] },
      events: [
        { type: 'banner', t: 0, state: 'shown', pageIndex: 0 },
        req(500, 0, meta, { postData: 'ev=PageView' }), // granted by the opt-out default: active before the choice
        { type: 'choice', t: T, choice: 'reject', ok: true, method: 'test', pageIndex: 0 },
        req(T + 50, 0, meta, { postData: 'ev=Flush1', resourceType: 'ping' }),
        req(T + 400, 0, meta, { postData: 'ev=Flush2' }),
        req(T + 400, 0, tiktok, { postData: 'event=Pageview' }), // never active before: no grace
        req(T + 1300, 0, meta, { postData: 'ev=Timer' }), // outside the window: counts
        { type: 'action', t: T + 1600, action: 'reload', url: PAGE, pageIndex: 0 },
        req(T + 2000, 1, meta, { postData: 'ev=PageView' }),
      ],
    });
    const [o] = summarizeBehavior([timeline]);
    const facts = (id: string) => o.parties.find((f) => f.partyId === id)!;
    expect(facts('meta.pixel').dataRequestPhases).toEqual({ 'before-choice': 1, 'reject-grace': 2, 'after-reject': 2 });
    expect(facts('tiktok.pixel').dataRequestPhases).toEqual({ 'after-reject': 1 });
  });

  it('#57: reject-grace requests are noted on the reject observation, not counted', () => {
    const scen = [
      { scenario: 'reject' as const, choice: { kind: 'reject' as const, ok: true, method: 'selector:complykit' } },
      { scenario: 'accept' as const, choice: { kind: 'accept' as const, ok: true, method: 'selector:complykit' } },
    ];
    const graced = evaluation({ scenarios: scen, observations: [observation('de', 'reject', { 'fixture.ads': { 'reject-grace': 2 } }, KNOWN), observation('de', 'accept', { 'fixture.ads': { 'after-accept': 1 } }, KNOWN)] });
    const v = vendor(graced, 'fixture.ads');
    expect(v.result).toBe('controlled');
    const w = v.observations.find((o) => o.scenario === 'reject' && !o.beforeChoice)!;
    expect(w).toMatchObject({ observed: 'held', graceRequests: 2 });
    expect(w.note).toMatch(/2 request\(s\) sent on the choice’s page within 1 s of the choice/);
  });
});

describe('D10 follow-up: gated snippets that call document.write', () => {
  it('a held, data-category inline script whose body calls document.write is a finding (amber)', () => {
    const f = (over: Partial<NonNullable<TrackingEvaluation['markup']>['findings'][number]>) => ({ partyId: 'fixture.ads', label: 'Fixture Ads', recognized: true, verdict: 'held' as const, kind: 'script' as const, context: 'document' as const, page: PAGE, line: 12, inline: true, attributes: { type: 'text/plain', 'data-category': 'advertising' }, matchedBy: 'inline-pattern' as const, match: 'fa(', locations: ['de'], alsoOn: [], occurrences: 1, ...over });
    const markup = (findings: ReturnType<typeof f>[]): TrackingEvaluation['markup'] => ({ pages: [{ url: PAGE, status: 'inspected', locations: ['de'], elements: findings.length }], findings, unexplained: [] });
    const p = evaluateConsentToolProof(evaluation({ markup: markup([f({ documentWrite: true })]) }));
    const finding = p.findings.find((x) => x.code === 'gated-document-write')!;
    expect(finding.message).toMatch(/Fixture Ads: the gated snippet calls document\.write \(\/:12\).*Not gateable asynchronously/);
    expect(finding.refs).toEqual(['/markup/findings/0']);
    expect(buildConsentToolProofReport(p)!.findings.find((x) => x.code === 'gated-document-write')).toMatchObject({ tone: 'amber', title: 'Gated script calls document.write' });
    // Not gated (no data-category), or no document.write: nothing.
    expect(codes(evaluation({ markup: markup([f({ documentWrite: true, attributes: { type: 'text/plain' } })]) }))).not.toContain('gated-document-write');
    expect(codes(evaluation({ markup: markup([f({})]) }))).not.toContain('gated-document-write');
  });
});
