import type {
  CompatibilityChange,
  CompatibilityReason,
  CompatibilitySection,
  ConsentApiName,
  ConsentApiObservation,
  ConsentToolDefaultFinding,
  ContainerTag,
  ImplementationEvidence,
  LocationSummary,
  MarkupFinding,
  MarkupSection,
  PartyCompatibility,
  PartyInventoryItem,
  PlatformFingerprint,
  TagContainer,
  TrackingEvaluation,
} from '../../record/index.js';
import { DEFAULT_KB, hostOf, regimeForCodes, lookupEntry, type KnowledgeBase, type KnowledgeEntry, type TagControl } from '../../registry/index.js';
import { PHASE_LABEL, WITHDRAW_GRACE_MS, graceCount, type Phase } from './analyze.js';
import { GOOGLE_TAG_SETTINGS_FOR, googleTagIdOf, googleTagSettingOn } from './implementation.js';

// The compatibility verdict (plans/client-consent-design.md §5; ticket B1):
// per tool, can a consent tool control it, and what has to change. Pure, over
// the evaluation record's other sections. Conservative by construction — a
// wrong 'gateable' is a false pass in a litigated area — so every rule below
// fails closed: missing evidence weakens a verdict, never strengthens it.
//
// Decision table (implementation class → verdict; design §3 numbering):
//
//   markup-leak (#2)             → uncontrollable. Change: remove-leak per element
//                                  (page:line), then whatever the script copy
//                                  needs (rewrite-tag / gate-gtm-tag from alsoSeen).
//                                  Runtime-only with no initiator at all (no URL,
//                                  no element located) → unknown: a redirect hop or
//                                  a script-created image looks the same.
//   cname (#6)                   → uncontrollable. Change: change-dns; rewrite-tag
//                                  for any gateable tag (the script can be gated,
//                                  the cookies it set stay first-party).
//   server-side-suspected (#7)   → uncontrollable. Change: accepted-exposure (a
//                                  browser cannot verify or stop it).
//                                  Loaded inside a third-party <iframe> that IS
//                                  located in the HTML (YouTube's fonts, images,
//                                  scripts) → uncontrollable, folded under the
//                                  iframe's party: no change of its own (removing
//                                  or gating the iframe removes it), a reason
//                                  pointing at that iframe's page:line.
//   gtm (#3)                     → tag-manager. A tag counts as GATED only when
//                                  the container was parsed AND the tag carries
//                                  'required' consent AND a denied, non-regional
//                                  Consent Mode default covering every required
//                                  type was observed (A3) with no default-after-
//                                  load / grant-on-load state for Google. GTM
//                                  treats never-set types as granted, so
//                                  'required' alone proves nothing. Every other
//                                  tag: gate-gtm-tag; no default observed:
//                                  set-consent-default; container unreadable /
//                                  not fetched / no tag mapped: gate-gtm-tag
//                                  without a tag id ("verify in the UI").
//   other-tag-manager (#4)       → tag-manager. Change: configure-tag-manager
//                                  (internals not readable here).
//   platform (#5)                → platform when the platform is named; change:
//                                  use-platform-api. Unnamed → unknown.
//   direct-script (#1)           → gateable ONLY with a 'gateable' markup finding
//                                  for the party and no 'leak' finding; change:
//                                  rewrite-tag per finding. HTML not inspected,
//                                  only 'held' tags, or no tag located → unknown.
//                                  GTM tags for the same party (alsoSeen gtm) add
//                                  their gate-gtm-tag changes and cap the verdict
//                                  at tag-manager: the HTML copy alone is not all.
//     the Google tag path        A party injected by a Google tag (gtag.js?id=G-/
//                                  AW-/GT-/DC-) whose <script> IS located in the
//                                  HTML → tag-manager (never gateable: the located
//                                  tag is the Google tag's, not the party's). The
//                                  Google tag is a container with no per-tag
//                                  "require consent" setting — its destinations
//                                  carry built-in checks only and fire regardless —
//                                  so A6 keeps the class of the path gtag.js came
//                                  by (direct-script here, gtm when GTM injected
//                                  it) and B1 lists what controls it: a denied
//                                  Consent Mode default in the snippet before
//                                  gtag('config') (set-consent-default, page:line
//                                  of the snippet), and the tag's settings that
//                                  send beyond the destination — Google signals,
//                                  the Ads link, automatic user-provided data,
//                                  DMA default granted (configure-tag-manager,
//                                  manager 'Google tag'). Not located → unknown,
//                                  with the same changes plus needs-a-look.
//     a destination GTM loads     A G-/AW-/DC- destination loaded by a GTM
//     from gtag('config')          container (gtag/js?id=…&cx=c) because the page
//                                  pushes gtag('config', id) into the dataLayer,
//                                  with every GTM container parsed and no tag in
//                                  them naming the id (nor a Google tag with an
//                                  unresolved id / a Custom HTML tag for the
//                                  party): there is no tag to gate, so no
//                                  gate-gtm-tag. Change: rewrite-tag on the
//                                  config snippet (the inline or data: URL script
//                                  whose body names the id; destinationId + why),
//                                  needs-a-look when it is not located, and the
//                                  consent default. Verdict stays tag-manager.
//   unknown                      → unknown. Change: needs-a-look.
//
// Purpose (purposeScopeOf, the matrix's groups): 'not-required' (necessary,
// cdn, captcha, payments, consent only) keeps its verdict as a description and
// lists NO change; 'unclassified' and 'context' keep changes with the condition
// stated in a reason.
//
// Additive, for any controllable verdict: call-consent-api when the vendor
// documents one (locked decision §9.3: alongside gating, never instead), and
// the A3 states for that vendor's API (not-called-after-refusal → call it;
// grant-on-load → stop granting; default-after-load → set-consent-default).
//
// Identical changes (same kind, page:line, element, container/tag and note) are
// listed once; several elements on one line say so in the note.
//
// Behavior outranks implementation (locked decision §9.1): a behavior mismatch
// in any tested location × scenario sets behaviorMismatch and puts a
// 'behavior-mismatch' change first. A verdict is where to fix; the mismatch is
// that it is not fixed. Where behavior could not be compared (unverified
// location, unknown regime, unclassified purpose, scenario not run),
// behaviorChecked is false and a reason says so — never a pass.

export interface BehaviorCell {
  partyId: string;
  location: string;
  scenario: string;
  run?: number;
  // mismatch              — active when the expectation was "off"
  // no-mismatch-observed  — nothing contradicted the expectation (not "clean":
  //                         capture limits are the matrix's to qualify)
  // not-established       — could not be compared
  status: 'mismatch' | 'no-mismatch-observed' | 'not-established';
  reason: string;
  ref?: string;
}

export interface CompatibilityInput {
  markup?: MarkupSection;
  containers?: TagContainer[];
  consentApi?: ConsentApiObservation[];
  platform?: Pick<PlatformFingerprint, 'name' | 'consentPlugin' | 'wpConsentApi'>;
  /** Behavior comparison cells for every party (see behaviorCellsFrom). */
  behavior?: BehaviorCell[];
  kb?: KnowledgeBase;
  /** Position of the party in the inventory, for evidence refs. */
  partyIndex?: number;
  /** Privacy regime per location id (from the verified jurisdictions), to qualify grant-on-load changes. */
  regimes?: Record<string, 'opt-in' | 'opt-out-signal' | 'opt-out' | 'unknown'>;
}

// --- Vendor consent APIs (A8 → A3) -------------------------------------------------

/** Which recorded consent API a party's control facts refer to. */
const PARTY_API: Array<{ test: RegExp; api: ConsentApiName }> = [
  { test: /^google\.(analytics|ads\.ccm|ads\.doubleclick|tag-manager)$/, api: 'google' },
  { test: /^meta\.pixel$/, api: 'meta' },
  { test: /^tiktok\.pixel$/, api: 'tiktok' },
  { test: /^microsoft\.clarity$/, api: 'clarity' },
  { test: /^microsoft\.uet$/, api: 'microsoft-uet' },
  { test: /^shopify\./, api: 'shopify' },
];

export function consentApiOf(partyId: string, entry?: Pick<KnowledgeEntry, 'decoder'>): ConsentApiName | undefined {
  const hit = PARTY_API.find((x) => x.test.test(partyId));
  if (hit) return hit.api;
  switch (entry?.decoder) {
    case 'google':
      return 'google';
    case 'meta':
      return 'meta';
    case 'tiktok':
      return 'tiktok';
    default:
      return undefined;
  }
}

