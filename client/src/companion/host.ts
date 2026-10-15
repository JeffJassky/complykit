// The contract between the core file and the add-on file (ticket T6, plans/
// hosted-script.md "Add-on mode"). Zero runtime imports: both bundles include
// this module. The core builds the host (src/companion-loader.ts) and exposes
// it as `ComplyKit._companion`; the add-on file (src/companion/entry.ts) starts
// on it. The add-on file is where all banner-specific code lives, so the core
// stays small.

import type { ConsentToolConfig } from '../config.js';
import type { ConsentState } from '../store.js';
import type { Diagnostics } from '../diagnostics.js';

/** The add-on file's name, next to the core file in the same folder. */
export const COMPANION_FILE = 'complykit-consent-companion.js';
/** On the core <script>: URL of the add-on file (overrides the same-folder default). */
export const COMPANION_ATTR = 'data-complykit-companion';

export interface CompanionHost {
  getConfig(): ConsentToolConfig | undefined;
  /** ComplyKit.sync: set the store from a mapped choice (a category left out keeps its value; reports a 'cmp' decision when the grants changed, unless `initial`). */
  sync(choice: Record<string, boolean>, initial?: boolean): ConsentState | null;
  /** The withdrawal cleanup (withdraw.ts clearStores) for these categories; `granted` ones are protected. */
  clear?(categories: string[], granted: string[]): Promise<NonNullable<Diagnostics['withdrawalSweep']>>;
  diagnostics: Diagnostics;
}
