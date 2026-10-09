import path from 'node:path';
import { promises as dns } from 'node:dns';
import crypto from 'node:crypto';
import type { Browser } from 'playwright';
import {
  runDir,
  timelineArtifact,
  ConsentToolRecord,
  ComplykitToolSnapshot,
  type Artifact,
  type RunId,
  type LocationSpec,
  type LocationVerification,
  type GeoSourceResult,
  type ScenarioId,
  type ScenarioSummary,
  type NotTestedItem,
  type Timeline,
  type ContainerCapture,
} from '../../../record/index.js';
import { runScenario, writeTimelineEvidence, type Markers } from './scenarios.js';
import { resolveJourney, type JourneyOptions } from './journey.js';
import { lookupExit, DEFAULT_GEO_SOURCES, VISITOR_LAUNCH_ARGS, type GeoSource } from './location.js';
import { autoconsentVersion } from './autoconsent.js';
import { discoverContainers, fetchContainers } from './containers.js';
import { transformResource, type LocalCopy } from './local-copy.js';

// The consent evaluation collector (plans/consent-design.md §2): for each
// location — verify where the exit really is; if verified, run that location's
// scenarios, each in a fresh profile; resolve first-party DNS; emit one
// `consent-timeline` artifact per tested location × scenario plus the evidence
// files. Everything it could not do becomes a not-tested item.
//
// Policy that depends on the legal registry (which jurisdictions a place is in,
// which scenarios a jurisdiction gets, what a registrable domain is) is passed
// in by the pipeline — collectors import record only (dependency law).

export { DEFAULT_GEO_SOURCES, IPINFO, IPWHOIS, contextOptionsFor, type GeoSource } from './location.js';
export { resolveJourney, type JourneyOptions } from './journey.js';
export { redactHar } from './har.js';
export { SHIM_SOURCE } from './shim.js';

export interface EvaluationPolicy {
  registrableDomain(host: string): string;
  /** Pure verdict from geo results (rules/tracking/plan.ts decideVerification). */
  verify(spec: LocationSpec, sources: GeoSourceResult[]): LocationVerification;
  /** Scenarios to run for a verified location. */
  scenariosFor(spec: LocationSpec, verification: LocationVerification): ScenarioId[];
}

/** Structured progress, for UIs (the service streams these). Additive to `trace`. */
export type EvaluationEvent =
  /** `runs`: visits planned per scenario (1 when absent, as older CLIs wrote it); the planned visit count is scenarios x runs. */
  | { type: 'location'; location: string; verdict: string; observed?: string; scenarios: ScenarioId[]; runs?: number; note?: string }
  /** `run`: the visit number, present only on repeat visits (2..runs, the slowed-connection repeats); absent = the first visit. */
  | { type: 'scenario-start'; location: string; scenario: ScenarioId; run?: number }
  | {
      type: 'scenario-done';
      location: string;
      scenario: ScenarioId;
      run?: number;
      status: 'tested' | 'not-tested' | 'not-applicable';
      reason?: string;
      requests: number;
      thirdPartyRequests: number;
      parties: number;
      cookies: number;
      durationMs: number;
      banner?: string;
    };

export interface ConsentEvaluationOptions {
  property: string;
  targetUrl: string;
  runId: RunId;
  cwd?: string;
  locations?: LocationSpec[]; // default: the machine's own location
  /** Override every location's scenario list. */
  scenarios?: ScenarioId[];
  journey?: JourneyOptions;
  geoSources?: GeoSource[];
  /** Keep cookie values, auth headers and bodies in evidence files. Default false. */
  rawEvidence?: boolean;
  har?: boolean; // default true
  bannerWaitMs?: number; // default 8000
  /** Per-scenario hard budget, ms (default 300000). */
  scenarioTimeoutMs?: number;
  /**
   * Throttled repeat runs (runs > 1) get the scenario budget times this factor
   * (default 3): Slow 3G + 4x CPU makes a banner flow on a heavy page take
   * several times the normal run, as the navigation timeout already allows.
   */
  throttledBudgetFactor?: number;
  /** Extra Chromium args (tests map fake hosts to a local server). */
  launchArgs?: string[];
  /** Scenarios run concurrently within a location. Default 1 (timing fidelity). */
  concurrency?: number;
  /**
   * Visits per scenario (default 1). Run 1 is normal; every further run repeats
   * the scenario under Slow-3G + CPU throttling, to catch trackers that only
   * fire when the consent tool loads slowly. A party active in any run is active.
   */
  runs?: number;
  /** Local-copy mode: rewrite the site's documents and named resources in this browser (local-copy.ts). */
  localCopy?: LocalCopy;
  policy: EvaluationPolicy;
  trace?: (line: string) => void;
  onEvent?: (e: EvaluationEvent) => void;
  /**
   * Called after every finished visit (repeats included) with what has been
   * collected so far: the timelines, the locations with the scenarios finished
   * so far, the gaps. No DNS records and no containers yet (they are resolved
   * once, at the end). For live views; a throw here is swallowed, never stops the scan.
   */
  onProgress?: (partial: PartialConsentCollection) => void;
}

