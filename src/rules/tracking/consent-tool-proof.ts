import {
  NECESSARY_CATEGORY,
  canonicalJson,
  consentCategoryDefault,
  guardConsentToolConfig,
  parseConsentToolConfig,
  readConsentConfigHeader,
  CONSENT_CONFIG_VERSION,
  type ComplykitToolSnapshot,
  type ConsentToolConfig,
  type ConsentToolProof,
  type ConsentToolProofFinding,
  type Regime,
  type TrackingEvaluation,
  type VendorControlObservation,
  type VendorControlProof,
} from '../../record/index.js';
import { regimeOf, purposeScopeOf, type BehaviorCell } from './compatibility.js';
import { PHASE_LABEL, WITHDRAW_GRACE_MS, graceCount, type Phase } from './analyze.js';

// The proof step (plans/client-consent-design.md §0 step 5, §7; ticket D10):
// complykit's own consent tool was found on the site — does the deployed
// config describe what actually happened? Pure, over the evaluation record.
// Conservative by construction: a wrong 'controlled' is a false pass, so every
// rule here fails closed.
//
// Decision rules, in one place:
//
//   Detection      detected = any tested scenario's landing saw the global, the
//                  config element or the complykit_consent cookie.
//
//   Config status  The first config element seen is THE deployed config.
//                    missing   no element while the tool's global was present
//                    not-json  element text is not JSON
//                    refused   guardConsentToolConfig (the client's own check)
//                              refuses it — the tool does nothing on it
//                    invalid   the guard accepts it (the tool runs) but the full
//                              schema does not — edited since generation
//                    ok        parsed and accepted
//                  `hashMatches` false (parsed) ⇒ 'config-edited'.
//                  Behind: differs from the workspace's latest config — hash AND
//                  content apart from generatedFrom (a regeneration that changed
//                  nothing hashes differently but is not behind) — or version
//                  older than this build's schema ⇒ 'config-behind'.
//                  generatedFrom.site ≠ scanned registrable domain ⇒
//                  'config-other-site'.
//
//   Expected state Per vendor, per tested scenario, the regime is the one the
//                  TOOL decided (its state on landing); when the tool was not
//                  running, the location's rules (regimeOf). A category is
//                  expected granted when:
//                    necessary            always
//                    accept               yes
//                    partial              only 'analytics'
//                    reject / withdraw /
//                    return-visit /
//                    opt-out-all          no
//                    gpc                  no — the tool denies every non-necessary
//                                         category under GPC, in every regime; a
//                                         running tool that did not record the
//                                         signal ⇒ 'gpc-not-honored'
//                    opt-out-link         not compared (the site's link, not ours)
//                    anything else        consentCategoryDefault(config, category,
//                                         regime) — the config's own default
//                  A choice scenario whose choice did not succeed is skipped, and
//                  so is one the tool was running in but that was NOT driven
//                  through its own hooks (method without 'complykit'). In a
//                  choice scenario the phases before the choice are compared too,
//                  against the config's default (beforeChoice).
//
//   Observed       From the behavior observations, in the scenario's phases
//                  (same table as B1): fired = any data request or storage
//                  write; restricted = only consent-denied / restricted-mode
//                  requests and nothing stored; loaded = no data, nothing
//                  stored, but the vendor's own script / iframe / pixel loaded
//                  (non-data requests); held = nothing at all. A record that
//                  did not count loads cannot show 'held' for a pass.
//                  Withdraw, and a reject that revoked a granted state for a
//                  vendor already active (#57): requests on the choice's page
//                  within 1 s of the choice (before the next page commits),
//                  plus — withdraw only — page-exit sends once the reload
//                  started, are not post-choice activity (counted under
//                  'withdraw-grace' / 'reject-grace', noted on the
//                  observation); everything else counts.
//
//   Per vendor     not-controlled  fired in ANY denied-state visit; or
//                                  restricted in a denied-state visit unless the
//                                  control is 'api' AND the regime is not opt-in
//                                  (design §9.3: in opt-in locations the API is
//                                  additive to gating, never instead — a
//                                  cookieless ping means the load was not held;
//                                  §1: counsel counts those pings as activity);
//                                  or loaded in a denied-state visit under a
//                                  'gate' (preventing the load is the gate's
//                                  whole job) or 'api' under opt-in; or, where
//                                  the tool decided a weaker regime than the
//                                  location's law, active where the LAW's regime
//                                  denies the category (the config grants it
//                                  only under the tool's weaker setting)
//                  controlled      every denied-state visit held (restricted
//                                  allowed only for 'api' outside opt-in), at
//                                  least one of them a whole visit (not only the
//                                  moments before a choice), AND at least one
//                                  granted-state visit saw it fire —
//                                  so it is still on the site and the tool is
//                                  what holds it — AND journey parity: a held
//                                  visit walked at least the steps (site search,
//                                  navigation) and as many pages as a granted
//                                  visit that ran it (a vendor firing only on a
//                                  search proves nothing by staying quiet in a
//                                  visit that never searched; no journey
//                                  recorded = no parity). Never without all
//                                  three. A load-only visit counts as held only
//                                  for 'api' / 'platform' outside opt-in. Never for
//                                  control 'none' (nothing in the config holds
//                                  it: what held it is unexplained) nor for a
//                                  vendor whose implementation is a DNS alias or
//                                  suspected server-side forwarding (its
//                                  requests may not be attributed to it, so
//                                  "nothing recorded" is not "held").
//                  not-observed    everything else: no denied-state visit, or
//                                  held everywhere but never seen running
//                                  (removed, or never released — holding
//                                  nothing proves nothing); necessary vendors
//                                  (never held by design).
//
//   Unlisted       A recognized party the config does not list, with a
//                  consent-requiring purpose or tracker behavior, that sent
//                  (unrestricted) data or stored something after reject /
//                  withdraw, or before any choice under an opt-in regime the
//                  tool decided ⇒ 'vendor-not-in-config'. The vendor table
//                  only covers what the config names; this is the rest.
//
//   Fed back       Every denied-state 'fired' (and 'restricted', on the same
//                  terms as above) observation becomes a behavior-mismatch cell for the
//                  compatibility verdict (B1/B2): a vendor the config says is
//                  gated but fires is a behavior mismatch, whatever the law's
//                  own matrix says for that location.
//
//   Install checks tool-after-gtm (diagnostics.gtm.orderOk false),
//                  ui-not-loaded (diagnostics.ui.state 'failed'),
//                  tool-not-running (config element, guard ok, store never
//                  started), gate-rule-unrewritten (an executable <script> in
//                  the served HTML whose src matches a gate[] rule: never
//                  rewritten to text/plain), necessary-tracker (a vendor listed
//                  as necessary that behaved like a tracker or has a consent
//                  purpose), regime-mismatch (the tool decided a regime LESS
//                  strict than the scanned location's rules; the report's
//                  controlled count then says it was measured against the
//                  tool's weaker setting), gated-document-write (a held,
//                  data-category inline <script> in the served HTML whose body
//                  calls document.write: released late, the write is ignored or
//                  wipes the page — not gateable asynchronously).

