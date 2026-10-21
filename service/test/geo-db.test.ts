import { describe, expect, it } from 'vitest';
import { geoFromCityRecord, openGeoDb } from '../src/server/geo.js';

// The mmdb reader is mmdb-lib; a real database is ~130 MB, so the opener is tested only on its
// failure path and the City-record mapping on hand-built records.
describe('geoFromCityRecord', () => {
  it('country ISO code plus the first subdivision code', () => {
    expect(geoFromCityRecord({ country: { iso_code: 'US' }, subdivisions: [{ iso_code: 'CA' }, { iso_code: 'LA' }] } as never)).toEqual({ country: 'US', region: 'CA' });
  });
  it('a country with no subdivision has no region', () => {
    expect(geoFromCityRecord({ country: { iso_code: 'DE' } } as never)).toEqual({ country: 'DE' });
    expect(geoFromCityRecord({ country: { iso_code: 'DE' }, subdivisions: [] } as never)).toEqual({ country: 'DE' });
  });
  it('no record, or no usable country, is unknown', () => {
    expect(geoFromCityRecord(null)).toBeUndefined();
    expect(geoFromCityRecord({} as never)).toBeUndefined();
    expect(geoFromCityRecord({ country: { iso_code: 'USA' } } as never)).toBeUndefined();
  });
});

describe('openGeoDb', () => {
  it('a missing file gives no lookup and exactly one log line', () => {
    const lines: string[] = [];
    expect(openGeoDb('/nonexistent/dbip.mmdb', (m) => lines.push(m))).toBeUndefined();
    expect(lines).toHaveLength(1);
  });
  it('no path configured: no lookup, no noise', () => {
    const lines: string[] = [];
    expect(openGeoDb(undefined, (m) => lines.push(m))).toBeUndefined();
    expect(lines).toEqual([]);
  });
});
