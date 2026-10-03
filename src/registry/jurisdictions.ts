import type { Requirement } from './schema.js';

// Visitor location → jurisdiction codes, and requirement scoping by those codes
// (plans/consent-design.md §8). Pure. A location is what the scan MEASURED
// (verified exit IP), never a hand-set property tag.
//
// Codes: 'eu' covers the EU and the EEA states that apply the ePrivacy rules;
// 'uk'; 'us' plus 'us-<state>' when the region is verified; otherwise the
// lower-cased ISO country. 'any' on a requirement matches every location.

// EU-27 + EEA (IS, LI, NO).
const EU_EEA = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV',
  'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO',
]);

export function isEuEea(country: string): boolean {
  return EU_EEA.has(country.toUpperCase());
}

export interface MeasuredPlace {
  country: string; // ISO 3166-1 alpha-2
  region?: string; // ISO 3166-2 subdivision suffix, e.g. 'CA' for California
}

/** Most general first: ['us', 'us-ca'], ['eu', 'eu-de'], ['uk']. */
export function jurisdictionsFor(place: MeasuredPlace): string[] {
  const cc = place.country.toUpperCase();
  if (isEuEea(cc)) return ['eu', `eu-${cc.toLowerCase()}`];
  if (cc === 'GB' || cc === 'UK') return ['uk'];
  if (cc === 'US') return place.region ? ['us', `us-${place.region.toLowerCase()}`] : ['us'];
  return [cc.toLowerCase()];
}

/**
 * The requirement's scope code that a location falls under, on a date — or
 * undefined if the requirement doesn't reach it (or isn't effective there yet).
 * Returns the most specific match so a finding's landmark names the law's own
 * jurisdiction ('eu', 'us-ca', 'us-co').
 */
export function requirementScopeFor(
  req: Requirement,
  codes: readonly string[],
  onDate: string,
): string | undefined {
  if (!req.jurisdictions?.length) return undefined;
  if (req.effective.from > onDate) return undefined;
  if (req.effective.until && req.effective.until < onDate) return undefined;
  let best: string | undefined;
  for (const scope of req.jurisdictions) {
    const hit = scope.code === 'any' || codes.includes(scope.code);
    if (!hit) continue;
    if (scope.from && scope.from > onDate) continue;
    // Prefer the specific code over 'any'.
    if (!best || best === 'any') best = scope.code === 'any' ? 'any' : scope.code;
  }
  return best;
}

// US state names → USPS codes (geo services report either).
const US_STATES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY',
  louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH',
  'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND',
  ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI',
  'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};

/** Normalize a region as a geo service reports it ('California', 'CA', 'US-CA') to 'CA'. */
export function normalizeRegion(country: string, region: string | undefined): string | undefined {
  if (!region) return undefined;
  const r = region.trim();
  if (!r) return undefined;
  const stripped = r.replace(new RegExp(`^${country}-`, 'i'), '');
  if (country.toUpperCase() === 'US') {
    if (/^[A-Za-z]{2}$/.test(stripped)) return stripped.toUpperCase();
    return US_STATES[stripped.toLowerCase()];
  }
  return /^[A-Za-z0-9]{1,3}$/.test(stripped) ? stripped.toUpperCase() : undefined;
}
