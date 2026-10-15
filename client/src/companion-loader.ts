// Loads the add-on file (ticket T6) when config.mode is 'companion': the site
// keeps its own banner and complykit follows it. Same pattern as ui-loader.ts:
// the file is next to the core (`?v=` pins the release; `data-complykit-companion`
// overrides the URL), async, nonce copied. It registers on the host below.
import { getConfig, sync } from './api.js';
import { diagnostics } from './diagnostics.js';
import { clearStores } from './withdraw.js';
import { TOOL_VERSION } from './version.js';
import { COMPANION_ATTR, COMPANION_FILE, type CompanionHost } from './companion/host.js';

const ownScript = typeof document !== 'undefined' ? (document.currentScript as HTMLScriptElement | null) : null;

export const companionHost: CompanionHost = { getConfig, sync, diagnostics, clear: (c, g) => clearStores(getConfig()!, c, g) };

export function loadCompanion(cmp: string): void {
  diagnostics.companion = { cmp, state: 'waiting' };
  let url: string | undefined;
  try {
    const a = ownScript?.getAttribute(COMPANION_ATTR);
    if (a) url = new URL(a, location.href).href;
    else if (ownScript?.src) url = `${new URL(COMPANION_FILE, ownScript.src).href}?v=${encodeURIComponent(TOOL_VERSION)}`;
  } catch {
    /* malformed: treated as absent */
  }
  if (!url) return void (diagnostics.companion.state = 'not-found');
  const s = document.createElement('script');
  s.src = url;
  s.async = true;
  if (ownScript?.nonce) s.nonce = ownScript.nonce;
  s.onerror = () => {
    diagnostics.companion = { cmp, state: 'not-found' };
    console.warn(`[complykit] add-on file not loaded (${url}); the banner is not followed`);
  };
  (document.head || document.documentElement).appendChild(s);
}
