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
//   store.setRegime(r, location?) / store.setGpc(b)   location arrived (D7). Only
//                              moves the defaults; a stored choice is never
//                              changed. A location given replaces the stored
//                              one; omitted, the last one stands.
//
// Persistence: first-party cookie `complykit_consent` (Path=/, SameSite=Lax,
// Secure on https, Domain=config.consent.cookieDomain when set) + a localStorage mirror
// under the same key, both holding the same JSON (cookie urlencoded):
//
//   {"v":1,"id":"<random>","at":"<ISO>","configHash":"<hash>","regime":"opt-in",
//    "gpc":false,"categories":{"necessary":true,"analytics":false,…},
//    "kind":"choice","supersedes":"<previous id>","gpcHonored":false,"region":"US-CA","source":"shopify"}
//
// Each decision is a complete snapshot. `kind` is "withdrawal" when the previous
// state was a choice and this one denies a non-necessary category it granted
// (withdraw() or a settings change), else "choice"; `supersedes` is the previous
// choice's id (absent for a first decision); `gpcHonored` is whether GPC counted
// as an opt-out; `region` is the visitor's country / state when known (never
// finer); `source` is add-on mode only. The optional ones are optional on read: a value written before they
// existed still loads as a choice (the format stays v:1; nobody is re-asked).
//
// Add-on mode (config.mode 'companion'): the site's banner decides and complykit's copy is proof only, never
// read back as the answer. store.follow(grants, answered, initial) is the one writer: once the banner has
// answered, it keeps the stored snapshot while the grants match, else writes a new one (same shape, plus
// `source` = config.companion.cmp) and queues the record. Before an answer the store follows the banner's
// grants with status 'unset' and writes nothing; a banner that forgets its answer clears the snapshot and
// leaves its id under PREV_KEY. set()/acceptAll()/rejectAll()/withdraw() stay memory-only there, and another
// tab's write never moves this tab (no storage listener).
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
// Defaults route through consentCategoryDefault() (fail closed), which takes the
// regime AND the visitor's location: policy holds by location (the wiretap
// states) and the owner's overrides (schema 1.1) both live there; nothing is
// decided here. GPC is an extra deny on top: with GPC on, every non-necessary
// category defaults to denied in every regime (design §6: honored as an opt-out
// everywhere), unless the owner turned that off (`overrides.honorGpc: false`;
// `gpcHonored` in the state says which). A visitor's explicit grant still wins
// over GPC.

import { REGIMES, consentCategoryDefault, honorsGpc, isNecessaryCategory, type ConsentToolConfig, type Regime, type VisitorLocation } from './config.js';
import { buildRecord, flushOutbox, queueRecord, randomId } from './record.js';

export const COOKIE_NAME = 'complykit_consent';
export const STORAGE_KEY = 'complykit_consent';
/** The id of a choice that expired or was re-asked, until the next decision names it in `supersedes`. */
const PREV_KEY = 'complykit_consent_prev';
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
  /** Where the visitor is, when the location source reported it (the current one, also after a choice). */
  location?: VisitorLocation;
  /** The browser sent a Global Privacy Control signal. */
  gpc: boolean;
  /** The signal counts as an opt-out: `gpc` and the owner has not turned GPC off. */
  gpcHonored: boolean;
  /** Present when status is 'chosen'. */
  id?: string;
  at?: string;
  /** Hash of the config the choice was made under. */
  configHash?: string;
  /** 'withdrawal' when this decision took back a grant the previous one made; absent on a value written before this field. */
  kind?: 'choice' | 'withdrawal';
  /** The id of the decision this one replaced. */
  supersedes?: string;
  /** Visitor location at decision time: `CC` or `CC-RR` (country / state only). */
  region?: string;
  /** Add-on mode: the site banner the decision was made in (`config.companion.cmp`); never set in full mode. */
  source?: string;
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
  kind?: 'choice' | 'withdrawal';
  supersedes?: string;
  gpcHonored?: boolean;
  region?: string;
  source?: string;
}

export type StoreEvent = 'change' | 'open' | 'withdraw';
export type Listener = (state: ConsentState) => void;

export interface StoreOptions {
  gpc?: boolean;
  /** The visitor's location, when known at start (the defaults can depend on it). */
  location?: VisitorLocation;
  now?: () => number;
  toolVersion?: string;
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
  /**
   * Add-on mode: the site banner's grants (`choice`: only the categories its map reaches; the live state keeps its
   * default for the others, the snapshot records them false and never compares them) and whether the visitor has
   * answered it. `answered` undefined = the source cannot tell: answered unless it is the page's `initial` state,
   * which is then answered only when a snapshot is stored and matches (a differing one is followed, not written,
   * and kept). Not answered: follow the grants, status 'unset', a stored snapshot is cleared (its id waits for the
   * next decision). Answered: the stored snapshot stays when its grants match, else a new one (with `source`) is
   * written and recorded. `hold`: only apply the grants (the proof waits, e.g. for the location lookup).
   */
  follow(choice: Record<string, boolean>, answered?: boolean, initial?: boolean, hold?: boolean): ConsentState;
  open(): void;
  setRegime(regime: Regime, location?: VisitorLocation): void;
  setGpc(gpc: boolean): void;
  /** Detach the cross-tab listener (tests, re-init). */
  destroy(): void;
}

