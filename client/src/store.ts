// The consent state store (ticket D3): what the visitor chose, remembered
// correctly, and the one source of truth every other client module reads.
//
// API (for the gate, adapters, GTM bridge, location and banner modules):
//
//   const store = createStore(config, regime, { gpc })
//   store.state()            → ConsentState (a fresh copy; mutate freely)
//   store.isGranted(id)      → boolean; `necessary` true, an unknown id false
//   store.needsChoice()      → true while no valid choice is stored (show the banner)
//   store.subscribe(fn)      → unsubscribe; fn(state) after EVERY change of the
//                              effective grants (choice, withdrawal, regime/GPC
//                              update before a choice, another tab's choice).
//                              Not called on subscribe: read state() first.
//   store.on('change' | 'open' | 'withdraw', fn) → unsubscribe
//   store.set({ analytics: true, … })   the visitor's choice (settings layer);
//                              a category left out is DENIED, `necessary` is
//                              always granted, ids the config does not list
//                              are dropped. Persists, records, emits 'change'.
//   store.acceptAll() / store.rejectAll()
//   store.withdraw()         rejectAll + a 'withdraw' event (the full flow —
//                              cookie cleanup, adapters revoke — is F3's)
//   store.open()             emits 'open' (the banner, D9, shows its settings)
//   store.setRegime(r) / store.setGpc(b)   location arrived (D7). Only moves
//                              the defaults; a stored choice is never changed.
//
// Persistence: first-party cookie `complykit_consent` (Path=/, SameSite=Lax,
// Secure on https, Domain=config.consent.cookieDomain when set) + a localStorage mirror
// under the same key, both holding the same JSON (cookie urlencoded):
//
//   {"v":1,"id":"<random>","at":"<ISO>","configHash":"<hash>","regime":"opt-in",
//    "gpc":false,"categories":{"necessary":true,"analytics":false,…}}
//
// Written ONLY when the visitor chooses — never for defaults — so a stored
// value always means "a choice was recorded" (the scanner's decoder in
// src/record/consent-tool.ts relies on that). The cookie is the primary copy;
// the mirror restores it when the cookie was dropped (ITP, a cookie cleaner).
//
// When a stored choice stops counting (the banner asks again, defaults apply):
//   - older than config.consent.lifetimeDays (default 365, clamped to 395)
//   - the config's category SET changed (added or removed id) — a new purpose
//     needs consent, and the strict reading re-asks on any change
//   - unreadable, a different format `v`, or `at` in the future
// A changed config hash with the same category set keeps the choice; the
// state reports the hash the choice was made under.
//
// Defaults route through consentCategoryDefault() (fail closed). GPC is an
// extra deny on top: with GPC on, every non-necessary category defaults to
// denied in every regime (design §6: honored as an opt-out everywhere). A
// visitor's explicit grant still wins over GPC.

import { REGIMES, consentCategoryDefault, isNecessaryCategory, type ConsentToolConfig, type Regime } from './config.js';
import { buildRecord, sendRecord, randomId, type ConsentRecordBody } from './record.js';

export const COOKIE_NAME = 'complykit_consent';
export const STORAGE_KEY = 'complykit_consent';
export const STATE_FORMAT = 1;
/** 12 months, EU convention: the default for `config.consent.lifetimeDays`. */
export const DEFAULT_LIFETIME_DAYS = 365;
/** The schema's ceiling (13 months, the CNIL maximum); a larger value is clamped. */
export const MAX_LIFETIME_DAYS = 395;
export const CONSENT_TTL_MS = DEFAULT_LIFETIME_DAYS * 86_400_000;
/** Client clocks drift; a stored `at` further ahead than this is not trusted. */
const FUTURE_SKEW_MS = 86_400_000;

/** Why the store has no valid choice ('none' = never chosen). */
export type AskReason = 'none' | 'expired' | 'categories-changed' | 'unreadable';

export interface ConsentState {
  /** 'chosen' = a valid stored choice applies; 'unset' = defaults apply and the banner should ask. */
  status: 'chosen' | 'unset';
  /** Effective grant per config category (every listed id present). */
  categories: Record<string, boolean>;
  /** Regime the grants were decided under: the choice's, or the current one for defaults. */
  regime: Regime;
  gpc: boolean;
  /** Present when status is 'chosen'. */
  id?: string;
  at?: string;
  /** Hash of the config the choice was made under. */
  configHash?: string;
  /** Present when status is 'unset'. */
  reason?: AskReason;
}

/** The persisted shape (format 1). */
export interface StoredConsent {
  v: 1;
  id: string;
  at: string;
  configHash: string;
  regime: Regime;
  gpc: boolean;
  categories: Record<string, boolean>;
}

export type StoreEvent = 'change' | 'open' | 'withdraw';
export type Listener = (state: ConsentState) => void;

export interface StoreOptions {
  gpc?: boolean;
  now?: () => number;
  toolVersion?: string;
  /** Override the record transport (tests). */
  send?: (endpoint: string, body: ConsentRecordBody) => void;
}