/** Consent Mode types a GTM tag for this party should require, by category. */
export function consentTypesFor(categories: string[]): string[] {
  const out = new Set<string>();
  for (const c of categories) {
    if (['advertising', 'advertisement', 'identity-resolution', 'marketing-email', 'fingerprinting'].includes(c)) {
      out.add('ad_storage');
      out.add('ad_user_data');
      out.add('ad_personalization');
    } else if (['analytics', 'performance', 'session-recording', 'error-monitoring'].includes(c)) out.add('analytics_storage');
    else if (['functional', 'chat', 'embed', 'reviews', 'preferences', 'fonts'].includes(c)) out.add('functionality_storage');
  }
  return out.size ? [...out] : ['analytics_storage', 'ad_storage'];
}

const PLATFORM_API: Record<PlatformFingerprint['name'], { api: string; where: string }> = {
  shopify: { api: 'Shopify.customerPrivacy.setTrackingConsent (loadFeatures consent-tracking-api first)', where: 'Settings → Customer privacy (cookie banner, regions)' },
  wix: { api: 'Wix consentPolicy (window.consentPolicy / wixEmbedsAPI)', where: 'Settings → Privacy & cookies → cookie consent banner' },
  squarespace: { api: 'no page-level consent API documented: the Squarespace cookie banner setting', where: 'Settings → Cookies & visitor data' },
  wordpress: { api: 'WordPress Consent API (wp_set_consent / wp_has_consent) through the consent plugin', where: 'the consent plugin’s settings (the pixel plugin must read wp_has_consent)' },
};

// --- Behavior cells from the observations --------------------------------------------
//
// Mirrors the matrix's expectation table (src/report/consent-matrix.ts →
// cookie-purpose.ts compareCookieBehavior) for the one question this rule
// asks: was the party active where the location's rules expect it OFF? Kept
// narrower than the matrix on purpose: everything it cannot decide the same
// way is 'not-established', never a pass. rules/ may not import report/.

const CONSENT_CATEGORIES = new Set(['analytics', 'performance', 'advertising', 'advertisement', 'session-recording', 'identity-resolution', 'fingerprinting', 'marketing-email']);
// The matrix's "context" uses: allowed without consent under opt-in rules only
// when strictly needed for a feature the visitor asked for — a review there.
const CONTEXT_CATEGORIES = new Set(['functional', 'chat', 'embed', 'fonts', 'reviews', 'error-monitoring']);
// Infrastructure the site needs to work: no consent requirement to fix, so no
// change belongs in the owner's list (it would be noise, or worse — gating the
// consent tool itself, the captcha, the payment form).
const NOT_REQUIRED_CATEGORIES = new Set(['necessary', 'cdn', 'captcha', 'payments', 'consent']);

export type PurposeScope = NonNullable<PartyCompatibility['purpose']>;

/** Does this party's purpose need consent? Same groups as the matrix; anything unlisted is 'context'. */
export function purposeScopeOf(categories: readonly string[]): PurposeScope {
  if (!categories.length || categories.includes('unknown') || categories.includes('other')) return 'unclassified';
  if (categories.some((c) => CONSENT_CATEGORIES.has(c))) return 'needs-consent';
  if (categories.every((c) => NOT_REQUIRED_CATEGORIES.has(c))) return 'not-required';
  return 'context';
}
const SALE_SHARE_CATEGORIES = new Set(['advertising', 'advertisement', 'identity-resolution', 'marketing-email']);
const ANALYTICS_ONLY = new Set(['analytics', 'performance', 'error-monitoring']);
const CHOICE_SCENARIOS = new Set(['reject', 'accept', 'partial', 'withdraw', 'opt-out-all', 'opt-out-link']);
const REFUSED = new Set(['reject', 'withdraw', 'return-visit']);
const OPTED_OUT = new Set(['gpc', 'opt-out-all', 'opt-out-link']);
const SCENARIO_PHASES: Record<string, Phase[]> = {
  reject: ['after-reject'],
  'return-visit': ['after-reject'],
  withdraw: ['after-withdraw'],
  dismiss: ['after-dismiss'],
  accept: ['after-accept'],
  partial: ['after-partial'],
  'opt-out-link': ['after-opt-out-link'],
};
const PRE_CHOICE: Phase[] = ['no-banner', 'before-banner', 'before-choice'];

type Regime = 'opt-in' | 'opt-out-signal' | 'opt-out' | 'unknown';

/** The regime for a location's jurisdictions on a date (default today): the registry's shared rule, same as the matrix. */
export function regimeOf(jurisdictions: readonly string[], onDate: string = new Date().toISOString().slice(0, 10)): Regime {
  return regimeForCodes(jurisdictions, onDate, { unverifiedUs: 'baseline' });
}

/** Is the party expected OFF in this scenario under this regime? undefined = no expectation decidable here. */
function expectedOff(categories: string[], regime: Regime, scenario: string): boolean | undefined {
  if (!categories.length || categories.includes('unknown') || categories.includes('other') || regime === 'unknown') return undefined;
  const needsConsent = categories.some((c) => CONSENT_CATEGORIES.has(c));
  if (!needsConsent) return false;
  const saleShare = categories.some((c) => SALE_SHARE_CATEGORIES.has(c));
  const analyticsOnly = categories.every((c) => ANALYTICS_ONLY.has(c));
  if (regime === 'opt-in') {
    if (scenario === 'accept') return false;
    if (scenario === 'partial') return !analyticsOnly;
    return true;
  }
  if (REFUSED.has(scenario)) return true;
  if (OPTED_OUT.has(scenario) && saleShare && (regime === 'opt-out-signal' || scenario !== 'gpc')) return true;
  return false;
}

