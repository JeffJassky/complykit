// Platform fingerprint — which hosted platform / CMS built the page, and which
// consent plugin it runs. Pure: the browser layer only COLLECTS signals (record
// `PlatformSignals`); this module decides. A platform name is a claim from page
// evidence, never from a hostname guess alone, and "no platform" is a normal answer.
//
// Used two ways: `classifyPlatform` turns collected signals into the record's
// `platform` field; `platformLoaderOf` says whether a script URL is the platform's
// own loader, so a tracker injected by it is attributed to the platform (the fix is
// then the platform's consent bridge, not a rewrite of the tag).

export type PlatformName = 'shopify' | 'wix' | 'squarespace' | 'wordpress';

/** Mirrors record `PlatformSignals` (registry imports nothing internal). */
export interface PlatformSignalsInput {
  /** Names of window globals found on the page (only the ones we probe for). */
  globals: string[];
  /** `<meta name="generator">` content. */
  generator?: string;
  /** script src / stylesheet href URLs seen in the document. */
  assetUrls: string[];
  /** Squarespace `Static.SQUARESPACE_CONTEXT.templateVersion`, when readable. */
  templateVersion?: string;
}

export interface PlatformFingerprint {
  name: PlatformName;
  version?: string;
  consentPlugin?: string;
  /** WordPress only: the WP Consent API is present (`wp_has_consent`). */
  wpConsentApi?: boolean;
  /** Which signals decided it — shown to the reader, never hidden. */
  evidence: string[];
}

interface PlatformDef {
  name: PlatformName;
  /** Window globals that prove it. */
  globals: string[];
  /** Asset URL patterns that prove it. */
  assets: RegExp[];
  generator?: RegExp;
  /** Script hosts/paths that are the platform's own loader. Host patterns hold on any site. */
  loaderHosts: RegExp[];
  /** First-party paths that are the platform's loader — only trusted once the platform is fingerprinted. */
  loaderPaths: RegExp[];
}

