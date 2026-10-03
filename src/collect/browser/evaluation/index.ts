import path from 'node:path';
import { promises as dns } from 'node:dns';
import crypto from 'node:crypto';
import type { Browser } from 'playwright';
import {
  runDir,
  type Artifact,
  type RunId,
  type LocationSpec,
  type LocationVerification,
  type GeoSourceResult,
  type ScenarioId,
  type ScenarioSummary,
  type NotTestedItem,
  type Timeline,
} from '../../../record/index.js';
import { runScenario, writeTimelineEvidence, type Markers } from './scenarios.js';
import { resolveJourney, type JourneyOptions } from './journey.js';
import { lookupExit, DEFAULT_GEO_SOURCES, type GeoSource } from './location.js';
import { autoconsentVersion } from './autoconsent.js';

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
  | { type: 'location'; location: string; verdict: string; observed?: string; scenarios: ScenarioId[]; note?: string }
  | { type: 'scenario-start'; location: string; scenario: ScenarioId }
  | {
      type: 'scenario-done';
      location: string;
      scenario: ScenarioId;
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
  /** Extra Chromium args (tests map fake hosts to a local server). */
  launchArgs?: string[];
  /** Scenarios run concurrently within a location. Default 1 (timing fidelity). */
  concurrency?: number;
  policy: EvaluationPolicy;
  trace?: (line: string) => void;
  onEvent?: (e: EvaluationEvent) => void;
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
  return chromium.launch({ headless: process.env.COMPLYKIT_HEADED !== '1', args });
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
  const locations = opts.locations?.length ? opts.locations : [LOCAL_LOCATION];
  const notTested: NotTestedItem[] = [];
  const runs: LocationRun[] = [];
  const timelines: Timeline[] = [];
  const raw = opts.rawEvidence === true;
  const dir = runDir(opts.runId, opts.cwd);
  const markers = makeMarkers(opts.runId);
  const browser = await launch(opts.launchArgs);

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
      emit({ type: 'location', location: spec.id, verdict: verification.verdict, observed, scenarios, note: verification.note });
      const results = new Map<ScenarioId, ScenarioSummary>();
      await pool(scenarios, opts.concurrency ?? 1, async (scenario) => {
        emit({ type: 'scenario-start', location: spec.id, scenario });
        const evidenceRel = path.join('evidence', 'tracking', spec.id, scenario);
        const out = await runScenario({
          browser,
          spec,
          verification,
          scenario,
          targetUrl: site.url,
          site,
          journey,
          runId: opts.runId,
          cwd: opts.cwd,
          evidenceDir: path.join(dir, evidenceRel),
          evidenceRel,
          har: opts.har !== false,
          raw,
          markers,
          bannerWaitMs: opts.bannerWaitMs ?? 8000,
          scenarioTimeoutMs: opts.scenarioTimeoutMs,
          trace,
        });
        // Site-reported region feeds the location's verification record.
        for (const r of out.siteReported) {
          if (!verification.siteReported.some((x) => x.source === r.source)) verification.siteReported.push(r);
        }
        const tl = out.timeline;
        const requests = tl.events.filter((e) => e.type === 'request');
        const third = requests.filter((e) => {
          try {
            return opts.policy.registrableDomain(new URL(e.url).hostname) !== site.registrableDomain;
          } catch {
            return false;
          }
        });
        const banner = tl.events.find((e) => e.type === 'banner' && (e.state === 'shown' || e.state === 'reappeared'));
        const choice = [...tl.events].reverse().find((e) => e.type === 'choice');
        results.set(scenario, {
          scenario,
          status: out.status,
          reason: out.reason,
          durationMs: tl.snapshot.durationMs,
          banner: { found: Boolean(banner), cmp: banner?.type === 'banner' ? banner.cmp : undefined, shownAtMs: banner?.t },
          choice: choice?.type === 'choice' ? { kind: choice.choice, ok: choice.ok, method: choice.note ? `${choice.method} — ${choice.note}` : choice.method } : undefined,
          counts: {
            requests: requests.length,
            thirdPartyRequests: third.length,
            parties: new Set(third.map((e) => opts.policy.registrableDomain(new URL(e.url).hostname))).size,
            cookies: tl.snapshot.cookies.length,
          },
          evidence: { har: tl.snapshot.evidence.har, timeline: tl.snapshot.evidence.timeline, screenshots: out.screenshots },
        });
        const sum = results.get(scenario)!;
        emit({
          type: 'scenario-done',
          location: spec.id,
          scenario,
          status: out.status,
          reason: out.reason,
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
      });
      run.scenarios = scenarios.map((s) => results.get(s)).filter((x): x is ScenarioSummary => Boolean(x));
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
    writeTimelineEvidence(path.join(dir, 'evidence', 'tracking', tl.location.id, tl.snapshot.scenario), tl, raw);
    artifacts.push({
      kind: 'consent-timeline',
      subject: { property: opts.property, routePattern: '*', instanceUrl: site.url, state: `${tl.location.id}/${tl.snapshot.scenario}` },
      capturedAt,
      payloadPath: tl.snapshot.evidence.timeline,
      scenario: tl.snapshot.scenario,
      location: tl.location as unknown as Record<string, unknown>,
      verification: tl.verification as unknown as Record<string, unknown>,
      events: tl.events as unknown as Record<string, unknown>[],
      snapshot: tl.snapshot as unknown as Record<string, unknown>,
    });
  }

  return {
    artifacts,
    timelines,
    locations: runs,
    notTested,
    site,
    autoconsentVersion: autoconsentVersion(),
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
