// Where the visitor is, and which regime that puts them under (ticket D7).
//
// The browser does not know where it is. The location comes from the site's own
// server, its CDN or its platform — NEVER from a call to a third-party geo
// service (design §9, decision 4): such a call is itself a pre-consent request
// to a third party, the very thing the scanner reports.
//
// Sources, first hit wins:
//   1. fixed     config.regimeSource {kind:'fixed'} — one regime for everyone.
//   2. meta      <meta name="complykit-region" content="US-CA"> written by the
//                server template (or the name config.regimeSource names).
//                Checked for every non-fixed source: it is synchronous and
//                server-authored, so it beats a network round trip.
//   3. header    {kind:'header'}: a SAME-ORIGIN endpoint that echoes a CDN
//                header as its body ("DE", "US-CA"). Asynchronous: until it
//                answers, the visitor is under the strictest regime (`pending`),
//                then the store moves to the real one. A cross-origin endpoint
//                is refused.
//   4. platform  {kind:'platform'}: Shopify `customerPrivacy.getRegion()`, read
//                only if the platform already loaded it (the bridge is E1's).
//   5. unknown   → FALLBACK_REGIME ('opt-in', the strictest).
//
// Location → regime is `regimeFor()` from src/registry/regime.ts, the same
// table the scanner uses. GPC (`navigator.globalPrivacyControl`) is read here
// and reported with the decision; the store applies it (every non-necessary
// default denied, design §6) and puts `gpc` in the consent record.

import { regimeFor, parseRegimeLocation, type ConsentRegime, type RegimeLocation } from '../../src/registry/regime.js';
import { FALLBACK_REGIME, type ConsentToolConfig, type Regime } from './config.js';
import { diagnostics } from './diagnostics.js';

// The registry's regime union and the config contract's must stay one type.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _sameRegime: Same<ConsentRegime, Regime> = true;
void _sameRegime;

export const DEFAULT_REGION_META = 'complykit-region';
/** How long the header endpoint gets before the visitor stays on the strictest regime for this page. */
export const HEADER_TIMEOUT_MS = 3000;

export type LocationSource = 'fixed' | 'meta' | 'header' | 'platform' | 'unknown';

export interface LocationDecision {
  regime: Regime;
  source: LocationSource;
  /** What the source reported (absent for fixed / unknown). */
  location?: RegimeLocation;
  /** navigator.globalPrivacyControl === true. */
  gpc: boolean;
  /** True while a header lookup is outstanding: `regime` is the strict placeholder. */
  pending: boolean;
}

/** Everything the resolver touches, injectable for tests. Defaults to the page's globals. */
export interface LocationEnv {
  document?: Pick<Document, 'querySelector'>;
  navigator?: object;
  /** For the platform source: `window.Shopify`. */
  window?: { Shopify?: { customerPrivacy?: { getRegion?: () => unknown } } };
  fetch?: (url: string, init?: RequestInit) => Promise<{ ok: boolean; text(): Promise<string> }>;
  /** The page URL; the header endpoint must share its origin. */
  pageUrl?: string;
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

function readPlatform(win: LocationEnv['window']): RegimeLocation | undefined {
  try {
    const cp = win?.Shopify?.customerPrivacy;
    return typeof cp?.getRegion === 'function' ? parseRegimeLocation(cp.getRegion()) : undefined;
  } catch {
    return undefined;
  }
}

/** The endpoint as an absolute URL when it is same-origin with the page; undefined otherwise. */
export function sameOriginEndpoint(endpoint: string, pageUrl: string | undefined): string | undefined {
  if (!pageUrl) return undefined;
  try {
    const page = new URL(pageUrl);
    const u = new URL(endpoint, page);
    return u.origin === page.origin ? u.href : undefined;
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
  const decide = (source: LocationSource, location?: RegimeLocation): LocationDecision => ({
    regime: location ? regimeFor(location, env.onDate) : FALLBACK_REGIME,
    source: location ? source : 'unknown',
    location,
    gpc,
    pending: false,
  });
  const done = (d: LocationDecision): LocationResolution => {
    diagnostics.location = { source: d.source, regime: d.regime, pending: d.pending, gpc };
    return { initial: d, ready: Promise.resolve(d) };
  };

  if (src.kind === 'fixed') {
    return done({ regime: src.regime, source: 'fixed', gpc, pending: false });
  }

  const metaName = src.kind === 'meta' && src.name ? src.name : DEFAULT_REGION_META;
  const fromMeta = readMeta(doc, metaName) ?? (metaName !== DEFAULT_REGION_META ? readMeta(doc, DEFAULT_REGION_META) : undefined);
  if (fromMeta) return done(decide('meta', fromMeta));

  if (src.kind === 'platform') return done(decide('platform', readPlatform(win)));

  if (src.kind === 'header') {
    const pageUrl = env.pageUrl ?? (typeof location !== 'undefined' ? location.href : undefined);
    const url = sameOriginEndpoint(src.endpoint, pageUrl);
    const f = env.fetch ?? (typeof fetch === 'function' ? fetch : undefined);
    if (!url || !f) {
      if (!url && typeof console !== 'undefined') console.warn(`[complykit] location endpoint ${src.endpoint} is not same-origin; using the strictest regime`);
      return done(decide('unknown'));
    }
    const initial: LocationDecision = { regime: FALLBACK_REGIME, source: 'unknown', gpc, pending: true };
    diagnostics.location = { source: 'header', regime: initial.regime, pending: true, gpc };
    const lookup = f(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { accept: 'text/plain' } })
      .then((res) => (res.ok ? res.text() : ''))
      .then((body) => decide('header', parseRegimeLocation(body.split(/[\r\n,]/)[0])))
      .catch(() => decide('unknown'));
    const timeout = new Promise<LocationDecision>((r) => setTimeout(() => r(decide('unknown')), env.timeoutMs ?? HEADER_TIMEOUT_MS));
    const ready = Promise.race([lookup, timeout]).then((d) => {
      diagnostics.location = { source: d.source, regime: d.regime, pending: false, gpc };
      return d;
    });
    return { initial, ready };
  }

  return done(decide('unknown'));
}