const PLATFORMS: PlatformDef[] = [
  {
    name: 'shopify',
    globals: ['Shopify'],
    assets: [/\/\/cdn\.shopify\.com\//i, /\/cdn\/shopifycloud\//i],
    generator: /^shopify/i,
    loaderHosts: [/^https?:\/\/(cdn\.shopify\.com|cdn\.shopifycdn\.net|pay\.shopify\.com|sandbox\.shopifycdn\.com|shop\.app)\//i],
    // Web Pixels Manager and the storefront's own bundles are served from the store's domain.
    loaderPaths: [/\/cdn\/wpm\//i, /\/cdn\/shopifycloud\//i, /\/web-pixels@/i, /\/\.well-known\/shopify\//i],
  },
  {
    name: 'wix',
    globals: ['wixBiSession', 'wixPerformanceMeasurements', 'wixEmbedsAPI'],
    assets: [/\/\/static\.parastorage\.com\//i, /\/\/[^/]*\.wixstatic\.com\//i],
    generator: /^wix\.com/i,
    loaderHosts: [/^https?:\/\/([^/]*\.)?(parastorage\.com|wixstatic\.com|wix\.com|wixapps\.net)\//i],
    loaderPaths: [/\/_partials\//i, /\/_api\/wix-/i],
  },
  {
    name: 'squarespace',
    globals: ['Static.SQUARESPACE_CONTEXT', 'SQUARESPACE_ROLLUPS'],
    assets: [/\/\/static1\.squarespace\.com\//i, /\/\/assets\.squarespace\.com\//i, /\/\/images\.squarespace-cdn\.com\//i],
    generator: /^squarespace/i,
    loaderHosts: [/^https?:\/\/([^/]*\.)?(squarespace\.com|squarespace-cdn\.com|sqspcdn\.com)\//i],
    loaderPaths: [/\/universal\/scripts-compressed\//i, /\/\.well-known\/squarespace\//i],
  },
  {
    name: 'wordpress',
    globals: ['wp', 'wpApiSettings'],
    assets: [/\/wp-content\//i, /\/wp-includes\//i],
    generator: /^wordpress/i,
    loaderHosts: [],
    loaderPaths: [/\/wp-content\/(plugins|themes|mu-plugins)\//i, /\/wp-includes\//i],
  },
];

// `wp` and `wpApiSettings` are generic enough that a global alone is weak: for
// WordPress we need an asset path or the generator tag too. Others are specific.
const WEAK_GLOBALS = new Set(['wp', 'wpApiSettings']);

interface ConsentPluginDef {
  id: string;
  /** Plugin directory under /wp-content/plugins/ (WordPress). */
  wpDirs?: RegExp;
  globals?: string[];
  platform?: PlatformName;
}

// Order matters: first match wins; more specific plugins first.
/** The asset-path pattern (regex source) that fingerprints a consent plugin by id — what the remediation flow checks is gone. */
export function consentPluginPathPattern(id: string): string | undefined {
  return CONSENT_PLUGINS.find((p) => p.id === id)?.wpDirs?.source;
}

const CONSENT_PLUGINS: ConsentPluginDef[] = [
  { id: 'complianz', wpDirs: /\/wp-content\/plugins\/complianz[^/]*\//i, globals: ['complianz', 'cmplz_banner'] },
  { id: 'cookieyes', wpDirs: /\/wp-content\/plugins\/cookie-law-info\//i, globals: ['ckySettings', 'getCkyConsent', 'CookieYes'] },
  { id: 'cookie-notice', wpDirs: /\/wp-content\/plugins\/cookie-notice\//i, globals: ['cnArgs'] },
  { id: 'real-cookie-banner', wpDirs: /\/wp-content\/plugins\/real-cookie-banner[^/]*\//i },
  { id: 'borlabs-cookie', wpDirs: /\/wp-content\/plugins\/borlabs-cookie\//i, globals: ['BorlabsCookie'] },
  { id: 'iubenda', wpDirs: /\/wp-content\/plugins\/iubenda[^/]*\//i },
  { id: 'cookiebot', wpDirs: /\/wp-content\/plugins\/cookiebot\//i },
  { id: 'gdpr-cookie-compliance', wpDirs: /\/wp-content\/plugins\/gdpr-cookie-compliance\//i, globals: ['moove_frontend_gdpr_scripts'] },
  { id: 'webtoffee-cookie-consent', wpDirs: /\/wp-content\/plugins\/webtoffee-(?:cookie-consent|gdpr-cookie-consent)[^/]*\//i },
  { id: 'shopify-customer-privacy', globals: ['Shopify.customerPrivacy'], platform: 'shopify' },
];

function versionFromGenerator(generator: string | undefined, name: PlatformName): string | undefined {
  if (!generator) return undefined;
  if (name === 'wordpress') return /^wordpress\s+(\d+(?:\.\d+){0,2})/i.exec(generator)?.[1];
  return undefined;
}

/** Decide the platform from collected signals, or `undefined` when nothing is proven. */
export function classifyPlatform(signals: PlatformSignalsInput | undefined): PlatformFingerprint | undefined {
  if (!signals) return undefined;
  const globals = new Set(signals.globals);
  const generator = signals.generator?.trim();
  const found: Array<{ def: PlatformDef; evidence: string[]; strong: boolean }> = [];
  for (const def of PLATFORMS) {
    const evidence: string[] = [];
    let strong = false;
    for (const g of def.globals) {
      if (!globals.has(g)) continue;
      evidence.push(`window.${g}`);
      if (!WEAK_GLOBALS.has(g)) strong = true;
    }
    for (const rx of def.assets) {
      const hit = signals.assetUrls.find((u) => rx.test(u));
      if (hit) {
        evidence.push(`asset ${assetLabel(hit)}`);
        strong = true;
      }
    }
    if (generator && def.generator?.test(generator)) {
      evidence.push(`generator "${generator.slice(0, 40)}"`);
      strong = true;
    }
    if (strong) found.push({ def, evidence, strong });
  }
  if (!found.length) return undefined;
  // Several platforms can leave traces (a WordPress site embedding a Shopify buy
  // button). The page's own generator tag decides first, then the most evidence.
  found.sort((a, b) => Number(Boolean(generator && b.def.generator?.test(generator))) - Number(Boolean(generator && a.def.generator?.test(generator))) || b.evidence.length - a.evidence.length);
  const { def, evidence } = found[0];
  const out: PlatformFingerprint = { name: def.name, evidence };
  const version = def.name === 'squarespace' ? signals.templateVersion : versionFromGenerator(generator, def.name);
  if (version) out.version = version;
  for (const p of CONSENT_PLUGINS) {
    if (p.platform && p.platform !== def.name) continue;
    const viaGlobal = p.globals?.some((g) => globals.has(g));
    const viaPath = def.name === 'wordpress' && p.wpDirs ? signals.assetUrls.find((u) => p.wpDirs!.test(u)) : undefined;
    if (viaGlobal || viaPath) {
      out.consentPlugin = p.id;
      out.evidence.push(viaPath ? `plugin path ${assetLabel(viaPath)}` : `window.${p.globals!.find((g) => globals.has(g))}`);
      break;
    }
  }
  if (def.name === 'wordpress' && (globals.has('wp_has_consent') || globals.has('wp_consent_type') || signals.assetUrls.some((u) => /\/wp-content\/plugins\/wp-consent-api\//i.test(u)))) {
    out.wpConsentApi = true;
    out.evidence.push('WP Consent API');
  }
  return out;
}

/** host + path only: no query, so ids and tokens never reach the record. */
function assetLabel(u: string): string {
  try {
    const x = new URL(u, 'https://placeholder.invalid');
    return `${x.host === 'placeholder.invalid' ? '' : x.host}${x.pathname}`.slice(0, 100);
  } catch {
    return u.split('?')[0].slice(0, 100);
  }
}

/** Is `url` the platform's own loader? Host rules hold on any site; first-party path
 *  rules apply only when the page was already fingerprinted as that platform. */
export function platformLoaderOf(url: string, fingerprint: Pick<PlatformFingerprint, 'name'> | undefined): PlatformName | undefined {
  for (const def of PLATFORMS) {
    if (def.loaderHosts.some((rx) => rx.test(url))) return def.name;
  }
  if (!fingerprint) return undefined;
  const def = PLATFORMS.find((d) => d.name === fingerprint.name);
  // A consent plugin's script that inserts a tracker is releasing a tag the site
  // itself wrote (and the plugin held) — not the platform injecting one. Found in
  // the E4 field run: a WordPress consent plugin's release of every held tag was
  // filed as "injected by the wordpress platform".
  if (def?.name === 'wordpress' && isConsentPluginAsset(url)) return undefined;
  if (def?.loaderPaths.some((rx) => rx.test(url))) return def.name;
  return undefined;
}

/** Is `url` a known WordPress consent plugin's own asset? */
function isConsentPluginAsset(url: string): boolean {
  return CONSENT_PLUGINS.some((p) => p.wpDirs?.test(url));
}