export function behaviorCellsFrom(ev: Pick<TrackingEvaluation, 'locations' | 'inventory' | 'behaviorObservations'> & Partial<Pick<TrackingEvaluation, 'startedAt'>>): BehaviorCell[] {
  const onDate = ev.startedAt?.slice(0, 10);
  const out: BehaviorCell[] = [];
  const observations = ev.behaviorObservations ?? [];
  for (const loc of ev.locations) {
    const verified = loc.verification.verdict === 'verified';
    const regime = regimeOf(loc.verification.jurisdictions, onDate);
    for (const sc of loc.scenarios) {
      const visits = observations.map((o, i) => ({ o, i })).filter(({ o }) => o.location === loc.spec.id && o.scenario === sc.scenario);
      const phases = SCENARIO_PHASES[sc.scenario] ?? PRE_CHOICE;
      for (const p of ev.inventory) {
        const base = { partyId: p.partyId, location: loc.spec.id, scenario: sc.scenario };
        const no = (reason: string, ref?: string): void => {
          out.push({ ...base, status: 'not-established', reason, ...(ref ? { ref } : {}) });
        };
        if (sc.status !== 'tested') {
          no(sc.reason ?? 'scenario not run');
          continue;
        }
        if (CHOICE_SCENARIOS.has(sc.scenario) && !sc.choice?.ok) {
          no('the required visitor choice was not confirmed');
          continue;
        }
        if (!verified) {
          no('the test location was not verified');
          continue;
        }
        const off = expectedOff(p.categories, regime, sc.scenario);
        if (off === undefined) {
          no(regime === 'unknown' ? 'no automatic expectation for this location' : 'the purpose is not classified');
          continue;
        }
        if (!visits.length) {
          no('per-item observations are missing');
          continue;
        }
        for (const { o, i } of visits) {
          const ref = `/behaviorObservations/${i}`;
          const cell = { ...base, ...(o.run !== undefined ? { run: o.run } : {}), ref };
          if (o.durationMs <= 0) {
            out.push({ ...cell, status: 'not-established', reason: 'per-item observations are missing' });
            continue;
          }
          const facts = o.parties.find((f) => f.partyId === p.partyId);
          if (!facts && p.recognized && !o.knownPartyIds.includes(p.partyId)) {
            out.push({ ...cell, status: 'not-established', reason: 'the saved tool identity could not be matched to the evidence classifier' });
            continue;
          }
          const requests = facts ? phases.reduce((n, ph) => n + (facts.dataRequestPhases[ph] ?? 0), 0) : 0;
          const limited = facts ? phases.reduce((n, ph) => n + (facts.limitedRequestsByPhase[ph] ?? 0), 0) : 0;
          const activeStores = facts ? facts.stores.filter((s) => s.presentAtEnd || s.writePhases.some((ph) => phases.includes(ph as Phase))) : [];
          const active = requests > 0 || activeStores.length > 0;
          const limitedOnly = requests > 0 && limited === requests && !activeStores.length;
          const when = phases.map((ph) => PHASE_LABEL[ph]).join(' / ');
          const context = !p.categories.some((c) => CONSENT_CATEGORIES.has(c)) && p.categories.some((c) => CONTEXT_CATEGORIES.has(c));
          if (!off && context && active && regime === 'opt-in' && !REFUSED.has(sc.scenario) && sc.scenario !== 'accept') {
            // The matrix marks this 'review': allowed only when strictly needed for a feature the visitor used.
            out.push({ ...cell, status: 'not-established', reason: `active ${when}; under opt-in rules a ${p.categories.join('/')} use runs without consent only when strictly needed for a feature the visitor used — not decided here` });
          } else if (!off) {
            out.push({ ...cell, status: 'no-mismatch-observed', reason: `may run in this scenario under ${regime} rules` });
          } else if (!active) {
            // Its own script / iframe / pixel loading with nothing sent (D10 follow-up): only for parties with a consent
            // purpose — a CDN or platform loader loading is not vendor activity. Kept consistent with the proof, which
            // fails a gated vendor for it: here (no control known) it is never a pass under opt-in, never a mismatch.
            const loads = facts?.loadRequestsByPhase ? phases.reduce((n, ph) => n + (facts.loadRequestsByPhase![ph] ?? 0), 0) : 0;
            const grace = facts ? graceCount(facts, phases) : 0;
            const graceNote = grace ? ` (${grace} request(s) sent on the choice’s page within ${WITHDRAW_GRACE_MS / 1000} s of the choice, or as page-exit sends while it reloaded, not counted (data the vendor had queued when told))` : '';
            if (loads > 0 && purposeScopeOf(p.categories) === 'needs-consent') {
              out.push(
                regime === 'opt-in'
                  ? { ...cell, status: 'not-established', reason: `its script / resources loaded (${loads} request(s)) ${when}, but no data was sent and nothing stored — under opt-in rules a vendor held for consent does not load at all (the visitor’s browser still contacted it); whether the load alone is processing is not decided here${graceNote}` }
                  : { ...cell, status: 'no-mismatch-observed', reason: `only its script / resources loaded (${loads} request(s)) ${when}; no data request or storage recorded${graceNote}` },
              );
            } else out.push({ ...cell, status: 'no-mismatch-observed', reason: `no data request or storage recorded ${when}${graceNote}` });
          } else if (limitedOnly) {
            out.push(
              regime === 'opt-in'
                ? { ...cell, status: 'not-established', reason: `only consent-denied / restricted-mode requests ${when}, nothing stored — contested in the EU/UK, not decided here` }
                : { ...cell, status: 'no-mismatch-observed', reason: `only restricted-mode requests ${when}, nothing stored` },
            );
          } else {
            out.push({
              ...cell,
              status: 'mismatch',
              reason: `${requests} data request(s)${activeStores.length ? ` and ${activeStores.length} cookie / storage item(s)` : ''} ${when}, where ${regime} rules expect it off`,
            });
          }
        }
      }
    }
  }
  return out;
}

// --- The consent tool's default (A4 → finding) ---------------------------------------

export function consentToolDefaultFinding(locations: LocationSummary[]): ConsentToolDefaultFinding {
  const observed: ConsentToolDefaultFinding['observed'] = [];
  const grants = new Set<string>();
  let vendor: string | null | undefined;
  let decodedAny = false;
  for (const loc of locations) {
    for (const sc of loc.scenarios) {
      const ct = sc.consentTool;
      if (!ct) continue;
      vendor ??= ct.vendor;
      if (!ct.decoded) continue;
      decodedAny = true;
      // A recorded choice is the visitor's, not a default (return visits carry one).
      if (ct.choiceRecorded === true) continue;
      const granted = Object.entries(ct.defaultGrants)
        .filter(([k, v]) => v && k !== 'necessary')
        .map(([k]) => k);
      if (!granted.length) continue;
      for (const g of granted) grants.add(g);
      observed.push({ location: loc.spec.id, scenario: sc.scenario, source: ct.source, grants: granted });
    }
  }
  if (observed.length) {
    return {
      status: 'grants-by-default',
      vendor,
      grants: [...grants],
      observed,
      note: `${vendor ?? 'the consent tool'} stores a default on a fresh profile that grants ${[...grants].join(', ')} before any choice (${observed.map((o) => `${o.location}:${o.scenario}`).join(', ')}). Tags in those categories run as if consented.`,
    };
  }
  if (decodedAny) {
    return { status: 'no-grants-decoded', vendor, grants: [], observed: [], note: `${vendor ?? 'the consent tool'}'s stored default was decoded and grants nothing beyond necessary — on the scenarios where it was read.` };
  }
  return {
    status: 'not-observed',
    vendor: vendor ?? null,
    grants: [],
    observed: [],
    note: vendor ? `${vendor} was named but its stored default could not be decoded; what it grants by default is not observed.` : 'No consent tool was detected or its default was not read; what runs by default is not established.',
  };
}

// --- Per-party verdict -------------------------------------------------------------

/** Above this many gate-gtm-tag changes for one party in one container, they are listed as one. */
const MAX_TAG_CHANGES = 5;

const VERDICT_RANK: Record<PartyCompatibility['verdict'], number> = { unknown: 0, uncontrollable: 1, 'tag-manager': 2, platform: 2, gateable: 3 };

/** How strong a claim a verdict is (for the fail-closed invariants and tests). */
export function verdictRank(v: PartyCompatibility['verdict']): number {
  return VERDICT_RANK[v];
}

function whereOf(f: MarkupFinding): string {
  const tag = f.kind === 'script' && f.dataUrl ? `<script ${f.dataUrl.attribute}="data:…">` : f.kind === 'script' && f.inline ? 'inline <script>' : `<${f.kind}>`;
  return `${tag}${f.context === 'noscript' ? ' in <noscript>' : ''}`;
}

/** Google template tags whose party is read from their id (an unresolved id leaves them unmapped). */
const GOOGLE_BY_ID_TEMPLATES = new Set(['__googtag', '__gaawc', '__gaawe']);
const GOOGLE_ID = /^(G|AW|DC|GT|UA)-[A-Z0-9-]+$/i;

function containerIdOf(url: string | undefined): string | undefined {
  const m = url ? /[?&]id=(GTM-[A-Z0-9]+)/i.exec(url) : null;
  return m ? m[1].toUpperCase() : undefined;
}

interface GoogleDefaultProof {
  /** A denied, non-regional Consent Mode default was observed somewhere, and nothing undid it. */
  deniedTypes: Set<string>;
  observedIn: string[]; // 'location:scenario'
  refs: string[];
  /** States that cancel the proof. */
  broken: Array<{ reason: string; ref: string }>;
}

function googleDefaultProof(observations: ConsentApiObservation[] | undefined): GoogleDefaultProof | undefined {
  if (!observations) return undefined;
  const proof: GoogleDefaultProof = { deniedTypes: new Set(), observedIn: [], refs: [], broken: [] };
  observations.forEach((o, oi) => {
    o.states.forEach((s, si) => {
      if (s.api === 'google' && (s.state === 'default-after-load' || s.state === 'grant-on-load')) proof.broken.push({ reason: s.reason, ref: `/consentApi/${oi}/states/${si}` });
    });
    let denied: Set<string> | undefined;
    for (const c of o.consentCalls) {
      if (c.api !== 'google' || c.action !== 'default' || c.regional || !c.consent) continue;
      const types = Object.entries(c.consent)
        .filter(([, v]) => v === 'denied')
        .map(([k]) => k);
      if (!types.length) continue;
      denied ??= new Set();
      for (const t of types) denied.add(t);
    }
    if (denied) {
      // Only types denied in EVERY observation that set a default count.
      proof.deniedTypes = proof.observedIn.length ? new Set([...proof.deniedTypes].filter((t) => denied!.has(t))) : denied;
      proof.observedIn.push(`${o.location}:${o.scenario}${o.run && o.run > 1 ? `#${o.run}` : ''}`);
      proof.refs.push(`/consentApi/${oi}`);
    }
  });
  return proof;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '/';
  }
}

