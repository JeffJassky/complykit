// Google Tag Manager bridge (ticket D6). Makes GTM-loaded tags obey the choice.
//
// GTM decides per tag, so the tool cannot gate what the container loads. What
// it can do is the two things GTM reads:
//   1. Consent Mode state. `gtag('consent','default',…)` must be in the data
//      layer BEFORE the container processes its `gtm.js` event, or tags that
//      fire on load read no default at all. Hence this runs synchronously when
//      installed, and the tool's script must sit above the GTM snippet.
//   2. A data layer event, `complykit_consent`, carrying every category's
//      state. Tags whose consent requirements GTM can't express (Custom HTML,
//      most community templates) trigger on it. See docs/guide/gtm-setup.md.
//
// Order per change: the Consent Mode update first, then the event — so a tag
// triggered by the event already sees the updated consent state.
//
// Fail closed: a signal no category maps to is denied; a category the config
// doesn't list is denied (consentCategoryDefault). If the container was
// already there when we ran, the defaults landed too late: we still set them
// (late beats never), warn, and record it for the proof scanner.
import { TRACKING_SIGNALS, consentDefault, consentUpdate, dataLayerOf, type ConsentModeSignals } from './adapters/google.js';
import { CONSENT_MODE_SIGNALS, NECESSARY_CATEGORY, consentCategoryDefault, type ConsentToolConfig, type Regime } from './config.js';
import { diagnostics } from './diagnostics.js';

export const GTM_CONSENT_EVENT = 'complykit_consent';
/** ms GTM tags wait for a `consent update` before firing on the defaults. */
export const DEFAULT_WAIT_FOR_UPDATE = 500;

/** The slice of the state store (ticket D3) the bridge needs. */
export interface ConsentStoreLike {
  isGranted(categoryId: string): boolean;
  subscribe(fn: () => void): (() => void) | void;
}

export interface GtmConsentEvent {
  event: typeof GTM_CONSENT_EVENT;
  complykit: { categories: Record<string, boolean>; regime: Regime };
}

export interface GtmDiagnostics {
  dataLayer: string;
  /** Regime the defaults were computed for. */
  regime: Regime;
  /** True only when nothing GTM-shaped was on the page before the defaults. */
  orderOk: boolean;
  /** Container ids already running (`google_tag_manager['GTM-…']`) before the defaults. */
  containersLoadedBefore: string[];
  /** A `gtm.js` event was already queued: the GTM snippet ran above us. */
  gtmEventBefore: boolean;
  /** `gtm.js` script elements already in the document. */
  containerScriptsBefore: string[];
  warnings: string[];
}

export interface GtmBridgeOptions {
  /** `wait_for_update` on the default command, ms. Default 500. */
  waitForUpdate?: number;
}

export interface GtmBridge {
  diagnostics: GtmDiagnostics;
  /** Push the current state (update + event) now. */
  sync(): void;
  stop(): void;
}

/** Consent Mode signals for a category predicate. Unmapped signals are denied; a tracking signal mapped to `necessary` is denied. */
export function consentModeSignals(
  mapping: Partial<Record<string, string>>,
  granted: (categoryId: string) => boolean,
): ConsentModeSignals {
  const out: ConsentModeSignals = {};
  for (const signal of CONSENT_MODE_SIGNALS) {
    const cat = mapping[signal];
    const forbidden = cat === NECESSARY_CATEGORY && TRACKING_SIGNALS.includes(signal);
    out[signal] = cat !== undefined && !forbidden && granted(cat) ? 'granted' : 'denied';
  }
  return out;
}

function detectEarlyGtm(dl: unknown[]): Omit<GtmDiagnostics, 'dataLayer' | 'regime' | 'orderOk' | 'warnings'> {
  const gtm = (window as unknown as { google_tag_manager?: Record<string, unknown> }).google_tag_manager;
  const containersLoadedBefore = gtm && typeof gtm === 'object' ? Object.keys(gtm).filter((k) => /^GTM-/.test(k)) : [];
  const gtmEventBefore = dl.some((e) => !!e && typeof e === 'object' && (e as { event?: unknown }).event === 'gtm.js');
  const containerScriptsBefore: string[] = [];
  document.querySelectorAll<HTMLScriptElement>('script[src]').forEach((s) => {
    if (/\/gtm\.js(\?|$)/.test(s.src)) containerScriptsBefore.push(s.src);
  });
  return { containersLoadedBefore, gtmEventBefore, containerScriptsBefore };
}

/**
 * Set Consent Mode defaults now, then mirror the store into the data layer on
 * every change. Call synchronously from the script that sits above the GTM
 * snippet. Returns undefined when the config has no `gtm` section.
 *
 * `regime` may be a getter: the location can resolve after load (a header
 * endpoint), in which case pass the fallback now and let the store notify.
 */
export function installGtmBridge(
  config: ConsentToolConfig,
  regime: Regime | (() => Regime),
  store: ConsentStoreLike,
  opts: GtmBridgeOptions = {},
): GtmBridge | undefined {
  const gtm = config.gtm;
  if (!gtm) return undefined;
  const currentRegime = typeof regime === 'function' ? regime : () => regime;
  const target = { dataLayer: gtm.dataLayer || 'dataLayer' };
  const dl = dataLayerOf(target.dataLayer);

  // Look before we push anything of ours.
  const early = detectEarlyGtm(dl);
  const warnings: string[] = [];
  if (early.containersLoadedBefore.length) {
    warnings.push(`GTM container ${early.containersLoadedBefore.join(', ')} loaded before the consent defaults; tags that fired on load ignored them.`);
  }
  if (early.gtmEventBefore) {
    warnings.push('The GTM snippet ran before the consent tool; the consent defaults are queued after gtm.js and do not apply to tags firing on it.');
  }
  if (early.containerScriptsBefore.length && !early.containersLoadedBefore.length) {
    warnings.push('A gtm.js script appears before the consent tool; place the consent tool above the GTM snippet.');
  }
  const startRegime = currentRegime();
  const diag: GtmDiagnostics = { dataLayer: target.dataLayer, regime: startRegime, orderOk: warnings.length === 0, ...early, warnings };
  diagnostics.gtm = diag;
  for (const w of warnings) console.warn(`[complykit] ${w}`);

  const defaults = consentModeSignals(gtm.consentMode, (id) => consentCategoryDefault(config, id, startRegime));
  consentDefault(defaults, { ...target, waitForUpdate: opts.waitForUpdate ?? DEFAULT_WAIT_FOR_UPDATE });

  const push = (force: boolean) => {
    const signals = consentModeSignals(gtm.consentMode, (id) => store.isGranted(id));
    // On install, an update identical to the defaults says nothing and would cut
    // `wait_for_update` short; after that, every decision is pushed.
    if (force || CONSENT_MODE_SIGNALS.some((s) => signals[s] !== defaults[s])) consentUpdate(signals, target);
    const categories: Record<string, boolean> = {};
    for (const c of config.categories) categories[c.id] = store.isGranted(c.id);
    const ev: GtmConsentEvent = { event: GTM_CONSENT_EVENT, complykit: { categories, regime: currentRegime() } };
    dl.push(ev);
  };

  push(false);
  const unsubscribe = store.subscribe(() => push(true));
  return {
    diagnostics: diag,
    sync: () => push(true),
    stop: () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    },
  };
}
