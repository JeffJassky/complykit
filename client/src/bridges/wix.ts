// Wix consent policy bridge (ticket E3). Makes pixels that the Wix dashboard
// injects itself (Marketing Integrations and the like) obey the visitor's
// choice through Wix's own consent policy, because the tool cannot gate a
// script Wix injects.
//
// What the Wix docs say (dev.wix.com, read 2026-10-06) and what we rely on:
//   - `window.consentPolicyManager` has getCurrentConsentPolicy() →
//     { defaultPolicy, policy: { essential, functional, analytics, advertising,
//     dataToThirdParty }, createdDate }, setConsentPolicy(policy, onSuccess?,
//     onError?), resetConsentPolicy(), onConsentPolicyChanged(handler).
//     https://dev.wix.com/docs/go-headless/wix-managed-headless/full-integration-astro/feature-guides/manage-cookie-consent
//     https://dev.wix.com/docs/sdk/host-modules/site/consent-policy-manager/set-consent-policy
//     https://dev.wix.com/docs/sdk/host-modules/site/consent-policy-manager/get-current-consent-policy
//   - setConsentPolicy: "Setting a category changes only that category;
//     omitted categories keep their current value" and the runtime always
//     forces `essential` to true. We therefore always send all four fields.
//   - The manager is set up by a deferred Wix script, so it may not exist when
//     we run. Wix dispatches `consentPolicyManagerReady` on window the moment
//     it appears (same article). We listen for it, with a bounded poll as a
//     fallback in case the event fired before we listened.
//   - onConsentPolicyChanged(handler): handler gets { defaultPolicy, policy }
//     (https://dev.wix.com/docs/sdk/host-modules/site/consent-policy-manager/on-consent-policy-changed).
//     A document-level `consentPolicyChanged` DOM event is also mentioned in
//     the Velo reference, but its payload is not documented clearly, so we use
//     only the method.
//
// What the docs do NOT settle (so we do not pretend):
//   - "Changes to the consent policy take effect after the page is refreshed"
//     (set-consent-policy reference) and setConsentPolicy persists through a
//     network request, so Wix's own scripts on THIS page view may still see the
//     previous policy. The bridge cannot make the first view safe by itself:
//     the Wix site-level default policy must be restrictive (docs/guide/
//     platform-wix.md). We never reload the page on the visitor's behalf.
//   - Which Wix-injected scripts honour which field is not documented per
//     script; the field names are the only contract.
//
// Safety rules:
//   - A Wix field is true only when every tool category mapped to it is granted
//     in OUR store right now. A category the config does not list is denied
//     (the store's fail-closed default); an empty mapping means always false.
//   - If something else (Wix's own banner) later grants a field our store
//     denies, we set it back (bounded), and record it in diagnostics.
//   - Calls queue until the manager exists. The queue is one slot: only the
//     newest wanted policy matters, so it cannot grow.
import type { ConsentToolConfig } from '../config.js';
import { diagnostics } from '../diagnostics.js';

/** The consent policy fields Wix documents (essential is forced true by Wix). */
export const WIX_POLICY_FIELDS = ['functional', 'analytics', 'advertising', 'dataToThirdParty'] as const;
export type WixPolicyField = (typeof WIX_POLICY_FIELDS)[number];
export type WixPolicy = Record<WixPolicyField, boolean> & { essential: true };

/** field → the category ids that must ALL be granted for it to be true. */
export type WixCategoryMap = Record<WixPolicyField, readonly string[]>;

/**
 * Defaults. dataToThirdParty is Wix's CCPA "sale/share" switch (Wix's about-
 * the-consent-policy page ties it to third-party data transfer), so it follows
 * advertising. Unclear in the docs; override with `map` if the site differs.
 */
export const DEFAULT_WIX_MAP: WixCategoryMap = {
  functional: ['functional'],
  analytics: ['analytics'],
  advertising: ['advertising'],
  dataToThirdParty: ['advertising'],
};

export const WIX_READY_EVENT = 'consentPolicyManagerReady';