/**
 * Whether, in this regime at this location, something is held until the visitor
 * accepts although the regime is not opt-in: a listed non-necessary category
 * whose pre-choice default is off (GPC aside). The banner words its copy by it.
 */
export function holdsBeforeChoice(config: ConsentToolConfig, regime: Regime, location?: VisitorLocation): boolean {
  return regime !== 'opt-in' && config.categories.some((c) => !isNecessaryCategory(c.id) && !consentCategoryDefault(config, c.id, regime, location));
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
function readMirror(key = STORAGE_KEY): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}
function writeMirror(json: string, key = STORAGE_KEY): void {
  try {
    localStorage.setItem(key, json);
  } catch {
    /* cookie still holds it */
  }
}
function clearMirror(key = STORAGE_KEY): void {
  try {
    localStorage.removeItem(key);
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
  // A field of the wrong type is dropped, not a reason to reject the value (key order = choose()'s).
  const pick = (k: string, t: string): any => (typeof j[k] === t ? j[k] : undefined);
  const kind = j.kind === 'choice' || j.kind === 'withdrawal' ? j.kind : undefined;
  return { v: 1, id: j.id, at: j.at, configHash: j.configHash, regime: j.regime as Regime, gpc: j.gpc === true, categories, kind, supersedes: pick('supersedes', 'string'), gpcHonored: pick('gpcHonored', 'boolean'), region: pick('region', 'string'), source: pick('source', 'string') };
}

// --- the store ---------------------------------------------------------------------

export function createStore(config: ConsentToolConfig, regime: Regime, opts: StoreOptions = {}): ConsentStore {
  const now = opts.now ?? Date.now;
  const ids = config.categories.map((c) => c.id);
  // Add-on mode (T6): the site's banner owns the choice; the store's own set() stays in memory, only follow() (the banner's answer) is kept as proof.
  const persist = config.mode !== 'companion';
  const { ttlMs, cookieDomain } = consentSettings(config);
  const forget = (): void => {
    clearCookie(cookieDomain);
    clearMirror();
  };
  const listeners: Record<StoreEvent, Listener[]> = { change: [], open: [], withdraw: [] };
  let gpc = opts.gpc ?? (typeof navigator !== 'undefined' && (navigator as { globalPrivacyControl?: boolean }).globalPrivacyControl === true);
  let location = opts.location;
  let current: ConsentState;

  const honored = honorsGpc(config);
  // Every state carries where the visitor is now and whether GPC counts; `r` / `g` are the choice's own when one applies.
  const mk = (rest: Pick<ConsentState, 'status' | 'categories'> & Partial<ConsentState>, r = regime, g = gpc): ConsentState => ({ ...rest, regime: r, location, gpc: g, gpcHonored: g && honored });
  const defaults = (): Record<string, boolean> => {
    const out: Record<string, boolean> = {};
    for (const id of ids) out[id] = consentCategoryDefault(config, id, regime, location) && (!(gpc && honored) || isNecessaryCategory(id));
    return out;
  };
  const unset = (reason: AskReason): ConsentState => mk({ status: 'unset', categories: defaults(), reason });

  /** The stored choice that still counts, or why none does. Clears storage that no longer counts, repairs a missing copy. */
  const read = (): StoredConsent | AskReason => {
    const fromCookie = readCookie();
    const fromMirror = readMirror();
    const c = parseStored(fromCookie);
    const m = parseStored(fromMirror);
    // The later choice wins (another tab may have written only one copy).
    const stored = c && m ? (Date.parse(m.at) > Date.parse(c.at) ? m : c) : (c ?? m);
    if (!stored) {
      if (fromCookie !== undefined || fromMirror !== undefined) {
        forget();
        return 'unreadable';
      }
      return 'none';
    }
    const at = Date.parse(stored.at);
    if (!Number.isFinite(at) || at > now() + FUTURE_SKEW_MS) {
      forget();
      return 'unreadable';
    }
    // A choice that stops counting is still the one the next decision replaces: its id waits under PREV_KEY.
    const reask = now() - at >= ttlMs ? 'expired' : Object.keys(stored.categories).length !== ids.length || ids.some((id) => !(id in stored.categories)) ? 'categories-changed' : '';
    if (reask) {
      forget();
      writeMirror(stored.id, PREV_KEY);
      return reask;
    }
    // Repair a missing or stale copy, keeping the original expiry.
    const json = JSON.stringify(stored);
    if (fromCookie !== json) writeCookie(json, Math.floor((at + ttlMs - now()) / 1000), cookieDomain);
    if (fromMirror !== json) writeMirror(json);
    return stored;
  };

  /** Decide the state from what is stored. Add-on mode starts with the defaults: the banner has not spoken yet. */
  const load = (): ConsentState => {
    const stored = persist ? read() : 'none';
    if (typeof stored === 'string') return unset(stored);
    const categories: Record<string, boolean> = {};
    for (const id of ids) categories[id] = isNecessaryCategory(id) || stored.categories[id] === true;
    return mk({ status: 'chosen', categories, id: stored.id, at: stored.at, configHash: stored.configHash, kind: stored.kind, supersedes: stored.supersedes, region: stored.region }, stored.regime, stored.gpc);
  };

  // A regime / GPC / location update before a choice: the defaults move, add-on mode keeps the banner's grants.
  // Before an answer (or before any banner state) a category the banner reported keeps its value; the rest take the current defaults.
  let followed: Record<string, boolean> | undefined;
  const overlay = (): Record<string, boolean> => {
    const out = defaults();
    for (const id of ids) if (followed && id in followed) out[id] = isNecessaryCategory(id) || followed[id] === true;
    return out;
  };
  const refresh = (): ConsentState => (persist ? unset(current.reason ?? 'none') : mk({ status: 'unset', categories: overlay(), reason: 'none' }));

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

  // A new decision replacing `prev`: the stored snapshot, persisted when `persist` or add-on `source`.
  const decide = (choice: Record<string, boolean>, prev?: Pick<ConsentState, 'id' | 'categories'>, source?: string, live?: Record<string, boolean>): ConsentState => {
    const categories: Record<string, boolean> = {};
    for (const id of ids) categories[id] = isNecessaryCategory(id) || choice[id] === true;
    const kind = prev && ids.some((id) => !isNecessaryCategory(id) && prev.categories[id] && !categories[id]) ? 'withdrawal' : 'choice';
    const region = location ? location.country + (location.region ? '-' + location.region : '') : undefined;
    const stored: StoredConsent = { v: 1, id: randomId(), at: new Date(now()).toISOString(), configHash: config.hash, regime, gpc, categories, kind, supersedes: prev ? prev.id : readMirror(PREV_KEY), gpcHonored: gpc && honored, region, source };
    if (persist || source) {
      const json = JSON.stringify(stored);
      writeCookie(json, Math.floor(ttlMs / 1000), cookieDomain);
      writeMirror(json);
      clearMirror(PREV_KEY);
      if (config.record?.endpoint) queueRecord(config.record.endpoint, buildRecord(stored, opts.toolVersion ?? '0.0.0'));
    }
    replace(mk({ status: 'chosen', categories: live ?? categories, id: stored.id, at: stored.at, configHash: stored.configHash, kind, supersedes: stored.supersedes, region, source }), true);
    return copy(current);
  };
  const choose = (choice: Record<string, boolean>): ConsentState => decide(choice, current.status === 'chosen' ? current : undefined);

  const follow = (choice: Record<string, boolean>, answered?: boolean, initial?: boolean, hold?: boolean): ConsentState => {
    // What the gate sees: the banner's grants, the current default for a category its map does not reach.
    followed = choice;
    const live = overlay();
    const keep = (r: Partial<ConsentState>): ConsentState => (replace(mk({ status: 'unset', categories: live, reason: 'none', ...r })), copy(current));
    if (hold) return keep({});
    const r = read();
    const stored = typeof r === 'string' ? undefined : r;
    const same = !!stored && ids.every((id) => !(id in choice) || isNecessaryCategory(id) || stored.categories[id] === (choice[id] === true));
    if (answered === false || (answered === undefined && initial && !same)) {
      if (stored && answered === false) {
        forget();
        writeMirror(stored.id, PREV_KEY);
      }
      return keep({});
    }
    if (!stored || !same) return decide(choice, stored, config.companion?.cmp ?? 'manual', live);
    return keep({ status: 'chosen', id: stored.id, at: stored.at, configHash: stored.configHash, kind: stored.kind, supersedes: stored.supersedes, region: stored.region, source: stored.source, reason: undefined });
  };

  const all = (on: boolean): Record<string, boolean> => {
    const out: Record<string, boolean> = {};
    for (const id of ids) out[id] = on;
    return out;
  };

  current = load();
  if (config.record?.endpoint) flushOutbox(config.record.endpoint, now());

  // Another tab chose: follow it.
  const onStorage = (e: StorageEvent): void => {
    if (e.key === STORAGE_KEY) replace(load());
  };
  if (persist && typeof window !== 'undefined') window.addEventListener('storage', onStorage);

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
    follow,
    open: () => emit('open'),
    // A move emits 'change' even when the grants stay the same, so the banner can
    // re-render its words for the new regime (F2: e.g. opt-in → opt-out-signal with GPC on).
    setRegime: (r, loc) => {
      const moved = r !== regime || (!!loc && JSON.stringify(loc) !== JSON.stringify(location));
      regime = r;
      if (loc) location = loc;
      if (current.status === 'unset') replace(refresh(), moved);
    },
    setGpc: (b) => {
      const moved = b !== gpc;
      gpc = b;
      if (current.status === 'unset') replace(refresh(), moved);
    },
    destroy: () => {
      if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
    },
  };
}
