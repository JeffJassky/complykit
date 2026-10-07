import { describe, expect, it } from 'vitest';
import {
  regimeFor,
  parseRegimeLocation,
  isOptOutSignalState,
  US_OPT_OUT_SIGNAL_STATES,
  EU_EEA_COUNTRIES,
} from '../src/registry/regime.js';
import { isEuEea, jurisdictionsFor } from '../src/registry/index.js';
import { optOutSignalStates } from '../src/rules/tracking/plan.js';
import { regimeFor as matrixRegimeFor } from '../src/report/consent-matrix.js';

const ON = '2026-10-06';

describe('regimeFor', () => {
  it('EU/EEA and UK are opt-in', () => {
    for (const cc of ['DE', 'FR', 'IE', 'NO', 'IS', 'LI', 'GB', 'UK']) {
      expect(regimeFor({ country: cc }, ON)).toBe('opt-in');
    }
    expect(regimeFor({ country: 'de', region: 'BY' }, ON)).toBe('opt-in');
  });

  it('US states with a signal duty in effect are opt-out-signal', () => {
    for (const st of ['CA', 'CO', 'CT', 'TX', 'OR', 'NJ', 'MD', 'DE']) {
      expect(regimeFor({ country: 'US', region: st }, ON)).toBe('opt-out-signal');
    }
    expect(regimeFor({ country: 'US', region: 'US-CA' }, ON)).toBe('opt-out-signal');
  });

  it('other US states are opt-out; signal duties start on their date', () => {
    for (const st of ['NY', 'FL', 'VA', 'UT', 'DC', 'PR']) expect(regimeFor({ country: 'US', region: st }, ON)).toBe('opt-out');
    expect(regimeFor({ country: 'US', region: 'OR' }, '2025-12-31')).toBe('opt-out');
    expect(regimeFor({ country: 'US', region: 'OR' }, '2026-01-01')).toBe('opt-out-signal');
  });

  it('US without a state, or with an unrecognized one, is the strictest US regime', () => {
    expect(regimeFor({ country: 'US' }, ON)).toBe('opt-out-signal');
    expect(regimeFor({ country: 'US', region: '' }, ON)).toBe('opt-out-signal');
    expect(regimeFor({ country: 'US', region: 'ZZ' }, ON)).toBe('opt-out-signal');
  });

  it('unknown, malformed or unresearched locations fail closed to opt-in', () => {
    expect(regimeFor(undefined, ON)).toBe('opt-in');
    expect(regimeFor({ country: '' }, ON)).toBe('opt-in');
    expect(regimeFor({ country: 'XYZ' }, ON)).toBe('opt-in');
    expect(regimeFor({ country: 'CA' }, ON)).toBe('opt-in'); // Canada: not researched
    expect(regimeFor({ country: 'BR' }, ON)).toBe('opt-in');
  });

  it('agrees with the report matrix wherever the matrix decides a regime', () => {
    // The matrix says 'unknown' outside EU/UK/US (client: opt-in), and 'opt-out' for a
    // US location with no verified state (client: opt-out-signal, failing closed).
    const places = [
      { country: 'DE' }, { country: 'GB' }, { country: 'US', region: 'CA' }, { country: 'US', region: 'CO' },
      { country: 'US', region: 'NY' }, { country: 'US', region: 'VA' }, { country: 'JP' },
    ];
    for (const p of places) {
      const m = matrixRegimeFor(jurisdictionsFor(p)).regime;
      expect(regimeFor(p, ON), JSON.stringify(p)).toBe(m === 'unknown' ? 'opt-in' : m);
    }
  });
});

describe('parseRegimeLocation', () => {
  it('reads the forms meta tags, CDN headers and Shopify report', () => {
    expect(parseRegimeLocation('DE')).toEqual({ country: 'DE' });
    expect(parseRegimeLocation(' us-ca ')).toEqual({ country: 'US', region: 'CA' });
    expect(parseRegimeLocation('US_CA')).toEqual({ country: 'US', region: 'CA' });
    expect(parseRegimeLocation('USCA')).toEqual({ country: 'US', region: 'CA' });
    expect(parseRegimeLocation('GB-ENG')).toEqual({ country: 'GB', region: 'ENG' });
  });

  it('rejects placeholders and junk', () => {
    for (const raw of ['', 'XX', 'T1', 'Germany', 'US-California', '1', undefined, null, 42, {}]) {
      expect(parseRegimeLocation(raw)).toBeUndefined();
    }
  });
});

describe('the shared tables', () => {
  it("the scanner's opt-out-signal states are exactly the shared table", () => {
    const fromTable = new Set(US_OPT_OUT_SIGNAL_STATES.map((s) => `us-${s.state.toLowerCase()}`));
    expect(optOutSignalStates()).toEqual(fromTable);
  });

  it('isOptOutSignalState respects dates and prefixes', () => {
    for (const s of US_OPT_OUT_SIGNAL_STATES) expect(isOptOutSignalState(s.state, s.from)).toBe(true);
    expect(isOptOutSignalState('VA', ON)).toBe(false);
    expect(isOptOutSignalState('us-ca', ON)).toBe(true);
    expect(isOptOutSignalState('OR', '2025-12-31')).toBe(false);
    expect(isOptOutSignalState('', ON)).toBe(false);
  });

  it('jurisdictions.ts reads the same EU/EEA list', () => {
    for (const cc of EU_EEA_COUNTRIES) expect(isEuEea(cc)).toBe(true);
    expect(isEuEea('GB')).toBe(false);
  });
});