export interface ConsentToolProofInput {
  /** The workspace's latest generated config (`config.value.config`, or the config itself). */
  workspaceConfig?: { value: unknown; at?: string; runId?: string };
}

const CHOICE_SCENARIOS = new Set(['reject', 'accept', 'partial', 'withdraw', 'opt-out-all', 'return-visit']);
const SCENARIO_PHASES: Record<string, Phase[]> = {
  reject: ['after-reject'],
  'return-visit': ['after-reject'],
  withdraw: ['after-withdraw'],
  dismiss: ['after-dismiss'],
  accept: ['after-accept'],
  partial: ['after-partial'],
};
const PRE_CHOICE: Phase[] = ['no-banner', 'before-banner', 'before-choice'];
/** Scenarios whose own phases deny every non-necessary category, whatever the config. */
const REFUSED_SCENARIOS = new Set(['reject', 'withdraw', 'return-visit']);
const STRICTNESS: Record<string, number> = { 'opt-in': 3, 'opt-out-signal': 2, 'opt-out': 1 };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Whether the deployed config grants `category` in this scenario; undefined = not compared. */
export function expectedGrantedFor(config: ConsentToolConfig, category: string, regime: Regime, scenario: string, gpcSeen: boolean): boolean | undefined {
  if (category === NECESSARY_CATEGORY) return true;
  switch (scenario) {
    case 'accept':
      return true;
    case 'partial':
      return category === 'analytics';
    case 'reject':
    case 'withdraw':
    case 'return-visit':
    case 'opt-out-all':
      return false;
    case 'gpc':
      // The tool's contract: GPC denies every non-necessary category, whatever the regime
      // (client/src/store.ts). Whether the tool saw the signal is a finding, not an excuse.
      void gpcSeen;
      return false;
    case 'opt-out-link':
      return undefined;
    default:
      return consentCategoryDefault(config, category, regime);
  }
}

interface SeenSnapshot {
  li: number;
  si: number;
  location: string;
  scenario: string;
  snap: ComplykitToolSnapshot;
}

/** The raw deployed config (first config element seen), parsed as JSON; `text: false` when the element's text is not JSON. */
function deployedRaw(seen: SeenSnapshot[]): { raw: unknown; json: boolean; ref?: string } | undefined {
  for (const s of seen) {
    if (s.snap.configJson === undefined) continue;
    const ref = `/locations/${s.li}/scenarios/${s.si}/complykit/configJson`;
    try {
      return { raw: JSON.parse(s.snap.configJson), json: true, ref };
    } catch {
      return { raw: undefined, json: false, ref };
    }
  }
  return undefined;
}

function workspaceHeader(ws: ConsentToolProofInput['workspaceConfig']): { hash?: string; at?: string; runId?: string; raw?: unknown } | undefined {
  if (!ws) return undefined;
  // The service stores value = { config, snippet, changeList, notes }; a plain config is accepted too.
  const cfg = isObj(ws.value) && isObj(ws.value.config) ? ws.value.config : ws.value;
  const h = readConsentConfigHeader(cfg);
  return { ...(h.hash ? { hash: h.hash } : {}), ...(h.generatedFrom?.at ? { at: h.generatedFrom.at } : ws.at ? { at: ws.at } : {}), ...(h.generatedFrom?.runId ? { runId: h.generatedFrom.runId } : ws.runId ? { runId: ws.runId } : {}), raw: cfg };
}

/**
 * What a config DOES: its parsed form (defaults filled) without `hash` and
 * `generatedFrom`, canonical. The hash covers generatedFrom (run id, time), so a
 * regeneration that changed nothing hashes differently; comparing this instead
 * keeps 'config-behind' from asking for a redeploy that changes nothing.
 * undefined when it does not parse (then only the hash is compared).
 */
function configContent(raw: unknown): string | undefined {
  const parsed = parseConsentToolConfig(raw);
  if (!parsed.ok) return undefined;
  const { hash: _h, generatedFrom: _g, ...rest } = parsed.config;
  return canonicalJson(rest);
}

