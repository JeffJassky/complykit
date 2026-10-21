// The consent tool's config: TYPES + a dependency-free runtime guard.
//
// This file imports NOTHING. It is the one module both sides of the contract
// share at runtime: the complykit package (scanner, generator, service) and
// the client package (`client/`, zero runtime deps, 15 KB gzipped budget). The
// zod schema that fully validates a config lives next door in
// consent-config.ts and is never bundled into the client; the client imports
// the types here type-only and calls `guardConsentToolConfig` on the inline
// config it finds in its snippet.
//
// Three copies of the shape exist on purpose (interfaces here, the zod schema,
// the published types/index.d.ts); src/contract.ts asserts they are mutually
// assignable, so one of them growing a field fails `tsc`.
//
// Versioning (plans/client-consent-design.md §10: "the config schema is
// versioned separately from the package"):
//   - `version` is "<major>.<minor>". A minor bump is additive and optional —
//     a tool on 1.0 may run a 1.3 config (it ignores what it does not know).
//     A major bump changes meaning; nothing crosses it without a migration.
//   - The tool REFUSES a config with a different major, newer or older: it
//     does nothing, so gated scripts stay inert (that is the fail-closed
//     outcome; a banner that guesses would be worse).
//   - The script is served per major (`/v1/complykit-consent.js`), so a site on
//     a 1.x config keeps a 1.x tool until the owner re-installs from a new scan.
//   - The rescan (D10) FLAGS an older config (minor or major) as "deployed config
//     is behind the workspace". When the parser refuses (different major, invalid
//     body) it still reads `version` / `hash` / `generatedFrom` through
//     `readConsentConfigHeader`, so the report can name what is deployed.

/** The inline config element: `<script type="application/json" id="complykit-config">`. */
export const CONSENT_CONFIG_ELEMENT_ID = 'complykit-config';

export const CONSENT_CONFIG_MAJOR = 1;
export const CONSENT_CONFIG_VERSION = '1.1';

/** The one reserved category: always granted, never toggled, always present. */
export const NECESSARY_CATEGORY = 'necessary';

/**
 * How a visitor's location is treated — the scanner's vocabulary
 * (src/report/consent-matrix.ts `regimeFor`, minus its 'unknown', which maps to
 * the fallback here). Decided from the location by `regimeFor()` (ticket D7),
 * which ships in both packages; the config carries only per-regime defaults.
 *   opt-in         — prior consent required (EU/EEA, UK): nothing non-necessary
 *                    runs until granted.
 *   opt-out-signal — may run until the visitor opts out, and an opt-out signal
 *                    (GPC) MUST be honored as that opt-out (US states with an
 *                    opt-out-signal law, e.g. California).
 *   opt-out        — may run until the visitor opts out; no opt-out-signal law
 *                    (the tool still honors GPC: design §6).
 * Unknown location ⇒ `FALLBACK_REGIME` (the strictest). Not configurable.
 */
export type Regime = 'opt-in' | 'opt-out-signal' | 'opt-out';
export const REGIMES: readonly Regime[] = ['opt-in', 'opt-out-signal', 'opt-out'];
export const FALLBACK_REGIME: Regime = 'opt-in';

/** Where the tool learns the visitor's location (never a third-party geo call). */
export type RegimeSource =
  // A same-origin endpoint echoes a CDN / server request header ("cf-ipcountry",
  // "x-vercel-ip-country", …) as the body: "DE" or "US-CA".
  | { kind: 'header'; header: string; endpoint: string }
  // `<meta name="complykit-region" content="US-CA">` written by the server template.
  | { kind: 'meta'; name: string }
  // The platform bridge (Shopify, Wix, WordPress) reports it.
  | { kind: 'platform' }
  // One regime for every visitor, decided by the owner.
  | { kind: 'fixed'; regime: Regime };

export interface ConsentCategory {
  /** Stable id used in `data-category`, in the state store and in the consent record. */
  id: string;
  label: string;
  description: string;
  /** Granted before the visitor chooses, per regime. `opt-in` is always false except for `necessary`. */
  defaultByRegime: Record<Regime, boolean>;
}

/**
 * How the tool controls a vendor (design §2):
 *   gate     — the load is gated (`type="text/plain" data-category`); the universal control.
 *   api      — gated AND told through its consent API (`adapter` names it).
 *   platform — only the platform's consent API reaches it (Shopify, Wix, WordPress).
 *   none     — the tool cannot control it (markup leak, CNAME, server-side); listed so
 *              the record and the rescan both know it is outside reach.
 */
