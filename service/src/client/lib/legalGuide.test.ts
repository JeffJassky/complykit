import { describe, expect, it } from 'vitest';
import { EMPTY_FILTER, filterPlaces, isFiltered, visibleLaws, guidePlaceHref } from './legalGuide';
import { FIXTURE_GUIDE as G } from './legalGuide.fixture';
import { parseHash } from './useHashView';

// plans/legal-guide-contract.md, PR 2: the guide page's filters. Places and laws
// filter each other: choosing laws narrows the places to those the laws reach;
// choosing a place narrows the laws to that place's.

const codes = (f: Partial<typeof EMPTY_FILTER>) => filterPlaces(G, { ...EMPTY_FILTER, ...f }).map((p) => p.code);
const lawIds = (f: Partial<typeof EMPTY_FILTER>) => visibleLaws(G, { ...EMPTY_FILTER, ...f }).map((l) => l.id);

describe('filterPlaces', () => {
  it('no filter: every place, in guide order', () => {
    expect(codes({})).toEqual(['eu', 'us-ca', 'us-ga', 'us-il', 'other']);
    expect(isFiltered(EMPTY_FILTER)).toBe(false);
  });

  it('laws: places any chosen law reaches', () => {
    expect(codes({ laws: ['ilea'] })).toEqual(['us-il']);
    expect(codes({ laws: ['ilea', 'eprivacy'] })).toEqual(['eu', 'us-il']);
  });

  it('models: places under any chosen model', () => {
    expect(codes({ models: ['opt-out-no-act'] })).toEqual(['us-ga', 'us-il']);
    expect(codes({ models: ['opt-in', 'unresearched'] })).toEqual(['eu', 'other']);
  });

  it('wiretap: only places in the wiretap posture', () => {
    expect(codes({ wiretap: true })).toEqual(['us-ca', 'us-il']);
  });

  it('search: by name, code, state code, member country or label; case-insensitive', () => {
    expect(codes({ query: 'illi' })).toEqual(['us-il']);
    expect(codes({ query: 'US-CA' })).toEqual(['us-ca']);
    expect(codes({ query: 'ga' })).toContain('us-ga'); // the bare state code
    expect(codes({ query: 'norway' })).toEqual(['eu']); // a member of a grouped place
    expect(codes({ query: '  ' })).toHaveLength(5);
  });

  it('groups combine with AND: law + model + wiretap + search', () => {
    expect(codes({ models: ['opt-out-no-act'], wiretap: true })).toEqual(['us-il']);
    expect(codes({ laws: ['enforcement-practice'], query: 'cal' })).toEqual(['us-ca']);
    expect(codes({ laws: ['eprivacy'], wiretap: true })).toEqual([]);
  });

  it('a chosen place is not itself a filter on the list', () => {
    expect(codes({ place: 'us-ca' })).toHaveLength(5);
    expect(isFiltered({ ...EMPTY_FILTER, place: 'us-ca' })).toBe(false);
    expect(isFiltered({ ...EMPTY_FILTER, wiretap: true })).toBe(true);
  });
});

describe('visibleLaws', () => {
  it('no filter: every law once, in guide order', () => {
    expect(lawIds({})).toEqual(['eprivacy', 'ccpa', 'cipa', 'ilea', 'enforcement-practice']);
  });

  it('a chosen place: exactly its laws, in its order', () => {
    expect(lawIds({ place: 'us-ca' })).toEqual(['ccpa', 'cipa', 'enforcement-practice']);
  });

  it('chosen laws: those laws', () => {
    expect(lawIds({ laws: ['cipa', 'eprivacy'] })).toEqual(['eprivacy', 'cipa']);
  });

  it('other filters: the laws that reach any place still listed', () => {
    expect(lawIds({ models: ['opt-in'] })).toEqual(['eprivacy', 'enforcement-practice']);
    expect(lawIds({ wiretap: true })).toEqual(['ccpa', 'cipa', 'ilea', 'enforcement-practice']);
  });

  it('an unknown place falls back to the filters', () => {
    expect(lawIds({ place: 'us-zz' })).toHaveLength(5);
  });
});

describe('routes', () => {
  it('#laws is the guide; #laws/<code> opens a place', () => {
    expect(parseHash('#laws')).toEqual({ view: 'laws' });
    expect(parseHash('#laws/us-ca')).toEqual({ view: 'laws', place: 'us-ca' });
    expect(parseHash('#laws/<script>')).toEqual({ view: 'laws', place: 'script' });
    expect(guidePlaceHref('us-ca')).toBe('#laws/us-ca');
  });
});