/** What a scan has collected so far (onProgress): enough to run the analysis over the finished visits. */
export interface PartialConsentCollection {
  artifacts: Artifact[];
  timelines: Timeline[];
  locations: LocationRun[];
  notTested: NotTestedItem[];
  site: { url: string; host: string; registrableDomain: string };
  autoconsentVersion?: string;
  containers: ContainerCapture[];
  startedAt: string;
  finishedAt: string;
}

export interface LocationRun {
  spec: LocationSpec;
  verification: LocationVerification;
  scenarios: ScenarioSummary[];
}

export interface ConsentEvaluationCollection {
  artifacts: Artifact[];
  timelines: Timeline[];
  locations: LocationRun[];
  notTested: NotTestedItem[];
  site: { url: string; host: string; registrableDomain: string };
  autoconsentVersion?: string;
  // Tag-manager containers the scenarios loaded, fetched through their
  // location's context (A2). Parsed by rules/tracking/gtm.ts.
  containers: ContainerCapture[];
  startedAt: string;
  finishedAt: string;
}

export const LOCAL_LOCATION: LocationSpec = { id: 'local', label: 'This machine' };

function makeMarkers(runId: RunId): Markers {
  const tag = crypto.createHash('sha256').update(`${String(runId)}${Math.random()}`).digest('hex').slice(0, 10);
  return {
    email: `ck.marker.${tag}@example.com`,
    text: `ckmarker${tag}`,
    clickIds: {
      gclid: `CK_GCLID_${tag}`,
      fbclid: `CK_FBCLID_${tag}`,
      ttclid: `CK_TTCLID_${tag}`,
      msclkid: `CK_MSCLKID_${tag}`,
      utm_source: 'complykit',
    },
  };
}

async function resolveCnames(host: string): Promise<string[]> {
  const out: string[] = [];
  let current = host;
  for (let i = 0; i < 6; i++) {
    let next: string[] = [];
    try {
      next = await dns.resolveCname(current);
    } catch {
      break;
    }
    if (!next.length) break;
    out.push(next[0]);
    current = next[0];
  }
  return out;
}

async function launch(args: string[] = []): Promise<Browser> {
  const { chromium } = await import('playwright');
  // COMPLYKIT_BROWSER_CHANNEL=chrome|msedge|…: drive an installed browser when
  // Playwright's own Chromium is not available (no download). The evidence then
  // comes from that browser; the trace line names it.
  const channel = process.env.COMPLYKIT_BROWSER_CHANNEL || undefined;
  return chromium.launch({ headless: process.env.COMPLYKIT_HEADED !== '1', args: [...VISITOR_LAUNCH_ARGS, ...args], ...(channel ? { channel } : {}) });
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(n, queue.length)) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
  });
  await Promise.all(workers);
}

