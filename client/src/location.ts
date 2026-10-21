// Where the visitor is, and which regime that puts them under (ticket D7).
//
// The browser does not know where it is. The location comes from the site's own
// server, its CDN or its platform — NEVER from a call to a third-party geo
// service (design §9, decision 4): such a call is itself a pre-consent request
// to a third party, the very thing the scanner reports.
//
// Sources, first hit wins:
//   0. global    window.ComplyKitRegion = 'US-CA', set by the site before this script.
//                Read synchronously, beats everything below (the header endpoint is
//                never fetched). Anything that is not a location is ignored.
//                `ComplyKit.setRegion()` (api.ts) is the after-load route, source 'api'.
//   1. fixed     config.regimeSource {kind:'fixed'} — one regime for everyone. The
//                global, then the default meta tag, are still read, for the visitor's
//                location only.
//   2. meta      <meta name="complykit-region" content="US-CA"> written by the
//                server template (or the name config.regimeSource names).
//                Checked for every non-fixed source: it is synchronous and
//                server-authored, so it beats a network round trip.
//   3. header    {kind:'header'}: an endpoint that echoes a CDN header as its
//                body ("DE", "US-CA"). It must share the origin of the page OR of
//                this tool's own script (the host that served it: the hosted
//                install asks GET <host>/geo, a party the visitor already
//                reached for the script). Asynchronous: until it
//                answers, the visitor is under the strictest regime (`pending`),
//                then the store moves to the real one (overrides.regimes['*'] does not apply while
//                pending: scripts released then cannot be unrun). An endpoint on any
//                third origin is refused.
//   4. platform  {kind:'platform'}: Shopify `customerPrivacy.getRegion()`, read
//                only if the platform already loaded it (the bridge is E1's).
//   5. unknown   → FALLBACK_REGIME ('opt-in', the strictest).
//
// Location → regime is `regimeFor()` from src/registry/regime.ts, the same
// table the scanner uses, unless the site owner moved it: `overrides.regimes`
// (schema 1.1) is checked first through the shared `overriddenRegime()`, and
// the decision says so (`overridden`). A `fixed` source ignores overrides. GPC (`navigator.globalPrivacyControl`) is read here
// and reported with the decision; the store applies it (every non-necessary
// default denied, design §6) and puts `gpc` in the consent record.

import { regimeFor, parseRegimeLocation, type ConsentRegime, type RegimeLocation } from '../../src/registry/regime.js';
import { FALLBACK_REGIME, overriddenRegime, type ConsentToolConfig, type Regime } from './config.js';
import { diagnostics } from './diagnostics.js';

// The registry's regime union and the config contract's must stay one type.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _sameRegime: Same<ConsentRegime, Regime> = true;
void _sameRegime;

export const DEFAULT_REGION_META = 'complykit-region';
/** How long the header endpoint gets before the visitor stays on the strictest regime for this page. */
export const HEADER_TIMEOUT_MS = 3000;

export type LocationSource = 'fixed' | 'global' | 'api' | 'meta' | 'header' | 'platform' | 'unknown';

export interface LocationDecision {
  regime: Regime;
  source: LocationSource;
  /** What the source reported (absent for fixed / unknown). */
  location?: RegimeLocation;
  /** navigator.globalPrivacyControl === true. */
  gpc: boolean;
  /** True while a header lookup is outstanding: `regime` is the strict placeholder (never an override). */
  pending: boolean;
  /** `regime` came from the owner's `overrides.regimes`, not the built-in table. */
  overridden: boolean;
}

/** Everything the resolver touches, injectable for tests. Defaults to the page's globals. */
export interface LocationEnv {
  document?: Pick<Document, 'querySelector'>;
  navigator?: object;
  /** For the platform source: `window.Shopify`. */
  window?: { ComplyKitRegion?: unknown; Shopify?: { customerPrivacy?: { getRegion?: () => unknown } } };
  fetch?: (url: string, init?: RequestInit) => Promise<{ ok: boolean; text(): Promise<string> }>;
  /** The page URL; the header endpoint may share its origin. */
  pageUrl?: string;
  /** The tool script's own URL (`document.currentScript.src` at load); the header endpoint may share its origin too. */
  scriptUrl?: string;
  timeoutMs?: number;
  /** YYYY-MM-DD for regimeFor (tests). */
  onDate?: string;
}

export interface LocationResolution {
  /** Decided synchronously, before any tracker can run. */
  initial: LocationDecision;
  /** Settles once (never rejects): `initial` itself unless a header lookup was started. */
  ready: Promise<LocationDecision>;
}

export function readGpc(nav: object | undefined = typeof navigator !== 'undefined' ? navigator : undefined): boolean {
  try {
    return (nav as { globalPrivacyControl?: unknown } | undefined)?.globalPrivacyControl === true;
  } catch {
    return false;
  }
}

function readMeta(doc: LocationEnv['document'], name: string): RegimeLocation | undefined {
  if (!doc || !/^[\w.:-]+$/.test(name)) return undefined;
  try {
    return parseRegimeLocation(doc.querySelector(`meta[name="${name}"]`)?.getAttribute('content'));
  } catch {
    return undefined;
  }
}

