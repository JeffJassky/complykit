import type { ChoiceEvent, ConsentApiEvent, ConsentApiName, ConsentApiObservation, RequestEvent, Timeline } from '../../record/index.js';
import { phaseAt, PHASE_LABEL, UNCONSENTED, type Phase } from './analyze.js';

// Consent-API misuse (plans/client-consent-design.md §3, the first of the two
// "states"). The shim records every call a page makes into a vendor's consent /
// tag API; this module reads those calls back, says what each one TOLD the
// vendor and in which consent phase, and derives three states:
//
//   - 'default-after-load'       a Consent Mode (or UET) default set after the
//                                vendor's library was already running or had
//                                already measured — the default arrived too late
//                                to govern what happened before it.
//   - 'not-called-after-refusal' the visitor rejected / withdrew / opted out
//                                while the vendor was running, and the page never
//                                told the vendor (no revoke, no denied update),
//                                and nothing before had told it 'denied' either.
//   - 'grant-on-load'            the vendor was told 'granted' in a phase where
//                                nothing had been consented to — on load before
//                                any choice, or after a refusal.
//
// Pure, over a Timeline. A state is a fact about what the page did; whether it
// matters in a jurisdiction is the caller's judgment. Absence of a state is
// never a pass: what the recorder cannot see is listed in `unknowns`.

export type ConsentAction =
  | 'default' // Consent Mode / UET default
  | 'update' // a consent update carrying values
  | 'grant' // a value-less grant (fbq consent grant, ttq.grantConsent, clarity('consent'))
  | 'revoke'
  | 'hold' // ttq.holdConsent: pending, treated as not granted
  | 'measure' // a command that can send data (config, event, track, init, dataLayer event)
  | 'read' // TCF / GPP / Shopify getters
  | 'ready' // the vendor's library took over its global
  | 'other';

export interface ConsentApiCall {
  t: number;
  api: ConsentApiName;
  call: string;
  kind: ConsentApiEvent['kind'];
  command?: string;
  action: ConsentAction;
  /** Consent values as told to the vendor (keys as the vendor names them). */
  consent?: Record<string, 'granted' | 'denied'>;
  /** Something was told 'granted'. */
  grants: boolean;
  /** Something was told 'denied' (or revoked / held). */
  denies: boolean;
  /** The command named regions (Consent Mode `region`): it applies only to visitors there. */
  regional: boolean;
  phase: Phase;
  pageIndex: number;
  frameUrl: string;
  top: boolean;
  chain: string[];
  args: unknown[];
}

export type ConsentApiStateKind = 'default-after-load' | 'not-called-after-refusal' | 'grant-on-load';

export interface ConsentApiState {
  state: ConsentApiStateKind;
  api: ConsentApiName;
  t: number;
  phase: Phase;
  reason: string;
  /** The calls (and, for ordering, the earlier event) that show it. */
  calls: ConsentApiCall[];
}

export interface ConsentApiAnalysis {
  calls: ConsentApiCall[];
  /** APIs the page used or loaded at all. */
  apis: ConsentApiName[];
  states: ConsentApiState[];
  /** What the recorder could not establish, stated (never a silent pass). */
  unknowns: string[];
}

/** APIs that CONTROL a vendor (TCF / GPP are the CMP's own signal; vendors read them). */
export const CONTROL_APIS: ReadonlySet<ConsentApiName> = new Set<ConsentApiName>(['google', 'meta', 'tiktok', 'clarity', 'microsoft-uet', 'shopify']);

export const CONSENT_API_LABEL: Record<ConsentApiName, string> = {
  google: 'Google tag (Consent Mode)',
  meta: 'Meta Pixel',
  tiktok: 'TikTok Pixel',
  clarity: 'Microsoft Clarity',
  'microsoft-uet': 'Microsoft UET',
  tcf: 'IAB TCF (__tcfapi)',
  gpp: 'IAB GPP (__gpp)',
  shopify: 'Shopify Customer Privacy API',
};

const REFUSALS: ReadonlySet<ChoiceEvent['choice']> = new Set<ChoiceEvent['choice']>(['reject', 'withdraw', 'opt-out-link']);
const CONSENT_ACTIONS: ReadonlySet<ConsentAction> = new Set<ConsentAction>(['default', 'update', 'grant', 'revoke', 'hold']);

const GOOGLE_HIT =
  /^https?:\/\/(?:[^/]*\.)?(?:google-analytics\.com|analytics\.google\.com)\/(?:g\/)?collect|^https?:\/\/(?:[^/]*\.)?(?:doubleclick\.net|googleadservices\.com)\/|^https?:\/\/(?:www\.)?google\.com\/(?:pagead|ccm)\//;
