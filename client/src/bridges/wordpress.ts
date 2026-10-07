// WordPress Consent API bridge (ticket E2).
//
// Lets plugins that follow the WP Consent API (WooCommerce, Site Kit, ...)
// read the visitor's choice from our banner, and lets the visitor's opt-out
// made elsewhere on the page reach our store.
//
// WP Consent API facts this relies on. Verified 2026-10-06 against the plugin
// source: assets/js/wp-consent-api.js, inc/api-functions.php and the readme,
// github.com/rlankhorst/wp-consent-level-api (plugin page:
// wordpress.org/plugins/wp-consent-api).
//   - five categories: functional, preferences, statistics,
//     statistics-anonymous, marketing. In PHP an unknown category falls back
//     to `functional`. `functional` is NOT special-cased as always granted:
//     under opt-in wp_has_consent('functional') is true only once its cookie
//     is 'allow', so we set it explicitly (necessary -> functional).
//   - window.wp_consent_type: a string containing 'optin' or 'optout'. The
//     consent banner is meant to set it (that is us) and then dispatch
//     `wp_consent_type_defined` on document. The plugin's own PHP setting is
//     only exposed as window.wp_fallback_consent_type; wp_has_consent reads
//     wp_consent_type first and the fallback only when it is undefined.
//   - wp_set_consent(category, 'allow' | 'deny'): ignores any other value;
//     writes cookie `<prefix>_<category>` (prefix default `wp_consent`, so
//     `wp_consent_marketing`; it is filterable), then, ONLY if the cookie
//     value changed, dispatches `wp_listen_for_consent_change` on document
//     synchronously. event.detail is an Array carrying one named property,
//     { [category]: value }, not a plain object (Object.entries reads it).
//   - wp_has_consent(category): optout and no cookie -> true; otherwise true
//     only if the cookie is 'allow'.
//
// What we do:
//   1. Set window.wp_consent_type from the regime: opt-in -> 'optin',
//      opt-out-signal / opt-out -> 'optout'. Ours wins over the plugin's PHP
//      setting: the banner and the regime must agree, or plugins would treat
//      a visitor as opted in under a different rule than the one we asked under.
//   2. Mirror our categories to WP categories with wp_set_consent on start
//      and on every change. Many of our categories may map to one WP category;
//      it is 'allow' only if EVERY one of them is granted (fail closed).
//   3. Listen for wp_listen_for_consent_change. A 'deny' for a WP category
//      denies our categories mapped to it. An 'allow' is IGNORED: another
//      plugin never grants consent on the visitor's behalf; only our banner
//      (the visitor's own choice) can. Our own wp_set_consent calls echo back
//      through the same event, synchronously, so a flag held around the call
//      skips them (an unchanged value dispatches no event at all).
//
// The WP plugin's scripts usually load after ours (we load first), so the
// bridge waits for wp_set_consent to exist and applies the wanted state when
// it appears. Activation: config.platform === 'wordpress', or wp_set_consent
// already defined on the page.

import type { ConsentToolConfig, Regime } from '../config.js';
import type { ConsentStore } from '../store.js';

export const WP_CATEGORIES = ['functional', 'preferences', 'statistics', 'statistics-anonymous', 'marketing'] as const;
export type WpCategory = (typeof WP_CATEGORIES)[number];

/** Our category id -> WP category (or several). Ids not listed are not mirrored. */
export type WpCategoryMapping = Record<string, WpCategory | WpCategory[]>;

/** Default mapping by category id; override per page with options.mapping / window.ComplyKitWordPressMapping. */
export const DEFAULT_WP_MAPPING: WpCategoryMapping = {
  necessary: 'functional',
  functional: 'functional',
  preferences: 'preferences',
  personalization: 'preferences',
  analytics: 'statistics',
  statistics: 'statistics',
  'statistics-anonymous': 'statistics-anonymous',
  'analytics-anonymous': 'statistics-anonymous',
  marketing: 'marketing',
  advertising: 'marketing',
};

export interface WordpressBridgeOptions {
  mapping?: WpCategoryMapping;
  /** How long to wait for wp_set_consent to appear, ms (default 10 000). */
  waitFor?: number;
  pollMs?: number;
}

export interface WordpressBridge {
  active: boolean;
  stop(): void;
}

type WpWindow = Window & {
  wp_set_consent?: (category: string, value: 'allow' | 'deny') => void;
  wp_consent_type?: string;
  ComplyKitWordPressMapping?: WpCategoryMapping;
};

