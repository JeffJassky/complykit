// collect/browser — session, profiles, settle, scroll, DOMSnapshot, CDP
// capture, consent driver, interaction probes, screenshots. The ONLY place
// Playwright exists (dependency law). Emits BrowserArtifacts. Lands in M2.
// This module is the `./collect-browser` subpath export (playwright peer).

export const COLLECT_BROWSER_MILESTONE = 'M2' as const;
