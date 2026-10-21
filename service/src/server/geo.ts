// Visitor location for the hosted script (plans/regime-overrides.md "Hosted location").
//
// GET /geo answers "CC" or "CC-RR" from a local GeoIP database, so a hosted
// install learns where the visitor is without any third-party call. The IP is
// read, looked up and dropped: never logged, stored or cached.

import fs from 'node:fs';
import { Reader, type CityResponse } from 'mmdb-lib';

export type GeoLookup = (ip: string) => { country: string; region?: string } | undefined;

// DB-IP City Lite names subdivisions ("California") without an ISO code, so the
// regions the consent rules key on are mapped from their English names. US states
// carry the wiretap holds; Canadian provinces are what owner overrides name (CA-QC).
const SUBDIVISION_CODES: Record<string, Record<string, string>> = {
  US: Object.fromEntries(
    (
      'Alabama:AL Alaska:AK Arizona:AZ Arkansas:AR California:CA Colorado:CO Connecticut:CT Delaware:DE Florida:FL Georgia:GA Hawaii:HI Idaho:ID Illinois:IL Indiana:IN Iowa:IA Kansas:KS Kentucky:KY Louisiana:LA Maine:ME Maryland:MD Massachusetts:MA Michigan:MI Minnesota:MN Mississippi:MS Missouri:MO Montana:MT Nebraska:NE Nevada:NV ' +
      'New_Hampshire:NH New_Jersey:NJ New_Mexico:NM New_York:NY North_Carolina:NC North_Dakota:ND Ohio:OH Oklahoma:OK Oregon:OR Pennsylvania:PA Rhode_Island:RI South_Carolina:SC South_Dakota:SD Tennessee:TN Texas:TX Utah:UT Vermont:VT Virginia:VA Washington:WA West_Virginia:WV Wisconsin:WI Wyoming:WY District_of_Columbia:DC'
    )
      .split(' ')
      .map((p) => p.split(':'))
      .map(([n, c]) => [n.replace(/_/g, ' ').toLowerCase(), c]),
  ),
  CA: Object.fromEntries(
    'Alberta:AB British_Columbia:BC Manitoba:MB New_Brunswick:NB Newfoundland_and_Labrador:NL Nova_Scotia:NS Ontario:ON Prince_Edward_Island:PE Quebec:QC Saskatchewan:SK Northwest_Territories:NT Nunavut:NU Yukon:YT'
      .split(' ')
      .map((p) => p.split(':'))
      .map(([n, c]) => [n.replace(/_/g, ' ').toLowerCase(), c]),
  ),
};

/** An mmdb City record → what /geo answers: the ISO country code and the first subdivision's code (or its code from its English name). */
export function geoFromCityRecord(rec: Pick<CityResponse, 'country' | 'subdivisions'> | null | undefined): ReturnType<GeoLookup> {
  const country = rec?.country?.iso_code;
  if (!country || !/^[A-Za-z]{2}$/.test(country)) return undefined;
  const sub = rec?.subdivisions?.[0];
  const name = sub?.names?.en?.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  const region = sub?.iso_code ?? (name ? SUBDIVISION_CODES[country.toUpperCase()]?.[name] : undefined);
  return { country: country.toUpperCase(), ...(region && /^[A-Za-z0-9]{1,3}$/.test(region) ? { region: region.toUpperCase() } : {}) };
}

/**
 * Open the GeoIP database at `file` (DB-IP City Lite, mmdb). A missing or
 * unreadable file gives no lookup and one log line; /geo then answers empty
 * (the client treats that as an unknown location, the strictest regime).
 */
export function openGeoDb(file: string | undefined, log: (message: string) => void = console.log): GeoLookup | undefined {
  if (!file) return undefined;
  try {
    const reader = new Reader<CityResponse>(fs.readFileSync(file));
    return (ip) => {
      try {
        return geoFromCityRecord(reader.get(ip));
      } catch {
        return undefined; // not an IP address
      }
    };
  } catch (err) {
    log(`[boot] GeoIP database not loaded from ${file} (${(err as Error).message}); GET /geo will answer empty`);
    return undefined;
  }
}