export async function collectConsentEvaluation(opts: ConsentEvaluationOptions): Promise<ConsentEvaluationCollection> {
  const startedAt = new Date().toISOString();
  const trace = opts.trace ?? (() => {});
  const target = new URL(opts.targetUrl);
  const site = { url: target.toString(), host: target.hostname, registrableDomain: opts.policy.registrableDomain(target.hostname) };
  const journey = resolveJourney(opts.journey);
  const countsOf = (tl: Timeline): { requests: number; thirdPartyRequests: number; parties: number; cookies: number } => {
    const requests = tl.events.filter((e) => e.type === 'request');
    const third = requests.filter((e) => {
      try {
        return opts.policy.registrableDomain(new URL(e.url).hostname) !== site.registrableDomain;
      } catch {
        return false;
      }
    });
    return {
      requests: requests.length,
      thirdPartyRequests: third.length,
      parties: new Set(third.map((e) => opts.policy.registrableDomain(new URL(e.url).hostname))).size,
      cookies: tl.snapshot.cookies.length,
    };
  };
  const locations = opts.locations?.length ? opts.locations : [LOCAL_LOCATION];
  const notTested: NotTestedItem[] = [];
  const runs: LocationRun[] = [];
  const timelines: Timeline[] = [];
  let containers: ContainerCapture[] = [];
  const raw = opts.rawEvidence === true;
  const totalRuns = Math.max(1, Math.min(5, Math.floor(opts.runs ?? 1)));
  const dir = runDir(opts.runId, opts.cwd);
  const markers = makeMarkers(opts.runId);
  if (opts.localCopy) {
    const lc = opts.localCopy;
    trace(`local copy: documents from ${lc.origin} are rewritten in this browser (${lc.file}) — nothing is installed on the site`);
    notTested.push({ scope: 'flow', id: 'local-copy', reason: `LOCAL COPY: the site's documents were rewritten inside the scanner's browser (${lc.file}): what this run shows is the rewritten copy's behavior, not the live site's` });
  }
  // A snapshot of everything finished so far, for live views (onProgress). The
  // arrays are copied: the analysis may run while the next visit adds to them.
  const progress = (): void => {
    if (!opts.onProgress) return;
    try {
      const at = new Date().toISOString();
      opts.onProgress({
        artifacts: timelines.map((tl) => timelineArtifact(tl, opts.property, site.url, at)),
        timelines: [...timelines],
        locations: runs.map((r) => ({ ...r, scenarios: [...r.scenarios] })),
        notTested: [...notTested],
        site,
        autoconsentVersion: autoconsentVersion(),
        containers: [],
        startedAt,
        finishedAt: at,
      });
    } catch (err) {
      trace(`live progress skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const browser = await launch(opts.launchArgs);
  if (process.env.COMPLYKIT_BROWSER_CHANNEL) trace(`browser: ${process.env.COMPLYKIT_BROWSER_CHANNEL} channel ${browser.version()} (COMPLYKIT_BROWSER_CHANNEL)`);

  try {
    for (const spec of locations) {
      trace(`location ${spec.id}: verifying exit${spec.proxy ? ` via ${spec.proxy.server}` : ' (no proxy — this machine)'}…`);
      let sources: GeoSourceResult[];
      try {
        sources = await lookupExit(browser, spec, opts.geoSources ?? DEFAULT_GEO_SOURCES);
      } catch (err) {
        sources = [{ name: 'lookup', error: err instanceof Error ? err.message.slice(0, 120) : 'failed' }];
      }
      const verification = opts.policy.verify(spec, sources);
      trace(
        `location ${spec.id}: ${verification.verdict}` +
          (verification.observed.country ? ` — exit in ${[verification.observed.country, verification.observed.region].filter(Boolean).join('-')}` : '') +
          (verification.note ? ` (${verification.note})` : ''),
      );
      const run: LocationRun = { spec, verification, scenarios: [] };
      runs.push(run);
      const emit = opts.onEvent ?? (() => {});
      const observed = [verification.observed.country, verification.observed.region].filter(Boolean).join('-') || undefined;
      if (verification.verdict !== 'verified') {
        emit({ type: 'location', location: spec.id, verdict: verification.verdict, observed, scenarios: [], note: verification.note });
        notTested.push({ scope: 'location', id: spec.id, location: spec.id, reason: `location ${verification.verdict}: ${verification.note ?? 'not verified'} — no findings are attributed to it` });
        continue;
      }
      const scenarios = opts.scenarios?.length ? opts.scenarios : spec.scenarios?.length ? spec.scenarios : opts.policy.scenariosFor(spec, verification);
      trace(`location ${spec.id}: scenarios ${scenarios.join(', ')}`);
      emit({ type: 'location', location: spec.id, verdict: verification.verdict, observed, scenarios, runs: totalRuns, note: verification.note });
      const results = new Map<ScenarioId, ScenarioSummary>();
      await pool(scenarios, opts.concurrency ?? 1, async (scenario) => {
        emit({ type: 'scenario-start', location: spec.id, scenario });
        const evidenceRel = path.join('evidence', 'tracking', spec.id, scenario);
        const visit = (runNo: number): ReturnType<typeof runScenario> => {
          const rel = runNo > 1 ? `${evidenceRel}-run${runNo}` : evidenceRel;
          return runScenario({
            browser,
            spec,
            verification,
            scenario,
            targetUrl: site.url,
            site,
            // A throttled page needs room: the same journey, longer navigation budget.
            journey: runNo > 1 ? { ...journey, navTimeoutMs: Math.max(journey.navTimeoutMs, 90000) } : journey,
            runId: opts.runId,
            cwd: opts.cwd,
            evidenceDir: path.join(dir, rel),
            evidenceRel: rel,
            har: opts.har !== false,
            raw,
            markers,
            bannerWaitMs: opts.bannerWaitMs ?? 8000,
            // The throttled pass gets a scaled budget too (#50): the same journey takes several times as long.
            scenarioTimeoutMs: runNo > 1 ? throttledBudget(opts) : opts.scenarioTimeoutMs,
            run: totalRuns > 1 ? runNo : undefined,
            throttle: runNo > 1,
            localCopy: opts.localCopy,
            trace,
          });
        };
        const out = await visit(1);
        // Site-reported region feeds the location's verification record.
        for (const r of out.siteReported) {
          if (!verification.siteReported.some((x) => x.source === r.source)) verification.siteReported.push(r);
        }
        const tl = out.timeline;
        const banner = tl.events.find((e) => e.type === 'banner' && (e.state === 'shown' || e.state === 'reappeared'));
        const choice = [...tl.events].reverse().find((e) => e.type === 'choice');
        const walk = [...tl.events].reverse().find((e) => e.type === 'opt-out-walk');
        const toolRead = tl.events.find((e) => e.type === 'consent-readout' && e.label === 'default-consent-tool');
        const consentTool = toolRead?.type === 'consent-readout' ? ConsentToolRecord.safeParse(toolRead.data) : undefined;
        const ckRead = tl.events.find((e) => e.type === 'consent-readout' && e.label === 'complykit-tool');
        const complykit = ckRead?.type === 'consent-readout' ? ComplykitToolSnapshot.safeParse(ckRead.data) : undefined;
        results.set(scenario, {
          scenario,
          status: out.status,
          reason: out.reason,
          ...(out.cause ? { cause: out.cause } : {}),
          durationMs: tl.snapshot.durationMs,
          banner: { found: Boolean(banner), cmp: banner?.type === 'banner' ? banner.cmp : undefined, shownAtMs: banner?.t },
          consentTool: consentTool?.success ? consentTool.data : undefined,
          complykit: complykit?.success ? complykit.data : undefined,
          choice: choice?.type === 'choice' ? { kind: choice.choice, ok: choice.ok, method: choice.note ? `${choice.method} — ${choice.note}` : choice.method } : undefined,
          optOutWalk: walk?.type === 'opt-out-walk' ? { found: walk.found, linkText: walk.linkText, requiredFields: walk.requiredFields, performed: walk.performed } : undefined,
          counts: countsOf(tl),
          evidence: { har: tl.snapshot.evidence.har, timeline: tl.snapshot.evidence.timeline, screenshots: out.screenshots },
        });
        const sum = results.get(scenario)!;
        emit({
          type: 'scenario-done',
          location: spec.id,
          scenario,
          status: out.status,
          reason: out.reason,
          ...(out.cause ? { cause: out.cause } : {}),
          requests: sum.counts?.requests ?? 0,
          thirdPartyRequests: sum.counts?.thirdPartyRequests ?? 0,
          parties: sum.counts?.parties ?? 0,
          cookies: sum.counts?.cookies ?? 0,
          durationMs: tl.snapshot.durationMs,
          banner: sum.banner?.found ? sum.banner.cmp : undefined,
        });
        if (out.status !== 'tested') {
          notTested.push({ scope: 'scenario', id: scenario, location: spec.id, reason: out.reason ?? out.status });
        }
        // A not-applicable scenario (no banner) adds nothing a browse visit doesn't;
        // a blocked visit recorded a challenge page, not the site — neither is evidence.
        if (out.status !== 'not-applicable' && !out.reason?.startsWith('bot protection')) timelines.push(tl);
        for (const n of tl.snapshot.notTested) notTested.push({ scope: 'flow', id: scenario, location: spec.id, reason: n });
        const finished = () => (run.scenarios = scenarios.map((s) => results.get(s)).filter((x): x is ScenarioSummary => Boolean(x)));
        finished();
        progress();
        // Repeat visits under throttling (A7). Only after a visit that tested: a
        // scenario that could not run once will not run slower. A repeat that fails
        // is a stated gap, never a quiet drop — the cell then reads "1 of 1 runs"
        // next to a not-tested note.
        if (out.status === 'tested' && totalRuns > 1) {
          sum.runs = 1;
          for (let runNo = 2; runNo <= totalRuns; runNo++) {
            trace(`${spec.id}/${scenario}: run ${runNo} of ${totalRuns} (throttled: Slow 3G, CPU x4)`);
            emit({ type: 'scenario-start', location: spec.id, scenario, run: runNo });
            const again = await visit(runNo);
            emit({
              type: 'scenario-done',
              location: spec.id,
              scenario,
              run: runNo,
              status: again.status,
              reason: again.reason,
              ...(again.cause ? { cause: again.cause } : {}),
              ...countsOf(again.timeline),
              durationMs: again.timeline.snapshot.durationMs,
            });
            if (again.status !== 'tested') {
              notTested.push({ scope: 'scenario', id: scenario, location: spec.id, reason: `throttled run ${runNo} of ${totalRuns} did not complete: ${again.reason ?? again.status}` });
              progress();
              continue;
            }
            sum.runs++;
            timelines.push(again.timeline);
            for (const n of again.timeline.snapshot.notTested) notTested.push({ scope: 'flow', id: scenario, location: spec.id, reason: n });
            finished();
            progress();
          }
        } else if (totalRuns > 1) {
          // The planned repeats are skipped (see above). Each still closes its step,
          // so a progress bar counting scenarios x runs reaches its total.
          for (let runNo = 2; runNo <= totalRuns; runNo++) {
            emit({
              type: 'scenario-done',
              location: spec.id,
              scenario,
              run: runNo,
              status: out.status,
              reason: `repeat skipped: the first visit was ${out.status === 'not-applicable' ? 'not applicable' : 'not tested'}`,
              requests: 0,
              thirdPartyRequests: 0,
              parties: 0,
              cookies: 0,
              durationMs: 0,
            });
          }
          progress();
        }
      });
      run.scenarios = scenarios.map((s) => results.get(s)).filter((x): x is ScenarioSummary => Boolean(x));
    }
    // Tag-manager containers: fetch every gtm.js / gtag.js the scenarios loaded,
    // through the location that loaded it, while the browser is still up.
    const discovered = discoverContainers(timelines);
    if (discovered.length) {
      trace(`containers: fetching ${discovered.map((d) => d.id).join(', ')}…`);
      const specs = new Map(runs.map((r) => [r.spec.id, r.spec]));
      const evidenceRel = path.join('evidence', 'tracking', 'containers');
      try {
        const lc = opts.localCopy;
        containers = await fetchContainers(browser, specs, discovered, { evidenceDir: path.join(dir, evidenceRel), evidenceRel, ...(lc ? { transform: (url, source) => transformResource(lc, url, source) } : {}) });
      } catch (err) {
        containers = discovered.map((d) => ({ ...d, fetchedAt: new Date().toISOString(), status: 'error' as const, error: err instanceof Error ? err.message.slice(0, 160) : 'fetch failed' }));
      }
      for (const c of containers) trace(`container ${c.id}: ${c.status === 'ok' ? `${c.bytes} bytes` : `not fetched (${c.error})`}`);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  // First-party DNS: subdomains of the site that resolve (CNAME) to someone else
  // are trackers wearing the site's name.
  const firstPartyHosts = new Set<string>();
  for (const tl of timelines) {
    for (const e of tl.events) {
      if (e.type !== 'request') continue;
      try {
        const h = new URL(e.url).hostname;
        if (opts.policy.registrableDomain(h) === site.registrableDomain) firstPartyHosts.add(h);
      } catch {
        /* skip */
      }
    }
  }
  const dnsRecords: Array<{ host: string; cname: string[] }> = [];
  await Promise.all(
    [...firstPartyHosts].slice(0, 50).map(async (host) => {
      const cname = await resolveCnames(host);
      if (cname.length) dnsRecords.push({ host, cname });
    }),
  );

  const artifacts: Artifact[] = [];
  const capturedAt = new Date().toISOString();
  for (const tl of timelines) {
    tl.snapshot.dns = dnsRecords;
    const runSuffix = (tl.snapshot.run ?? 1) > 1 ? `-run${tl.snapshot.run}` : '';
    writeTimelineEvidence(path.join(dir, 'evidence', 'tracking', tl.location.id, tl.snapshot.scenario + runSuffix), tl, raw);
    artifacts.push(timelineArtifact(tl, opts.property, site.url, capturedAt));
  }

  return {
    artifacts,
    timelines,
    locations: runs,
    notTested,
    site,
    autoconsentVersion: autoconsentVersion(),
    containers,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

/** Default per-scenario budget, ms, and the throttled runs' multiple of it. */
export const SCENARIO_BUDGET_MS = 300000;
export const THROTTLED_BUDGET_FACTOR = 3;

/** The budget of a throttled repeat run (A7, #50): the scenario budget times throttledBudgetFactor. */
export function throttledBudget(opts: Pick<ConsentEvaluationOptions, 'scenarioTimeoutMs' | 'throttledBudgetFactor'>): number {
  const factor = opts.throttledBudgetFactor !== undefined && Number.isFinite(opts.throttledBudgetFactor) && opts.throttledBudgetFactor > 0 ? opts.throttledBudgetFactor : THROTTLED_BUDGET_FACTOR;
  return Math.round((opts.scenarioTimeoutMs ?? SCENARIO_BUDGET_MS) * factor);
}
