// Entry point. Empty on purpose (D1 scaffold): later tickets add the state
// store, script gate, vendor adapters, GTM bridge and banner. The IIFE build
// exposes this module's exports as the global `ComplyKit`.
export { TOOL_VERSION as version } from './version.js';
// Consent state store + public API (D3): ComplyKit.get / on / open / withdraw.
export { get, on, open, withdraw, init } from './api.js';
export { installGtmBridge, consentModeSignals, GTM_CONSENT_EVENT } from './gtm.js';
export { diagnostics } from './diagnostics.js';
// D4: the script gate. Exported for pages that run their own store; installed
// on the page's store as soon as it starts.
export { createScriptGate, RELEASED_ATTR } from './gate.js';
import { createScriptGate } from './gate.js';
import { whenStore, getConfig } from './api.js';
whenStore((s) => {
  const c = getConfig();
  if (c) createScriptGate({ config: c, store: s });
});
// D6: the GTM bridge. Runs synchronously when the store starts (inside
// autoInit, while this script still blocks the parser), so the Consent Mode
// defaults are queued before the GTM snippet below it.
import { installGtmBridge as installGtm } from './gtm.js';
whenStore((s) => {
  const c = getConfig();
  if (c?.gtm) installGtm(c, () => s.state().regime, s);
});
// D5: vendor consent-API adapters (additive to the gate; never release a script).
export { startAdapters, ADAPTER_IDS } from './adapters/index.js';
import { startAdapters as startVendorAdapters } from './adapters/index.js';
import { setAdapters, getAdapters } from './api.js';
whenStore((s) => {
  const c = getConfig();
  if (c) setAdapters(startVendorAdapters(c, () => s.state().regime, s));
});
// F3: the withdrawal flow — on a revoke: adapters re-synced, reachable vendor
// cookies / storage deleted; after ComplyKit.withdraw(): reload (gate holds).
// Registered right after the adapters so GTM and the adapters run first.
import { installWithdrawal as installWd } from './withdraw.js';
whenStore((s) => {
  const c = getConfig();
  if (c) installWd(c, s, getAdapters);
});
// E2: WordPress Consent API bridge (platform 'wordpress', or wp_set_consent present).
export { installWordpressBridge, DEFAULT_WP_MAPPING } from './bridges/wordpress.js';
import { installWordpressBridge as installWp } from './bridges/wordpress.js';
whenStore((s) => {
  const c = getConfig();
  if (c) installWp(c, s);
});
// E3: Wix consent policy bridge (platform 'wix', or the Wix API on the page).
export { installWixBridge, wixPolicyFor, DEFAULT_WIX_MAP } from './bridges/wix.js';
import { installWixBridge as installWix } from './bridges/wix.js';
whenStore((s) => {
  const c = getConfig();
  if (c) installWix(c, s);
});
// E1: Shopify Customer Privacy bridge (platform 'shopify', or window.Shopify on the page).
export { installShopifyBridge, shopifyConsentFor, DEFAULT_SHOPIFY_MAP } from './bridges/shopify.js';
import { installShopifyBridge as installShopify } from './bridges/shopify.js';
whenStore((s) => {
  const c = getConfig();
  if (c) installShopify(c, s);
});
// D7: location source + regime decision (used by init; exported for pages and tests).
export { resolveLocation, readGpc, DEFAULT_REGION_META } from './location.js';
// D9: the banner + settings layer live in a second file the core loads
// (complykit-consent-ui.js, same folder); `_ui` is the host it mounts on.
export { uiHost as _ui, loadUi } from './ui-loader.js';
import { installUiLoader } from './ui-loader.js';
whenStore((s) => installUiLoader(s));
// D3: start on the inline config, if the snippet carries one (keep this last).
import { autoInit } from './api.js';
autoInit();
