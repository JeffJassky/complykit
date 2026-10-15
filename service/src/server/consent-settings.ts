// The owner's consent settings (plans/hosted-script.md "Owner settings"): the
// install task's form, stored in the site workspace as one entry. Validated here
// (the route and the reader share it), applied to the served config by
// hostedConfig, and read by the to-do list (add-on mode hides remove-existing-tool).

import type { CompanionCmp, ConsentSettings, SiteWorkspace } from '../shared/api.js';
import { CONSENT_SETTINGS_ENTRY, WorkspaceError } from './workspace.js';

export const CONSENT_SETTINGS_KEY = CONSENT_SETTINGS_ENTRY;

export const COMPANION_CMP_IDS: readonly CompanionCmp[] = ['onetrust', 'cookiebot', 'usercentrics', 'didomi', 'trustarc', 'shopify', 'wordpress', 'tcf', 'consent-mode', 'manual'];
const LAYOUTS = ['bar', 'box', 'modal'] as const;
const KEYS = new Set(['mode', 'cmp', 'layout', 'blockPage', 'privacyPolicyUrl']);
const MAX_URL = 2048;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const bad = (message: string): never => {
  throw new WorkspaceError(400, message);
};

/** The settings as stored: only the allow-listed keys, each checked. Throws WorkspaceError(400). */
export function normalizeConsentSettings(raw: unknown): ConsentSettings {
  if (!isObj(raw)) return bad('the settings must be a JSON object');
  for (const k of Object.keys(raw)) if (!KEYS.has(k)) bad(`unknown setting ${JSON.stringify(k.slice(0, 40))}`);
  if (raw.mode !== 'full' && raw.mode !== 'companion') bad('`mode` must be "full" or "companion"');
  const out: ConsentSettings = { mode: raw.mode as ConsentSettings['mode'] };
  if (raw.cmp !== undefined) {
    if (!(COMPANION_CMP_IDS as readonly unknown[]).includes(raw.cmp)) bad('`cmp` is not a banner complykit can follow');
    out.cmp = raw.cmp as CompanionCmp;
  } else if (raw.mode === 'companion') bad('`cmp` is required in add-on mode');
  if (raw.layout !== undefined) {
    if (!(LAYOUTS as readonly unknown[]).includes(raw.layout)) bad('`layout` must be bar, box or modal');
    out.layout = raw.layout as ConsentSettings['layout'];
  }
  if (raw.blockPage !== undefined) {
    if (typeof raw.blockPage !== 'boolean') bad('`blockPage` must be true or false');
    out.blockPage = raw.blockPage as boolean;
  }
  if (raw.privacyPolicyUrl !== undefined) {
    const u = raw.privacyPolicyUrl;
    let ok = false;
    if (typeof u === 'string' && u.length <= MAX_URL && !/[\u0000- ]/.test(u)) {
      try {
        ok = new URL(u).protocol === 'https:';
      } catch {
        ok = false;
      }
    }
    if (!ok) bad('`privacyPolicyUrl` must be an https URL');
    out.privacyPolicyUrl = u as string;
  }
  return out;
}

/** The workspace's stored settings; an entry that does not validate is ignored (undefined). */
export function storedConsentSettings(ws: Pick<SiteWorkspace, 'entries'>): ConsentSettings | undefined {
  const e = ws.entries[CONSENT_SETTINGS_KEY];
  if (!e) return undefined;
  try {
    return normalizeConsentSettings(e.value);
  } catch {
    return undefined;
  }
}

export const isCompanion = (s: ConsentSettings | undefined): boolean => s?.mode === 'companion';

/** Applies the settings to a config (a copy): only the keys present; full drops mode/companion, add-on drops `record`. */
export function applyConsentSettings(config: Record<string, unknown>, settings: ConsentSettings | undefined): Record<string, unknown> {
  const out = { ...config };
  if (!settings) return out;
  if (settings.mode === 'companion' && settings.cmp) {
    out.mode = 'companion';
    out.companion = { cmp: settings.cmp };
    delete out.record;
  } else {
    delete out.mode;
    delete out.companion;
  }
  if (settings.layout !== undefined) out.layout = settings.layout;
  if (settings.blockPage !== undefined) out.blockPage = settings.blockPage;
  if (settings.privacyPolicyUrl !== undefined) out.privacyPolicyUrl = settings.privacyPolicyUrl;
  return out;
}
