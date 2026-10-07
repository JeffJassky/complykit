// Loads the UI file (ticket D9). The tool ships as TWO files, both self-hosted
// in the same folder:
//
//   complykit-consent.js     core: store, gate, adapters, GTM bridge, location,
//                            platform bridges, API. Blocking, in <head>, before
//                            any gated tag or the GTM snippet. ≤15 KB gz.
//   complykit-consent-ui.js  banner, settings layer, Privacy choices control
//                            (theming F1 and strings F2 land here). ≤12 KB gz.
//                            Loaded BY THE CORE, async — never pasted.
//
//   <script type="application/json" id="complykit-config">{…}</script>
//   <script src="/assets/complykit/complykit-consent.js"></script>
//
// The UI file's URL is the core's own src with the file name swapped
// (`new URL('complykit-consent-ui.js', core.src)`); `data-complykit-ui="<url>"`
// on the core tag overrides it, and is required when the core is inlined.
//
// When: at once when the store needs a choice (the banner must show); on
// idle otherwise (the Privacy choices control is the withdrawal entry point,
// so it must exist even when no choice is owed); and immediately on
// ComplyKit.open() / a `data-complykit-open` click, which open the settings
// layer as soon as it mounts.
//
// Fail closed: the UI file decides nothing. If it does not load, no choice is
// made, the defaults stand (nothing non-necessary under opt-in), a console
// warning is printed and `ComplyKit.diagnostics.ui` says why.

import { getConfig, getStore, on } from './api.js';
import { diagnostics } from './diagnostics.js';
import type { ConsentStore } from './store.js';
import { OPEN_ATTR, UI_ATTR, UI_FILE, type UiHost } from './ui/host.js';

export interface UiDiagnostics {
  url?: string;
  state: 'loading' | 'loaded' | 'failed';
  error?: string;
}

const ownScript = typeof document !== 'undefined' ? (document.currentScript as HTMLScriptElement | null) : null;
let started = false;

export const uiHost: UiHost = {
  getStore,
  getConfig,
  on,
  script: ownScript,
  opener: null,
  pendingOpen: false,
  mounted: false,
  requestOpen(from) {
    uiHost.opener = from;
    getStore()?.open();
  },
};

/** Where the UI file is; undefined when it cannot be derived (inlined core, no attribute). */
export function uiUrl(): string | undefined {
  const a = ownScript?.getAttribute(UI_ATTR);
  try {
    if (a) return a === 'none' ? undefined : new URL(a, location.href).href;
    if (ownScript?.src) return new URL(UI_FILE, ownScript.src).href;
  } catch {
    /* malformed: treated as absent */
  }
  return undefined;
}

const fail = (url: string | undefined, error: string): void => {
  diagnostics.ui = { url, state: 'failed', error };
  if (typeof console !== 'undefined') console.warn(`[complykit] banner not loaded (${error}); no choice made, defaults stand`);
};

export function loadUi(): void {
  if (started || typeof document === 'undefined') return;
  started = true;
  if (ownScript?.getAttribute(UI_ATTR) === 'none') return; // the site renders its own UI on the API
  const url = uiUrl();
  if (!url) return fail(undefined, `no UI URL: set ${UI_ATTR} on the core script`);
  diagnostics.ui = { url, state: 'loading' };
  const s = document.createElement('script');
  s.src = url;
  s.async = true;
  if (ownScript?.nonce) s.nonce = ownScript.nonce;
  s.onload = () => {
    if (diagnostics.ui?.state === 'loading') diagnostics.ui.state = 'loaded';
  };
  s.onerror = () => fail(url, `failed to load ${url}`);
  (document.head || document.documentElement).appendChild(s);
}

export function installUiLoader(store: ConsentStore): void {
  if (typeof document === 'undefined') return;
  // Opens requested before the UI file mounted are replayed on mount.
  on('open', () => {
    if (!uiHost.mounted) {
      uiHost.pendingOpen = true;
      loadUi();
    }
  });
  document.addEventListener('click', (e) => {
    const el = (e.target as Element | null)?.closest?.(`[${OPEN_ATTR}]`);
    if (!el) return;
    e.preventDefault();
    uiHost.requestOpen(el);
  });
  if (store.needsChoice()) loadUi();
  else {
    const idle = (window as { requestIdleCallback?: (fn: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
    if (idle) idle(loadUi, { timeout: 3000 });
    else setTimeout(loadUi, 1);
  }
}