const UET_HIT = /^https?:\/\/bat\.bing\.com\/action\//;
const GOOGLE_TAG_SCRIPT = /^https?:\/\/(?:www\.)?googletagmanager\.com\/(?:gtm\.js|gtag\/js)/;

const str = (v: unknown): string | undefined => (typeof v === 'string' && !v.startsWith('<') ? v : undefined);

/** Consent values from a (shape-redacted) object: 'granted'/'denied' strings and booleans. */
function consentValues(o: unknown, skip: ReadonlySet<string> = new Set(['wait_for_update', 'region'])): Record<string, 'granted' | 'denied'> | undefined {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
  const out: Record<string, 'granted' | 'denied'> = {};
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (skip.has(k)) continue;
    if (v === true || (typeof v === 'string' && /^(granted|true|yes|1|accepted)$/i.test(v))) out[k] = 'granted';
    else if (v === false || (typeof v === 'string' && /^(denied|false|no|0|declined|rejected)$/i.test(v))) out[k] = 'denied';
  }
  return Object.keys(out).length ? out : undefined;
}

function hasRegion(o: unknown): boolean {
  return !!o && typeof o === 'object' && !Array.isArray(o) && 'region' in (o as object);
}

/** What one recorded call told the vendor. Pure; exported for tests. */
export function interpretCall(e: Pick<ConsentApiEvent, 'api' | 'call' | 'kind' | 'args'>): Pick<ConsentApiCall, 'command' | 'action' | 'consent' | 'regional'> {
  if (e.kind === 'ready') return { action: 'ready', regional: false };
  const a = e.args ?? [];
  const a0 = str(a[0]);
  const a1 = str(a[1]);
  switch (e.api) {
    case 'google': {
      if (e.call === 'dataLayer.push') {
        const o = a[0];
        const ev = o && typeof o === 'object' && !Array.isArray(o) ? str((o as Record<string, unknown>).event) : undefined;
        return { command: ev, action: ev ? 'measure' : 'other', regional: false };
      }
      if (a0 === 'consent' && (a1 === 'default' || a1 === 'update')) return { command: `consent ${a1}`, action: a1, consent: consentValues(a[2]), regional: hasRegion(a[2]) };
      if (a0 === 'config' || a0 === 'event') return { command: a0, action: 'measure', regional: false };
      if (a0 === 'get') return { command: a0, action: 'read', regional: false };
      return { command: a0, action: 'other', regional: false };
    }
    case 'microsoft-uet': {
      if (a0 === 'consent' && (a1 === 'default' || a1 === 'update')) return { command: `consent ${a1}`, action: a1, consent: consentValues(a[2]), regional: false };
      if (a0 === 'event' || a0 === 'pageLoad') return { command: a0, action: 'measure', regional: false };
      return { command: a0, action: 'other', regional: false };
    }
    case 'meta': {
      if (a0 === 'consent' && a1 === 'grant') return { command: 'consent grant', action: 'grant', regional: false };
      if (a0 === 'consent' && a1 === 'revoke') return { command: 'consent revoke', action: 'revoke', regional: false };
      if (a0 && /^(init|track|trackCustom|trackSingle|trackSingleCustom)$/.test(a0)) return { command: a0, action: 'measure', regional: false };
      return { command: a0, action: 'other', regional: false };
    }
    case 'tiktok': {
      if (e.call === 'ttq.grantConsent') return { command: 'grantConsent', action: 'grant', regional: false };
      if (e.call === 'ttq.revokeConsent') return { command: 'revokeConsent', action: 'revoke', regional: false };
      if (e.call === 'ttq.holdConsent') return { command: 'holdConsent', action: 'hold', regional: false };
      return { action: 'other', regional: false };
    }
    case 'clarity': {
      if (a0 === 'consentv2') {
        const consent = consentValues(a[1]);
        return { command: a0, action: consent ? 'update' : 'other', consent, regional: false };
      }
      if (a0 === 'consent') return { command: a0, action: a[1] === false ? 'revoke' : 'grant', regional: false };
      if (a0 && /^(event|set|identify|upgrade)$/.test(a0)) return { command: a0, action: 'measure', regional: false };
      return { command: a0, action: 'other', regional: false };
    }
    case 'shopify': {
      const m = e.call.replace(/^Shopify\.customerPrivacy\./, '');
      if (m === 'setTrackingConsent') {
        // Current API: an object of booleans; older API: a single boolean.
        const consent = typeof a[0] === 'boolean' ? { all: a[0] ? ('granted' as const) : ('denied' as const) } : consentValues(a[0]);
        return { command: m, action: consent ? 'update' : 'other', consent, regional: false };
      }
      return { command: m, action: 'read', regional: false };
    }
    case 'tcf':
    case 'gpp':
      return { command: a0, action: 'read', regional: false };
  }
}

