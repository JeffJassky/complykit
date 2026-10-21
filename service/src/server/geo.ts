// Visitor location for the hosted script (plans/regime-overrides.md "Hosted location").
//
// GET /geo answers "CC" or "CC-RR" from a local GeoIP database, so a hosted
// install learns where the visitor is without any third-party call. The IP is
// read, looked up and dropped: never logged, stored or cached.

import fs from 'node:fs';
import { Reader, type CityResponse } from 'mmdb-lib';

export type GeoLookup = (ip: string) => { country: string; region?: string } | undefined;

/** An mmdb City record → what /geo answers: the ISO country code and the first subdivision's code. */
export function geoFromCityRecord(rec: Pick<CityResponse, 'country' | 'subdivisions'> | null | undefined): ReturnType<GeoLookup> {
  const country = rec?.country?.iso_code;
  if (!country || !/^[A-Za-z]{2}$/.test(country)) return undefined;
  const region = rec?.subdivisions?.[0]?.iso_code;
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
