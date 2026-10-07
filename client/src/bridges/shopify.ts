// Shopify Customer Privacy API bridge (ticket E1). Makes what Shopify injects
// itself (the web pixel manager's app pixels and Customer Events pixels,
// Shopify analytics, checkout) obey the visitor's choice. The script gate
// cannot hold those back; Shopify gates them on its own consent signal, so we
// write our choice into that signal.
//
// What the Shopify docs say (shopify.dev, read 2026-10-06) and what we rely on:
//   - Load: window.Shopify.loadFeatures([{name: 'consent-tracking-api',
//     version: '0.1'}], (error) => …). "When invoked without an error, the API
//     is globally available at window.Shopify.customerPrivacy."
//     https://shopify.dev/docs/api/customer-privacy
//   - setTrackingConsent({analytics, marketing, preferences, sale_of_data}, cb).
//     "You can set one or more consent signals at once": omitted fields are
//     left alone. The callback's argument is not documented (examples ignore
//     it); we treat an argument carrying `error` as a failure.
//   - currentVisitorConsent() → {analytics, marketing, preferences,
//     sale_of_data} each 'yes' | 'no' | '' (undeclared).
//   - analyticsProcessingAllowed(), marketingAllowed(),
//     preferencesProcessingAllowed(), saleOfDataAllowed(): the effective
//     answer, region default included.
//   - "For regions requiring consent, non-essential purposes are not allowed by
//     default until consent is given. For other regions, the default behavior
//     is to allow all processing purposes." Which regions require consent is
//     the store's Settings → Customer privacy → cookie banner regions.
//     https://shopify.dev/themes/trust-security/cookie-banner
//     https://help.shopify.com/en/manual/privacy-and-security/privacy/customer-privacy-settings/privacy-settings
//   - getRegion() → "USCA", "GBENG" … (ISO 3166-2 without the hyphen);
//     shouldShowBanner(), saleOfDataRegion(): read for diagnostics only.
//   - document event 'visitorConsentCollected', detail {analyticsAllowed,
//     marketingAllowed, preferencesAllowed, saleOfDataAllowed}; "published
//     only when consent changes, not when the listener is added".
//
// What the docs do NOT settle (so we do not pretend):
//   - Shopify says consent should be recorded "only on a visitor interaction …
//     never done automatically on behalf of the visitor". We follow that for
//     every GRANT. We break it in one direction only: when Shopify would allow
//     a purpose our store denies (no choice yet, but the store's banner regions
//     do not cover the visitor, which is the case once Shopify's own banner is
//     off), we record a denial for that purpose. Failing closed beats letting
//     Shopify's allow-by-default region rule grant for us.
//   - Whether turning Shopify's banner "off" also turns off the consent
//     requirement for its regions is not stated; the help page implies regions
//     outside the banner are allow-by-default. The bridge does not depend on
//     either answer: it compares against the effective *Allowed() values.
//   - When the pixel manager reads consent relative to our call on the first
//     page view is undocumented. The API loads asynchronously, so a pixel that
//     starts before it may see Shopify's region default. docs/guide/
//     platform-shopify.md says so; the proof scan is what shows it.
//
// Safety rules:
//   - A Shopify field is true only when every tool category mapped to it is
//     granted in OUR store right now (unlisted category ⇒ denied).
//     sale_of_data is also false whenever marketing is false or GPC is on.
//   - Before a visitor choice we only ever send `false`. Defaults are pushed as
//     grants only under an opt-out regime and only if `pushOptOutDefaults` is
//     set (off by default; Shopify already allows outside its banner regions).
//   - Shopify's stored consent never grants on our behalf: if it says yes (or
//     allows) where we say no, ours is pushed, also after
//     'visitorConsentCollected' (bounded).
//   - Location: D7 (location.ts) reads getRegion() only if the API was already
//     loaded. When the config's regimeSource is 'platform' and D7 found
//     nothing, we re-run D7's resolver once the API is loaded and move the
//     store's regime: one resolver, not two.
import type { ConsentToolConfig, Regime } from '../config.js';
import { diagnostics } from '../diagnostics.js';
import { resolveLocation } from '../location.js';

export const SHOPIFY_FIELDS = ['analytics', 'marketing', 'preferences', 'sale_of_data'] as const;
export type ShopifyField = (typeof SHOPIFY_FIELDS)[number];
export type ShopifyConsent = Record<ShopifyField, boolean>;

/** field → the category ids that must ALL be granted for it to be true. */
export type ShopifyCategoryMap = Record<ShopifyField, readonly string[]>;

