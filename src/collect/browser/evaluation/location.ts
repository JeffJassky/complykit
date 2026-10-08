import type { Browser, BrowserContextOptions } from 'playwright';
import type { LocationSpec, GeoSourceResult } from '../../../record/index.js';

// Location verification (plans/consent-design.md §2.2). Sites decide what to
// show from the visitor's IP, so a finding is attributed to a place only after
// the exit the browser actually used has been looked up in TWO independent
// geolocation sources — through the same proxy the scenarios use, from inside
// the browser, so the lookup can't take a different path than the evidence.
//
//   verified — both sources agree, and agree with what was expected;
//   mismatch — a source places the exit somewhere other than expected;
//   unknown  — a lookup failed or the sources disagree with each other.
//
// Only verified locations produce findings; everything else is "not tested".
// This file is the I/O (lookups through the proxy, context settings); the pure
// verdict is rules/tracking/plan.ts decideVerification, passed in as policy.

export interface GeoSource {
  name: string;
  /** Look up the exit. `fetchJson` fetches a URL from inside the browser; `spec`
   *  is the location being verified (live sources ignore it; test stubs use it). */
  lookup(fetchJson: (url: string) => Promise<unknown>, spec: LocationSpec): Promise<Omit<GeoSourceResult, 'name'>>;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export const IPINFO: GeoSource = {
  name: 'ipinfo.io',
  async lookup(fetchJson) {
    const j = (await fetchJson('https://ipinfo.io/json')) as Record<string, unknown>;
    return { ip: str(j.ip), country: str(j.country)?.toUpperCase(), region: str(j.region), city: str(j.city), org: str(j.org) };
  },
};

export const IPWHOIS: GeoSource = {
  name: 'ipwho.is',
  async lookup(fetchJson) {
    const j = (await fetchJson('https://ipwho.is/')) as Record<string, unknown>;
    if (j.success === false) throw new Error(str(j.message) ?? 'lookup failed');
    const conn = j.connection as Record<string, unknown> | undefined;
    return { ip: str(j.ip), country: str(j.country_code)?.toUpperCase(), region: str(j.region_code) ?? str(j.region), city: str(j.city), org: str(conn?.org) };
  },
};

export const DEFAULT_GEO_SOURCES: GeoSource[] = [IPINFO, IPWHOIS];

// Sensible browser locale/timezone per country when the config doesn't say.
const DEFAULTS: Record<string, { timezone: string; locale: string }> = {
  US: { timezone: 'America/New_York', locale: 'en-US' },
  GB: { timezone: 'Europe/London', locale: 'en-GB' },
  DE: { timezone: 'Europe/Berlin', locale: 'de-DE' },
  FR: { timezone: 'Europe/Paris', locale: 'fr-FR' },
  NL: { timezone: 'Europe/Amsterdam', locale: 'nl-NL' },
  IE: { timezone: 'Europe/Dublin', locale: 'en-IE' },
  ES: { timezone: 'Europe/Madrid', locale: 'es-ES' },
  IT: { timezone: 'Europe/Rome', locale: 'it-IT' },
  SE: { timezone: 'Europe/Stockholm', locale: 'sv-SE' },
  CA: { timezone: 'America/Toronto', locale: 'en-CA' },
  AU: { timezone: 'Australia/Sydney', locale: 'en-AU' },
};
const US_TZ: Record<string, string> = {
  CA: 'America/Los_Angeles', WA: 'America/Los_Angeles', OR: 'America/Los_Angeles', NV: 'America/Los_Angeles',
  CO: 'America/Denver', MT: 'America/Denver', UT: 'America/Denver', AZ: 'America/Phoenix',
  TX: 'America/Chicago', MN: 'America/Chicago', NE: 'America/Chicago', IL: 'America/Chicago',
  FL: 'America/New_York', PA: 'America/New_York', NY: 'America/New_York', NJ: 'America/New_York',
  CT: 'America/New_York', MD: 'America/New_York', DE: 'America/New_York', NH: 'America/New_York', VA: 'America/New_York',
};

/** Browser-context settings that make a visit look like it comes from `spec`. */
/**
 * Launch flags that make the scan browser look like a visitor's: without them
 * Chromium reports navigator.webdriver = true, and consent tools that hide
 * from bots (CookieConsent v3's default hideFromBots, among others) never
 * show their banner, so the scan judges a site its visitors never see.
 */
export const VISITOR_LAUNCH_ARGS = ['--disable-blink-features=AutomationControlled'];

/** A desktop Chrome user agent for this browser version (headless Chromium says "HeadlessChrome"). */
export function visitorUserAgent(browserVersion: string): string {
  const major = /^(\d+)/.exec(browserVersion)?.[1] ?? '130';
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

export function contextOptionsFor(spec: LocationSpec, browserVersion?: string): BrowserContextOptions {
  const cc = spec.country?.toUpperCase();
  const d = cc ? DEFAULTS[cc] : undefined;
  const timezoneId = spec.timezone ?? (cc === 'US' && spec.region ? US_TZ[spec.region.toUpperCase()] : undefined) ?? d?.timezone;
  const locale = spec.locale ?? d?.locale;
  return {
    ...(browserVersion ? { userAgent: visitorUserAgent(browserVersion) } : {}),
    ...(spec.proxy ? { proxy: { server: spec.proxy.server, username: spec.proxy.username, password: spec.proxy.password, bypass: spec.proxy.bypass } } : {}),
    ...(timezoneId ? { timezoneId } : {}),
    ...(locale ? { locale } : {}),
  };
}

/** Look the exit up through the location's own proxy, from inside a browser. */
export async function lookupExit(browser: Browser, spec: LocationSpec, sources: GeoSource[], timeoutMs = 15000): Promise<GeoSourceResult[]> {
  const context = await browser.newContext(contextOptionsFor(spec, browser.version()));
  try {
    const page = await context.newPage();
    await page.goto('about:blank').catch(() => {});
    const fetchJson = async (url: string): Promise<unknown> =>
      page.evaluate(
        async ({ u, ms }) => {
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), ms);
          try {
            const r = await fetch(u, { signal: ctl.signal, headers: { accept: 'application/json' } });
            return await r.json();
          } finally {
            clearTimeout(timer);
          }
        },
        { u: url, ms: timeoutMs },
      );
    const out: GeoSourceResult[] = [];
    for (const s of sources) {
      try {
        out.push({ name: s.name, ...(await s.lookup(fetchJson, spec)) });
      } catch (err) {
        out.push({ name: s.name, error: err instanceof Error ? err.message.slice(0, 120) : 'lookup failed' });
      }
    }
    return out;
  } finally {
    await context.close();
  }
}