export const WP_CHANGE_EVENT = 'wp_listen_for_consent_change';
export const WP_TYPE_EVENT = 'wp_consent_type_defined';

const isWpCategory = (v: unknown): v is WpCategory => (WP_CATEGORIES as readonly unknown[]).includes(v);

/** WP category -> our category ids mapped to it (only ids in the config, and only valid WP categories). */
function invert(config: ConsentToolConfig, mapping: WpCategoryMapping): Map<WpCategory, string[]> {
  const out = new Map<WpCategory, string[]>();
  for (const c of config.categories) {
    const m = mapping[c.id];
    for (const wp of Array.isArray(m) ? m : m ? [m] : []) {
      if (!isWpCategory(wp)) continue;
      const list = out.get(wp) ?? [];
      list.push(c.id);
      out.set(wp, list);
    }
  }
  return out;
}

export const wpConsentType = (regime: Regime): 'optin' | 'optout' => (regime === 'opt-in' ? 'optin' : 'optout');

export function installWordpressBridge(config: ConsentToolConfig, store: ConsentStore, opts: WordpressBridgeOptions = {}): WordpressBridge {
  if (typeof window === 'undefined' || typeof document === 'undefined') return { active: false, stop() {} };
  const w = window as WpWindow;
  if (config.platform !== 'wordpress' && typeof w.wp_set_consent !== 'function') return { active: false, stop() {} };

  const byWp = invert(config, { ...DEFAULT_WP_MAPPING, ...(w.ComplyKitWordPressMapping ?? {}), ...(opts.mapping ?? {}) });
  const sent = new Map<WpCategory, 'allow' | 'deny'>();
  let sending = false;
  let stopped = false;

  const wanted = (wp: WpCategory): 'allow' | 'deny' => {
    const ids = byWp.get(wp) ?? [];
    return ids.length > 0 && ids.every((id) => store.isGranted(id)) ? 'allow' : 'deny';
  };

  const publishType = (): void => {
    const t = wpConsentType(store.state().regime);
    if (w.wp_consent_type === t) return;
    w.wp_consent_type = t;
    document.dispatchEvent(new CustomEvent(WP_TYPE_EVENT));
  };

  // Idempotent: a category already told the wanted value is not told again.
  const push = (): void => {
    publishType();
    if (typeof w.wp_set_consent !== 'function') return;
    sending = true;
    try {
      for (const wp of byWp.keys()) {
        const v = wanted(wp);
        if (sent.get(wp) === v) continue;
        sent.set(wp, v);
        try {
          w.wp_set_consent(wp, v);
        } catch {
          sent.delete(wp);
        }
      }
    } finally {
      sending = false;
    }
  };

  const onWpChange = (e: Event): void => {
    if (sending || stopped) return; // our own call echoing back
    const detail = (e as CustomEvent<Record<string, unknown>>).detail;
    if (!detail || typeof detail !== 'object') return;
    const state = store.state();
    const choice: Record<string, boolean> = { ...state.categories };
    let denied = false;
    for (const [wp, value] of Object.entries(detail)) {
      // Only a deny crosses over. An allow from a plugin is never the visitor's choice here.
      if (value !== 'deny' || !isWpCategory(wp)) continue;
      for (const id of byWp.get(wp) ?? []) {
        if (choice[id] === true && id !== 'necessary') {
          choice[id] = false;
          denied = true;
        }
      }
    }
    // The change event that follows re-syncs wp_set_consent through push().
    if (denied) store.set(choice);
  };

  document.addEventListener(WP_CHANGE_EVENT, onWpChange);
  const unsub = store.subscribe(push);
  push();

  // The plugin's script may arrive after ours: wait for wp_set_consent.
  const pollMs = opts.pollMs ?? 100;
  const until = Date.now() + (opts.waitFor ?? 10_000);
  let timer: ReturnType<typeof setInterval> | undefined;
  if (typeof w.wp_set_consent !== 'function') {
    timer = setInterval(() => {
      if (typeof w.wp_set_consent === 'function') {
        clearInterval(timer);
        push();
      } else if (Date.now() > until) clearInterval(timer);
    }, pollMs);
  }

  return {
    active: true,
    stop() {
      stopped = true;
      unsub();
      document.removeEventListener(WP_CHANGE_EVENT, onWpChange);
      if (timer) clearInterval(timer);
    },
  };
}
