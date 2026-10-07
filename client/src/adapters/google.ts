// Google Consent Mode primitives (ticket D5 owns this file; D6 created the
// minimal version the GTM bridge needs — D5 extends it, keeping these two
// signatures).
//
// gtag() is nothing but `dataLayer.push(arguments)`. Google Tag Manager and
// gtag.js only treat a queue entry as a command when it is an `Arguments`
// object — a plain array `['consent', 'default', {...}]` is read as a data
// push and ignored. So the commands below push a real `arguments` object onto
// the named data layer, whether or not gtag.js has defined `window.gtag` yet,
// and whatever the site called its data layer.
import { CONSENT_MODE_SIGNALS, NECESSARY_CATEGORY, type ConsentModeSignal } from '../config.js';

export type ConsentModeValue = 'granted' | 'denied';
export type ConsentModeSignals = Partial<Record<ConsentModeSignal, ConsentModeValue>>;

export interface GtagTarget {
  /** Global name of the data layer array. Default `dataLayer`. */
  dataLayer?: string;
}

/** The data layer array, created if absent (as Google's own snippet does). */
export function dataLayerOf(name = 'dataLayer'): unknown[] {
  const w = window as unknown as Record<string, unknown>;
  if (!Array.isArray(w[name])) w[name] = [];
  return w[name] as unknown[];
}

// Pushes its own `arguments` object: the only shape GTM / gtag.js run as a command.
function gtagPush(this: unknown[], ..._args: unknown[]): void {
  // eslint-disable-next-line prefer-rest-params
  this.push(arguments);
}

function gtag(target: GtagTarget | undefined, ...args: unknown[]): void {
  gtagPush.apply(dataLayerOf(target?.dataLayer), args);
}

/**
 * `gtag('consent','default',…)`. Must run before the container / gtag.js
 * processes its first event, or tags firing on load read no default.
 * `waitForUpdate` (ms) asks tags to hold for an update before firing.
 */
export function consentDefault(signals: ConsentModeSignals, opts?: GtagTarget & { waitForUpdate?: number }): void {
  const payload: Record<string, unknown> = { ...signals };
  if (opts?.waitForUpdate !== undefined) payload.wait_for_update = opts.waitForUpdate;
  gtag(opts, 'consent', 'default', payload);
  const t = trackOf(opts);
  t.defaulted = true;
  t.last = key(signals);
}

/** `gtag('consent','update',…)`. Runtime grant and revoke both go through here. */
export function consentUpdate(signals: ConsentModeSignals, opts?: GtagTarget): void {
  gtag(opts, 'consent', 'update', { ...signals });
  trackOf(opts).last = key(signals);
}

// --- one Consent Mode state per data layer (D5) -------------------------------------
//
// The GTM bridge (D6, `gtm.ts`) and the `google-consent-mode` adapter (D5,
// adapters/index.ts) both speak Consent Mode. A page gets ONE `default`, and
// updates only when the signals change, whoever pushes them: the record below
// is per window and per data layer name, and consentDefault / consentUpdate
// write it. Split of work: with a `gtm` section in the config the bridge owns
// Consent Mode (it has `gtm.consentMode` and `wait_for_update`) and the
// adapter only checks coverage; without one (gtag.js pasted directly) the
// adapter owns it, through consentHold / consentSync below.

interface ConsentModeTrack {
  defaulted: boolean;
  /** JSON of the signals last in force (default or update). */
  last?: string;
}
const tracks = new WeakMap<object, Record<string, ConsentModeTrack>>();

function trackOf(target?: GtagTarget): ConsentModeTrack {
  const w = window as unknown as object;
  let byName = tracks.get(w);
  if (!byName) tracks.set(w, (byName = {}));
  const name = target?.dataLayer || 'dataLayer';
  return (byName[name] ??= { defaulted: false });
}

const key = (s: ConsentModeSignals) => JSON.stringify(CONSENT_MODE_SIGNALS.map((k) => s[k] ?? null));

/** True once a `consent default` went onto this data layer (from either module). */
export function consentModeDefaulted(target?: GtagTarget): boolean {
  return trackOf(target).defaulted;
}

/**
 * The adapter's hold: `gtag('consent','default', …denied)` once per page and
 * data layer (KB control facts, google.analytics / google.ads.*: "hold"). A
 * second call — or a call after the GTM bridge set its defaults — does nothing.
 * Returns whether it pushed.
 */
export function consentHold(signals: ConsentModeSignals, target?: GtagTarget): boolean {
  if (consentModeDefaulted(target)) return false;
  consentDefault(signals, target);
  return true;
}

/**
 * `gtag('consent','update', …)` only when the signals differ from what is in
 * force on this data layer (idempotent). Pushes the hold first if no default
 * exists yet — an update without a default is the misorder Google warns about.
 * Returns whether an update was pushed.
 */
export function consentSync(signals: ConsentModeSignals, hold: ConsentModeSignals, target?: GtagTarget): boolean {
  consentHold(hold, target);
  if (trackOf(target).last === key(signals)) return false;
  consentUpdate(signals, target);
  return true;
}

/**
 * Signals that are tracking by definition: never granted through `necessary`
 * (mirrors TRACKING_SIGNALS in src/record/consent-config.ts, which refuses such
 * a mapping; the client fails closed on it too).
 */
export const TRACKING_SIGNALS: readonly ConsentModeSignal[] = ['ad_storage', 'ad_user_data', 'ad_personalization', 'analytics_storage'];

/**
 * Which signals each Google KB entry reads — the keys of its `api` in
 * src/registry/kb/control.ts (consentMode([...]); sources:
 * https://developers.google.com/tag-platform/security/guides/consent,
 * https://developers.google.com/tag-platform/security/concepts/consent-mode,
 * https://support.google.com/google-ads/answer/10000067).
 */
export const GOOGLE_VENDOR_SIGNALS: Readonly<Record<string, readonly ConsentModeSignal[]>> = {
  'google.analytics': ['analytics_storage'],
  'google.ads.ccm': ['ad_storage', 'ad_user_data', 'ad_personalization'],
  'google.ads.doubleclick': ['ad_storage', 'ad_user_data', 'ad_personalization'],
};

/** signal → the categories that must ALL be granted for it. Absent / empty ⇒ denied. */
export type ConsentModeMap = Partial<Record<ConsentModeSignal, string[]>>;

/**
 * Every signal, granted only when it is mapped and every category it maps to is
 * granted. A tracking signal mapped to `necessary` is denied (fail closed).
 */
export function signalsFromMap(map: ConsentModeMap, granted: (categoryId: string) => boolean): Required<ConsentModeSignals> {
  const out = {} as Required<ConsentModeSignals>;
  for (const s of CONSENT_MODE_SIGNALS) {
    const cats = map[s] ?? [];
    const ok = cats.length > 0 && cats.every((c) => !(c === NECESSARY_CATEGORY && TRACKING_SIGNALS.includes(s)) && granted(c));
    out[s] = ok ? 'granted' : 'denied';
  }
  return out;
}

/**
 * gtag.js commands already queued on the data layer before our default
 * (`gtag('js', …)` / `gtag('config', …)` from a snippet above the tool): the
 * default lands after them and Google ignores it for those hits.
 */
export function gtagCommandsBefore(target?: GtagTarget): string[] {
  const out: string[] = [];
  for (const e of dataLayerOf(target?.dataLayer)) {
    const a = e as ArrayLike<unknown> | null;
    if (a && typeof a === 'object' && Object.prototype.toString.call(a) === '[object Arguments]' && (a[0] === 'js' || a[0] === 'config')) {
      out.push(String(a[0]));
    }
  }
  return out;
}
