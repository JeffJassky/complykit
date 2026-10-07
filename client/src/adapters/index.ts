// Vendor consent-API adapters (ticket D5; design §2 mechanism 2, §9 decision 3).
//
// Tells already-loaded vendors the visitor's choice in their own language. It
// is ADDITIVE: the gate (type="text/plain" data-category) is the control, and
// nothing here ever releases a gated script, in any regime. In opt-in regimes a
// vendor is gated AND told; an adapter is never the reason something runs.
//
// Adapter ids — the vocabulary of `vendors[].adapter` (only read when
// `control` is 'api'). Each implements exactly the calls in the KB's control
// facts (src/registry/kb/control.ts, CONTROL_FACTS[<kb id>].api):
//
//   google-consent-mode  google.analytics, google.ads.ccm, google.ads.doubleclick
//                        gtag('consent','default'|'update', {...signals})
//   meta                 meta.pixel        fbq('consent','revoke'|'grant')
//   tiktok               tiktok.pixel      ttq.holdConsent() / grantConsent() / revokeConsent()
//   microsoft-uet        microsoft.uet     uetq.push('consent','default'|'update', {ad_storage})
//   microsoft-clarity    microsoft.clarity clarity('consentv2', {ad_Storage, analytics_Storage})
//   pinterest            pinterest.tag     pintrk('setconsent', true|false)
//   none                 explicit no-op (the vendor is gated only)
//
// An id this build does not know is treated as `none` and reported in
// diagnostics (a newer-minor config may name one); the gate still applies.
//
// Lifecycle per adapter: at start the hold (deny) if the vendor documents one,
// then the current state; on every store change the new state. Calls are
// idempotent — an adapter that is already granted is not granted again. The
// vendor's state for one adapter is granted only when EVERY vendor using it is
// in a granted category (fail closed).
//   initial denied:  hold            (no documented hold: revoke)
//   initial granted: hold, grant     (no documented hold: grant)
//   granted → denied: revoke         denied → granted: grant
//
// A vendor global that does not exist yet (gated, or loading) is waited for:
// the wanted state is kept and the global is polled every `pollMs` for
// `pollFor` ms after each change (defaults 100 ms / 10 s); `flush()` re-checks
// at any time (the gate may call it after a released script loads). When the
// global appears, the calls still owed run in order. We poll instead of
// defining the global ourselves: Meta's base code skips loading when `fbq`
// already exists (`if(f.fbq)return`), so a stub of ours would stop the pixel.
// Only globals whose docs say to pre-create them are created: `uetq` (UET's
// hold is documented as `window.uetq = window.uetq || []`) and the data layer.
import { CONSENT_ADAPTER_IDS, type ConsentToolConfig, type ConsentVendor, type Regime } from '../config.js';
import { diagnostics } from '../diagnostics.js';
import {
  GOOGLE_VENDOR_SIGNALS,
  consentModeDefaulted,
  consentSync,
  gtagCommandsBefore,
  signalsFromMap,
  type ConsentModeMap,
} from './google.js';

/** The id vocabulary, shared with the config schema (src/record/consent-config-guard.ts). */
export const ADAPTER_IDS = CONSENT_ADAPTER_IDS;
export type AdapterId = (typeof ADAPTER_IDS)[number];

/** The slice of the state store (ticket D3) the adapters need. */
export interface AdapterStore {
  isGranted(categoryId: string): boolean;
  subscribe(fn: () => void): (() => void) | void;
}

type Step = 'hold' | 'grant' | 'revoke';
type W = Record<string, any>;

/**
 * One vendor API. `call` returns false when the global (or the method) is not
 * there yet — the step is then owed, not dropped. `hold` is absent when the
 * vendor documents none.
 */
export interface AdapterSpec {
  /** KB entries whose control facts this implements. */
  kb: readonly string[];
  hold?: (w: W) => boolean;
  grant: (w: W) => boolean;
  revoke: (w: W) => boolean;
}

const fn = (w: W, name: string): ((...a: unknown[]) => unknown) | undefined => (typeof w[name] === 'function' ? w[name] : undefined);

// Meta: https://developers.facebook.com/docs/meta-pixel/implementation/gdpr
// hold = fbq('consent','revoke') (before fbq('init')); grant / revoke.
const fbq = (arg: 'grant' | 'revoke') => (w: W) => {
  const f = fn(w, 'fbq');
  if (!f) return false;
  f('consent', arg);
  return true;
};