/**
 * Default candidates per field. Only the ids the config actually lists are
 * used; a field none of whose candidates is listed is always false.
 * preferences = Shopify's "remember country/language" purpose, which config
 * generators call functional. Override with `map` per site.
 */
export const DEFAULT_SHOPIFY_MAP: ShopifyCategoryMap = {
  analytics: ['analytics', 'statistics'],
  marketing: ['advertising', 'marketing'],
  preferences: ['functional', 'preferences', 'personalization'],
  sale_of_data: ['advertising', 'marketing'],
};

export const SHOPIFY_FEATURE = { name: 'consent-tracking-api', version: '0.1' } as const;
export const SHOPIFY_CONSENT_EVENT = 'visitorConsentCollected';

const ALLOWED_METHOD: Record<ShopifyField, keyof ShopifyCustomerPrivacy> = {
  analytics: 'analyticsProcessingAllowed',
  marketing: 'marketingAllowed',
  preferences: 'preferencesProcessingAllowed',
  sale_of_data: 'saleOfDataAllowed',
};

/** The slice of the state store (D3) the bridge needs. */
export interface ShopifyStoreLike {
  isGranted(categoryId: string): boolean;
  state(): { status: 'chosen' | 'unset'; regime: Regime; gpc: boolean };
  subscribe(fn: () => void): (() => void) | void;
  setRegime?(regime: Regime): void;
}

/** The slice of window.Shopify.customerPrivacy we use. */
export interface ShopifyCustomerPrivacy {
  setTrackingConsent(consent: Partial<ShopifyConsent>, cb?: (result?: unknown) => void): unknown;
  currentVisitorConsent?(): Partial<Record<ShopifyField, 'yes' | 'no' | ''>> | undefined;
  analyticsProcessingAllowed?(): boolean;
  marketingAllowed?(): boolean;
  preferencesProcessingAllowed?(): boolean;
  saleOfDataAllowed?(): boolean;
  shouldShowBanner?(): boolean;
  saleOfDataRegion?(): boolean;
  getRegion?(): string;
}

export interface ShopifyBridgeOptions {
  /** Override part of the field → categories map (used as given, not filtered). */
  map?: Partial<ShopifyCategoryMap>;
  /** Under an opt-out regime with no choice, push the store's defaults (grants included). Default false. */
  pushOptOutDefaults?: boolean;
  /** The window to look at. Default globalThis. */
  win?: Record<string, any>;
  /** Where 'visitorConsentCollected' fires. Default win.document. */
  doc?: { addEventListener(n: string, fn: (e: any) => void): void; removeEventListener(n: string, fn: (e: any) => void): void };
  /** Poll for window.Shopify / the API, ms. Default 100. */
  pollMs?: number;
  /** Give up waiting for the API after this many ms. Default 15000. */
  waitMs?: number;
  /** Failed set attempts tolerated per wanted state. Default 3. */
  maxRetries?: number;
  /** Times we push ours back after someone else granted. Default 5. */
  maxReasserts?: number;
}

export interface ShopifyDiagnostics {
  activatedBy: 'config' | 'api';
  /** loadFeatures was called by us. */
  loadRequested: boolean;
  /** customerPrivacy was found (immediately or later). */
  apiSeen: boolean;
  /** getRegion() as Shopify reported it. */
  region?: string;
  /** shouldShowBanner(): Shopify would ask this visitor (its banner may be on). */
  shopifyWouldAsk?: boolean;
  saleOfDataRegion?: boolean;
  /** Last object we sent to setTrackingConsent. */
  lastSet?: Partial<ShopifyConsent>;
  sets: number;
  failures: number;
  reasserted: number;
  /** The wait for the API ran out with a push still owed. */
  gaveUp: boolean;
  notes: string[];
}

export interface ShopifyBridge {
  diagnostics: ShopifyDiagnostics;
  /** The full consent our store wants right now. */
  desired(): ShopifyConsent;
  /** Re-check the API now (tests; harmless otherwise). */
  flush(): void;
  stop(): void;
}

export function shopifyPrivacyOf(w: Record<string, any>): ShopifyCustomerPrivacy | undefined {
  const cp = w.Shopify?.customerPrivacy;
  return cp && typeof cp.setTrackingConsent === 'function' ? cp : undefined;
}

/** The default map narrowed to the ids this config lists, plus any override. */
export function shopifyMapFor(config: Pick<ConsentToolConfig, 'categories'>, override: Partial<ShopifyCategoryMap> = {}): ShopifyCategoryMap {
  const listed = new Set(config.categories.map((c) => c.id));
  const out = {} as ShopifyCategoryMap;
  for (const f of SHOPIFY_FIELDS) out[f] = override[f] ?? DEFAULT_SHOPIFY_MAP[f].filter((id) => listed.has(id));
  return out;
}