export type VendorControl = 'gate' | 'api' | 'platform' | 'none';

/**
 * Vendor consent-API adapter ids — the vocabulary of `vendors[].adapter`
 * (client/src/adapters/index.ts implements each from the KB control facts).
 * The client treats an id it does not know as 'none'; the schema refuses it.
 */
export const CONSENT_ADAPTER_IDS = ['google-consent-mode', 'meta', 'tiktok', 'microsoft-uet', 'microsoft-clarity', 'pinterest', 'none'] as const;

export interface ConsentVendor {
  /** Knowledge-base entry id ('meta.pixel'). */
  id: string;
  label: string;
  category: string;
  control: VendorControl;
  /** Adapter id, one of CONSENT_ADAPTER_IDS; required when `control` is 'api'. */
  adapter?: string;
  /** Cookie / storage keys this vendor sets (regex sources, from the KB), for withdrawal cleanup. */
  stores: Array<{ name: string; kind: 'cookie' | 'local' | 'session' }>;
  note?: string;
}

/** A gated script the tool owns: what to release under which category, and what the rescan verifies. */
export interface GateRule {
  category: string;
  /** Regex source matched against the script's `data-src` / `src`. */
  src?: string;
  /** CSS selector for inline gated scripts. */
  selector?: string;
  vendor?: string;
}

export type ConsentModeSignal =
  | 'ad_storage'
  | 'ad_user_data'
  | 'ad_personalization'
  | 'analytics_storage'
  | 'functionality_storage'
  | 'personalization_storage'
  | 'security_storage';
export const CONSENT_MODE_SIGNALS: readonly ConsentModeSignal[] = [
  'ad_storage',
  'ad_user_data',
  'ad_personalization',
  'analytics_storage',
  'functionality_storage',
  'personalization_storage',
  'security_storage',
];

export interface GtmConfig {
  containers: string[];
  dataLayer: string;
  /** Consent Mode signal → category that grants it. An unmapped signal stays denied. */
  consentMode: Partial<Record<ConsentModeSignal, string>>;
  /** Container tags that must carry a consent requirement (the owner's change list; the rescan checks). */
  tags: Array<{ name: string; category: string; vendor?: string }>;
}

export type ConsentPlatform = 'none' | 'shopify' | 'wix' | 'squarespace' | 'wordpress';

/** CSS custom-property values: `--ck-bg`, `--ck-fg`, `--ck-accent`, `--ck-border`, `--ck-radius`. Font is always `inherit`. */
export interface ConsentTheme {
  bg?: string;
  fg?: string;
  accent?: string;
  border?: string;
  radius?: string;
}

export type ConsentLayout = 'bar' | 'box' | 'modal';

/**
 * String-table keys. Per-regime defaults live in the client (client/src/ui/strings.ts,
 * ticket F2); the config carries overrides per language. Which overrides are refused
 * (a required string dropped, a misleading pattern) is decided by
 * consent-strings-guard.ts, called from the zod schema at generation time.
 */
export const CONSENT_STRING_KEYS = [
  'banner.title',
  'banner.body',
  'banner.accept',
  'banner.reject',
  'banner.manage',
  'settings.title',
  'settings.body',
  'settings.acceptAll',
  'settings.rejectAll',
  'settings.save',
  'settings.close',
  'withdraw.link',
  'withdraw.confirm',
  'withdraw.note',
  'withdraw.recall',
  'privacyChoices.link',
  'optOut.link',
  'optOut.confirmed',
  // F2 (additive, schema 1.0 minor-compatible: an older tool ignores them).
  'optOut.iconAlt',
  'gpc.honored',
  'privacyPolicy.link',
] as const;
export type ConsentStringKey = (typeof CONSENT_STRING_KEYS)[number];

/** One language's table: overrides by key, plus optional per-regime overrides of the same keys. */
export type ConsentStringTable = Partial<Record<ConsentStringKey, string>> & {
  byRegime?: Partial<Record<Regime, Partial<Record<ConsentStringKey, string>>>>;
};