export interface ConsentStore {
  state(): ConsentState;
  isGranted(categoryId: string): boolean;
  needsChoice(): boolean;
  subscribe(fn: Listener): () => void;
  on(event: StoreEvent, fn: Listener): () => void;
  set(choice: Record<string, boolean>): ConsentState;
  acceptAll(): ConsentState;
  rejectAll(): ConsentState;
  withdraw(): ConsentState;
  open(): void;
  setRegime(regime: Regime): void;
  setGpc(gpc: boolean): void;
  /** Detach the cross-tab listener (tests, re-init). */
  destroy(): void;
}

// --- persistence -------------------------------------------------------------------

function readCookie(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  for (const part of document.cookie.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === COOKIE_NAME) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

// `domain` = config.consent.cookieDomain (share the choice across subdomains);
// absent ⇒ a host-only cookie.
function cookieTail(maxAgeSec: number, domain?: string): string {
  const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : '';
  return `; Path=/${domain ? `; Domain=${domain}` : ''}; Max-Age=${maxAgeSec}; SameSite=Lax${secure}`;
}

// A Domain the browser rejects (it does not cover this host: a staging host, a
// typo, a fixture origin) silently drops the cookie, so a write is checked and
// falls back to a host-only cookie. A host-only copy left from before
// `cookieDomain` was set is removed so only one cookie of the name exists.
function writeCookie(json: string, maxAgeSec: number, domain?: string): void {
  if (typeof document === 'undefined') return;
  const value = `${COOKIE_NAME}=${encodeURIComponent(json)}`;
  if (domain) {
    document.cookie = `${COOKIE_NAME}=${cookieTail(0)}`;
    document.cookie = value + cookieTail(maxAgeSec, domain);
    if (readCookie() === json) return;
  }
  document.cookie = value + cookieTail(maxAgeSec);
}

/** Clears both the Domain and the host-only variant: either may hold the value. */
function clearCookie(domain?: string): void {
  if (typeof document === 'undefined') return;
  if (domain) document.cookie = `${COOKIE_NAME}=${cookieTail(0, domain)}`;
  document.cookie = `${COOKIE_NAME}=${cookieTail(0)}`;
}

/** `config.consent` (lifetimeDays, cookieDomain), clamped and checked again: the guard is structural only. */
function consentSettings(config: ConsentToolConfig): { ttlMs: number; cookieDomain?: string } {
  const c = config.consent as { lifetimeDays?: unknown; cookieDomain?: unknown } | undefined;
  const days = typeof c?.lifetimeDays === 'number' && c.lifetimeDays > 0 ? Math.min(c.lifetimeDays, MAX_LIFETIME_DAYS) : DEFAULT_LIFETIME_DAYS;
  const cookieDomain = typeof c?.cookieDomain === 'string' && /^[A-Za-z0-9.-]+$/.test(c.cookieDomain) ? c.cookieDomain : undefined;
  return { ttlMs: days * 86_400_000, cookieDomain };
}

// Storage access can throw (blocked site data, sandboxed frames): never fatal.
function readMirror(): string | undefined {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}
function writeMirror(json: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, json);
  } catch {
    /* cookie still holds it */
  }
}
function clearMirror(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Parse a stored value; undefined when it is not format 1. */
export function parseStored(raw: string | undefined): StoredConsent | undefined {
  if (!raw) return undefined;
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isObj(j) || j.v !== STATE_FORMAT || !isObj(j.categories)) return undefined;
  if (typeof j.id !== 'string' || typeof j.at !== 'string' || typeof j.configHash !== 'string' || !REGIMES.includes(j.regime as Regime)) return undefined;
  const categories: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(j.categories)) {
    if (typeof v !== 'boolean') return undefined;
    categories[k] = v;
  }
  return { v: 1, id: j.id, at: j.at, configHash: j.configHash, regime: j.regime as Regime, gpc: j.gpc === true, categories };
}

// --- the store ---------------------------------------------------------------------