/** Every field true only when all its categories are granted; sale_of_data also needs marketing and no GPC. */
export function shopifyConsentFor(store: Pick<ShopifyStoreLike, 'isGranted'>, map: ShopifyCategoryMap, gpc: boolean): ShopifyConsent {
  const out = {} as ShopifyConsent;
  for (const f of SHOPIFY_FIELDS) {
    const cats = map[f] ?? [];
    out[f] = cats.length > 0 && cats.every((c) => store.isGranted(c));
  }
  out.sale_of_data = out.sale_of_data && out.marketing && !gpc;
  return out;
}

const call = <T>(cp: ShopifyCustomerPrivacy, m: keyof ShopifyCustomerPrivacy): T | undefined => {
  try {
    const fn = cp[m] as unknown;
    return typeof fn === 'function' ? (fn as () => T).call(cp) : undefined;
  } catch {
    return undefined;
  }
};

/** What Shopify will act on per field: explicitly granted, or allowed by its region default. */
function shopifyGrants(cp: ShopifyCustomerPrivacy, f: ShopifyField, explicit: Partial<Record<ShopifyField, string>>): boolean {
  if (explicit[f] === 'yes') return true;
  if (explicit[f] === 'no') return false;
  // Undeclared: the region default decides. A missing method counts as allowed (fail closed: we push a denial).
  return call<boolean>(cp, ALLOWED_METHOD[f]) !== false;
}

/**
 * Installs the bridge. Returns undefined (does nothing) unless the config says
 * `platform: 'shopify'` or window.Shopify is on the page.
 */
