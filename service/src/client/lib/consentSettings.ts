import type { CompanionCmp, ConsentSettings, DetectedBanner, SiteWorkspace } from '../../shared/api';

// The owner's consent settings as the client reads them (workspace entry
// `consent-settings`; the service validates, this is lenient and display-only).

export const CONSENT_SETTINGS_ENTRY = 'consent-settings';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Banners add-on mode can follow, in the form's order. */
export const COMPANION_BANNERS: ReadonlyArray<{ cmp: CompanionCmp; label: string }> = [
  { cmp: 'onetrust', label: 'OneTrust' },
  { cmp: 'cookiebot', label: 'Cookiebot' },
  { cmp: 'usercentrics', label: 'Usercentrics' },
  { cmp: 'didomi', label: 'Didomi' },
  { cmp: 'trustarc', label: 'TrustArc' },
  { cmp: 'shopify', label: 'Shopify' },
  { cmp: 'wordpress', label: 'WordPress Consent API' },
  { cmp: 'tcf', label: 'IAB TCF' },
  { cmp: 'consent-mode', label: 'Google Consent Mode' },
  { cmp: 'manual', label: 'Other — manual' },
];

const NOTES: Record<CompanionCmp, string> = {
  onetrust: 'Follows OneTrust’s active groups: performance cookies are analytics, targeting cookies are advertising.',
  cookiebot: 'Follows Cookiebot’s statistics, marketing and preferences choices.',
  usercentrics: 'Follows Usercentrics’ categories (marketing covers advertising and analytics).',
  didomi: 'Follows Didomi’s purposes: measurement and analytics purposes, and advertising and personalization purposes.',
  trustarc: 'Follows TrustArc’s consent level: functional, then advertising and analytics.',
  shopify: 'Follows Shopify’s customer privacy choices: analytics, marketing and preferences.',
  wordpress: 'Follows the categories your consent plugin reports through the WordPress Consent API.',
  tcf: 'Follows the IAB TCF purposes the banner records (measurement purposes are analytics, ad purposes are advertising).',
  'consent-mode': 'Follows the consent updates your banner sends to Google Consent Mode (analytics_storage, ad_storage).',
  manual: 'complykit can’t follow this banner automatically: add one line to its choice callback so complykit knows what the visitor chose.',
};
export const companionNote = (cmp: CompanionCmp): string => NOTES[cmp];

/** The line for the banner's callback, with the site's own category ids (necessary is always on). */
export function manualSyncCode(categoryIds: readonly string[]): string {
  const ids = categoryIds.filter((c) => c !== 'necessary');
  const body = ids.map((c, i) => `${c}: ${i === 0 ? 'true' : 'false'}`).join(', ');
  return `ComplyKit.sync({ ${body} })`.replace('{  }', '{}');
}

/** What the form edits. Layout, blockPage and the link stay undefined until the owner touches them (only keys present are stored). */
export interface SettingsDraft {
  mode: ConsentSettings['mode'];
  cmp?: CompanionCmp;
  layout?: ConsentSettings['layout'];
  blockPage?: boolean;
  privacyPolicyUrl?: string;
}

/** The generated config's values, shown as the defaults. */
export interface SettingsDefaults {
  layout?: string;
  blockPage?: boolean;
  privacyPolicyUrl?: string;
}

export function settingsFromDraft(d: SettingsDraft): ConsentSettings {
  if (d.mode === 'companion') return { mode: 'companion', ...(d.cmp ? { cmp: d.cmp } : {}) };
  const url = d.privacyPolicyUrl?.trim();
  return { mode: 'full', ...(d.layout ? { layout: d.layout } : {}), ...(d.blockPage !== undefined ? { blockPage: d.blockPage } : {}), ...(url ? { privacyPolicyUrl: url } : {}) };
}

/** The stored settings, or { mode: 'full' } (also for an entry that is not valid: the service ignores those too). */
export function consentSettingsOf(ws: Pick<SiteWorkspace, 'entries'>): ConsentSettings {
  const v = ws.entries[CONSENT_SETTINGS_ENTRY]?.value;
  if (!isObject(v)) return { mode: 'full' };
  if (v.mode === 'companion') return typeof v.cmp === 'string' && COMPANION_BANNERS.some((b) => b.cmp === v.cmp) ? { mode: 'companion', cmp: v.cmp as CompanionCmp } : { mode: 'full' };
  if (v.mode !== 'full') return { mode: 'full' };
  return {
    mode: 'full',
    ...(v.layout === 'bar' || v.layout === 'box' || v.layout === 'modal' ? { layout: v.layout } : {}),
    ...(typeof v.blockPage === 'boolean' ? { blockPage: v.blockPage } : {}),
    ...(typeof v.privacyPolicyUrl === 'string' ? { privacyPolicyUrl: v.privacyPolicyUrl } : {}),
  };
}

const configOf = (ws: Pick<SiteWorkspace, 'config'>): Record<string, unknown> => {
  const v = ws.config?.value;
  return isObject(v) && isObject(v.config) ? v.config : {};
};

/** The banner the scan saw (stored with the generated config). */
export function detectedCmpOf(ws: Pick<SiteWorkspace, 'config'>): CompanionCmp | undefined {
  const v = ws.config?.value;
  const d = isObject(v) ? v.detectedCmp : undefined;
  return COMPANION_BANNERS.find((b) => b.cmp === d)?.cmp;
}

/** The banner the scan saw, named: the stored detectedBanner, or (workspaces generated before it existed) the label of the stored detectedCmp. */
export function detectedBannerOf(ws: Pick<SiteWorkspace, 'config'>): DetectedBanner | undefined {
  const v = ws.config?.value;
  const b = isObject(v) ? v.detectedBanner : undefined;
  if (isObject(b) && typeof b.label === 'string' && b.label.trim() && COMPANION_BANNERS.some((x) => x.cmp === b.cmp)) return { label: b.label, cmp: b.cmp as CompanionCmp };
  return bannerFromCmp(detectedCmpOf(ws));
}

/** A banner for a bare CompanionCmp (old stored data, the report's detectedCmp): named from COMPANION_BANNERS. */
export function bannerFromCmp(cmp: CompanionCmp | undefined): DetectedBanner | undefined {
  const hit = COMPANION_BANNERS.find((x) => x.cmp === cmp);
  return hit ? { label: hit.label, cmp: hit.cmp } : undefined;
}

/** The site's category ids from its stored config. */
export function categoryIdsOf(ws: Pick<SiteWorkspace, 'config'>): string[] {
  const c = configOf(ws).categories;
  return Array.isArray(c) ? c.filter((x): x is { id: string } => isObject(x) && typeof x.id === 'string').map((x) => x.id) : [];
}

export function settingsDefaultsOf(ws: Pick<SiteWorkspace, 'config'>): SettingsDefaults {
  const c = configOf(ws);
  return {
    ...(typeof c.layout === 'string' ? { layout: c.layout } : {}),
    ...(typeof c.blockPage === 'boolean' ? { blockPage: c.blockPage } : {}),
    ...(typeof c.privacyPolicyUrl === 'string' ? { privacyPolicyUrl: c.privacyPolicyUrl } : {}),
  };
}

/** Shown at the top of the to-do list in add-on mode. */
export const COMPANION_LIST_NOTE = 'You’re keeping your own consent banner. Blocking tags before a visitor chooses stays the banner’s job; complykit only deletes the cookies of what a visitor withdraws. The changes below that say what to hold are for the banner’s settings.';