export function createStore(config: ConsentToolConfig, regime: Regime, opts: StoreOptions = {}): ConsentStore {
  const now = opts.now ?? Date.now;
  const ids = config.categories.map((c) => c.id);
  const { ttlMs, cookieDomain } = consentSettings(config);
  const forget = (): void => {
    clearCookie(cookieDomain);
    clearMirror();
  };
  const listeners: Record<StoreEvent, Listener[]> = { change: [], open: [], withdraw: [] };
  let gpc = opts.gpc ?? (typeof navigator !== 'undefined' && (navigator as { globalPrivacyControl?: boolean }).globalPrivacyControl === true);
  let current: ConsentState;

  const defaults = (): Record<string, boolean> => {
    const out: Record<string, boolean> = {};
    for (const id of ids) out[id] = consentCategoryDefault(config, id, regime) && (!gpc || isNecessaryCategory(id));
    return out;
  };
  const unset = (reason: AskReason): ConsentState => ({ status: 'unset', categories: defaults(), regime, gpc, reason });

  /** Decide the state from what is stored. Clears storage that no longer counts. */
  const load = (): ConsentState => {
    const fromCookie = readCookie();
    const fromMirror = readMirror();
    const c = parseStored(fromCookie);
    const m = parseStored(fromMirror);
    // The later choice wins (another tab may have written only one copy).
    const stored = c && m ? (Date.parse(m.at) > Date.parse(c.at) ? m : c) : (c ?? m);
    if (!stored) {
      if (fromCookie !== undefined || fromMirror !== undefined) {
        forget();
        return unset('unreadable');
      }
      return unset('none');
    }
    const at = Date.parse(stored.at);
    if (!Number.isFinite(at) || at > now() + FUTURE_SKEW_MS) {
      forget();
      return unset('unreadable');
    }
    if (now() - at >= ttlMs) {
      forget();
      return unset('expired');
    }
    const keys = Object.keys(stored.categories);
    if (keys.length !== ids.length || ids.some((id) => !(id in stored.categories))) {
      forget();
      return unset('categories-changed');
    }
    // Repair a missing or stale copy, keeping the original expiry.
    const json = JSON.stringify(stored);
    if (fromCookie !== json) writeCookie(json, Math.floor((at + ttlMs - now()) / 1000), cookieDomain);
    if (fromMirror !== json) writeMirror(json);
    const categories: Record<string, boolean> = {};
    for (const id of ids) categories[id] = isNecessaryCategory(id) || stored.categories[id] === true;
    return { status: 'chosen', categories, regime: stored.regime, gpc: stored.gpc, id: stored.id, at: stored.at, configHash: stored.configHash };
  };

  const copy = (s: ConsentState): ConsentState => ({ ...s, categories: { ...s.categories } });

  const emit = (event: StoreEvent): void => {
    for (const fn of listeners[event].slice()) {
      try {
        fn(copy(current));
      } catch (err) {
        // One broken subscriber must not stop the others (or the gate).
        setTimeout(() => {
          throw err;
        });
      }
    }
  };

  const sameGrants = (a: ConsentState, b: ConsentState): boolean => ids.every((id) => a.categories[id] === b.categories[id]) && a.status === b.status && a.id === b.id;

  const replace = (next: ConsentState, force = false): void => {
    const changed = force || !sameGrants(current, next);
    current = next;
    if (changed) emit('change');
  };

  const choose = (choice: Record<string, boolean>): ConsentState => {
    const categories: Record<string, boolean> = {};
    for (const id of ids) categories[id] = isNecessaryCategory(id) || choice[id] === true;
    const stored: StoredConsent = { v: 1, id: randomId(), at: new Date(now()).toISOString(), configHash: config.hash, regime, gpc, categories };
    const json = JSON.stringify(stored);
    writeCookie(json, Math.floor(ttlMs / 1000), cookieDomain);
    writeMirror(json);
    if (config.record?.endpoint) {
      const body = buildRecord(stored, opts.toolVersion ?? '0.0.0');
      try {
        (opts.send ?? sendRecord)(config.record.endpoint, body);
      } catch {
        /* proof is best-effort; the choice itself still stands */
      }
    }
    replace({ status: 'chosen', categories, regime, gpc, id: stored.id, at: stored.at, configHash: stored.configHash }, true);
    return copy(current);
  };

  const all = (on: boolean): Record<string, boolean> => {
    const out: Record<string, boolean> = {};
    for (const id of ids) out[id] = on;
    return out;
  };

  current = load();

  // Another tab chose: follow it.
  const onStorage = (e: StorageEvent): void => {
    if (e.key === STORAGE_KEY) replace(load());
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);

  return {
    state: () => copy(current),
    isGranted: (id) => isNecessaryCategory(id) || current.categories[id] === true,
    needsChoice: () => current.status !== 'chosen',
    subscribe: (fn) => {
      listeners.change.push(fn);
      return () => {
        listeners.change = listeners.change.filter((f) => f !== fn);
      };
    },
    on: (event, fn) => {
      if (!listeners[event]) return () => {};
      listeners[event].push(fn);
      return () => {
        listeners[event] = listeners[event].filter((f) => f !== fn);
      };
    },
    set: choose,
    acceptAll: () => choose(all(true)),
    rejectAll: () => choose(all(false)),
    withdraw: () => {
      const s = choose(all(false));
      emit('withdraw');
      return s;
    },
    open: () => emit('open'),
    // A move emits 'change' even when the grants stay the same, so the banner can
    // re-render its words for the new regime (F2: e.g. opt-in → opt-out-signal with GPC on).
    setRegime: (r) => {
      const moved = r !== regime;
      regime = r;
      if (current.status === 'unset') replace({ ...unset(current.reason ?? 'none') }, moved);
    },
    setGpc: (b) => {
      const moved = b !== gpc;
      gpc = b;
      if (current.status === 'unset') replace({ ...unset(current.reason ?? 'none') }, moved);
    },
    destroy: () => {
      if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
    },
  };
}