export function installShopifyBridge(config: ConsentToolConfig, store: ShopifyStoreLike, opts: ShopifyBridgeOptions = {}): ShopifyBridge | undefined {
  const w = opts.win ?? ((globalThis as any).window as Record<string, any> | undefined) ?? (globalThis as Record<string, any>);
  const byConfig = config.platform === 'shopify';
  if (!byConfig && !w.Shopify) return undefined;

  const map = shopifyMapFor(config, opts.map);
  const pollMs = opts.pollMs ?? 100;
  const waitMs = opts.waitMs ?? 15_000;
  const maxRetries = opts.maxRetries ?? 3;
  const maxReasserts = opts.maxReasserts ?? 5;
  const doc = opts.doc ?? (w.document && typeof w.document.addEventListener === 'function' ? w.document : undefined);

  const diag: ShopifyDiagnostics = { activatedBy: byConfig ? 'config' : 'api', loadRequested: false, apiSeen: false, sets: 0, failures: 0, reasserted: 0, gaveUp: false, notes: [] };
  diagnostics.shopify = diag;

  let attempts = 0;
  let inFlight = false;
  /** The store changed while a call was out. */
  let dirty = false;
  let ready = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let consentHandler: ((e: unknown) => void) | undefined;
  let unsub: (() => void) | void;

  const desired = () => shopifyConsentFor(store, map, store.state().gpc);

  /** What to send now, or undefined when Shopify already agrees with us. */
  function plan(cp: ShopifyCustomerPrivacy): Partial<ShopifyConsent> | undefined {
    const st = store.state();
    const want = desired();
    const explicit = call<Partial<Record<ShopifyField, string>>>(cp, 'currentVisitorConsent') ?? {};
    const full = st.status === 'chosen' || (opts.pushOptOutDefaults === true && st.regime !== 'opt-in');
    if (full) {
      // A choice exists: Shopify must hold exactly it, explicitly.
      return SHOPIFY_FIELDS.every((f) => explicit[f] === (want[f] ? 'yes' : 'no')) ? undefined : { ...want };
    }
    // No choice: only deny what Shopify would allow and we do not. Never a grant.
    const out: Partial<ShopifyConsent> = {};
    for (const f of SHOPIFY_FIELDS) if (!want[f] && shopifyGrants(cp, f, explicit)) out[f] = false;
    return Object.keys(out).length > 0 ? out : undefined;
  }

  function apply() {
    if (stopped || inFlight) return;
    const cp = shopifyPrivacyOf(w);
    if (!cp) return;
    const send = plan(cp);
    if (!send) return;
    // Belt and braces: no grant leaves here under opt-in without a choice.
    const st = store.state();
    if (st.status !== 'chosen' && st.regime === 'opt-in') for (const f of SHOPIFY_FIELDS) if (send[f] === true) delete send[f];
    if (Object.keys(send).length === 0) return;
    inFlight = true;
    let settled = false;
    const done = (result?: unknown) => {
      if (settled) return;
      settled = true;
      inFlight = false;
      const err = result && typeof result === 'object' && 'error' in result ? (result as { error: unknown }).error : undefined;
      if (err) return fail(err);
      attempts = 0;
      // The store moved while the call was out: settle on the newest. (Not
      // unconditionally: if Shopify's getters lag behind the write we would loop.)
      if (dirty) {
        dirty = false;
        apply();
      }
    };
    try {
      cp.setTrackingConsent(send, done);
      diag.sets++;
      diag.lastSet = send;
    } catch (err) {
      settled = true;
      inFlight = false;
      fail(err);
    }
  }

  function fail(err: unknown) {
    diag.failures++;
    diag.notes.push(`setTrackingConsent failed: ${String(err)}`);
    if (++attempts < maxRetries) setTimeout(apply, pollMs);
    else diag.notes.push(`gave up after ${maxRetries} failed attempts; Shopify may still allow more than the visitor chose.`);
  }

  function onConsentCollected() {
    if (stopped || inFlight) return;
    const cp = shopifyPrivacyOf(w);
    if (!cp || !plan(cp)) return; // our own echo, or nothing over-granted
    if (diag.reasserted >= maxReasserts) {
      diag.notes.push(`Shopify consent changed against the visitor's choice; gave up pushing it back after ${maxReasserts} tries (is Shopify's own banner still on?).`);
      return;
    }
    diag.reasserted++;
    diag.notes.push("Shopify's consent changed to something the visitor did not choose; pushed ours back (is Shopify's own banner still on?).");
    attempts = 0;
    apply();
  }

  function onReady(cp: ShopifyCustomerPrivacy) {
    if (ready || stopped) return;
    ready = true;
    diag.apiSeen = true;
    clearWait();
    diag.region = call<string>(cp, 'getRegion');
    diag.shopifyWouldAsk = call<boolean>(cp, 'shouldShowBanner');
    diag.saleOfDataRegion = call<boolean>(cp, 'saleOfDataRegion');
    if (diag.shopifyWouldAsk === true) diag.notes.push("shouldShowBanner() is true: if Shopify's own cookie banner is on it will ask too (turn it off; see platform-shopify guide).");
    // D7 coordination: a 'platform' regime source that found no region at start.
    if (config.regimeSource.kind === 'platform' && (!diagnostics.location || diagnostics.location.source === 'unknown') && store.setRegime) {
      const d = resolveLocation(config, { window: w as never }).initial;
      if (d.source === 'platform') store.setRegime(d.regime); // fires subscribe → apply
    }
    if (doc && !consentHandler) {
      consentHandler = onConsentCollected;
      doc.addEventListener(SHOPIFY_CONSENT_EVENT, consentHandler);
    }
    apply();
  }

  function clearWait() {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  }

  /** One step: API there → ready; loadFeatures there → ask for it; else keep waiting. */
  function probe(): boolean {
    const cp = shopifyPrivacyOf(w);
    if (cp) {
      onReady(cp);
      return true;
    }
    const lf = w.Shopify?.loadFeatures;
    if (!diag.loadRequested && typeof lf === 'function') {
      diag.loadRequested = true;
      try {
        lf.call(w.Shopify, [{ ...SHOPIFY_FEATURE }], (error?: unknown) => {
          if (error) diag.notes.push(`loadFeatures(consent-tracking-api) failed: ${String((error as { message?: unknown })?.message ?? error)}`);
          const now = shopifyPrivacyOf(w);
          if (now) onReady(now);
        });
      } catch (err) {
        diag.notes.push(`loadFeatures threw: ${String(err)}`);
      }
    }
    return false;
  }

  function wait() {
    if (stopped || ready || timer !== undefined) return;
    if (probe()) return;
    const startedAt = Date.now();
    timer = setInterval(() => {
      if (probe()) return;
      if (Date.now() - startedAt >= waitMs) {
        clearWait();
        diag.gaveUp = true;
        diag.notes.push(`Shopify customerPrivacy did not load within ${waitMs} ms; the choice was NOT sent to Shopify.`);
      }
    }, pollMs);
  }

  function flush() {
    if (ready) apply();
    else wait();
  }

  unsub = store.subscribe(() => {
    attempts = 0;
    if (inFlight) dirty = true;
    flush();
  });
  flush();

  return {
    diagnostics: diag,
    desired,
    flush,
    stop() {
      stopped = true;
      clearWait();
      if (doc && consentHandler) doc.removeEventListener(SHOPIFY_CONSENT_EVENT, consentHandler);
      if (typeof unsub === 'function') unsub();
    },
  };
}