/** The state store's cookie: how long a choice is remembered, and on which domain. */
export interface ConsentStateConfig {
  /** Days a choice is kept before the visitor is asked again. Default 365, at most 395 (13 months). */
  lifetimeDays: number;
  /** Cookie domain, e.g. ".example.test" to share across subdomains. Default: the current host. */
  cookieDomain?: string;
}

export interface ConsentRecordEndpoint {
  /** Same-origin path or absolute URL that receives the consent record (POST, JSON). */
  endpoint: string;
}

/** Add-on mode: the existing banner the tool follows (consent-config.ts CompanionCmpSchema). */
export type CompanionCmp = 'onetrust' | 'cookiebot' | 'usercentrics' | 'didomi' | 'trustarc' | 'shopify' | 'wordpress' | 'tcf' | 'consent-mode' | 'manual';
export const COMPANION_CMPS: readonly CompanionCmp[] = ['onetrust', 'cookiebot', 'usercentrics', 'didomi', 'trustarc', 'shopify', 'wordpress', 'tcf', 'consent-mode', 'manual'];

export interface CompanionConfig {
  cmp: CompanionCmp;
  /** The banner's purpose/group id → complykit category ids. Absent = the built-in map. */
  map?: Record<string, string[]>;
}

/**
 * A visitor location key (schema 1.1): 'US-CA' (ISO 3166-1 country, ISO 3166-2
 * subdivision suffix), 'US' (country), or '*' (any location no other key matches,
 * an unknown one included). Upper case. Lookups go most specific first:
 * 'US-CA' → 'US' → '*'.
 */
export type LocationKey = string;
export const LOCATION_KEY_PATTERN = /^(\*|[A-Z]{2}(-[A-Z0-9]{1,3})?)$/;

/** Where the visitor is, as the location source reported it (registry/regime.ts RegimeLocation). */
export interface VisitorLocation {
  country: string;
  region?: string;
}

/**
 * The site owner's overrides (schema 1.1). complykit POLICY does not apply to
 * them: the client runs whatever they say, in either direction — stricter or
 * looser than the law, compliant or not. The scanner and the report keep
 * judging the site against complykit policy, so a looser override shows up as
 * mismatches there (plus a `policy-overridden` proof finding naming it).
 * Overrides are kept across regeneration (the service stores them with the
 * owner's consent settings and applies them when it serves the config).
 */
export interface ConsentOverrides {
  /** Location key → regime. Checked before the built-in table (regimeFor). Ignored when regimeSource is 'fixed'. */
  regimes?: Record<LocationKey, Regime>;
  /**
   * Granted before the visitor chooses: key → category id → granted. A key is a
   * location key or a regime. Beats every policy layer (categories[].defaultByRegime,
   * locationDefaults). Lookup order: subdivision key, country key, regime key, '*'.
   * `necessary` cannot be listed (always granted).
   */
  defaults?: Record<LocationKey | Regime, Record<string, boolean>>;
  /** false: a Global Privacy Control signal is not treated as an opt-out. Default true. */
  honorGpc?: boolean;
  /** The owner's reason, in their words. Shown with the proof finding. */
  note?: string;
}

export interface ConsentToolConfig {
  version: string;
  generatedFrom: { runId: string; at: string; site: string; complykit: string; kb?: string };
  /** sha-256 of the canonical JSON of everything else (see consent-config.ts). */
  hash: string;
  regimeSource: RegimeSource;
  categories: ConsentCategory[];
  /**
   * POLICY layer by location (schema 1.1, generated): category id → false = held
   * until the visitor accepts, for visitors at that location key, in a regime whose
   * defaultByRegime would grant it. The generator writes the wiretap-litigation
   * states here (registry/wiretap.ts). Holds only: the schema refuses `true`
   * (a grant is an override and belongs in `overrides.defaults`).
   */
  locationDefaults?: Record<LocationKey, Record<string, boolean>>;
  /** The owner's overrides (schema 1.1). Absent = complykit policy throughout. */
  overrides?: ConsentOverrides;
  vendors: ConsentVendor[];
  gate: GateRule[];
  gtm?: GtmConfig;
  platform: ConsentPlatform;
  theme: ConsentTheme;
  /** language tag → string table. Defaults per regime live in the tool; these are overrides. */
  strings: Record<string, ConsentStringTable>;
  consent: ConsentStateConfig;
  /** Linked from the banner. https only. */
  privacyPolicyUrl?: string;
  record?: ConsentRecordEndpoint;
  /** Where the banner beacon is posted (counters only). Absent = no beacon. */
  analytics?: { endpoint: string };
  /** Absent = 'full'. 'companion': follow the site's own banner, clean up on revoke (plans/hosted-script.md). */
  mode?: 'full' | 'companion';
  /** Required when mode is 'companion'. */
  companion?: CompanionConfig;
  layout: ConsentLayout;
  /** Block the page (backdrop, inert, no scroll) until the visitor chooses. The guard fills false when absent (configs older than the field). */
  blockPage: boolean;
}

