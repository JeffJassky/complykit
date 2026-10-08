import { describe, expect, it } from 'vitest';
import { DEFAULT_LAWS, LAWS, isLawId } from '../src/shared/laws.js';

describe('law catalog', () => {
  it('has five laws with unique ids, location ids and regions', () => {
    expect(LAWS).toHaveLength(5);
    expect(new Set(LAWS.map((l) => l.id)).size).toBe(5);
    expect(new Set(LAWS.map((l) => l.locationId)).size).toBe(5);
    expect(new Set(LAWS.map((l) => l.flyRegion)).size).toBe(5);
  });

  it('runs exactly one law locally: California on lax', () => {
    const local = LAWS.filter((l) => l.local);
    expect(local.map((l) => [l.id, l.flyRegion])).toEqual([['ca', 'lax']]);
  });

  it('defaults to all five ids', () => {
    expect([...DEFAULT_LAWS]).toEqual(LAWS.map((l) => l.id));
    expect(DEFAULT_LAWS).toHaveLength(5);
  });

  it('isLawId accepts each id and rejects everything else', () => {
    for (const l of LAWS) expect(isLawId(l.id)).toBe(true);
    for (const v of ['va', '', 1, undefined, null, {}]) expect(isLawId(v)).toBe(false);
  });
});
