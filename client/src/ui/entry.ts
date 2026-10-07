// The UI file's entry (complykit-consent-ui.js): mount on the core's host.
// Loaded by the core (src/ui-loader.ts); on its own it does nothing.
import { mountUi } from './index.js';
import type { UiHost } from './host.js';

const core = typeof window !== 'undefined' ? (window as { ComplyKit?: { _ui?: UiHost } }).ComplyKit : undefined;
if (core?._ui) mountUi(core._ui);
else if (typeof console !== 'undefined') console.warn('[complykit] UI file loaded without the core (complykit-consent.js); nothing shown');