// --- version policy ---------------------------------------------------------------

export type ConsentConfigVersionStatus =
  | 'current'
  | 'older-minor'
  | 'newer-minor'
  | 'older-major'
  | 'newer-major'
  | 'invalid';

export function parseConsentConfigVersion(v: unknown): { major: number; minor: number } | undefined {
  if (typeof v !== 'string') return undefined;
  const m = /^(\d+)\.(\d+)$/.exec(v);
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

/** Compare a config's `version` with the schema this build knows. */
export function consentConfigVersionStatus(v: unknown): ConsentConfigVersionStatus {
  const got = parseConsentConfigVersion(v);
  if (!got) return 'invalid';
  const ours = parseConsentConfigVersion(CONSENT_CONFIG_VERSION)!;
  if (got.major > ours.major) return 'newer-major';
  if (got.major < ours.major) return 'older-major';
  if (got.minor > ours.minor) return 'newer-minor';
  if (got.minor < ours.minor) return 'older-minor';
  return 'current';
}

// --- the header: what the rescan reads even when the parser refuses ---------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface ConsentConfigHeader {
  version?: string;
  hash?: string;
  generatedFrom?: { runId?: string; at?: string; site?: string; complykit?: string; kb?: string };
}

/**
 * `version`, `hash` and `generatedFrom` of whatever is in the config element,
 * without validating anything else. Strings only; everything else is dropped.
 * The rescan uses this to name a deployed config it cannot parse (newer major,
 * edited by hand), so "deployed config is behind" never depends on parsing.
 */
export function readConsentConfigHeader(raw: unknown): ConsentConfigHeader {
  if (!isObj(raw)) return {};
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const out: ConsentConfigHeader = {};
  if (str(raw.version) !== undefined) out.version = str(raw.version);
  if (str(raw.hash) !== undefined) out.hash = str(raw.hash);
  if (isObj(raw.generatedFrom)) {
    const g = raw.generatedFrom;
    const gf: NonNullable<ConsentConfigHeader['generatedFrom']> = {};
    for (const k of ['runId', 'at', 'site', 'complykit', 'kb'] as const) {
      const v = str(g[k]);
      if (v !== undefined) gf[k] = v;
    }
    out.generatedFrom = gf;
  }
  return out;
}

// --- the runtime guard -------------------------------------------------------------

export type ConsentConfigGuardResult =
  | { ok: true; config: ConsentToolConfig; version: 'current' | 'older-minor' | 'newer-minor' }
  | {
      ok: false;
      reason: 'not-an-object' | 'invalid-version' | 'newer-major' | 'older-major' | 'missing-field';
      detail: string;
    };

/**
 * The client's structural check: version compatible, load-bearing fields present and
 * of the right kind. It does NOT replace the zod schema — the generator validated the
 * config before it was pasted; the hash says whether it was edited since. A
 * refusal means the tool must do nothing (gated scripts stay inert).
 */
