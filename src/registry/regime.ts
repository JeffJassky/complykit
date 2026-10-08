// Visitor location → consent regime (plans/client-consent-design.md §6
// "Location", §9 decision 4). Shared by the scanner and the client package
// (`client/`), so this file imports NOTHING — the client bundles it as-is,
// without zod or the rest of the registry. Keep it small: act names, citations
// and URLs live in us-states.ts, which only the scanner loads.
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

/**
 * What the scanner reports for a measured location: a regime, or 'unknown' when
 * no researched law reaches it (then nothing is compared). The client never
 * runs under 'unknown' — `regimeFor()` maps it to 'opt-in'.
 */
export type RegimeVerdict = ConsentRegime | 'unknown';

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
 * US states with a comprehensive consumer privacy act: the date the act is in
 * force (`from`) and, where the act requires honoring an opt-out preference
 * signal (GPC), the date that duty starts (`gpcFrom`). California is the CCPA
 * (in force 2020-01-01; GPC under regs §7025 from 2023-03-29). The rest are per
 * research-consent-law.md §1.4 and the CPPA's 2026-08-06 list. Louisiana's and
 * Vermont's signal duties are enacted for 2027-01 / 2028-01 without a confirmed
 * day; they get `gpcFrom` when it is confirmed. Enacted acts with a future `from`
 * are listed so they switch on by date, not by a release.
 */
export const US_PRIVACY_ACT_STATES: ReadonlyArray<{ state: string; from: string; gpcFrom?: string }> = [
  { state: 'CA', from: '2020-01-01', gpcFrom: '2023-03-29' },
  { state: 'VA', from: '2023-01-01' },
  { state: 'CO', from: '2023-07-01', gpcFrom: '2024-07-01' },
  { state: 'CT', from: '2023-07-01', gpcFrom: '2025-01-01' },
  { state: 'UT', from: '2023-12-31' },
  { state: 'TX', from: '2024-07-01', gpcFrom: '2025-01-01' },
  { state: 'OR', from: '2024-07-01', gpcFrom: '2026-01-01' },
  { state: 'MT', from: '2024-10-01', gpcFrom: '2025-01-01' },
  { state: 'IA', from: '2025-01-01' },
  { state: 'DE', from: '2025-01-01', gpcFrom: '2026-01-01' },
  { state: 'NE', from: '2025-01-01', gpcFrom: '2025-01-01' },
  { state: 'NH', from: '2025-01-01', gpcFrom: '2025-01-01' },
  { state: 'NJ', from: '2025-01-15', gpcFrom: '2025-07-15' },
  { state: 'TN', from: '2025-07-01' },
  { state: 'MN', from: '2025-07-31', gpcFrom: '2025-07-31' },
  { state: 'MD', from: '2025-10-01', gpcFrom: '2025-10-01' },
  { state: 'IN', from: '2026-01-01' },
  { state: 'KY', from: '2026-01-01' },
  { state: 'RI', from: '2026-01-01' },
  { state: 'OK', from: '2027-01-01' },
  { state: 'LA', from: '2027-01-01' },
  { state: 'AL', from: '2027-05-01' },
  { state: 'VT', from: '2028-01-01' },
];

/**
 * US states whose law requires honoring an opt-out preference signal (GPC), with
 * the date that duty starts. Derived from US_PRIVACY_ACT_STATES (one table, two
 * views).
 */
export const US_OPT_OUT_SIGNAL_STATES: ReadonlyArray<{ state: string; from: string }> = US_PRIVACY_ACT_STATES.filter(
  (s): s is { state: string; from: string; gpcFrom: string } => typeof s.gpcFrom === 'string',
).map((s) => ({ state: s.state, from: s.gpcFrom }));

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
 * The regime for a location, on a date (default: today). The client's decision.
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

/**
 * The regime for a measured location expressed as jurisdiction codes
 * (jurisdictions.ts: ['eu','eu-de'], ['uk'], ['us','us-tx'], ['us'], ['br']), on a
 * date. The scanner's decision — the one the report, the behavior matrix and the
 * compatibility expectations share.
 *
 *   'eu' or 'uk' present                       → opt-in
 *   'us-<st>' with the signal duty in effect   → opt-out-signal
 *   'us-<st>' otherwise                        → opt-out
 *   'us' with no state code                    → `unverifiedUs`: 'baseline' (default,
 *                                                the scanner: assert no state law we could
 *                                                not verify) → opt-out; 'strict' (the
 *                                                client's posture) → opt-out-signal
 *   anything else, or no codes                 → unknown (nothing researched; the scanner
 *                                                compares nothing, the client is opt-in)
 */
export function regimeForCodes(
  codes: readonly string[],
  onDate: string = today(),
  opts: { unverifiedUs?: 'baseline' | 'strict' } = {},
): RegimeVerdict {
  if (codes.includes('eu') || codes.includes('uk')) return 'opt-in';
  if (codes.includes('us')) {
    const state = codes.find((c) => /^us-[a-z]{2}$/i.test(c));
    if (!state) return opts.unverifiedUs === 'strict' ? 'opt-out-signal' : 'opt-out';
    return isOptOutSignalState(state.slice(3), onDate) ? 'opt-out-signal' : 'opt-out';
  }
  return 'unknown';
}

const stateOf = (region: string | undefined): string | undefined => region?.trim().toUpperCase().replace(/^US[-_]/, '') || undefined;

/** Whether a US state's law requires honoring GPC on a date. The client honors GPC US-wide anyway (research §8.2). */
export function isOptOutSignalState(region: string, onDate: string = today()): boolean {
  const st = stateOf(region);
  return !!st && US_OPT_OUT_SIGNAL_STATES.some((s) => s.state === st && s.from <= onDate);
}

/** Whether a US state has a comprehensive privacy act in force on a date. */
export function isUsPrivacyActState(region: string, onDate: string = today()): boolean {
  const st = stateOf(region);
  return !!st && US_PRIVACY_ACT_STATES.some((s) => s.state === st && s.from <= onDate);
}