// TikTok: https://business-api.tiktok.com/portal/docs/pixel-cookie-consent-mode/v1.3
// The base code must list the three methods in ttq.methods or they are not
// queued; until a method exists on ttq the step stays owed.
const ttq = (method: 'holdConsent' | 'grantConsent' | 'revokeConsent') => (w: W) => {
  const t = w.ttq;
  if (!t || typeof t[method] !== 'function') return false;
  t[method]();
  return true;
};

// Microsoft UET: https://help.ads.microsoft.com/apex/index/3/en/60119
// With no default UET assumes granted, so the hold creates the queue as documented.
const uet = (command: 'default' | 'update', value: 'granted' | 'denied') => (w: W) => {
  w.uetq = w.uetq || [];
  w.uetq.push('consent', command, { ad_storage: value });
  return true;
};

// Microsoft Clarity: https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-consent-api-v2
// No documented hold (the project setting runs it cookieless until granted).
const clarity = (value: 'granted' | 'denied') => (w: W) => {
  const f = fn(w, 'clarity');
  if (!f) return false;
  f('consentv2', { ad_Storage: value, analytics_Storage: value });
  return true;
};

// Pinterest: https://help.pinterest.com/en/business/article/install-the-base-code
const pintrk = (value: boolean) => (w: W) => {
  const f = fn(w, 'pintrk');
  if (!f) return false;
  f('setconsent', value);
  return true;
};

/** Every adapter but Google Consent Mode (shared with the GTM bridge, google.ts) and `none`. */
export const ADAPTERS: Readonly<Record<Exclude<AdapterId, 'google-consent-mode' | 'none'>, AdapterSpec>> = {
  meta: { kb: ['meta.pixel'], hold: fbq('revoke'), grant: fbq('grant'), revoke: fbq('revoke') },
  tiktok: { kb: ['tiktok.pixel'], hold: ttq('holdConsent'), grant: ttq('grantConsent'), revoke: ttq('revokeConsent') },
  'microsoft-uet': { kb: ['microsoft.uet'], hold: uet('default', 'denied'), grant: uet('update', 'granted'), revoke: uet('update', 'denied') },
  'microsoft-clarity': { kb: ['microsoft.clarity'], grant: clarity('granted'), revoke: clarity('denied') },
  pinterest: { kb: ['pinterest.tag'], grant: pintrk(true), revoke: pintrk(false) },
};

export const isAdapterId = (id: unknown): id is AdapterId => (ADAPTER_IDS as readonly unknown[]).includes(id);

export interface AdapterNote {
  kind:
    | 'unknown-adapter' // vendors[].adapter not in ADAPTER_IDS: treated as `none`
    | 'not-gated' // opt-in regime, control 'api', no gate rule or GTM tag covers it
    | 'consent-mode-late' // gtag('js'|'config') was queued before our default
    | 'consent-mode-unmapped'; // a Google vendor's signal is missing from gtm.consentMode
  vendor?: string;
  detail: string;
}

export interface AdapterDiagnostics {
  regime: Regime;
  /** Adapters running, with the vendors behind each. */
  active: Array<{ adapter: AdapterId; vendors: string[] }>;
  /** Steps owed to a vendor whose global has not appeared yet. */
  waiting: AdapterId[];
  notes: AdapterNote[];
}

export interface AdapterOptions {
  pollMs?: number;
  pollFor?: number;
}

export interface Adapters {
  diagnostics: AdapterDiagnostics;
  /** Re-read the store and tell every vendor (idempotent). */
  sync(): void;
  /** Retry steps owed to vendors whose global was missing. */
  flush(): void;
  stop(): void;
}

type Applied = 'none' | 'held' | 'granted' | 'denied';

/** One adapter's state machine: what the vendor was told, what it should be told. */
function runner(spec: AdapterSpec, w: W) {
  let applied: Applied = 'none';
  let want = false;
  const next = (): Step | undefined => {
    if (applied === 'none') return spec.hold ? 'hold' : want ? 'grant' : 'revoke';
    if (want) return applied === 'granted' ? undefined : 'grant';
    return applied === 'granted' ? 'revoke' : undefined; // held or denied: already denied
  };
  return {
    set(granted: boolean) {
      want = granted;
    },
    /** Run owed steps; true when nothing is owed. */
    run(): boolean {
      for (let step = next(); step; step = next()) {
        if (!spec[step]!(w)) return false;
        applied = step === 'hold' ? 'held' : step === 'grant' ? 'granted' : 'denied';
      }
      return true;
    },
  };
}