// Consent Mode types for strictly necessary storage: granting them by default is
// the documented norm (security_storage), not a grant of anything that needs consent.
const NECESSARY_TYPES: ReadonlySet<string> = new Set(['security_storage']);
const isNecessaryType = (k: string): boolean => NECESSARY_TYPES.has(k.toLowerCase());

/** Every recorded consent-API call with what it told the vendor and its consent phase. */
export function consentApiCalls(timeline: Timeline): ConsentApiCall[] {
  const { events } = timeline;
  const banner = events.find((e) => e.type === 'banner' && e.state === 'shown');
  const choices = events.filter((e): e is ChoiceEvent => e.type === 'choice').sort((a, b) => a.t - b.t);
  const out: ConsentApiCall[] = [];
  for (const e of events) {
    if (e.type !== 'consent-api') continue;
    const it = interpretCall(e);
    const entries = it.consent ? Object.entries(it.consent) : [];
    out.push({
      t: e.t,
      api: e.api,
      call: e.call,
      kind: e.kind,
      ...it,
      grants: it.action === 'grant' || entries.some(([k, v]) => v === 'granted' && !isNecessaryType(k)),
      denies: it.action === 'revoke' || it.action === 'hold' || entries.some(([, v]) => v === 'denied'),
      phase: phaseAt(e.t, banner?.t, choices),
      pageIndex: e.pageIndex,
      frameUrl: e.frameUrl,
      top: e.top,
      chain: e.chain,
      args: e.args,
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

function describeValues(c: ConsentApiCall, which: 'granted' | 'denied'): string {
  const keys = Object.entries(c.consent ?? {})
    .filter(([k, v]) => v === which && !(which === 'granted' && isNecessaryType(k)))
    .map(([k]) => k);
  return keys.length ? ` (${keys.join(', ')})` : '';
}

/** What the vendor had last been told before time t: granted, denied, or nothing. */
function toldBefore(calls: ConsentApiCall[], t: number): { state: 'granted' | 'denied' | 'unset'; call?: ConsentApiCall } {
  let last: ConsentApiCall | undefined;
  for (const c of calls) if (c.t < t && CONSENT_ACTIONS.has(c.action) && !c.regional && (c.grants || c.denies)) last = c;
  if (!last) return { state: 'unset' };
  return { state: last.grants ? 'granted' : 'denied', call: last };
}

export function analyzeConsentApi(timeline: Timeline): ConsentApiAnalysis {
  const calls = consentApiCalls(timeline);
  const apis = [...new Set(calls.map((c) => c.api))];
  const states: ConsentApiState[] = [];
  const unknowns: string[] = [];
  const choices = timeline.events.filter((e): e is ChoiceEvent => e.type === 'choice' && e.ok).sort((a, b) => a.t - b.t);
  const requests = timeline.events.filter((e): e is RequestEvent => e.type === 'request');
  const byApi = (api: ConsentApiName): ConsentApiCall[] => calls.filter((c) => c.api === api);

  // 1. Default set after the library was running / had measured (per document).
  for (const api of ['google', 'microsoft-uet'] as const) {
    const list = byApi(api);
    if (!list.length) continue;
    const hit = api === 'google' ? GOOGLE_HIT : UET_HIT;
    const docs = new Map<string, ConsentApiCall[]>();
    for (const c of list) {
      const k = `${c.pageIndex}|${c.frameUrl}`;
      docs.set(k, [...(docs.get(k) ?? []), c]);
    }
    let flagged = false;
    let missing = 0;
    for (const doc of docs.values()) {
      const def = doc.find((c) => c.action === 'default');
      if (!def) {
        if (doc.some((c) => c.action === 'measure' || c.action === 'ready')) missing++;
        continue;
      }
      if (flagged) continue;
      // A default issued by the Google tag itself (a Consent Initialization
      // trigger inside the container) runs before the container's other
      // triggers; only a hit already sent is evidence against it.
      const fromContainer = api === 'google' && def.chain.some((u) => GOOGLE_TAG_SCRIPT.test(u));
      const earlier = doc.slice(0, doc.indexOf(def));
      const ready = fromContainer ? undefined : earlier.find((c) => c.action === 'ready');
      const measured = fromContainer ? undefined : earlier.find((c) => c.action === 'measure');
      const sent = requests.find((r) => r.pageIndex === def.pageIndex && r.t < def.t && hit.test(r.url));
      if (!ready && !measured && !sent) continue;
      flagged = true;
      const why = sent
        ? `a request to ${new URL(sent.url).host} had already been sent`
        : ready
          ? `the ${api === 'google' ? 'Google tag' : 'UET tag'} had already loaded and taken over its queue`
          : `a '${measured!.command ?? measured!.call}' command had already run`;
      states.push({
        state: 'default-after-load',
        api,
        t: def.t,
        phase: def.phase,
        reason: `${CONSENT_API_LABEL[api]}: the consent default was set ${Math.round(def.t)} ms into the visit, after ${why}; whatever ran before it was not governed by the default.`,
        calls: [...(ready ? [ready] : []), ...(measured ? [measured] : []), def],
      });
    }
    if (missing) {
      unknowns.push(
        api === 'google'
          ? `Google tag present on ${missing} document(s) with no Consent Mode default seen through gtag() or dataLayer; a default set inside the container by a consent template is not visible to the recorder.`
          : `Microsoft UET present on ${missing} document(s) with no consent default seen through uetq.push.`,
      );
    }
  }

  // 2. Never told after a refusal, while the vendor was running.
  const refusal = [...choices].reverse().find((c) => REFUSALS.has(c.choice));
  if (refusal) {
    for (const api of apis) {
      if (!CONTROL_APIS.has(api)) continue;
      const list = byApi(api);
      // Running at the refusal: on the page where the choice was made, or any time after.
      const running = list.some((c) => c.t >= refusal.t || c.pageIndex === refusal.pageIndex);
      if (!running) continue;
      // A call that denies anything counts as told; a grant mixed into it is state 3's to report.
      const after = list.filter((c) => c.t >= refusal.t && CONSENT_ACTIONS.has(c.action) && c.denies);
      if (after.length) continue;
      const before = toldBefore(list, refusal.t);
      if (before.state === 'denied') continue;
      const label = CONSENT_API_LABEL[api];
      states.push({
        state: 'not-called-after-refusal',
        api,
        t: refusal.t,
        phase: `after-${refusal.choice}` as Phase,
        reason:
          before.state === 'granted'
            ? `${label}: told 'granted' at ${Math.round(before.call!.t)} ms${describeValues(before.call!, 'granted')}, and never told otherwise after the visitor chose '${refusal.choice}' at ${Math.round(refusal.t)} ms.`
            : `${label}: running when the visitor chose '${refusal.choice}' at ${Math.round(refusal.t)} ms, and its consent API was never called — not before, not after.`,
        calls: before.call ? [before.call] : [],
      });
    }
  }

  // 3. Told 'granted' with nothing consented to.
  for (const api of apis) {
    if (!CONTROL_APIS.has(api)) continue;
    const list = byApi(api);
    const regional = list.filter((c) => c.grants && c.regional && UNCONSENTED.has(c.phase));
    if (regional.length) unknowns.push(`${CONSENT_API_LABEL[api]}: a region-scoped consent command granted something before consent; whether it applied to this visitor's region is not decided here.`);
    const bad = list.filter((c) => c.grants && !c.regional && CONSENT_ACTIONS.has(c.action) && UNCONSENTED.has(c.phase));
    if (!bad.length) continue;
    const first = bad[0];
    const how = first.action === 'default' ? 'a default of' : first.action === 'update' ? 'an update to' : 'a grant:';
    states.push({
      state: 'grant-on-load',
      api,
      t: first.t,
      phase: first.phase,
      reason: `${CONSENT_API_LABEL[api]}: ${how} 'granted'${describeValues(first, 'granted')} at ${Math.round(first.t)} ms (${first.call}), ${PHASE_LABEL[first.phase]}.`,
      calls: bad,
    });
  }

  return { calls, apis, states, unknowns };
}

// --- The persisted summary (TrackingEvaluation.consentApi) ---------------------------

const LISTED_ACTIONS: ReadonlySet<ConsentAction> = new Set<ConsentAction>(['default', 'update', 'grant', 'revoke', 'hold', 'ready']);

/**
 * The record-shaped summary of one timeline's consent-API activity: the
 * consent-bearing calls (and the "loaded" moments), the derived states, and the
 * unknowns. Measurement calls are counted in `calls`, not listed. Pure.
 */
export function summarizeConsentApi(timeline: Timeline): ConsentApiObservation {
  const a = analyzeConsentApi(timeline);
  return {
    location: timeline.snapshot.locationId,
    scenario: timeline.snapshot.scenario,
    ...(timeline.snapshot.run !== undefined ? { run: timeline.snapshot.run } : {}),
    apis: a.apis,
    calls: a.calls.length,
    consentCalls: a.calls
      .filter((c) => LISTED_ACTIONS.has(c.action))
      .map((c) => ({
        t: c.t,
        api: c.api,
        call: c.call,
        ...(c.command !== undefined ? { command: c.command } : {}),
        action: c.action,
        phase: c.phase,
        ...(c.consent ? { consent: c.consent } : {}),
        grants: c.grants,
        denies: c.denies,
        regional: c.regional,
        pageIndex: c.pageIndex,
      })),
    states: a.states.map((s) => ({ state: s.state, api: s.api, t: s.t, phase: s.phase, reason: s.reason })),
    unknowns: a.unknowns,
  };
}