function readGlobal(win: LocationEnv['window']): RegimeLocation | undefined {
  try {
    return parseRegimeLocation(win?.ComplyKitRegion);
  } catch {
    return undefined;
  }
}

function readPlatform(win: LocationEnv['window']): RegimeLocation | undefined {
  try {
    const cp = win?.Shopify?.customerPrivacy;
    return typeof cp?.getRegion === 'function' ? parseRegimeLocation(cp.getRegion()) : undefined;
  } catch {
    return undefined;
  }
}

// This script's own URL, captured while it loads (document.currentScript is null afterwards).
const ownScriptUrl = ((): string | undefined => {
  try {
    return typeof document !== 'undefined' ? (document.currentScript as HTMLScriptElement | null)?.src || undefined : undefined;
  } catch {
    return undefined;
  }
})();

/** The endpoint as an absolute URL when it shares the origin of the page or of the tool's own script; undefined otherwise. */
export function sameOriginEndpoint(endpoint: string, pageUrl: string | undefined, scriptUrl?: string): string | undefined {
  if (!pageUrl) return undefined;
  try {
    const page = new URL(pageUrl);
    const u = new URL(endpoint, page);
    if (u.origin === page.origin) return u.href;
    return scriptUrl && u.origin === new URL(scriptUrl).origin ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Decide the visitor's regime from the config's source. Never throws; anything
 * unreadable is `unknown` → the strictest regime.
 */
export function resolveLocation(config: ConsentToolConfig, env: LocationEnv = {}): LocationResolution {
  const doc = env.document ?? (typeof document !== 'undefined' ? document : undefined);
  const win = env.window ?? (typeof window !== 'undefined' ? (window as LocationEnv['window']) : undefined);
  const gpc = readGpc(env.navigator ?? (typeof navigator !== 'undefined' ? navigator : undefined));
  const src = config.regimeSource;
  // An unknown location matches only the '*' override; otherwise it is the strictest regime.
  const decide = (source: LocationSource, location?: RegimeLocation): LocationDecision => {
    const o = overriddenRegime(config, location);
    return {
      regime: o ?? (location ? regimeFor(location, env.onDate) : FALLBACK_REGIME),
      source: location ? source : 'unknown',
      location,
      gpc,
      pending: false,
      overridden: o !== undefined,
    };
  };
  const note = (d: LocationDecision): LocationDecision => {
    diagnostics.location = d;
    return d;
  };
  const done = (d: LocationDecision): LocationResolution => {
    note(d);
    return { initial: d, ready: Promise.resolve(d) };
  };

  if (src.kind === 'fixed') {
    // The regime is fixed and overrides.regimes is ignored, but the global, then the meta tag
    // (and only they) still tell us WHERE the visitor is, so locationDefaults and location-keyed
    // overrides.defaults apply.
    const where = readGlobal(win) ?? readMeta(doc, DEFAULT_REGION_META);
    return done({ regime: src.regime, source: 'fixed', location: where, gpc, pending: false, overridden: false });
  }

  const fromGlobal = readGlobal(win);
  if (fromGlobal) return done(decide('global', fromGlobal));

  const metaName = src.kind === 'meta' && src.name ? src.name : DEFAULT_REGION_META;
  const fromMeta = readMeta(doc, metaName) ?? (metaName !== DEFAULT_REGION_META ? readMeta(doc, DEFAULT_REGION_META) : undefined);
  if (fromMeta) return done(decide('meta', fromMeta));

  if (src.kind === 'platform') return done(decide('platform', readPlatform(win)));

  if (src.kind === 'header') {
    const pageUrl = env.pageUrl ?? (typeof location !== 'undefined' ? location.href : undefined);
    const url = sameOriginEndpoint(src.endpoint, pageUrl, 'scriptUrl' in env ? env.scriptUrl : ownScriptUrl);
    const f = env.fetch ?? (typeof fetch === 'function' ? fetch : undefined);
    if (!url || !f) {
      if (!url && typeof console !== 'undefined') console.warn(`[complykit] location endpoint ${src.endpoint} is on neither the page's nor the script's origin; using the strictest regime`);
      return done(decide('unknown'));
    }
    // "Not known yet" is not "unknown": scripts released in this window cannot be
    // unrun, so a pending lookup always starts strict, whatever overrides.regimes['*'] says.
    const initial: LocationDecision = { regime: FALLBACK_REGIME, source: 'unknown', gpc, pending: true, overridden: false };
    diagnostics.location = { ...initial, source: 'header' };
    const lookup = f(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { accept: 'text/plain' } })
      .then((res) => (res.ok ? res.text() : ''))
      .then((body) => decide('header', parseRegimeLocation(body.split(/[\r\n,]/)[0])))
      .catch(() => decide('unknown'));
    const timeout = new Promise<LocationDecision>((r) => setTimeout(() => r(decide('unknown')), env.timeoutMs ?? HEADER_TIMEOUT_MS));
    const ready = Promise.race([lookup, timeout]).then((d) => (diagnostics.location?.pending ? note(d) : d)); // setRegion() ran meanwhile: keep its record
    return { initial, ready };
  }

  return done(decide('unknown'));
}