const vendorsFor = (config: ConsentToolConfig) => {
  const by = new Map<string, ConsentVendor[]>();
  for (const v of config.vendors) {
    if (v.control !== 'api' || !v.adapter) continue;
    const list = by.get(v.adapter) ?? [];
    list.push(v);
    by.set(v.adapter, list);
  }
  return by;
};

/**
 * Start the adapters for a config on the page's `window`. Runs the holds and
 * the current state synchronously — call it from the tool's script, above the
 * vendor snippets — then follows the store.
 */
export function startAdapters(config: ConsentToolConfig, regimeOf: Regime | (() => Regime), store: AdapterStore, opts: AdapterOptions = {}): Adapters {
  const regime = typeof regimeOf === 'function' ? regimeOf() : regimeOf;
  const w = window as unknown as W;
  const pollMs = opts.pollMs ?? 100;
  const pollFor = opts.pollFor ?? 10_000;
  const diag: AdapterDiagnostics = { regime, active: [], waiting: [], notes: [] };
  const gated = new Set<string>([...config.gate.map((g) => g.vendor), ...(config.gtm?.tags ?? []).map((t) => t.vendor)].filter((v): v is string => !!v));
  const runners: Array<{ id: AdapterId; vendors: ConsentVendor[]; r: ReturnType<typeof runner> }> = [];
  let googleSync: (() => void) | undefined;

  for (const [id, vendors] of vendorsFor(config)) {
    if (regime === 'opt-in') {
      for (const v of vendors) {
        if (!gated.has(v.id)) diag.notes.push({ kind: 'not-gated', vendor: v.id, detail: `${v.id} has a consent API but no gate rule or GTM tag: in an opt-in regime the API does not replace the gate.` });
      }
    }
    if (!isAdapterId(id)) {
      for (const v of vendors) diag.notes.push({ kind: 'unknown-adapter', vendor: v.id, detail: `adapter "${id}" is not known to this build; treated as "none".` });
      continue;
    }
    diag.active.push({ adapter: id, vendors: vendors.map((v) => v.id) });
    if (id === 'none') continue;
    if (id === 'google-consent-mode') {
      googleSync = google(config, vendors, store, diag);
      continue;
    }
    runners.push({ id, vendors, r: runner(ADAPTERS[id], w) });
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  let until = 0;
  const flush = () => {
    diag.waiting = runners.filter((x) => !x.r.run()).map((x) => x.id);
    if (!diag.waiting.length || Date.now() >= until) {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    }
  };
  const sync = () => {
    googleSync?.();
    for (const x of runners) x.r.set(x.vendors.every((v) => store.isGranted(v.category)));
    until = Date.now() + pollFor;
    flush();
    if (diag.waiting.length && timer === undefined) timer = setInterval(flush, pollMs);
  };

  sync();
  const unsubscribe = store.subscribe(() => sync());
  diagnostics.adapters = diag;
  return {
    diagnostics: diag,
    sync,
    flush,
    stop() {
      if (typeof unsubscribe === 'function') unsubscribe();
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}

/**
 * Google Consent Mode. With a `gtm` section the GTM bridge (gtm.ts) owns the
 * default and the updates from `gtm.consentMode`; this only checks that every
 * Google vendor's signals are mapped there. Without one, the signals come from
 * the vendors (GOOGLE_VENDOR_SIGNALS → the vendor's category) and this pushes
 * the hold (all denied) and then each change, deduplicated per data layer.
 */
function google(config: ConsentToolConfig, vendors: ConsentVendor[], store: AdapterStore, diag: AdapterDiagnostics): (() => void) | undefined {
  if (config.gtm) {
    for (const v of vendors) {
      for (const s of GOOGLE_VENDOR_SIGNALS[v.id] ?? []) {
        if (!config.gtm.consentMode[s]) diag.notes.push({ kind: 'consent-mode-unmapped', vendor: v.id, detail: `gtm.consentMode has no category for ${s}: it stays denied.` });
      }
    }
    return undefined;
  }
  const map: ConsentModeMap = {};
  for (const v of vendors) for (const s of GOOGLE_VENDOR_SIGNALS[v.id] ?? []) (map[s] ??= []).push(v.category);
  const hold = signalsFromMap(map, () => false);
  if (!consentModeDefaulted()) {
    const before = gtagCommandsBefore();
    if (before.length) diag.notes.push({ kind: 'consent-mode-late', detail: `gtag('${before.join("', '")}') was queued before the consent default; Google ignores a late default for those hits. Place the tool above the gtag snippet.` });
  }
  return () => {
    consentSync(signalsFromMap(map, (c) => store.isGranted(c)), hold);
  };
}
