// The add-on file's entry (complykit-consent-companion.js): start on the core's host.
// Loaded by the core (src/companion-loader.ts) in add-on mode; on its own it does nothing.
import { startCompanion } from './index.js';
import type { CompanionHost } from './host.js';

const core = typeof window !== 'undefined' ? (window as { ComplyKit?: { _companion?: CompanionHost } }).ComplyKit : undefined;
if (core?._companion) startCompanion(core._companion);
else if (typeof console !== 'undefined') console.warn('[complykit] add-on file loaded without the core (complykit-consent.js); nothing followed');