/** Same document, ignoring scheme, query and hash (an iframe's src vs. the frame URL the browser loaded). */
function sameDocument(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const norm = (u: string): string | undefined => {
    try {
      const x = new URL(u, 'https://x.invalid/');
      return `${x.hostname.replace(/^www\./, '')}${x.pathname.replace(/\/$/, '')}`;
    } catch {
      return undefined;
    }
  };
  const na = norm(a);
  return na !== undefined && na === norm(b);
}

const GOOGLE_SETTING_WHY: Record<string, string> = {
  __ogt_google_signals: 'Google signals sends to doubleclick.net for cross-device reporting and ad personalization',
  __ccd_ga_ads_link: 'the Google Ads link shares Analytics data with Google Ads',
  __ogt_1p_data_v2: 'automatic user-provided data collection reads email / phone / address from forms and sends them hashed',
  __ogt_dma: "the DMA consent default is 'granted' when no consent state is set",
};

/** Merge identical changes (same kind, place, container/tag and note); several elements on one line are counted. */
function dedupeChanges(changes: CompatibilityChange[]): CompatibilityChange[] {
  const out: CompatibilityChange[] = [];
  const byKey = new Map<string, { c: CompatibilityChange; urls: Set<string> }>();
  for (const c of changes) {
    const key = [c.kind, c.page ?? '', c.line ?? '', c.element ?? '', c.containerId ?? '', c.tagId ?? '', c.note].join('|');
    const seen = byKey.get(key);
    if (!seen) {
      byKey.set(key, { c, urls: new Set(c.url ? [c.url] : []) });
      out.push(c);
      continue;
    }
    if (c.url) seen.urls.add(c.url);
  }
  return out.map((c) => {
    const key = [c.kind, c.page ?? '', c.line ?? '', c.element ?? '', c.containerId ?? '', c.tagId ?? '', c.note].join('|');
    const n = byKey.get(key)!.urls.size;
    return n > 1 ? { ...c, note: `${c.note} (${n} such elements on this line)` } : c;
  });
}