export function guardConsentToolConfig(raw: unknown): ConsentConfigGuardResult {
  if (!isObj(raw)) return { ok: false, reason: 'not-an-object', detail: 'config is not an object' };
  const version = consentConfigVersionStatus(raw.version);
  if (version === 'invalid') return { ok: false, reason: 'invalid-version', detail: `version ${JSON.stringify(raw.version)} is not "<major>.<minor>"` };
  if (version === 'newer-major' || version === 'older-major') {
    return { ok: false, reason: version, detail: `config version ${String(raw.version)} needs a tool built for major ${String(raw.version).split('.')[0]}; this one knows ${CONSENT_CONFIG_VERSION}` };
  }
  const missing = (field: string): ConsentConfigGuardResult => ({ ok: false, reason: 'missing-field', detail: `${field} is missing or malformed` });
  if (!isObj(raw.generatedFrom) || typeof raw.generatedFrom.runId !== 'string' || typeof raw.generatedFrom.site !== 'string') return missing('generatedFrom.runId / site');
  if (typeof raw.hash !== 'string') return missing('hash');
  if (!isObj(raw.regimeSource) || typeof raw.regimeSource.kind !== 'string') return missing('regimeSource.kind');
  if (!Array.isArray(raw.categories) || raw.categories.length === 0) return missing('categories');
  if (raw.regimeSource.kind === 'fixed' && !(REGIMES as readonly unknown[]).includes(raw.regimeSource.regime)) return missing('regimeSource.regime');
  for (const c of raw.categories as unknown[]) {
    if (!isObj(c) || typeof c.id !== 'string' || !isObj(c.defaultByRegime)) return missing('categories[].id / defaultByRegime');
    // The one invariant the client must not take on trust: under opt-in nothing but
    // `necessary` is granted before the visitor chooses. A config saying otherwise was
    // edited after generation; refuse it rather than run it.
    if (c.id !== NECESSARY_CATEGORY && c.defaultByRegime['opt-in'] !== false) return missing(`categories[${c.id}].defaultByRegime.opt-in (must be false)`);
  }
  if (!(raw.categories as Array<{ id: string }>).some((c) => c.id === NECESSARY_CATEGORY)) return missing(`categories (no "${NECESSARY_CATEGORY}")`);
  if (!Array.isArray(raw.vendors)) return missing('vendors');
  for (const v of raw.vendors as unknown[]) {
    if (!isObj(v) || typeof v.id !== 'string' || typeof v.category !== 'string' || typeof v.control !== 'string' || !Array.isArray(v.stores)) {
      return missing('vendors[].id / category / control / stores');
    }
  }
  if (!Array.isArray(raw.gate)) return missing('gate');
  for (const g of raw.gate as unknown[]) {
    if (!isObj(g) || typeof g.category !== 'string' || (typeof g.src !== 'string' && typeof g.selector !== 'string')) return missing('gate[].category / src|selector');
  }
  if (raw.gtm !== undefined) {
    const g = raw.gtm;
    if (!isObj(g) || !Array.isArray(g.containers) || typeof g.dataLayer !== 'string' || !isObj(g.consentMode) || !Array.isArray(g.tags)) return missing('gtm');
  }
  if (raw.record !== undefined && !(isObj(raw.record) && typeof raw.record.endpoint === 'string')) return missing('record.endpoint');
  if (raw.analytics !== undefined && !(isObj(raw.analytics) && typeof raw.analytics.endpoint === 'string')) return missing('analytics.endpoint');
  if (raw.mode !== undefined && raw.mode !== 'full' && raw.mode !== 'companion') return missing('mode');
  if (raw.mode === 'companion' && !(isObj(raw.companion) && (COMPANION_CMPS as readonly unknown[]).includes(raw.companion.cmp))) return missing('companion.cmp');
  if (!isObj(raw.consent) || typeof raw.consent.lifetimeDays !== 'number' || !(raw.consent.lifetimeDays > 0)) return missing('consent.lifetimeDays');
  if (typeof raw.layout !== 'string') return missing('layout');
  if (raw.blockPage !== undefined && typeof raw.blockPage !== 'boolean') return missing('blockPage');
  if (!isObj(raw.theme)) return missing('theme');
  if (!isObj(raw.strings)) return missing('strings');
  if (typeof raw.platform !== 'string') return missing('platform');
  // Schema 1.1. Structural only, like the rest: a malformed block refuses the whole
  // config (gated scripts stay inert) rather than running half of an owner's intent.
  const boolTable = (v: unknown, onlyFalse = false): boolean =>
    isObj(v) && Object.values(v).every((row) => isObj(row) && Object.values(row).every((b) => (onlyFalse ? b === false : typeof b === 'boolean')));
  if (raw.locationDefaults !== undefined && !boolTable(raw.locationDefaults, true)) return missing('locationDefaults (key → category → false)');
  if (raw.overrides !== undefined) {
    const o = raw.overrides;
    if (!isObj(o)) return missing('overrides');
    if (o.regimes !== undefined && !(isObj(o.regimes) && Object.values(o.regimes).every((r) => (REGIMES as readonly unknown[]).includes(r)))) return missing('overrides.regimes');
    if (o.defaults !== undefined && !boolTable(o.defaults)) return missing('overrides.defaults');
    if (o.honorGpc !== undefined && typeof o.honorGpc !== 'boolean') return missing('overrides.honorGpc');
  }
  // A copy, never the caller's object: the rescan hashes the raw config as deployed.
  // Configs older than `blockPage` get false.
  return { ok: true, config: { ...raw, blockPage: raw.blockPage === true } as unknown as ConsentToolConfig, version };
}

