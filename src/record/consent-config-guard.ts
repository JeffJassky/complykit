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
export const CONSENT_CONFIG_VERSION = '1.0';

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

export interface ConsentToolConfig {
  version: string;
  generatedFrom: { runId: string; at: string; site: string; complykit: string; kb?: string };
  /** sha-256 of the canonical JSON of everything else (see consent-config.ts). */
  hash: string;
  regimeSource: RegimeSource;
  categories: ConsentCategory[];
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
  layout: ConsentLayout;
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
  if (!isObj(raw.consent) || typeof raw.consent.lifetimeDays !== 'number' || !(raw.consent.lifetimeDays > 0)) return missing('consent.lifetimeDays');
  if (typeof raw.layout !== 'string') return missing('layout');
  if (!isObj(raw.theme)) return missing('theme');
  if (!isObj(raw.strings)) return missing('strings');
  if (typeof raw.platform !== 'string') return missing('platform');
  return { ok: true, config: raw as unknown as ConsentToolConfig, version };
}

// --- category semantics (fail closed) -----------------------------------------------

export function isNecessaryCategory(id: string): boolean {
  return id === NECESSARY_CATEGORY;
}

/**
 * Whether a category is granted BEFORE the visitor chooses, in a regime.
 * `necessary` → true. A category the config does not list → false: an unknown
 * category is denied until explicitly granted, and the store never grants what
 * it cannot name. Everything else → the configured default for that regime.
 */
export function consentCategoryDefault(config: ConsentToolConfig, categoryId: string, regime: Regime): boolean {
  if (isNecessaryCategory(categoryId)) return true;
  // A regime this build does not know is the strictest one; under opt-in nothing
  // else is granted, whatever the config says (defense in depth over the guard).
  const r: Regime = REGIMES.includes(regime) ? regime : FALLBACK_REGIME;
  if (r === 'opt-in') return false;
  const cat = config.categories.find((c) => c.id === categoryId);
  if (!cat) return false;
  return cat.defaultByRegime[r] === true;
}