export function compatibilityFor(party: PartyInventoryItem, input: CompatibilityInput): PartyCompatibility {
  const kb = input.kb ?? DEFAULT_KB;
  const entry = kb.entries.find((e) => e.id === party.partyId);
  const control: TagControl | undefined = entry?.control;
  const impl = party.implementation ?? { class: 'unknown' as const, evidence: [], alsoSeen: [] };
  const reasons: CompatibilityReason[] = [];
  const changes: CompatibilityChange[] = [];
  const pi = input.partyIndex;

  // Implementation evidence first: it is the explanation for everything below.
  impl.evidence.forEach((e: ImplementationEvidence, i: number) => {
    reasons.push({ source: 'implementation', note: `${e.class}${e.observed ? ' (observed)' : ''}: ${e.note}`, ...(pi !== undefined ? { ref: `/inventory/${pi}/implementation/evidence/${i}` } : {}) });
  });
  if (!party.implementation) reasons.push({ source: 'implementation', note: 'no implementation classification on this record (older build)' });

  // Markup findings for this party (A1).
  const findings = (input.markup?.findings ?? []).map((f, i) => ({ f, ref: `/markup/findings/${i}` })).filter(({ f }) => f.partyId === party.partyId);
  const gateable = findings.filter(({ f }) => f.verdict === 'gateable');
  const leaks = findings.filter(({ f }) => f.verdict === 'leak');
  const held = findings.filter(({ f }) => f.verdict === 'held');
  const markupInspected = input.markup !== undefined && input.markup.pages.some((p) => p.status === 'inspected');

  const rewriteChanges = (): CompatibilityChange[] =>
    gateable.map(({ f }) => ({
      kind: 'rewrite-tag' as const,
      note: `${whereOf(f)} at ${f.page}:${f.line}${f.alsoOn.length ? ` (also on ${f.alsoOn.length} other page(s))` : ''}: set type="text/plain" and data-category, ${f.dataUrl ? `move the data: URL from ${f.dataUrl.attribute} to data-src unchanged` : 'keep the source'} — the consent tool re-inserts it on consent${f.optimizer ? ` (${f.optimizer} delays it today: that delay is not consent gating)` : ''}`,
      page: f.page,
      line: f.line,
      element: whereOf(f),
      ...(f.url ? { url: f.url } : {}),
    }));
  const leakChanges = (): CompatibilityChange[] => {
    if (leaks.length) {
      return leaks.map(({ f }) => ({
        kind: 'remove-leak' as const,
        note: `${whereOf(f)} at ${f.page}:${f.line}${f.trigger === 'javascript-disabled' ? ' fires for visitors without JavaScript' : ' is fetched by the browser before any script runs'}: remove it from the HTML (no consent tool can hold it)`,
        page: f.page,
        line: f.line,
        element: whereOf(f),
        ...(f.url ? { url: f.url } : {}),
      }));
    }
    const ev = impl.evidence.find((e) => e.class === 'markup-leak');
    return [{ kind: 'remove-leak', note: `${ev?.note ?? 'an element the browser fetches itself'} — the element was traced at runtime, not located in the inspected HTML: find and remove it`, ...(ev?.url ? { url: ev.url } : {}) }];
  };

  // A Google tag destination GTM loads from a gtag('config', id) command in the
  // page (issue #48): the page pushes the config into the dataLayer, a GTM
  // container sees it and loads gtag.js?id=…&cx=c for that destination itself.
  // No container tag carries the id, so "require consent on tag N" has no tag to
  // act on — the snippet that pushes the config is what must be held (plus the
  // denied Consent Mode default). Established only when it cannot be anything
  // else, fail closed: GTM on the load chain, every GTM container parsed, no
  // tag in them names the id, and no Google tag there whose id is unresolved (or
  // a Custom HTML tag mapped to this party) that could be the one carrying it.
  const configDestinations = (): Array<{ id: string; loader?: string; snippets: Array<{ f: MarkupFinding; ref: string }> }> => {
    const gtmLoader = impl.evidence.find((e) => e.class === 'gtm' && e.kind === 'loader');
    const ids = googleTagIds.filter((id) => /^(G|AW|DC)-/.test(id));
    if (!gtmLoader || !ids.length) return [];
    const gtm = (input.containers ?? []).filter((c) => c.kind === 'gtm');
    if (!gtm.length || gtm.some((c) => c.status !== 'parsed')) return [];
    const live = gtm.flatMap((c) => c.tags.filter((t) => t.kind === 'tag' && !t.paused));
    const unresolved = live.some((t) => (t.partyId === party.partyId || (!t.partyId && GOOGLE_BY_ID_TEMPLATES.has(t.template))) && !t.identifiers.some((x) => GOOGLE_ID.test(x)));
    if (unresolved) return [];
    if (ids.some((id) => live.some((t) => t.identifiers.some((x) => x.toUpperCase() === id)))) return [];
    const urls = [...party.loadedBy, ...impl.evidence.map((e) => e.url).filter((u): u is string => !!u)];
    const all = (input.markup?.findings ?? []).map((f, i) => ({ f, ref: `/markup/findings/${i}` }));
    return ids.map((id) => {
      const loader = urls.find((u) => googleTagIdOf(u) === id);
      // The snippet: an inline (or data: URL) script whose body names the id —
      // this party's own match first, then any other party's on that tag.
      const hits = all.filter(({ f }) => f.kind === 'script' && f.inline && f.verdict === 'gateable' && (f.ids ?? []).some((x) => x.toUpperCase() === id));
      const own = hits.filter(({ f }) => f.partyId === party.partyId);
      const snippets = (own.length ? own : hits).filter(({ f }, i, a) => a.findIndex((x) => x.f.page === f.page && x.f.line === f.line) === i);
      return { id, ...(loader ? { loader } : {}), snippets };
    });
  };
  const configChanges = (dests: ReturnType<typeof configDestinations>): CompatibilityChange[] => {
    const out: CompatibilityChange[] = [];
    for (const d of dests) {
      const via = d.loader ?? `gtag.js for ${d.id}`;
      const why = `Google Tag Manager loads ${d.id} itself (${via}) because the page pushes gtag('config', '${d.id}') into the dataLayer — no tag in the container carries ${d.id}, so there is no tag to require consent on. Holding this snippet holds the destination; holding the gtag.js loader alone does not while a GTM container is on the page. (Or move the config into GTM as a Google tag with a consent requirement, and remove the snippet.)`;
      reasons.push({ source: 'container', note: `destination ${d.id} is loaded by GTM from a gtag('config') command in the page${d.loader ? ` (${d.loader})` : ''}: no tag in ${(input.containers ?? []).filter((c) => c.kind === 'gtm').map((c) => c.id).join(', ')} names ${d.id}${d.snippets.length ? `; the config snippet is ${d.snippets.map(({ f }) => `${whereOf(f)} at ${f.page}:${f.line}`).join(', ')}` : '; the snippet that pushes it was not located in the inspected HTML'}`, ...(d.snippets[0] ? { ref: d.snippets[0].ref } : {}) });
      if (!d.snippets.length) {
        out.push({ kind: 'needs-a-look', destinationId: d.id, note: `find the gtag('config', '${d.id}') call that Google Tag Manager picks up from the dataLayer (no container tag carries ${d.id}, and the call was not located in the inspected HTML — a bundled script or another page) and hold it with type="text/plain" data-category, or move the config into GTM as a tag with a consent requirement`, why });
        continue;
      }
      for (const { f } of d.snippets) {
        // Already listed as this party's own rewrite: say why there, once.
        const same = changes.find((c) => c.kind === 'rewrite-tag' && c.page === f.page && c.line === f.line);
        if (same) {
          same.destinationId ??= d.id;
          same.why ??= why;
          continue;
        }
        out.push({
          kind: 'rewrite-tag',
          note: `${whereOf(f)} at ${f.page}:${f.line}: the gtag('config', '${d.id}') snippet — set type="text/plain" and data-category${f.dataUrl ? `, move the data: URL from ${f.dataUrl.attribute} to data-src unchanged` : ''}; GTM then has no config command to load ${d.id} from until the visitor agrees`,
          page: f.page,
          line: f.line,
          element: whereOf(f),
          destinationId: d.id,
          why,
        });
      }
    }
    return out;
  };

  // GTM (A2 + A3): which tags, and whether any is PROVEN gated.
  const gtmChanges = (): CompatibilityChange[] => {
    const out: CompatibilityChange[] = [];
    const dests = configDestinations();
    const types = consentTypesFor(party.categories);
    const proof = googleDefaultProof(input.consentApi);
    const defaultOk = !!proof && proof.observedIn.length > 0 && !proof.broken.length;
    const containers = input.containers ?? [];
    const parsed = containers.filter((c) => c.kind === 'gtm' && c.status === 'parsed');
    const tags: Array<{ c: TagContainer; ci: number; t: ContainerTag; ti: number }> = [];
    containers.forEach((c, ci) => {
      if (c.kind !== 'gtm' || c.status !== 'parsed') return;
      c.tags.forEach((t, ti) => {
        if (t.partyId === party.partyId && t.kind === 'tag' && !t.paused) tags.push({ c, ci, t, ti });
      });
    });
    const unreadable = containers.filter((c) => c.kind === 'gtm' && c.status !== 'parsed');
    for (const u of unreadable) reasons.push({ source: 'container', note: `${u.id} ${u.status}: ${u.reason ?? 'its tags are unknown, not gated'}`, ref: `/containers/${containers.indexOf(u)}` });

    let needDefault = false;
    for (const { c, ci, t, ti } of tags) {
      const ref = `/containers/${ci}/tags/${ti}`;
      const where = `${c.id} tag ${t.tagId} (${t.templateLabel})`;
      if (t.consent.status === 'required' && t.consent.additional.length) {
        const missing = proof ? t.consent.additional.filter((x) => !proof.deniedTypes.has(x)) : t.consent.additional;
        if (defaultOk && !missing.length) {
          reasons.push({ source: 'container', note: `${where} requires ${t.consent.additional.join(', ')}, and a denied default for those types was observed before the container fired (${proof!.observedIn.join(', ')}) — gated`, ref });
          continue;
        }
        needDefault = true;
        reasons.push({
          source: 'container',
          note: `${where} requires ${t.consent.additional.join(', ')}, but ${
            !proof ? 'consent-API calls were not recorded' : !proof.observedIn.length ? 'no denied Consent Mode default was observed' : proof.broken.length ? `the default was undone (${proof.broken[0].reason})` : `the observed default did not deny ${missing.join(', ')}`
          } — GTM treats a never-set type as granted, so this requirement is not proven to hold the tag`,
          ref,
        });
        continue;
      }
      const why =
        t.consent.status === 'required'
          ? 'carries a consent requirement with no types the parser could read'
          : t.consent.status === 'built-in'
            ? 'has only built-in Consent Mode checks: it fires regardless and switches to cookieless pings'
            : t.consent.status === 'template-checks'
              ? 'reads consent state in its own template code — whether it holds anything back is unverified'
              : t.consent.status === 'none'
                ? 'has no consent requirement: it fires whenever its trigger does'
                : 'could not be characterised by the parser';
      reasons.push({ source: 'container', note: `${where} ${why}${t.firesOnPageLoad ? '; fires on page load' : ''}`, ref });
      out.push({ kind: 'gate-gtm-tag', note: `${where}: set "Require additional consent for tag to fire" to ${types.join(', ')}`, containerId: c.id, tagId: t.tagId, consentTypes: types });
      needDefault = true;
    }
    // Many tags for one party in one container (49 GA4 event tags): one change
    // per container naming the tags, not one per tag.
    for (const id of new Set(out.map((c) => c.containerId))) {
      const per = out.filter((c) => c.kind === 'gate-gtm-tag' && c.containerId === id && c.tagId !== undefined);
      if (per.length <= MAX_TAG_CHANGES) continue;
      const ids = per.map((c) => c.tagId!);
      const labels = [...new Set(tags.filter((x) => x.c.id === id && ids.includes(x.t.tagId)).map((x) => x.t.templateLabel))];
      const first = out.indexOf(per[0]);
      for (const c of per) out.splice(out.indexOf(c), 1);
      out.splice(first, 0, {
        kind: 'gate-gtm-tag',
        note: `${id}: ${ids.length} tags (${labels.join(', ')}) — tag ${ids.slice(0, 12).join(', ')}${ids.length > 12 ? ` and ${ids.length - 12} more` : ''}: set "Require additional consent for tag to fire" to ${types.join(', ')} on each (or on the shared trigger / a consent exception)`,
        containerId: id,
        consentTypes: types,
      });
    }
    if (dests.length) {
      // The destination is not a container tag: no "require consent on tag N".
      out.push(...configChanges(dests));
      needDefault = true;
    } else if (!tags.length) {
      const loader = impl.evidence.find((e) => e.class === 'gtm' && e.kind === 'loader');
      const id = containerIdOf(loader?.url) ?? unreadable[0]?.id ?? impl.evidence.find((e) => e.containerId)?.containerId;
      const why = !containers.length
        ? 'the container was not fetched'
        : parsed.length && !unreadable.length
          ? `no tag in ${parsed.map((c) => c.id).join(', ')} was mapped to this party (a Custom HTML tag the parser could not attribute, or another container)`
          : 'the container could not be read';
      reasons.push({ source: 'container', note: `${why}: which tag loads it, and its consent setting, are unknown — not gated` });
      out.push({ kind: 'gate-gtm-tag', note: `${id ?? 'the GTM container'}: find every tag that loads ${party.label} and require ${types.join(', ')} — ${why}`, ...(id ? { containerId: id } : {}), consentTypes: types });
      needDefault = true;
    }
    // One Consent Mode default serves every Google tag on the page: list it once.
    if (needDefault && !changes.some((c) => c.kind === 'set-consent-default')) {
      if (!proof) {
        out.push({ kind: 'set-consent-default', note: `set gtag('consent', 'default', {${types.map((t) => `${t}: 'denied'`).join(', ')}}) before the container snippet — consent-API calls were not recorded, so no default is known to exist`, consentTypes: types });
      } else if (!proof.observedIn.length) {
        reasons.push({ source: 'consent-api', note: 'no denied Consent Mode default was observed through gtag() or dataLayer in any scenario (a default set inside the container by a consent template is not visible to the recorder)' });
        out.push({ kind: 'set-consent-default', note: `set gtag('consent', 'default', {${types.map((t) => `${t}: 'denied'`).join(', ')}}) before the container snippet — none was observed`, consentTypes: types });
      } else if (proof.broken.length) {
        for (const b of proof.broken) reasons.push({ source: 'consent-api', note: b.reason, ref: b.ref });
        out.push({ kind: 'set-consent-default', note: `move the Consent Mode default above the container snippet and stop granting on load (${proof.broken[0].reason})`, consentTypes: types });
      } else {
        const missing = types.filter((t) => !proof.deniedTypes.has(t));
        if (missing.length) out.push({ kind: 'set-consent-default', note: `extend the Consent Mode default to deny ${missing.join(', ')} (observed default denies ${[...proof.deniedTypes].join(', ')})`, consentTypes: missing });
        else reasons.push({ source: 'consent-api', note: `a denied Consent Mode default (${[...proof.deniedTypes].join(', ')}) was observed before the container fired in ${proof.observedIn.join(', ')}`, ref: proof.refs[0] });
      }
    }
    return out;
  };

  // The Google tag (gtag.js) on the party's load chain (see the decision table).
  const googleTagIds = [
    ...new Set(
      [
        ...impl.evidence.filter((e) => e.kind === 'container-tag' && e.containerId && /^(G|AW|GT|DC)-/i.test(e.containerId)).map((e) => e.containerId!.toUpperCase()),
        // Loader evidence only: a party's OWN markup tag being gtag.js (the Google tag itself) is not "loaded by" it.
        ...impl.evidence.map((e) => (e.url && e.kind !== 'markup' && e.kind !== 'source' ? googleTagIdOf(e.url) : undefined)),
        ...party.loadedBy.map(googleTagIdOf),
      ].filter((x): x is string => !!x),
    ),
  ];
  const googleTagChanges = (snippet?: MarkupFinding): CompatibilityChange[] => {
    const out: CompatibilityChange[] = [];
    if (!googleTagIds.length) return out;
    const containers = input.containers ?? [];
    const types = consentTypesFor(party.categories);
    reasons.push({
      source: 'container',
      note: `loaded by the Google tag (${googleTagIds.join(', ')}): it has no "require consent" setting — its destinations carry built-in Consent Mode checks only and fire regardless (cookieless pings while denied); to send nothing before consent the snippet itself must be held${snippet ? ` (<script> at ${snippet.page}:${snippet.line}, listed under ${snippet.label})` : ''}`,
    });
    for (const id of googleTagIds) {
      const ci = containers.findIndex((c) => c.kind === 'gtag' && c.id.toUpperCase() === id);
      const c = ci >= 0 ? containers[ci] : undefined;
      if (!c || c.status !== 'parsed') {
        reasons.push({ source: 'container', note: `Google tag ${id} ${!c ? 'was not fetched' : c.status === 'unreadable' ? 'could not be read' : 'was not fetched'}: its destinations and settings are unknown`, ...(c ? { ref: `/containers/${ci}` } : {}) });
        continue;
      }
      const hasDestination = c.tags.some((t) => t.kind === 'tag' && t.partyId === party.partyId);
      const on = c.tags.filter((t) => t.kind === 'setting' && GOOGLE_TAG_SETTINGS_FOR[t.template]?.some((x) => x === party.partyId || (x === '*' && hasDestination)) && googleTagSettingOn(t));
      const templates = [...new Set(on.map((t) => t.template))];
      if (templates.length) {
        out.push({
          kind: 'configure-tag-manager',
          manager: 'Google tag',
          containerId: c.id,
          note: `Google tag ${c.id} settings (Google tag / Analytics / Ads admin): ${templates.map((t) => GOOGLE_SETTING_WHY[t] ?? t).join('; ')} — switch off what is not needed, and keep the rest behind a denied Consent Mode default (with none set, Google treats consent as granted)`,
        });
        for (const t of on) reasons.push({ source: 'container', note: `${c.id}: ${t.templateLabel} is on${t.settings && Object.keys(t.settings).length ? ` (${Object.entries(t.settings).slice(0, 4).map(([k, v]) => `${k}=${v}`).join(', ')})` : ''}`, ref: `/containers/${ci}/tags/${c.tags.indexOf(t)}` });
      }
    }
    if (changes.some((c) => c.kind === 'set-consent-default') || out.some((c) => c.kind === 'set-consent-default')) return out;
    const proof = googleDefaultProof(input.consentApi);
    const missing = proof ? types.filter((t) => !proof.deniedTypes.has(t)) : types;
    const why = !proof
      ? 'consent-API calls were not recorded, so no default is known to exist'
      : !proof.observedIn.length
        ? 'none was observed'
        : proof.broken.length
          ? `the observed default was undone (${proof.broken[0].reason})`
          : missing.length
            ? `the observed default does not deny ${missing.join(', ')}`
            : '';
    if (!why) {
      reasons.push({ source: 'consent-api', note: `a denied Consent Mode default (${[...proof!.deniedTypes].join(', ')}) was observed (${proof!.observedIn.join(', ')}): the Google tag still sends cookieless pings while denied — requests continue, not held`, ref: proof!.refs[0] });
      return out;
    }
    out.push({
      kind: 'set-consent-default',
      note: `in the Google tag snippet${snippet ? ` (<script> at ${snippet.page}:${snippet.line})` : ''}: call gtag('consent', 'default', {${types.map((t) => `${t}: 'denied'`).join(', ')}}) before gtag('config', '${googleTagIds[0]}'), and gtag('consent', 'update', …) from the consent tool on a choice — ${why}`,
      containerId: googleTagIds[0],
      consentTypes: types,
      ...(snippet ? { page: snippet.page, line: snippet.line, element: whereOf(snippet) } : {}),
    });
    return out;
  };

  // A runtime-only leak with nothing concrete behind it: the first request had
  // no call chain at all (initiator 'other', no URL) and no element was located.
  // That is also what a redirect hop (c.gif → partner sync) or a script-created
  // image whose stack was lost looks like — not proof of an element in the HTML.
  const leakEvidence = impl.evidence.filter((e) => e.class === 'markup-leak');
  const weakLeak = impl.class === 'markup-leak' && !leaks.length && leakEvidence.length > 0 && leakEvidence.every((e) => e.kind === 'source' && !e.url);

  let verdict: PartyCompatibility['verdict'];
  switch (impl.class) {
    case 'markup-leak': {
      if (weakLeak) {
        verdict = 'unknown';
        reasons.push({ source: 'implementation', note: `a non-script request with no traceable initiator${markupInspected ? ', and no element for it in the inspected HTML' : ''}: an element in the HTML would be a leak, but a redirect hop or an image created by another script looks the same — not established` });
        changes.push({ kind: 'needs-a-look', note: `find what sends ${party.label}'s first request (an <img>/<iframe> in the HTML, a redirect from another tool's pixel, or a script-created image) — only an element in the HTML is uncontrollable` });
        if (impl.alsoSeen.includes('gtm')) changes.push(...gtmChanges());
        break;
      }
      verdict = 'uncontrollable';
      // Loaded inside a third-party <iframe> located in the HTML: the iframe's own
      // change (remove / facade it) covers this request — fold it under that party
      // rather than repeat the change (or invent a runtime one) for every subresource.
      const frameFinding =
        !leaks.length && leakEvidence.length && leakEvidence.every((e) => e.kind === 'loader' && e.url)
          ? (input.markup?.findings ?? []).find(
              (f) =>
                f.kind === 'iframe' &&
                f.partyId !== party.partyId &&
                (f.verdict === 'leak' || f.verdict === 'gateable') &&
                purposeScopeOf(kb.entries.find((x) => x.id === f.partyId)?.categories ?? ['unknown']) !== 'not-required' &&
                leakEvidence.some((e) => sameDocument(e.url, f.url)),
            )
          : undefined;
      if (frameFinding) {
        const fi = (input.markup?.findings ?? []).indexOf(frameFinding);
        reasons.push({ source: 'markup', note: `loaded inside the ${whereOf(frameFinding)} at ${frameFinding.page}:${frameFinding.line} (${frameFinding.label}): it goes when that iframe goes — see ${frameFinding.label}'s change; no separate change listed`, ref: `/markup/findings/${fi}` });
      } else changes.push(...leakChanges());
      if (gateable.length) changes.push(...rewriteChanges());
      if (impl.alsoSeen.includes('gtm')) changes.push(...gtmChanges());
      break;
    }
    case 'cname': {
      verdict = 'uncontrollable';
      const cn = impl.evidence.find((e) => e.class === 'cname');
      changes.push({
        kind: 'change-dns',
        note: `${cn?.host ?? 'a first-party subdomain'} points at ${cn?.target ?? party.label}: cookies it sets are first-party and no consent tool can reach them — repoint the DNS or accept the exposure in writing`,
        ...(cn?.host ? { host: cn.host } : {}),
        ...(cn?.target ? { target: cn.target } : {}),
      });
      if (gateable.length) changes.push(...rewriteChanges());
      break;
    }
    case 'server-side-suspected': {
      verdict = 'uncontrollable';
      const ep = impl.evidence.find((e) => e.class === 'server-side-suspected');
      changes.push({ kind: 'accepted-exposure', note: `${ep?.note ?? 'server-side forwarding is possible'}: nothing in the browser controls or verifies it — a server-side checklist item, or accept the exposure in writing`, ...(ep?.url ? { url: ep.url } : {}) });
      break;
    }
    case 'gtm': {
      verdict = 'tag-manager';
      changes.push(...gtmChanges());
      changes.push(...googleTagChanges());
      if (leaks.length) {
        verdict = 'uncontrollable';
        changes.unshift(...leakChanges());
      }
      break;
    }
    case 'other-tag-manager': {
      verdict = 'tag-manager';
      const ld = impl.evidence.find((e) => e.class === 'other-tag-manager');
      const manager = /loaded by ([^(]+?) \(/.exec(ld?.note ?? '')?.[1]?.trim();
      changes.push({ kind: 'configure-tag-manager', note: `${manager ?? 'the tag manager'} loads ${party.label}: gate the tag inside it with its own consent setting — container internals are not readable by this scan (needs a look)`, ...(manager ? { manager } : {}), ...(ld?.url ? { url: ld.url } : {}) });
      if (leaks.length) {
        verdict = 'uncontrollable';
        changes.unshift(...leakChanges());
      }
      break;
    }
    case 'platform': {
      const name = input.platform?.name ?? (control?.platform as PlatformFingerprint['name'] | undefined);
      if (name && PLATFORM_API[name]) {
        verdict = 'platform';
        const p = PLATFORM_API[name];
        reasons.push({ source: 'platform', note: `${name} injects it: a rewrite of the HTML does not reach it${input.platform?.consentPlugin ? `; consent plugin: ${input.platform.consentPlugin}` : ''}` });
        changes.push({ kind: 'use-platform-api', note: `use ${p.api}; dashboard: ${p.where}`, platform: name, api: p.api });
        reasons.push({ source: 'platform', note: `the platform's consent setting governs what ${name} injects into the browser only: events the platform or the vendor's app forwards server-side${name === 'shopify' ? ' (Shopify server pixels, the Meta / Google apps’ conversions APIs)' : ''} are not covered and cannot be verified from the browser` });
        if (name === 'wordpress' && input.platform?.wpConsentApi === false) reasons.push({ source: 'platform', note: 'the WP Consent API was not detected: the plugin that injects this tag may not read consent at all' });
      } else {
        verdict = 'unknown';
        reasons.push({ source: 'platform', note: 'injected by a platform sandbox / worker, but the platform was not identified — which consent API applies is unknown' });
        changes.push({ kind: 'needs-a-look', note: `identify the platform or app that injects ${party.label}` });
      }
      if (leaks.length) {
        verdict = 'uncontrollable';
        changes.unshift(...leakChanges());
      }
      break;
    }
    case 'direct-script': {
      if (leaks.length) {
        verdict = 'uncontrollable';
        changes.push(...leakChanges());
        if (gateable.length) changes.push(...rewriteChanges());
      } else if (!markupInspected) {
        verdict = 'unknown';
        reasons.push({ source: 'markup', note: 'the served HTML was not inspected: the tag to rewrite is not located' });
        changes.push({ kind: 'needs-a-look', note: `inspect the served HTML for the <script> that loads ${party.label}` });
      } else if (gateable.length) {
        verdict = 'gateable';
        for (const { f, ref } of gateable) reasons.push({ source: 'markup', note: `${whereOf(f)} at ${f.page}:${f.line} (${f.matchedBy}: ${f.match})`, ref });
        changes.push(...rewriteChanges());
        changes.push(...googleTagChanges());
      } else if (held.length) {
        verdict = 'unknown';
        for (const { f, ref } of held) reasons.push({ source: 'markup', note: `${whereOf(f)} at ${f.page}:${f.line} is already held back (type="text/plain" / data-src)`, ref });
        reasons.push({ source: 'markup', note: 'only held-back tags were found, yet the party loaded: the live copy was not located' });
        changes.push({ kind: 'needs-a-look', note: `find what still loads ${party.label} while its tag is held back` });
      } else {
        verdict = 'unknown';
        const src = impl.evidence.find((e) => e.class === 'direct-script' && e.kind === 'loader') ?? impl.evidence.find((e) => e.class === 'direct-script');
        // Injected by another party's script that IS located in the HTML (gtag.js
        // loading GA / DoubleClick): point at that tag rather than "a bundle".
        // The loader's own tag may be inline (no src): match it by the loader's party too.
        const loaderEntry = src?.url ? lookupEntry(kb, hostOf(src.url) ?? '', pathOf(src.url)) : undefined;
        const others = (input.markup?.findings ?? []).filter((f) => f.partyId !== party.partyId && f.verdict === 'gateable');
        const exactTag = src?.url ? others.find((f) => f.url === src.url) : undefined;
        const loaderTag = exactTag ?? (loaderEntry ? others.find((f) => f.partyId === loaderEntry.id) : undefined);
        if (exactTag && loaderTag && src?.url && googleTagIdOf(src.url)) {
          // The Google tag path: the located snippet is the Google tag's, and the
          // Google tag decides through Consent Mode and its settings.
          verdict = 'tag-manager';
          reasons.push({ source: 'markup', note: `loaded by the Google tag snippet ${whereOf(loaderTag)} at ${loaderTag.page}:${loaderTag.line} (${loaderTag.label}'s tag) — holding that tag holds this copy back; anything else that loads ${party.label} is not established` });
          changes.push(...googleTagChanges(loaderTag));
        } else if (loaderTag) {
          reasons.push({ source: 'markup', note: `loaded by ${whereOf(loaderTag)} at ${loaderTag.page}:${loaderTag.line} (${loaderTag.label}'s tag) — gating that tag holds this copy back; anything else that loads ${party.label} is not established` });
          changes.push({ kind: 'needs-a-look', note: `loaded by ${src!.url}: gate ${whereOf(loaderTag)} at ${loaderTag.page}:${loaderTag.line} (see ${loaderTag.label}), then rescan — whether that is the only path is not established`, page: loaderTag.page, line: loaderTag.line, element: whereOf(loaderTag), url: src!.url });
        } else {
          reasons.push({ source: 'markup', note: `traced at runtime to ${src?.url ?? 'a script in the page'}, but no tag for it was found in the inspected HTML (see markup.unexplained)` });
          changes.push({ kind: 'needs-a-look', note: `locate the code that loads ${party.label}${src?.url ? ` (traced to ${src.url})` : ''} — it may be inside a bundled site script` });
          changes.push(...googleTagChanges());
        }
      }
      // The same party also has tags in a GTM container: gating the HTML copy
      // leaves those firing — list them, and claim no more than tag-manager.
      if (impl.alsoSeen.includes('gtm') && !leaks.length) {
        const g = gtmChanges();
        changes.push(...g);
        if (verdict === 'gateable' && g.some((c) => c.kind === 'gate-gtm-tag')) {
          verdict = 'tag-manager';
          reasons.push({ source: 'container', note: `GTM tags for ${party.label} fire besides the tag in the HTML: holding that tag is not enough on its own` });
        }
      }
      break;
    }
    default: {
      verdict = 'unknown';
      if (leaks.length) {
        verdict = 'uncontrollable';
        changes.push(...leakChanges());
      } else changes.push({ kind: 'needs-a-look', note: `how ${party.label} gets onto the page could not be traced` });
    }
  }

  // Additive: the vendor's own consent API (A8), and what A3 saw of it.
  if (verdict === 'platform' && control?.api) {
    reasons.push({ source: 'control', note: `${control.api.name} exists, but inside the platform's injected copy it is the platform (or the vendor's app) that must call it — not a change the site owner makes in code` });
  } else if (verdict === 'gateable' || verdict === 'tag-manager') {
    if (control?.api) {
      changes.push({
        kind: 'call-consent-api',
        note: `alongside gating: ${control.api.hold ? `${control.api.hold} before the tag loads; ` : ''}${control.api.revoke} on refusal (after revoke the tag ${control.api.afterRevoke === 'stops' ? 'stops' : control.api.afterRevoke === 'cookieless' ? 'keeps sending cookieless pings — still requests' : control.api.afterRevoke === 'stops-storage' ? 'stops its storage, requests may continue' : 'does what its docs do not say'})`,
        api: control.api.name,
      });
    }
  }
  const api = consentApiOf(party.partyId, entry);
  if (api && input.consentApi) {
    // One reason per observation (evidence refs); one change per state kind, naming every observation.
    const byState = new Map<string, { reason: string; where: string[] }>();
    input.consentApi.forEach((o, oi) => {
      o.states.forEach((s, si) => {
        if (s.api !== api) return;
        const ref = `/consentApi/${oi}/states/${si}`;
        const where = `${o.location}:${o.scenario}${o.run && o.run > 1 ? `#${o.run}` : ''}`;
        reasons.push({ source: 'consent-api', note: `${where}: ${s.reason}`, ref });
        const g = byState.get(s.state) ?? { reason: s.reason, where: [] };
        g.where.push(where);
        byState.set(s.state, g);
      });
    });
    for (const [state, g] of byState) {
      const seen = `${g.where.length} visit(s): ${g.where.join(', ')}`;
      if (state === 'default-after-load') {
        if (!changes.some((c) => c.kind === 'set-consent-default')) changes.push({ kind: 'set-consent-default', note: `set the consent default before ${party.label} loads: ${g.reason} (${seen})`, api: control?.api?.name });
      } else if (state === 'not-called-after-refusal') {
        changes.push({ kind: 'call-consent-api', note: `${control?.api?.revoke ?? 'the revoke call'} was never made after the visitor refused (${seen})`, api: control?.api?.name });
      } else {
        // Granting before a choice is the violation under opt-in rules; where none of
        // the visits ran under them, say so instead of implying it is wrong everywhere.
        // Strict wherever opt-in rules (or no known rules) applied, and for an opt-out
        // visit in a state that must honor the signal.
        const optInSeen = g.where.some((w) => {
          const [loc, sc] = w.split('#')[0].split(':');
          const r = input.regimes?.[loc];
          return r === 'opt-in' || r === undefined || r === 'unknown' || (r === 'opt-out-signal' && OPTED_OUT.has(sc));
        });
        changes.push({
          kind: 'call-consent-api',
          note: optInSeen
            ? `stop granting on load: ${g.reason} (${seen})`
            : `granted before any choice (${seen}) — observed under US opt-out rules only, where that can be the expected default; under opt-in rules (EU/UK) it must not grant before a choice: make the default location-aware. ${g.reason}`,
          api: control?.api?.name,
        });
      }
    }
  }
  if (control?.snippetLeak && control.snippetLeak !== 'none' && markupInspected && !leaks.length) {
    reasons.push({ source: 'control', note: `the vendor's install snippet ships a ${control.snippetLeak === 'iframe' ? '<noscript> iframe' : '<noscript> image pixel'}; none was found on the inspected pages — pages not visited may carry one` });
  }
  if (control?.loadsOthers) reasons.push({ source: 'control', note: 'loads other vendors: gating it gates them, and what it loads needs its own verdict' });
  if (control?.tcf && !control.api) reasons.push({ source: 'control', note: 'reads the IAB TCF string only; outside a TCF setup, gating the load is the only control' });

  // Purpose: a party whose purpose needs no consent has nothing for the owner
  // to change; the verdict still records the mechanism. Unclassified and
  // context purposes keep their changes, with the condition stated.
  const purpose = purposeScopeOf(party.categories);
  if (purpose === 'not-required') {
    reasons.push({ source: 'control', note: `its purpose (${party.categories.join(', ')}) needs no consent: no change listed — the verdict describes how it loads, not something to fix${changes.length ? ` (${changes.length} change(s) dropped)` : ''}` });
    changes.length = 0;
  } else if (purpose === 'unclassified') {
    reasons.push({ source: 'control', note: 'its purpose is not classified: the changes apply only if it tracks visitors — classify it first' });
  } else if (purpose === 'context') {
    reasons.push({ source: 'control', note: `a ${party.categories.join('/')} use: under opt-in rules it needs consent unless strictly necessary for a feature the visitor asked for; the changes apply when it is not` });
  }

  // Fail-closed invariants, whatever the branches above did.
  if (verdict === 'gateable' && !(gateable.length && !leaks.length && markupInspected)) verdict = 'unknown';
  if (verdict === 'unknown' && !changes.length && purpose !== 'not-required') changes.push({ kind: 'needs-a-look', note: `how ${party.label} gets onto the page could not be established` });

  const merged = dedupeChanges(changes);
  changes.length = 0;
  changes.push(...merged);

  // Behavior outranks implementation.
  const cells = (input.behavior ?? []).filter((c) => c.partyId === party.partyId);
  const mismatches = cells.filter((c) => c.status === 'mismatch');
  const checked = cells.some((c) => c.status !== 'not-established');
  for (const m of mismatches) reasons.unshift({ source: 'behavior', note: `${m.location}:${m.scenario}${m.run && m.run > 1 ? `#${m.run}` : ''}: ${m.reason}`, ...(m.ref ? { ref: m.ref } : {}) });
  if (mismatches.length) {
    changes.unshift({
      kind: 'behavior-mismatch',
      note: `observed active where it should be off (${[...new Set(mismatches.map((m) => `${m.location}:${m.scenario}`))].join(', ')}): whatever the implementation says, the current setup does not hold ${party.label} back. Make the changes below, then rescan — behavior is the ground truth.`,
    });
  } else if (!checked) {
    const why = [...new Set(cells.map((c) => c.reason))];
    reasons.push({ source: 'behavior', note: `behavior not established${why.length ? ` (${why.slice(0, 3).join('; ')})` : ' (no comparison available)'} — the verdict explains the implementation only` });
  }

  return { partyId: party.partyId, label: party.label, implementation: impl.class, verdict, purpose, behaviorMismatch: mismatches.length > 0, behaviorChecked: checked, reasons, changes };
}

// --- Whole-evaluation -----------------------------------------------------------

export type CompatibilityEvaluationInput = Pick<TrackingEvaluation, 'inventory' | 'locations'> & Partial<Pick<TrackingEvaluation, 'markup' | 'containers' | 'consentApi' | 'platform' | 'behaviorObservations' | 'startedAt'>> & { kb?: KnowledgeBase };

export function evaluateCompatibility(ev: CompatibilityEvaluationInput): CompatibilitySection {
  const behavior = ev.behaviorObservations ? behaviorCellsFrom({ locations: ev.locations, inventory: ev.inventory, behaviorObservations: ev.behaviorObservations, startedAt: ev.startedAt }) : [];
  const consentTool = consentToolDefaultFinding(ev.locations);
  const regimes = Object.fromEntries(ev.locations.map((l) => [l.spec.id, l.verification.verdict === 'verified' ? regimeOf(l.verification.jurisdictions, ev.startedAt?.slice(0, 10)) : ('unknown' as const)]));
  const parties = ev.inventory.map((p, i) =>
    compatibilityFor(p, { markup: ev.markup, containers: ev.containers, consentApi: ev.consentApi, platform: ev.platform, behavior, kb: ev.kb, partyIndex: i, regimes }),
  );
  return {
    parties,
    consentTool,
    inputs: {
      markup: ev.markup !== undefined,
      containers: ev.containers !== undefined,
      consentApi: ev.consentApi !== undefined,
      consentTool: ev.locations.some((l) => l.scenarios.some((s) => s.consentTool)),
      behavior: behavior.some((c) => c.status !== 'not-established'),
    },
  };
}
