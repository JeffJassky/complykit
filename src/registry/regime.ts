// Visitor location → consent regime (plans/client-consent-design.md §6
// "Location", §9 decision 4). Shared by the scanner and the client package
// (`client/`), so this file imports NOTHING — the client bundles it as-is,
// without zod or the rest of the registry.
//
// The tables are data from plans/research-consent-law.md §1.4 and §3. The
// registry's requirement entries derive their state lists from them
// (requirements/tracking.ts), so the scanner's "which states honor opt-out
// signals" and the client's "which regime is this visitor in" cannot drift.
//
// The vocabulary is the scanner's (report/consent-matrix.ts, cookie-purpose.ts):
//   opt-in         — EU/EEA, UK: prior consent.
//   opt-out-signal — a US state whose law requires honoring an opt-out
//                    preference signal (GPC).
//   opt-out        — the rest of the US: opt-out rules, no signal mandate.
// The scanner's fourth value, 'unknown' (anywhere else), is not a regime the
// client can run under: here it is `opt-in`. Fail closed: a location we cannot
// read, or a country we have not researched, is `opt-in` (the strictest).

/** Same literal union as `Regime` in src/record/consent-config-guard.ts (registry may not import record). */
export type ConsentRegime = 'opt-in' | 'opt-out-signal' | 'opt-out';

/** What the server, CDN or platform told us. ISO 3166-1 alpha-2 country; ISO 3166-2 subdivision suffix ('CA'). */
export interface RegimeLocation {
  country: string;
  region?: string;
}

// EU-27 + EEA (IS, LI, NO): ePrivacy Art 5(3) prior consent.
export const EU_EEA_COUNTRIES: readonly string[] = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV',
  'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO',
];

/** UK under PECR reg 6 (research §3.3). 'UK' is not ISO but some CDNs send it. */
export const UK_COUNTRIES: readonly string[] = ['GB', 'UK'];

/**
 * US states whose law requires honoring an opt-out preference signal (GPC), with
 * the date that duty starts. California is CCPA regs §7025; the rest are the
 * state comprehensive acts per the CPPA's 2026-08-06 list (research §1.4).
 * Louisiana (2027-01) and Vermont (2028-01) are enacted but not yet listed;
 * add them here when their dates are confirmed.
 */
export const US_OPT_OUT_SIGNAL_STATES: ReadonlyArray<{ state: string; from: string }> = [
  { state: 'CA', from: '2023-03-29' },
  { state: 'CO', from: '2024-07-01' },
  { state: 'CT', from: '2025-01-01' },
  { state: 'TX', from: '2025-01-01' },
  { state: 'MT', from: '2025-01-01' },
  { state: 'NE', from: '2025-01-01' },
  { state: 'NH', from: '2025-01-01' },
  { state: 'NJ', from: '2025-07-15' },
  { state: 'MN', from: '2025-07-31' },
  { state: 'MD', from: '2025-10-01' },
  { state: 'OR', from: '2026-01-01' },
  { state: 'DE', from: '2026-01-01' },
];

// USPS codes for the 50 states, DC and the inhabited territories. A region outside
// this list is a misread, not a place: it is treated as "state not reported".
const US_REGION_CODES =
  'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR GU VI AS MP'.split(' ');

const today = (): string => new Date().toISOString().slice(0, 10);

/**
 * Parse what a meta tag, header echo or platform reports: "DE", "US-CA",
 * "us_ca", "USCA" (Shopify's form), "US". Returns undefined for anything that
 * is not a two-letter country (CDN placeholders like "XX" and "T1" — Tor —
 * are unknown, not a country).
 */
export function parseRegimeLocation(raw: unknown): RegimeLocation | undefined {
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim().toUpperCase();
  const m = /^([A-Z]{2})(?:[-_ ]?([A-Z0-9]{1,3}))?$/.exec(s);
  if (!m) return undefined;
  const country = m[1];
  if (country === 'XX' || country === 'ZZ') return undefined;
  return m[2] ? { country, region: m[2] } : { country };
}

/**
 * The regime for a location, on a date (default: today).
 *   EU/EEA, UK                                     → opt-in
 *   US state whose signal duty is in effect        → opt-out-signal
 *   US, state not reported or not recognized       → opt-out-signal (the strictest US
 *                                                    regime: the visitor may be in California)
 *   any other US state                             → opt-out
 *   any other country, or no location              → opt-in (not researched ⇒ strictest)
 */
export function regimeFor(location: RegimeLocation | undefined, onDate: string = today()): ConsentRegime {
  if (!location || typeof location.country !== 'string') return 'opt-in';
  const cc = location.country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return 'opt-in';
  if (EU_EEA_COUNTRIES.includes(cc) || UK_COUNTRIES.includes(cc)) return 'opt-in';
  if (cc === 'US') {
    const st = stateOf(location.region);
    if (!st || !US_REGION_CODES.includes(st)) return 'opt-out-signal';
    return isOptOutSignalState(st, onDate) ? 'opt-out-signal' : 'opt-out';
  }
  return 'opt-in';
}

const stateOf = (region: string | undefined): string | undefined => region?.trim().toUpperCase().replace(/^US[-_]/, '') || undefined;

/** Whether a US state's law requires honoring GPC on a date. The client honors GPC US-wide anyway (research §8.2). */
export function isOptOutSignalState(region: string, onDate: string = today()): boolean {
  const st = stateOf(region);
  return !!st && US_OPT_OUT_SIGNAL_STATES.some((s) => s.state === st && s.from <= onDate);
}