/** The slice of the state store (ticket D3) the bridge needs. */
export interface WixStoreLike {
  isGranted(categoryId: string): boolean;
  subscribe(fn: () => void): (() => void) | void;
}

/** The slice of Wix's manager we call. */
export interface WixConsentPolicyManager {
  getCurrentConsentPolicy?(): { defaultPolicy?: boolean; policy?: Partial<Record<WixPolicyField | 'essential', boolean>> } | undefined;
  setConsentPolicy(policy: Partial<WixPolicy>, onSuccess?: (d: unknown) => void, onError?: (e: unknown) => void): unknown;
  onConsentPolicyChanged?(handler: (e: { policy?: Partial<Record<WixPolicyField, boolean>> }) => void): unknown;
}

export interface WixBridgeOptions {
  /** Override part of the field → categories map. */
  map?: Partial<WixCategoryMap>;
  /** The window to look at. Default globalThis. */
  win?: Record<string, any>;
  /** Fallback poll for the manager, ms. Default 250. */
  pollMs?: number;
  /** Give up waiting for the manager after this many ms. Default 15000. */
  waitMs?: number;
  /** Failed set attempts tolerated per wanted policy. Default 3. */
  maxRetries?: number;
  /** Times we put a field back after someone else granted it. Default 5. */
  maxReasserts?: number;
}

export interface WixDiagnostics {
  /** Why the bridge is on: the config says Wix, or the Wix API was found. */
  activatedBy: 'config' | 'api';
  /** The manager was found (immediately or later). */
  managerSeen: boolean;
  /** Last policy we asked Wix to store. */
  lastSet?: Record<WixPolicyField, boolean>;
  sets: number;
  failures: number;
  /** Times a field granted by someone else was set back. */
  reasserted: number;
  /** The wait for the manager ran out with a policy still owed. */
  gaveUp: boolean;
  notes: string[];
}

export interface WixBridge {
  diagnostics: WixDiagnostics;
  /** The policy the store wants right now. */
  desired(): Record<WixPolicyField, boolean>;
  /** Re-check the manager now (tests; harmless otherwise). */
  flush(): void;
  stop(): void;
}

/** Whether the Wix API is on the page now. */
export function wixManagerOf(w: Record<string, any>): WixConsentPolicyManager | undefined {
  const m = w.consentPolicyManager;
  return m && typeof m.setConsentPolicy === 'function' ? m : undefined;
}

/** The policy to store: every field true only when all its categories are granted. */
export function wixPolicyFor(store: Pick<WixStoreLike, 'isGranted'>, map: WixCategoryMap = DEFAULT_WIX_MAP): Record<WixPolicyField, boolean> {
  const out = {} as Record<WixPolicyField, boolean>;
  for (const f of WIX_POLICY_FIELDS) {
    const cats = map[f] ?? [];
    out[f] = cats.length > 0 && cats.every((c) => store.isGranted(c));
  }
  return out;
}

const same = (a: Record<WixPolicyField, boolean>, b: Partial<Record<WixPolicyField, boolean>> | undefined) => !!b && WIX_POLICY_FIELDS.every((f) => a[f] === b[f]);

/**
 * Installs the bridge. Returns undefined (does nothing) unless the config says
 * `platform: 'wix'` or the Wix API is already on the page.
 */