// --- category semantics (fail closed) -----------------------------------------------

export function isNecessaryCategory(id: string): boolean {
  return id === NECESSARY_CATEGORY;
}

/**
 * The keys a location is looked up under, most specific first: {US, CA} →
 * ['US-CA', 'US', '*']; {DE} → ['DE', '*']; no location → ['*'].
 */
export function locationKeys(location?: VisitorLocation): LocationKey[] {
  const cc = typeof location?.country === 'string' ? location.country.trim().toUpperCase() : '';
  if (!/^[A-Z]{2}$/.test(cc)) return ['*'];
  const rg = typeof location?.region === 'string' ? location.region.trim().toUpperCase().replace(new RegExp(`^${cc}[-_]`), '') : '';
  return /^[A-Z0-9]{1,3}$/.test(rg) ? [`${cc}-${rg}`, cc, '*'] : [cc, '*'];
}

/**
 * The regime `overrides.regimes` assigns to a location (first matching key,
 * most specific first), or undefined when no override applies and the
 * built-in table decides. An unknown location matches only '*'.
 */
export function overriddenRegime(config: Pick<ConsentToolConfig, 'overrides'>, location?: VisitorLocation): Regime | undefined {
  const table = config.overrides?.regimes;
  if (!isObj(table)) return undefined;
  for (const k of locationKeys(location)) {
    const r = table[k];
    if ((REGIMES as readonly unknown[]).includes(r)) return r;
  }
  return undefined;
}

/** Whether the tool treats Global Privacy Control as an opt-out (default true; `overrides.honorGpc: false` turns it off). */
export function honorsGpc(config: Pick<ConsentToolConfig, 'overrides'>): boolean {
  return config.overrides?.honorGpc !== false;
}

/** Whether the config carries any owner override (an empty block counts as none). */
export function hasOverrides(config: Pick<ConsentToolConfig, 'overrides'>): boolean {
  const o = config.overrides;
  if (!isObj(o)) return false;
  return (isObj(o.regimes) && Object.keys(o.regimes).length > 0) || (isObj(o.defaults) && Object.keys(o.defaults).length > 0) || o.honorGpc === false;
}

/**
 * Whether a category is granted BEFORE the visitor chooses, for a visitor in
 * `regime` at `location`. GPC is NOT applied here (the store and the proof
 * apply it on top, when `honorsGpc`). Precedence, first answer wins:
 *   1. `necessary` → true.
 *   2. A category the config does not list → false (fail closed: the store never
 *      grants what it cannot name), overrides included.
 *   3. overrides.defaults: subdivision key, country key, the regime, '*'.
 *   4. Policy: opt-in (or a regime this build does not know) → false.
 *   5. Policy: locationDefaults, most specific key first (holds only).
 *   6. Policy: categories[].defaultByRegime[regime].
 */
export function consentCategoryDefault(config: ConsentToolConfig, categoryId: string, regime: Regime, location?: VisitorLocation): boolean {
  if (isNecessaryCategory(categoryId)) return true;
  const cat = config.categories.find((c) => c.id === categoryId);
  if (!cat) return false;
  const keys = locationKeys(location);
  const od = config.overrides?.defaults;
  if (isObj(od)) {
    const order = [...keys.filter((k) => k !== '*'), regime, '*'];
    for (const k of order) {
      const v = isObj(od[k]) ? od[k][categoryId] : undefined;
      if (typeof v === 'boolean') return v;
    }
  }
  // A regime this build does not know is the strictest one; under opt-in nothing
  // else is granted by policy, whatever the config says (defense in depth over the guard).
  const r: Regime = REGIMES.includes(regime) ? regime : FALLBACK_REGIME;
  if (r === 'opt-in') return false;
  const ld = config.locationDefaults;
  if (isObj(ld)) {
    for (const k of keys) {
      if (isObj(ld[k]) && ld[k][categoryId] === false) return false;
    }
  }
  return cat.defaultByRegime[r] === true;
}
