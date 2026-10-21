// The public API on the `ComplyKit` global (ticket D3) and the one store
// instance the page runs on.
//
//   ComplyKit.get()                  → ConsentState, or null when the tool is not
//                                      running (no config, or a refused one)
//   ComplyKit.on('change', fn)       → unsubscribe; also 'open' and 'withdraw'.
//                                      Listeners added before the store exists are
//                                      kept and attached when it starts.
//   ComplyKit.open()                 → asks the banner (D9) to show its settings
//   ComplyKit.setRegion('US-CA')     → true; tells the tool where the visitor is after load
//                                      (false, nothing changed: not a location, or not running)
//   ComplyKit.withdraw()             → every non-necessary category denied, a
//                                      record sent, 'withdraw' emitted
//
// Internal modules get the store with `whenStore(fn)` (called now, or when the
// store starts). `init(config, regime)` starts it explicitly (once: a second
// call returns the running store); `autoInit()`
// reads the inline config the snippet carries:
//   <script type="application/json" id="complykit-config">{…}</script>
//   (or `data-complykit-config` on such a script, or `window.ComplyKitConfig`)
// A config the guard refuses ⇒ nothing starts, gated scripts stay inert.

import { CONSENT_CONFIG_ELEMENT_ID, guardConsentToolConfig, type ConsentToolConfig, type Regime } from './config.js';
import { createStore, type ConsentState, type ConsentStore, type Listener, type StoreEvent, type StoreOptions } from './store.js';
import { TOOL_VERSION } from './version.js';
import { resolveLocation, readGpc } from './location.js';
import { regimeFor, parseRegimeLocation } from '../../src/registry/regime.js';
import { overriddenRegime } from './config.js';
import { diagnostics } from './diagnostics.js';
import { report } from './events.js';

let store: ConsentStore | undefined;
let config: ConsentToolConfig | undefined;
const pending: Array<[StoreEvent, Listener, { off?: () => void }]> = [];
/** Settles when a pending location lookup has answered or timed out; undefined when none is outstanding. */
/** setRegion() ran: a pending header lookup's late answer must not move the store. */
let regionSet = false;
let locationWait: Promise<void> | undefined;
export const locationPending = (): Promise<void> | undefined => locationWait;
const waiting: Array<(s: ConsentStore) => void> = [];

/**
 * Start the store on a config (already guarded or not). Returns undefined when
 * the guard refuses it. Once a store runs, a second call is refused and returns
 * that store: the gate, adapters, bridges and withdrawal flow subscribe once
 * (whenStore), so a replacement store would run with nothing listening.
 */
export function init(raw: unknown, regime?: Regime, opts: StoreOptions = {}): ConsentStore | undefined {
  if (store) {
    if (typeof console !== 'undefined') console.warn('[complykit] already started; init() ignored');
    return store;
  }
  const g = guardConsentToolConfig(raw);
  if (!g.ok) {
    if (typeof console !== 'undefined') console.warn(`[complykit] config refused (${g.reason}): ${g.detail}`);
    return undefined;
  }
  config = g.config;
  // D7: the regime is decided before the store exists (fixed / meta / platform are
  // synchronous); a header lookup starts strict and moves the store when it answers.
  const loc = regime ? undefined : resolveLocation(config);
  const r = regime ?? loc!.initial.regime;
  locationWait = loc?.initial.pending ? loc.ready.then(() => undefined) : undefined;
  store = createStore(config, r, { toolVersion: TOOL_VERSION, location: loc?.initial.location, ...opts });
  if (loc?.initial.pending) {
    const started = store;
    void loc.ready.then((d) => {
      if (store === started && !regionSet) started.setRegime(d.regime, d.location);
    });
  }
  for (const p of pending) p[2].off = store.on(p[0], p[1]);
  for (const fn of waiting.splice(0)) fn(store);
  return store;
}

/** Find the inline config in the page; undefined when there is none or it is not JSON. */
export function findInlineConfig(): unknown {
  if (typeof document === 'undefined') return undefined;
  const el = document.querySelector(`script#${CONSENT_CONFIG_ELEMENT_ID}[type="application/json"], script[type="application/json"][data-complykit-config]`);
  if (el?.textContent) {
    try {
      return JSON.parse(el.textContent);
    } catch {
      return undefined;
    }
  }
  return (window as { ComplyKitConfig?: unknown }).ComplyKitConfig;
}

export function autoInit(): ConsentStore | undefined {
  if (store) return store;
  const raw = findInlineConfig();
  return raw === undefined ? undefined : init(raw);
}

/** Run fn with the store now, or once it starts. */
export function whenStore(fn: (s: ConsentStore) => void): void {
  if (store) fn(store);
  else waiting.push(fn);
}

export function getStore(): ConsentStore | undefined {
  return store;
}

// The running vendor adapters (D5), kept reachable so the withdrawal flow (F3)
// can make sure the revoke has happened before it cleans up and reloads.
let adapters: { sync(): void } | undefined;
export const setAdapters = (a: { sync(): void }): void => {
  adapters = a;
};
export const getAdapters = (): { sync(): void } | undefined => adapters;

/** The guarded config the store runs on (the gate needs its category and gate lists). */
export function getConfig(): ConsentToolConfig | undefined {
  return config;
}

export function get(): ConsentState | null {
  return store ? store.state() : null;
}

export function on(event: StoreEvent, fn: Listener): () => void {
  const entry: [StoreEvent, Listener, { off?: () => void }] = [event, fn, {}];
  pending.push(entry);
  if (store) entry[2].off = store.on(event, fn);
  return () => {
    const i = pending.indexOf(entry);
    if (i >= 0) pending.splice(i, 1);
    entry[2].off?.();
  };
}

/**
 * Tell the tool where the visitor is (`'US-CA'`, `'DE'`). Replaces what was decided, and a pending header
 * lookup's late answer is then ignored; a stored choice is never changed. Scripts released before the call cannot
 * be unrun, so prefer `window.ComplyKitRegion` before the script. False (nothing changed) for a value that is
 * not a location, or when the tool is not running.
 */
export function setRegion(value: unknown): boolean {
  const location = parseRegimeLocation(value);
  if (!location || !store || !config) return false;
  const o = config.regimeSource.kind === 'fixed' ? undefined : overriddenRegime(config, location);
  const regime = config.regimeSource.kind === 'fixed' ? config.regimeSource.regime : o ?? regimeFor(location);
  regionSet = true;
  store.setRegime(regime, location);
  diagnostics.location = { source: 'api', regime, location, pending: false, gpc: readGpc(), overridden: o !== undefined };
  return true;
}

export function open(): void {
  store?.open();
}

export function withdraw(): ConsentState | null {
  return store ? store.withdraw() : null;
}

/**
 * Add-on mode: set the store from the site's own banner choice (`{ categoryId: granted }`; a category left
 * out keeps its current value). A change of grants is reported as a decision `via: 'cmp'`, unless `initial` (the
 * first state learned from the banner on a page is applied, not a decision). Returns null (and does
 * nothing) when the tool is not running in add-on mode: in full mode the visitor's choice is complykit's own.
 */
export function sync(choice: Record<string, boolean>, initial?: boolean): ConsentState | null {
  if (!store || config?.mode !== 'companion') return null;
  const before = store.state().categories;
  const s = store.set({ ...before, ...choice });
  if (!initial && Object.keys(before).some((k) => before[k] !== s.categories[k])) report({ t: 'decide', action: 'save', via: 'cmp', categories: s.categories });
  return s;
}
