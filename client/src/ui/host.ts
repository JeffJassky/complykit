// The contract between the core file and the UI file (ticket D9 split).
// Zero runtime imports: both bundles include this module, so it must not pull
// the store or the API into the UI file (a second copy would be a second,
// empty store). The core builds the host (src/ui-loader.ts) and exposes it as
// `ComplyKit._ui`; the UI file (src/ui/entry.ts) mounts on it.

import type { ConsentToolConfig } from '../config.js';
import type { ConsentStore, Listener, StoreEvent } from '../store.js';

/** The UI file's name, next to the core file in the same folder. */
export const UI_FILE = 'complykit-consent-ui.js';
/** On the core <script>: URL of the UI file (overrides the same-folder default), or "none". */
export const UI_ATTR = 'data-complykit-ui';
/** On any site element: a click opens the settings layer. */
export const OPEN_ATTR = 'data-complykit-open';
/** On the core <script>: where the Privacy choices control sits (bottom-left | bottom-right | none). */
export const CHOICES_ATTR = 'data-complykit-choices';

export interface UiHost {
  getStore(): ConsentStore | undefined;
  getConfig(): ConsentToolConfig | undefined;
  /** Store events that survive a re-init (api.on). */
  on(event: StoreEvent, fn: Listener): () => void;
  /** The core's own <script> element (attributes, nonce); null when it was inlined. */
  script: HTMLScriptElement | null;
  /** Who asked for the settings layer last (focus returns there). */
  opener: Element | null;
  /** An open was requested before the UI mounted; the UI opens on mount. */
  pendingOpen: boolean;
  /** Set by the UI file once it has mounted. */
  mounted: boolean;
  /** Settles when a pending location lookup is answered (or timed out); undefined when none is outstanding. The banner waits for it. */
  locationPending?(): Promise<void> | undefined;
  /** Ask for the settings layer from `from` (loads the UI file if needed). */
  requestOpen(from: Element | null): void;
  /** The UI tells the core what the visitor saw and did (the banner beacon, client/src/events.ts). A no-op when analytics are off. */
  report(e: UiAnalyticsEvent): void;
}

/**
 * What the UI reports for the banner beacon (plans/hosted-script.md, "Event beacon").
 * - shown: the banner became visible.
 * - open: the settings layer opened; `via` = what opened it.
 * - decide: the visitor made a choice in the UI; `action` is the button (`save` = the settings layer's Save), `categories` the resulting choice. `via: 'cmp'` = the add-on file followed the site's own banner (T6).
 */
export type UiAnalyticsEvent =
  | { t: 'shown' }
  | { t: 'open'; via: 'banner' | 'choices' | 'api' }
  | { t: 'decide'; action: 'accept' | 'reject' | 'save'; via: 'banner' | 'settings' | 'cmp'; categories: Record<string, boolean> };

let current: UiHost | undefined;
export const setHost = (h: UiHost): void => {
  current = h;
};
/** The host the UI file mounted on (set before anything renders). */
export const host = (): UiHost => current!;
