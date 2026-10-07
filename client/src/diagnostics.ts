// What the tool observed about the page it runs on, for the proof scanner to
// read (`window.ComplyKit.diagnostics` in the IIFE build). Each module that
// can detect a misinstall writes its own key. Read-only for the page: nothing
// in the tool branches on it.
import type { GtmDiagnostics } from './gtm.js';
import type { AdapterDiagnostics } from './adapters/index.js';
import type { WixDiagnostics } from './bridges/wix.js';
import type { ShopifyDiagnostics } from './bridges/shopify.js';
import type { UiDiagnostics } from './ui-loader.js';

export interface Diagnostics {
  /** Set by the GTM bridge when it installs (ticket D6). */
  gtm?: GtmDiagnostics;
  /** Set by the location resolver (ticket D7): where the regime came from. */
  location?: { source: 'fixed' | 'meta' | 'header' | 'platform' | 'unknown'; regime: string; pending: boolean; gpc: boolean };
  /** Set by the vendor adapters when they start (ticket D5). */
  adapters?: AdapterDiagnostics;
  /** Set by the Wix consent policy bridge when it activates (ticket E3). */
  wix?: WixDiagnostics;
  /** Set by the Shopify Customer Privacy bridge when it activates (ticket E1). */
  shopify?: ShopifyDiagnostics;
  /** Set by the UI-file loader (ticket D9): where the banner file is and whether it loaded. */
  ui?: UiDiagnostics;
}

export const diagnostics: Diagnostics = {};