export function evaluateConsentToolProof(ev: TrackingEvaluation, input: ConsentToolProofInput = {}): ConsentToolProof {
  const seen: SeenSnapshot[] = [];
  ev.locations.forEach((l, li) => {
    l.scenarios.forEach((s, si) => {
      if (s.complykit?.present) seen.push({ li, si, location: l.spec.id, scenario: s.scenario, snap: s.complykit });
    });
  });
  const empty: ConsentToolProof = {
    detected: false,
    seenIn: [],
    config: { status: 'missing', issues: [] },
    vendors: [],
    totals: { controlled: 0, notControlled: 0, notObserved: 0 },
    findings: [],
    driven: [],
    notTested: [],
  };
  if (!seen.length) return empty;

  const findings: ConsentToolProofFinding[] = [];
  const notTested: string[] = [];
  const version = seen.map((s) => s.snap.version).find((v): v is string => typeof v === 'string');
  const seenIn = seen.map((s) => ({ location: s.location, scenario: s.scenario, running: s.snap.running, bannerShown: s.snap.bannerShown }));
  const running = seen.some((s) => s.snap.running);

  // --- the deployed config ---
  const dep = deployedRaw(seen);
  const header = dep?.json ? readConsentConfigHeader(dep.raw) : {};
  let config: ConsentToolConfig | undefined;
  const cfgOut: ConsentToolProof['config'] = { status: 'missing', issues: [], ...(header.version ? { version: header.version } : {}), ...(header.hash ? { hash: header.hash } : {}), ...(header.generatedFrom ? { generatedFrom: header.generatedFrom } : {}) };
  if (!dep) {
    cfgOut.status = 'missing';
    findings.push({ code: 'config-missing', message: 'complykit’s script is on the page but no config element (<script type="application/json" id="complykit-config">) was found: the tool starts nothing without one.', refs: [`/locations/${seen[0].li}/scenarios/${seen[0].si}/complykit`] });
  } else if (!dep.json) {
    cfgOut.status = 'not-json';
    findings.push({ code: 'config-refused', message: 'the config element’s text is not JSON: the tool refuses it and does nothing (gated scripts stay inert, no banner).', refs: dep.ref ? [dep.ref] : [] });
  } else {
    const guard = guardConsentToolConfig(dep.raw);
    cfgOut.guard = guard.ok ? { ok: true } : { ok: false, reason: guard.reason, detail: guard.detail };
    const parsed = parseConsentToolConfig(dep.raw);
    cfgOut.versionStatus = parsed.version;
    if (!guard.ok) {
      cfgOut.status = 'refused';
      if (!parsed.ok) cfgOut.issues = parsed.issues;
      findings.push({ code: 'config-refused', message: `the deployed config is refused by the tool (${guard.reason}: ${guard.detail}): it does nothing on it — gated scripts stay inert and no banner is shown.`, refs: dep.ref ? [dep.ref] : [], details: { reason: guard.reason, detail: guard.detail } });
    } else if (!parsed.ok) {
      cfgOut.status = 'invalid';
      cfgOut.issues = parsed.issues;
      // The guard accepted it, so the tool runs it; use what the guard accepted.
      config = guard.config;
      findings.push({ code: 'config-invalid', message: `the deployed config does not validate against the schema (${parsed.issues.slice(0, 3).map((i) => `${i.path}: ${i.message}`).join('; ')}${parsed.issues.length > 3 ? '; …' : ''}) — the generator did not write it as is. The tool runs it anyway (its own guard is narrower).`, refs: dep.ref ? [dep.ref] : [], details: { issues: parsed.issues } });
    } else {
      cfgOut.status = 'ok';
      cfgOut.hashMatches = parsed.hashMatches;
      config = parsed.config;
      if (!parsed.hashMatches) findings.push({ code: 'config-edited', message: 'the deployed config was edited by hand since generation: its body does not hash to its `hash`. Regenerate from a scan rather than editing — the change list and this proof assume the generated form.', refs: dep.ref ? [dep.ref] : [] });
    }
    // Behind this build's schema.
    if (parsed.version === 'older-minor' || parsed.version === 'older-major') {
      findings.push({ code: 'config-behind', message: `the deployed config is on schema ${header.version ?? '?'}; this build generates ${CONSENT_CONFIG_VERSION}${parsed.version === 'older-major' ? ' — a different major: the tool refuses it' : ' — an older minor: it runs, but newer fields are absent'}. Regenerate and redeploy.`, refs: dep.ref ? [dep.ref] : [], details: { versionStatus: parsed.version } });
    }
    // Behind the workspace.
    const wsFull = workspaceHeader(input.workspaceConfig);
    if (wsFull) {
      const { raw: wsRaw, ...ws } = wsFull;
      const sameHash = Boolean(ws.hash && header.hash && ws.hash === header.hash);
      // Content is only compared for an unedited deployed config: an edited one's body is not what its header says.
      const deployedContent = cfgOut.status === 'ok' && cfgOut.hashMatches ? configContent(dep.raw) : undefined;
      const sameContent = !sameHash && deployedContent !== undefined && deployedContent === configContent(wsRaw);
      const same = sameHash || sameContent;
      cfgOut.workspace = { ...ws, same, ...(sameContent ? { sameContent: true } : {}) };
      if (!same) {
        const when = (a?: string): string => (a ? a.slice(0, 16).replace('T', ' ') : 'undated');
        findings.push({
          code: 'config-behind',
          message: `the deployed config is not the workspace’s latest: deployed ${when(header.generatedFrom?.at)}${header.generatedFrom?.runId ? ` (run ${header.generatedFrom.runId})` : ''}, workspace ${when(ws.at)}${ws.runId ? ` (run ${ws.runId})` : ''}; their settings differ. Paste the latest snippet.`,
          refs: dep.ref ? [dep.ref] : [],
          details: { deployedHash: header.hash, workspaceHash: ws.hash, deployedAt: header.generatedFrom?.at, workspaceAt: ws.at },
        });
      }
    } else notTested.push('whether the deployed config is the workspace’s latest (the scan had no workspace config to compare with)');
    // Another site's config.
    const site = header.generatedFrom?.site?.toLowerCase();
    if (site && site !== ev.site.registrableDomain.toLowerCase()) {
      findings.push({ code: 'config-other-site', message: `the deployed config was generated for ${site}, not ${ev.site.registrableDomain}: its vendor list and gate rules describe another site.`, refs: dep.ref ? [dep.ref] : [], details: { generatedFor: site, scanned: ev.site.registrableDomain } });
    }
    if (!running && guard.ok) {
      findings.push({ code: 'tool-not-running', message: 'the config element is present and the guard accepts it, but the store never started in any scenario (ComplyKit.get() returned null): the script did not run — a blocked or wrong script URL, a CSP, or an error before init.', refs: seen.map((s) => `/locations/${s.li}/scenarios/${s.si}/complykit`) });
    }
  }

  // --- install diagnostics ---
  for (const s of seen) {
    const ref = `/locations/${s.li}/scenarios/${s.si}/complykit/diagnostics`;
    const gtm = s.snap.diagnostics?.gtm;
    if (gtm && gtm.orderOk === false && !findings.some((f) => f.code === 'tool-after-gtm')) {
      findings.push({
        code: 'tool-after-gtm',
        message: `the consent tool ran after Google Tag Manager (${[gtm.containersLoadedBefore.length ? `container ${gtm.containersLoadedBefore.join(', ')} already loaded` : '', gtm.gtmEventBefore ? 'the gtm.js event was already queued' : '', gtm.containerScriptsBefore.length ? 'a gtm.js script sits above it' : ''].filter(Boolean).join('; ')}): the Consent Mode defaults were set too late, and tags that fired on load ignored them. Move the tool’s <script> above the GTM snippet, in <head>.`,
        refs: [`${ref}/gtm`],
        details: { containersLoadedBefore: gtm.containersLoadedBefore, gtmEventBefore: gtm.gtmEventBefore, containerScriptsBefore: gtm.containerScriptsBefore, warnings: gtm.warnings },
      });
    }
    const ui = s.snap.diagnostics?.ui;
    if (ui?.state === 'failed' && !findings.some((f) => f.code === 'ui-not-loaded')) {
      findings.push({ code: 'ui-not-loaded', message: `the banner file did not load (${ui.error ?? 'failed'}): no choice can be made, the defaults stand — under opt-in rules nothing non-necessary ever runs, and no withdrawal entry point exists.`, refs: [`${ref}/ui`], details: { url: ui.url, error: ui.error } });
    }
  }
  if (config?.gtm && running && !seen.some((s) => s.snap.diagnostics?.gtm)) notTested.push('the GTM bridge wrote no diagnostics although the config has a gtm section (load order vs GTM not checked)');

  // --- regime the tool decided vs the location's rules ---
  for (const l of ev.locations) {
    if (l.verification.verdict !== 'verified') continue;
    const law = regimeOf(l.verification.jurisdictions, ev.startedAt?.slice(0, 10));
    if (law === 'unknown') continue;
    const s = seen.find((x) => x.location === l.spec.id && x.snap.state?.regime);
    const decided = s?.snap.state?.regime;
    if (!decided || !(decided in STRICTNESS)) continue;
    if (STRICTNESS[decided] < STRICTNESS[law]) {
      findings.push({
        code: 'regime-mismatch',
        message: `from ${l.spec.label ?? l.spec.id} the tool decided “${decided}” (source: ${s?.snap.diagnostics?.location?.source ?? 'not reported'}) but the location’s rules are “${law}”: the defaults it applied are less strict than the law there. Check regimeSource (a header endpoint that does not answer falls back to opt-in; a fixed regime applies everywhere).`,
        refs: [`/locations/${s!.li}/scenarios/${s!.si}/complykit/state`],
        details: { location: l.spec.id, decided, law },
      });
    }
  }

  // --- gate rules never rewritten (served HTML, A1) ---
  if (config) {
    const gateable = (ev.markup?.findings ?? []).map((f, i) => ({ f, ref: `/markup/findings/${i}` })).filter(({ f }) => f.kind === 'script' && f.verdict === 'gateable' && f.url);
    const selectorRules = config.gate.filter((g) => !g.src && g.selector).length;
    if (selectorRules) notTested.push(`${selectorRules} gate rule(s) match by selector: not checked against the served HTML (only src rules are)`);
    if (!ev.markup || !ev.markup.pages.some((p) => p.status === 'inspected')) {
      if (config.gate.length) notTested.push('whether the gate rules’ scripts were rewritten (the served HTML was not inspected)');
    } else {
      for (const g of config.gate) {
        if (!g.src) continue;
        let re: RegExp;
        try {
          re = new RegExp(g.src);
        } catch {
          notTested.push(`gate rule ${g.src} is not a valid pattern — not checked`);
          continue;
        }
        const hits = gateable.filter(({ f }) => re.test(f.url!));
        if (!hits.length) continue;
        const vendor = g.vendor ? config.vendors.find((v) => v.id === g.vendor) : undefined;
        findings.push({
          code: 'gate-rule-unrewritten',
          message: `${vendor?.label ?? hits[0].f.label}: the config gates it (${g.category}) but its <script> is still executable in the served HTML at ${hits.map(({ f }) => `${shortPage(f.page)}:${f.line}`).join(', ')} — never rewritten to type="text/plain" data-category="${g.category}". The browser runs it before the tool can hold it.`,
          refs: hits.map((h) => h.ref),
          details: { category: g.category, src: g.src, vendor: g.vendor, pages: hits.map(({ f }) => ({ page: f.page, line: f.line, url: f.url })) },
        });
      }
    }
  }

  // --- gated snippets that call document.write (D4 review): not gateable asynchronously ---
  if (config && ev.markup) {
    const writes = ev.markup.findings
      .map((f, i) => ({ f, ref: `/markup/findings/${i}` }))
      .filter(({ f }) => f.kind === 'script' && f.documentWrite && f.verdict === 'held' && f.attributes['data-category'] !== undefined);
    if (writes.length) {
      findings.push({
        code: 'gated-document-write',
        message: `${[...new Set(writes.map(({ f }) => f.label))].join(', ')}: the gated snippet calls document.write (${writes.map(({ f }) => `${shortPage(f.page)}:${f.line}`).join(', ')}). The tool releases it after the page is parsed, where document.write is ignored or replaces the whole page — the tag silently does nothing, or breaks the page. Not gateable asynchronously: ask the vendor for an async snippet, or leave it out and record the decision.`,
        refs: writes.map((w) => w.ref),
        details: { tags: writes.map(({ f }) => ({ partyId: f.partyId, page: f.page, line: f.line, category: f.attributes['data-category'] })) },
      });
    }
  }

  // --- vendors: expected control vs observed behavior ---
  const vendors: VendorControlProof[] = [];
  const observations = ev.behaviorObservations ?? [];
  const inventory = new Map(ev.inventory.map((p) => [p.partyId, p]));
  const skipped = new Set<string>();
  const obsByVendor = new Map<string, VendorControlObservation[]>();
  // Scope of what was compared (the headline's qualifier): locations, most pages, fewest visits per compared scenario.
  const comparedVisits = new Map<string, number>();
  let maxPages: number | undefined;
  // Unlisted trackers that ran where every non-necessary category was denied.
  const configIds = new Set(config?.vendors.map((v) => v.id) ?? []);
  const unlisted = new Map<string, { label: string; where: Set<string>; refs: Set<string> }>();
  if (config) {
    for (const l of ev.locations) {
      if (l.verification.verdict !== 'verified') {
        skipped.add(`${l.spec.id}: location not verified`);
        continue;
      }
      const law = regimeOf(l.verification.jurisdictions, ev.startedAt?.slice(0, 10));
      for (const s of l.scenarios) {
        if (s.status !== 'tested') {
          skipped.add(`${l.spec.id}/${s.scenario}: ${s.reason ?? s.status}`);
          continue;
        }
        const isChoice = CHOICE_SCENARIOS.has(s.scenario);
        if (isChoice && !s.choice?.ok) {
          skipped.add(`${l.spec.id}/${s.scenario}: the visitor choice was not confirmed (${s.choice?.method ?? 'no choice recorded'})`);
          continue;
        }
        const snap = s.complykit;
        // Our tool is driven by its own hooks only; a choice made some other way is not evidence about it.
        if (isChoice && snap?.running && !/complykit/.test(s.choice?.method ?? '')) {
          skipped.add(`${l.spec.id}/${s.scenario}: the choice was not made through the tool’s own controls (${s.choice?.method ?? 'none'})`);
          continue;
        }
        const regime = (snap?.running && snap.state?.regime && snap.state.regime in STRICTNESS ? snap.state.regime : law) as Regime | 'unknown';
        if (regime === 'unknown') {
          skipped.add(`${l.spec.id}/${s.scenario}: no regime (the tool did not report one and the location’s rules are unknown)`);
          continue;
        }
        const visits = observations.map((o, i) => ({ o, i })).filter(({ o }) => o.location === l.spec.id && o.scenario === s.scenario && o.durationMs > 0);
        if (!visits.length) {
          skipped.add(`${l.spec.id}/${s.scenario}: per-item observations are missing`);
          continue;
        }
        comparedVisits.set(`${l.spec.id}/${s.scenario}`, visits.length);
        for (const { o } of visits) if (typeof o.pages === 'number') maxPages = Math.max(maxPages ?? 0, o.pages);
        const phases = SCENARIO_PHASES[s.scenario] ?? PRE_CHOICE;
        // Phase sets compared in this scenario: the scenario's own, and (choice scenarios) the time before the choice.
        const windows: Array<{ phases: Phase[]; beforeChoice: boolean }> = [{ phases, beforeChoice: false }, ...(isChoice ? [{ phases: PRE_CHOICE, beforeChoice: true }] : [])];

        // Unlisted trackers: all-denied windows only (after reject / withdraw; before any choice under opt-in).
        const deniedAll = [...(REFUSED_SCENARIOS.has(s.scenario) ? phases : []), ...(regime === 'opt-in' && (isChoice || !SCENARIO_PHASES[s.scenario]) ? PRE_CHOICE : [])];
        if (deniedAll.length) {
          for (const { o, i } of visits) {
            for (const f of o.parties) {
              if (configIds.has(f.partyId)) continue;
              const p = inventory.get(f.partyId);
              if (!p || !p.recognized || p.categories.includes('tag-manager')) continue;
              const scope = purposeScopeOf(p.categories);
              if (!(scope === 'needs-consent' || (scope === 'unclassified' && p.behavesLikeTracker))) continue;
              const req = deniedAll.reduce((n, ph) => n + (f.dataRequestPhases[ph] ?? 0) - (f.limitedRequestsByPhase[ph] ?? 0), 0);
              const st = f.stores.filter((x) => x.writePhases.some((ph) => deniedAll.includes(ph as Phase))).length;
              if (req <= 0 && st === 0) continue;
              const u = unlisted.get(f.partyId) ?? { label: p.label, where: new Set<string>(), refs: new Set<string>() };
              u.where.add(`${l.spec.id}/${s.scenario}${o.run && o.run > 1 ? `#${o.run}` : ''}`);
              u.refs.add(`/behaviorObservations/${i}`);
              unlisted.set(f.partyId, u);
            }
          }
        }

        // The tool decided a weaker regime than the law here: each visit is ALSO judged against the law (a vendor the
        // tool's setting grants but the law expects denied, that ran, is not controlled).
        const lawWeaker = regime !== law && law !== 'unknown' && regime in STRICTNESS && STRICTNESS[regime] < STRICTNESS[law] ? (law as Regime) : undefined;
        for (const v of config.vendors) {
          const party = inventory.get(v.id);
          for (const win of windows) {
            const expectedUnder = (r: Regime): boolean | undefined => (win.beforeChoice ? (v.category === NECESSARY_CATEGORY ? true : consentCategoryDefault(config, v.category, r)) : expectedGrantedFor(config, v.category, r, s.scenario, snap?.state?.gpc === true));
            const expected = expectedUnder(regime);
            if (expected === undefined) continue;
            const byLaw = lawWeaker && expected ? expectedUnder(lawWeaker) : undefined;
            const lawDenies = byLaw === false;
            const when = win.phases.map((ph) => PHASE_LABEL[ph]).join(' / ');
            for (const { o, i } of visits) {
              const facts = o.parties.find((f) => f.partyId === v.id);
              if (!facts && party?.recognized && !o.knownPartyIds.includes(v.id)) {
                skipped.add(`${l.spec.id}/${s.scenario}: ${v.label} could not be matched to the evidence classifier`);
                continue;
              }
              const sum = (rec: Record<string, number> | undefined): number => win.phases.reduce((n, ph) => n + (rec?.[ph] ?? 0), 0);
              const requests = facts ? sum(facts.dataRequestPhases) : 0;
              const limited = facts ? sum(facts.limitedRequestsByPhase) : 0;
              const stores = facts ? facts.stores.filter((st) => st.writePhases.some((ph) => win.phases.includes(ph as Phase))).length : 0;
              // No facts = the party made no request at all in this visit: zero loads. Facts from a record that did not count loads: unknown.
              const loads = !facts ? 0 : facts.loadRequestsByPhase ? sum(facts.loadRequestsByPhase) : undefined;
              const grace = facts ? graceCount(facts, win.phases) : 0;
              const observed: VendorControlObservation['observed'] =
                requests === 0 && stores === 0 ? (loads ? 'loaded' : 'held') : requests > 0 && limited === requests && stores === 0 ? 'restricted' : 'fired';
              // Nothing (or only a load) before the choice in a granted state adds nothing a held after-choice visit does not;
              // only record it when it ran, it is the denied side, or the law denies it there.
              if (win.beforeChoice && expected && !lawDenies && (observed === 'held' || observed === 'loaded')) continue;
              const journey = journeyOf(o.journey, win.phases);
              const graceNote = grace ? `; ${grace} request(s) sent on the choice’s page within ${WITHDRAW_GRACE_MS / 1000} s of the choice, or as page-exit sends while it reloaded, not counted (data the vendor had queued when told)` : '';
              (obsByVendor.get(v.id) ?? obsByVendor.set(v.id, []).get(v.id)!).push({
                location: l.spec.id,
                scenario: s.scenario,
                ...(o.run !== undefined ? { run: o.run } : {}),
                regime,
                expectedGranted: expected,
                observed,
                requests,
                stores,
                ...(loads !== undefined ? { loads } : {}),
                ...(journey ? { journey } : {}),
                ...(grace ? { graceRequests: grace } : {}),
                ...(byLaw !== undefined ? { lawRegime: lawWeaker, expectedGrantedByLaw: byLaw } : {}),
                note:
                  (observed === 'held'
                    ? `nothing recorded ${when}${loads === undefined ? ' (script loads were not counted in this record)' : ''}`
                    : observed === 'loaded'
                      ? `${loads} request(s) loading its script / resources, no data sent, nothing stored ${when}`
                      : observed === 'restricted'
                        ? `${requests} consent-denied / restricted-mode request(s) only ${when}`
                        : `${requests} data request(s)${stores ? ` and ${stores} storage write(s)` : ''} ${when}`) + graceNote,
                ref: `/behaviorObservations/${i}`,
                ...(win.beforeChoice ? { beforeChoice: true } : {}),
              });
            }
          }
        }
      }
    }
    for (const v of config.vendors) {
      const party = inventory.get(v.id);
      const impl = party?.implementation;
      const unattributable = impl ? [impl.class, ...impl.alsoSeen].find((c) => c === 'cname' || c === 'server-side-suspected') : undefined;
      vendors.push(decideVendor(v, party !== undefined, obsByVendor.get(v.id) ?? [], unattributable));
    }
  }
  const totals = { controlled: vendors.filter((v) => v.result === 'controlled').length, notControlled: vendors.filter((v) => v.result === 'not-controlled').length, notObserved: vendors.filter((v) => v.result === 'not-observed').length };
  const notControlled = vendors.filter((v) => v.result === 'not-controlled');
  if (notControlled.length) {
    findings.push({
      code: 'vendor-not-controlled',
      message: `${notControlled.length} vendor(s) the config lists ran where it denies their category: ${notControlled.map((v) => `${v.label} (${v.category}, control: ${v.control})`).join(', ')}. The config says one thing; the site does another.`,
      refs: notControlled.map((v) => `/consentToolProof/vendors/${vendors.indexOf(v)}`),
    });
  }
  if (unlisted.size) {
    const xs = [...unlisted.entries()];
    findings.push({
      code: 'vendor-not-in-config',
      message: `${xs.length} tracker(s) the deployed config does not list ran where every non-necessary category was denied: ${xs.map(([, u]) => `${u.label} (${[...u.where].join(', ')})`).join('; ')}. The tool cannot hold what its config does not name — classify them in the site workspace, regenerate and redeploy (or find what loads them outside the tool).`,
      refs: [...new Set(xs.flatMap(([, u]) => [...u.refs]))],
      details: { parties: xs.map(([id, u]) => ({ id, label: u.label, where: [...u.where] })) },
    });
  }
  // GPC: the scenario sends the signal; a running tool must have recorded it.
  for (const l of ev.locations) {
    const s = l.scenarios.find((x) => x.scenario === 'gpc' && x.status === 'tested');
    if (s?.complykit?.running && s.complykit.state && s.complykit.state.gpc !== true) {
      const li = ev.locations.indexOf(l);
      findings.push({ code: 'gpc-not-honored', message: `from ${l.spec.label ?? l.spec.id} the visit sent Global Privacy Control, but the running tool’s state did not record it (gpc: false): every non-necessary category should have defaulted to denied.`, refs: [`/locations/${li}/scenarios/${l.scenarios.indexOf(s)}/complykit/state`], details: { location: l.spec.id } });
    }
  }
  // Necessary vendors that look like trackers (D2 review concern).
  if (config) {
    for (const v of config.vendors) {
      if (v.category !== NECESSARY_CATEGORY) continue;
      const p = inventory.get(v.id);
      if (!p) continue;
      const why = p.behavesLikeTracker ? `behaved like a tracker (${p.trackerSignals.join(', ')})` : purposeScopeOf(p.categories) === 'needs-consent' ? `is classified ${p.categories.join(', ')}` : undefined;
      if (why) findings.push({ code: 'necessary-tracker', message: `${v.label} is listed as necessary — never held back, no toggle — but ${why}. Classify it in the site workspace and regenerate; a tracker under "necessary" is the one setting no consent tool can defend.`, refs: [`/inventory/${ev.inventory.indexOf(p)}`], details: { vendor: v.id } });
    }
  }
  // Not in the inventory: the config names it, the scan never saw it.
  const unseen = vendors.filter((v) => !v.seen);
  if (unseen.length) notTested.push(`${unseen.length} vendor(s) in the config were not seen at all in this scan (${unseen.map((v) => v.label).join(', ')}): removed from the site, held in every scenario, or on pages not visited`);
  notTested.push(...[...skipped].sort().map((s) => `not compared — ${s}`));
  if (config?.vendors.some((v) => v.control === 'api')) notTested.push('vendors controlled through a consent API: whether the vendor honored the call is judged by its requests and storage only (what it does server-side is not observable)');
  if (ev.locations.some((l) => l.scenarios.some((s) => s.scenario === 'opt-out-link' && s.status === 'tested'))) notTested.push('the opt-out-link scenario walks the site’s own link; it is not compared with the config');

  const driven: ConsentToolProof['driven'] = [];
  for (const l of ev.locations) for (const s of l.scenarios) if (s.choice && /complykit/.test(s.choice.method)) driven.push({ location: l.spec.id, scenario: s.scenario, choice: s.choice.kind, ok: s.choice.ok, method: s.choice.method });

  const scope = comparedVisits.size ? { ...(maxPages !== undefined ? { pages: maxPages } : {}), locations: new Set([...comparedVisits.keys()].map((k) => k.split('/')[0])).size, runs: Math.min(...comparedVisits.values()) } : undefined;
  return { detected: true, ...(version ? { version } : {}), seenIn, config: cfgOut, vendors, totals, findings, driven, notTested: [...new Set(notTested)], ...(scope ? { scope } : {}) };
}

/** A restricted-mode-only visit in a denied state passes only for a consent-API vendor outside opt-in (design §9.3: under opt-in the API is additive to gating, never instead). */
function restrictedPasses(control: string, regime: string): boolean {
  return control === 'api' && regime !== 'opt-in';
}

/**
 * A load-only visit (the vendor's script / iframe / pixel, no data, nothing
 * stored) in a denied state: 'fail' for a gate (preventing the load is the
 * gate's whole job) and for a consent API under opt-in (§9.3: the tag must be
 * held there); 'pass' for an API or platform bridge outside opt-in (the script
 * is meant to load and be told); 'unproven' otherwise (a platform bridge under
 * opt-in, no control): neither held nor shown running.
 */
function loadedVerdict(control: string, regime: string): 'fail' | 'pass' | 'unproven' {
  if (control === 'gate') return 'fail';
  if (control === 'api') return regime === 'opt-in' ? 'fail' : 'pass';
  if (control === 'platform' && regime !== 'opt-in') return 'pass';
  return 'unproven';
}

/** Did this denied-state visit (under `regime`) show the vendor active where it must not be? */
function deniedFails(o: VendorControlObservation, control: string, regime: string): boolean {
  if (o.observed === 'fired') return true;
  if (o.observed === 'restricted') return !restrictedPasses(control, regime);
  if (o.observed === 'loaded') return loadedVerdict(control, regime) === 'fail';
  return false;
}

/** Granted by the tool's (weaker) setting, denied by the location's law. */
const lawDenied = (o: VendorControlObservation): boolean => o.expectedGranted && o.expectedGrantedByLaw === false;

/** Journey parity: did the denied visit walk at least the granted visit's steps (search, navigation) and as many pages? */
function covers(denied: VendorControlObservation['journey'], granted: VendorControlObservation['journey']): boolean {
  if (!denied || !granted) return false;
  return granted.steps.filter((x) => x === 'search' || x === 'navigate').every((x) => denied.steps.includes(x)) && denied.pages >= granted.pages;
}

const journeyWords = (j: VendorControlObservation['journey']): string => (j ? `${j.pages} page(s)${j.steps.includes('search') ? ', site search' : ', no site search'}` : 'journey not recorded');

function decideVendor(v: ConsentToolConfig['vendors'][number], seen: boolean, obs: VendorControlObservation[], unattributable?: string): VendorControlProof {
  const base = { id: v.id, label: v.label, category: v.category, control: v.control, seen, observations: obs };
  const says = v.control === 'none' ? ' (the config itself lists no control for it)' : '';
  if (v.category === NECESSARY_CATEGORY) return { ...base, result: 'not-observed', reason: 'listed as necessary: never held back by design, so nothing is proved either way' };
  const denied = obs.filter((o) => !o.expectedGranted);
  const granted = obs.filter((o) => o.expectedGranted && !lawDenied(o));
  const where = (xs: VendorControlObservation[]): string => [...new Set(xs.map((o) => `${o.location}/${o.scenario}${o.beforeChoice ? ' (before the choice)' : ''}${o.run && o.run > 1 ? `#${o.run}` : ''}`))].join(', ');
  const fired = denied.filter((o) => o.observed === 'fired');
  if (fired.length) return { ...base, result: 'not-controlled', reason: `ran where the config denies ${v.category}: ${where(fired)}${says}` };
  const restricted = denied.filter((o) => o.observed === 'restricted');
  const restrictedBad = restricted.filter((o) => !restrictedPasses(v.control, o.regime));
  if (restrictedBad.length) {
    const why = v.control === 'api' ? 'under opt-in rules the load must be held, not only told through the consent API (cookieless pings are still requests before consent)' : 'the script ran; only its own consent default limited it, not the tool';
    return { ...base, result: 'not-controlled', reason: `loaded and sent restricted-mode requests where the config denies ${v.category} (${where(restrictedBad)}): ${why}${says}` };
  }
  const loaded = denied.filter((o) => o.observed === 'loaded');
  const loadedBad = loaded.filter((o) => loadedVerdict(v.control, o.regime) === 'fail');
  if (loadedBad.length) {
    const why = v.control === 'gate' ? 'nothing was sent, but a gate exists to prevent the load itself — the visitor’s browser still contacted the vendor' : 'under opt-in rules the tag must be held, not only told through the consent API';
    return { ...base, result: 'not-controlled', reason: `its script / resources loaded where the config denies ${v.category} (${where(loadedBad)}): ${why}${says}` };
  }
  // The tool decided a weaker regime than the law: granted by its setting, denied by the law — and active.
  const lawBad = obs.filter((o) => lawDenied(o) && deniedFails(o, v.control, o.lawRegime!));
  if (lawBad.length) {
    const o = lawBad[0];
    return { ...base, result: 'not-controlled', reason: `ran where the location’s “${o.lawRegime}” rules expect ${v.category} denied (${where(lawBad)}); the tool decided the weaker “${o.regime}” setting, under which the config grants it${says}` };
  }
  const ranWhenGranted = granted.filter((o) => o.observed === 'fired');
  // The held side of a pass needs a whole denied-state visit: the moments before a
  // choice can be short (a script may simply not have loaded yet), so they can fail
  // a vendor but never pass one. A visit whose loads were not counted, or whose
  // load-only result is not proof (a platform bridge under opt-in), is not held.
  const wholeDenied = denied.filter((o) => !o.beforeChoice);
  const heldVisits = wholeDenied.filter((o) => (o.observed === 'held' && o.loads !== undefined) || ((o.observed === 'restricted' || o.observed === 'loaded') && !deniedFails(o, v.control, o.regime) && (o.observed === 'restricted' || loadedVerdict(v.control, o.regime) === 'pass')));
  const unproven = wholeDenied.filter((o) => !heldVisits.includes(o));
  if (heldVisits.length && ranWhenGranted.length) {
    const loadOnly = heldVisits.filter((o) => o.observed === 'loaded');
    const held = `held in ${heldVisits.length} denied-state visit(s) (${where(heldVisits)})${restricted.length ? ', restricted-mode pings only in ' + where(restricted) : ''}${loadOnly.length ? `, its script loaded but sent nothing in ${where(loadOnly)}` : ''}; ran when granted (${where(ranWhenGranted)})`;
    // Fail closed: nothing in the config holds it, or its requests may not be attributed to it.
    if (v.control === 'none') return { ...base, result: 'not-observed', reason: `${held} — but the config lists no control for it, so what held it is not established (it may fire only on actions or pages this scan did not repeat in every state)` };
    if (unattributable) return { ...base, result: 'not-observed', reason: `${held} — but it is implemented through ${unattributable === 'cname' ? 'a first-party DNS alias' : 'suspected server-side forwarding'}: its requests may not be attributed to it, so “nothing recorded” does not prove it was held` };
    // Journey parity: a vendor that fires only on an action (a search, a product page) proves nothing by staying
    // quiet in a visit that never took that action. Some held visit must have walked what the granted run walked.
    const parity = ranWhenGranted.filter((g) => heldVisits.some((d) => covers(d.journey, g.journey)));
    if (!parity.length) {
      return {
        ...base,
        result: 'not-observed',
        reason: `${held} — but no held visit walked the journey of a granted visit that ran it (granted: ${ranWhenGranted.map((g) => `${where([g])}: ${journeyWords(g.journey)}`).join('; ')}; held: ${heldVisits.map((d) => `${where([d])}: ${journeyWords(d.journey)}`).join('; ')}): a vendor that fires only on an action or page the held visits did not repeat would look the same`,
      };
    }
    return { ...base, result: 'controlled', reason: held };
  }
  if (heldVisits.length) return { ...base, result: 'not-observed', reason: `held in ${heldVisits.length} denied-state visit(s) (${where(heldVisits)}) but never seen running in a granted state${granted.length ? ` (${where(granted)})` : ' (none tested)'}: removed from the site, or never released — holding nothing proves nothing` };
  if (unproven.length) {
    const notCounted = unproven.filter((o) => o.observed === 'held');
    return {
      ...base,
      result: 'not-observed',
      reason: notCounted.length
        ? `nothing recorded in ${where(notCounted)}, but this record did not count script loads, so “held” is not established (a gated vendor must not even load) — rescan`
        : `its script loaded but sent nothing in ${where(unproven)}: under ${unproven[0].regime} rules a ${v.control === 'platform' ? 'platform bridge' : v.control} control that lets the script load is neither held nor shown running`,
    };
  }
  return { ...base, result: 'not-observed', reason: granted.length ? `no tested scenario put ${v.category} in a denied state for a whole visit (only granted-state visits: ${where(granted)}${denied.length ? `; held before the choice in ${where(denied)}, which alone proves nothing` : ''})` : 'no scenario could be compared' };
}

/** Behavior-mismatch cells for the compatibility verdict: a vendor that was active where the deployed config (or, under a weaker tool regime, the law) denies its category. */
export function configBehaviorCells(proof: ConsentToolProof | undefined): BehaviorCell[] {
  if (!proof?.detected) return [];
  const out: BehaviorCell[] = [];
  for (const v of proof.vendors) {
    for (const o of v.observations) {
      const byLaw = lawDenied(o);
      if (o.expectedGranted && !byLaw) continue;
      if (!deniedFails(o, v.control, byLaw ? o.lawRegime! : o.regime)) continue;
      out.push({
        partyId: v.id,
        location: o.location,
        scenario: o.scenario,
        ...(o.run !== undefined ? { run: o.run } : {}),
        status: 'mismatch',
        reason: byLaw
          ? `ran where the location’s ${o.lawRegime} rules deny ${v.category}; the deployed complykit config grants it only under the weaker ${o.regime} setting the tool decided${o.beforeChoice ? ' (before the choice)' : ''} (${o.note ?? 'active'})`
          : `ran where the deployed complykit config denies ${v.category} under ${o.regime} rules${o.beforeChoice ? ' (before the choice)' : ''} (${o.note ?? 'active'})`,
        ...(o.ref ? { ref: o.ref } : {}),
      });
    }
  }
  return out;
}

/** The journey over a window's phases: distinct pages, union of steps. undefined when the record has none. */
function journeyOf(j: Record<string, { pageIndexes: number[]; steps: string[] }> | undefined, phases: readonly string[]): VendorControlObservation['journey'] {
  if (!j) return undefined;
  const pages = new Set<number>();
  const steps = new Set<string>();
  for (const ph of phases) {
    for (const p of j[ph]?.pageIndexes ?? []) pages.add(p);
    for (const st of j[ph]?.steps ?? []) steps.add(st);
  }
  return { pages: pages.size, steps: [...steps].sort() };
}

function shortPage(page: string): string {
  try {
    const u = new URL(page);
    return `${u.pathname}${u.search}` || '/';
  } catch {
    return page;
  }
}