export function installWixBridge(config: ConsentToolConfig, store: WixStoreLike, opts: WixBridgeOptions = {}): WixBridge | undefined {
  const w = opts.win ?? ((globalThis as any).window as Record<string, any> | undefined) ?? (globalThis as Record<string, any>);
  const byConfig = config.platform === 'wix';
  if (!byConfig && !wixManagerOf(w)) return undefined;

  const map: WixCategoryMap = { ...DEFAULT_WIX_MAP, ...opts.map };
  const pollMs = opts.pollMs ?? 250;
  const waitMs = opts.waitMs ?? 15_000;
  const maxRetries = opts.maxRetries ?? 3;
  const maxReasserts = opts.maxReasserts ?? 5;

  const diag: WixDiagnostics = { activatedBy: byConfig ? 'config' : 'api', managerSeen: false, sets: 0, failures: 0, reasserted: 0, gaveUp: false, notes: [] };
  diagnostics.wix = diag;

  let owed = true; // the initial decision is always owed
  let attempts = 0;
  let listening = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let startedAt = Date.now();
  let stopped = false;
  let unsub: (() => void) | void;
  let readyHandler: (() => void) | undefined;

  const desired = () => wixPolicyFor(store, map);

  const clearWait = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    if (readyHandler && typeof w.removeEventListener === 'function') w.removeEventListener(WIX_READY_EVENT, readyHandler);
    readyHandler = undefined;
  };

  function listen(m: WixConsentPolicyManager) {
    if (listening || typeof m.onConsentPolicyChanged !== 'function') return;
    listening = true;
    try {
      m.onConsentPolicyChanged((e) => {
        if (stopped) return;
        // Something changed the policy (our own set echoes back equal and is ignored).
        const want = desired();
        const got = e?.policy;
        if (!got) return;
        const over = WIX_POLICY_FIELDS.filter((f) => got[f] === true && !want[f]);
        if (over.length === 0) return;
        if (diag.reasserted >= maxReasserts) {
          diag.notes.push(`Wix granted ${over.join(', ')} against the visitor's choice; gave up setting it back after ${maxReasserts} tries (is Wix's own banner still on?).`);
          return;
        }
        diag.reasserted++;
        diag.notes.push(`Something else granted ${over.join(', ')}; set back to denied (is Wix's own banner still on?).`);
        owed = true;
        attempts = 0;
        apply();
      });
    } catch (err) {
      diag.notes.push(`onConsentPolicyChanged threw: ${String(err)}`);
    }
  }

  function apply() {
    if (stopped || !owed) return;
    const m = wixManagerOf(w);
    if (!m) return;
    diag.managerSeen = true;
    clearWait();
    listen(m);
    const want = desired();
    // Skip the call when Wix already holds exactly this, explicitly set for the visitor.
    let current: ReturnType<NonNullable<WixConsentPolicyManager['getCurrentConsentPolicy']>>;
    try {
      current = m.getCurrentConsentPolicy?.();
    } catch {
      current = undefined;
    }
    if (current && current.defaultPolicy === false && same(want, current.policy)) {
      owed = false;
      diag.lastSet = want;
      return;
    }
    try {
      // Every field, always: omitted fields would keep their current (maybe granted) value.
      m.setConsentPolicy(
        { essential: true, ...want },
        () => {},
        (err) => fail(err, want),
      );
      diag.sets++;
      diag.lastSet = want;
      owed = false;
    } catch (err) {
      fail(err, want);
    }
  }

  function fail(err: unknown, want: Record<WixPolicyField, boolean>) {
    diag.failures++;
    diag.notes.push(`setConsentPolicy failed: ${String(err)}`);
    attempts++;
    // The store may have moved on: only retry for what is wanted now.
    if (attempts < maxRetries) {
      owed = true;
      setTimeout(apply, pollMs);
    } else {
      owed = false;
      diag.notes.push(`gave up after ${maxRetries} failed attempts; Wix may still hold a more permissive policy than ${JSON.stringify(want)}.`);
    }
  }

  function wait() {
    if (stopped || timer !== undefined || wixManagerOf(w)) return;
    startedAt = Date.now();
    if (typeof w.addEventListener === 'function' && !readyHandler) {
      readyHandler = () => apply();
      w.addEventListener(WIX_READY_EVENT, readyHandler, { once: true });
    }
    timer = setInterval(() => {
      if (wixManagerOf(w)) return apply();
      if (Date.now() - startedAt >= waitMs) {
        diag.gaveUp = owed;
        if (owed) diag.notes.push(`consentPolicyManager did not appear within ${waitMs} ms; the choice was NOT sent to Wix.`);
        clearWait();
      }
    }, pollMs);
  }

  function flush() {
    if (wixManagerOf(w)) apply();
    else if (owed) wait();
  }

  unsub = store.subscribe(() => {
    owed = true;
    attempts = 0;
    diag.gaveUp = false;
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
      if (typeof unsub === 'function') unsub();
    },
  };
}
