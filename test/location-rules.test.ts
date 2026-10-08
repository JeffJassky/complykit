import { describe, expect, it } from 'vitest';
import {
  describeLocationRules,
  regimeForCodes,
  jurisdictionsFor,
  requirementScopeFor,
  getRequirement,
  verifyRegistry,
  ALL_REQUIREMENTS,
  US_PRIVACY_ACT_STATES,
  US_OPT_OUT_SIGNAL_STATES,
  US_STATE_PRIVACY_ACTS,
  US_STATE_NAMES,
  usStateAct,
  isUsPrivacyActState,
  normalizeRegion,
} from '../src/registry/index.js';
import { containsBannedVocabulary } from '../src/report/vocabulary.js';
import { regimeFor as matrixRegimeFor } from '../src/report/consent-matrix.js';
import { regimeOf } from '../src/rules/tracking/compatibility.js';
import { optOutSignalStates } from '../src/rules/tracking/plan.js';

// Contract for plans/location-rules-plan.md: the one source of truth for "which
// rules apply at this location" (describeLocationRules), the shared regime, the
// new state opt-out-method requirement, and the dates. Green in the contract
// commit except the last describe (PR A).

const ON = '2026-10-08';
const d = (place: { country: string; region?: string }, verified = true) =>
  describeLocationRules(verified ? jurisdictionsFor(place) : [], ON, { verified });

describe('the state tables', () => {
  it('every signal state is an act state, and its signal date is not before its act date', () => {
    for (const s of US_OPT_OUT_SIGNAL_STATES) {
      const act = US_PRIVACY_ACT_STATES.find((a) => a.state === s.state)!;
      expect(act, s.state).toBeDefined();
      expect(act.gpcFrom).toBe(s.from);
      expect(act.from <= s.from, s.state).toBe(true);
    }
  });

  it('the twelve states on the CPPA 2026-08-06 list are signal states today; Louisiana and Vermont are not yet', () => {
    const today = US_OPT_OUT_SIGNAL_STATES.filter((s) => s.from <= ON).map((s) => s.state).sort();
    expect(today).toEqual(['CA', 'CO', 'CT', 'DE', 'MD', 'MN', 'MT', 'NE', 'NH', 'NJ', 'OR', 'TX']);
    expect(US_OPT_OUT_SIGNAL_STATES.some((s) => s.state === 'LA' || s.state === 'VT')).toBe(false);
  });

  it('every act state has an act record with a name, a chapter citation and an official URL', () => {
    for (const s of US_PRIVACY_ACT_STATES) {
      const act = US_STATE_PRIVACY_ACTS[s.state];
      expect(act, s.state).toBeDefined();
      expect(act.name.length).toBeGreaterThan(10);
      expect(act.citation.length).toBeGreaterThan(5);
      expect(act.urls.length).toBeGreaterThan(0);
      for (const u of act.urls) expect(u.href).toMatch(/^https:\/\//);
      expect(US_STATE_NAMES[s.state], s.state).toBeDefined();
    }
    expect(Object.keys(US_STATE_PRIVACY_ACTS).sort()).toEqual(US_PRIVACY_ACT_STATES.map((s) => s.state).sort());
  });

  it('usStateAct and isUsPrivacyActState respect dates, prefixes and case', () => {
    expect(usStateAct('tx')?.from).toBe('2024-07-01');
    expect(usStateAct('US-TX')?.gpcFrom).toBe('2025-01-01');
    expect(usStateAct('VA')?.gpcFrom).toBeUndefined();
    expect(usStateAct('NY')).toBeUndefined();
    expect(isUsPrivacyActState('VA', ON)).toBe(true);
    expect(isUsPrivacyActState('OK', ON)).toBe(false);
    expect(isUsPrivacyActState('OK', '2027-01-01')).toBe(true);
    expect(isUsPrivacyActState('FL', ON)).toBe(false);
  });

  it('state names agree with jurisdictions.ts normalizeRegion', () => {
    for (const [code, name] of Object.entries(US_STATE_NAMES)) {
      if (['PR', 'GU', 'VI', 'AS', 'MP'].includes(code)) continue;
      expect(normalizeRegion('US', name), name).toBe(code);
    }
  });
});

describe('requirement us-states.opt-out-method', () => {
  const req = getRequirement('us-states.opt-out-method')!;

  it('exists, is an obligation, volatile, and the registry still verifies', () => {
    expect(req).toBeDefined();
    expect(req.kind).toBe('obligation');
    expect(req.volatile).toBe(true);
    expect(String(req.instrument)).toBe('us-state-privacy');
    const v = verifyRegistry();
    expect(v.errors).toEqual([]);
  });

  it('is scoped to every act state except California, from each act date', () => {
    const codes = (req.jurisdictions ?? []).map((j) => [j.code, j.from]).sort();
    const expected = US_PRIVACY_ACT_STATES.filter((s) => s.state !== 'CA').map((s) => [`us-${s.state.toLowerCase()}`, s.from]).sort();
    expect(codes).toEqual(expected);
  });

  it('reaches Virginia and Texas today, Oklahoma only from 2027, California never', () => {
    expect(requirementScopeFor(req, ['us', 'us-va'], ON)).toBe('us-va');
    expect(requirementScopeFor(req, ['us', 'us-tx'], ON)).toBe('us-tx');
    expect(requirementScopeFor(req, ['us', 'us-ok'], ON)).toBeUndefined();
    expect(requirementScopeFor(req, ['us', 'us-ok'], '2027-01-01')).toBe('us-ok');
    expect(requirementScopeFor(req, ['us', 'us-ca'], ON)).toBeUndefined();
    expect(requirementScopeFor(req, ['us'], ON)).toBeUndefined();
  });
});

describe('regimeForCodes', () => {
  it('EU/UK opt-in; signal states; other act states opt-out; dates', () => {
    expect(regimeForCodes(['eu', 'eu-de'], ON)).toBe('opt-in');
    expect(regimeForCodes(['uk'], ON)).toBe('opt-in');
    expect(regimeForCodes(['us', 'us-ca'], ON)).toBe('opt-out-signal');
    expect(regimeForCodes(['us', 'us-tx'], ON)).toBe('opt-out-signal');
    expect(regimeForCodes(['us', 'us-va'], ON)).toBe('opt-out');
    expect(regimeForCodes(['us', 'us-ny'], ON)).toBe('opt-out');
    expect(regimeForCodes(['us', 'us-or'], '2025-12-31')).toBe('opt-out');
    expect(regimeForCodes(['us', 'us-or'], '2026-01-01')).toBe('opt-out-signal');
  });

  it("'us' without a state is baseline opt-out by default and strict opt-out-signal for the client's posture", () => {
    expect(regimeForCodes(['us'], ON)).toBe('opt-out');
    expect(regimeForCodes(['us'], ON, { unverifiedUs: 'strict' })).toBe('opt-out-signal');
  });

  it('anything else is unknown', () => {
    expect(regimeForCodes(['br'], ON)).toBe('unknown');
    expect(regimeForCodes(['ca'], ON)).toBe('unknown');
    expect(regimeForCodes([], ON)).toBe('unknown');
  });
});

describe('describeLocationRules', () => {
  it('Germany: opt-in, the three must-haves, ePrivacy + GDPR with URLs, no notes', () => {
    const r = d({ country: 'DE' });
    expect(r.regime).toBe('opt-in');
    expect(r.label).toBe('Opt-in (EU/EEA)');
    expect(r.verified).toBe(true);
    expect(r.mustHave).toHaveLength(3);
    expect(r.mustHave.join(' ')).toMatch(/as easy as accepting/);
    const ids = r.laws.map((l) => l.requirementId);
    expect(ids).toContain('eprivacy.art5.3');
    expect(ids).toContain('gdpr.art7.3');
    expect(ids).not.toContain('practice.tracker-inventory');
    expect(ids.some((i) => i.startsWith('ccpa') || i.startsWith('pecr'))).toBe(false);
    for (const l of r.laws) expect(l.urls.length, l.requirementId).toBeGreaterThan(0);
    expect(r.laws.find((l) => l.requirementId === 'eprivacy.art5.3')?.citation).toBe('ePrivacy Directive Art. 5(3)');
    expect(r.notes).toEqual([]);
    expect(r.stateAct).toBeUndefined();
  });

  it('UK: opt-in under PECR / UK GDPR, not the EU instruments', () => {
    const r = d({ country: 'GB' });
    expect(r.label).toBe('Opt-in (UK)');
    const ids = r.laws.map((l) => l.requirementId);
    expect(ids).toContain('pecr.reg6');
    expect(ids).toContain('uk-gdpr.art7.3');
    expect(ids).not.toContain('eprivacy.art5.3');
  });

  it('California: opt-out with the signal; CCPA duties + CIPA exposure, obligations first; the state act', () => {
    const r = d({ country: 'US', region: 'CA' });
    expect(r.regime).toBe('opt-out-signal');
    expect(r.label).toBe('Opt-out, privacy signal honored (California)');
    expect(r.mustHave.join(' ')).toMatch(/Do Not Sell or Share/);
    expect(r.mustHave.join(' ')).toMatch(/Global Privacy Control/);
    const ids = r.laws.map((l) => l.requirementId);
    expect(ids).toEqual(expect.arrayContaining(['ccpa.regs.7025', 'ccpa.regs.7025c6', 'ccpa.opt-out-link', 'cipa.631']));
    expect(ids).not.toContain('us-states.opt-out-signal');
    expect(ids).not.toContain('us-states.opt-out-method');
    const kinds = r.laws.map((l) => l.kind);
    expect(kinds.lastIndexOf('obligation')).toBeLessThan(kinds.indexOf('exposure'));
    expect(r.laws.find((l) => l.requirementId === 'ccpa.regs.7025c6')?.since).toBe('2026-01-01');
    expect(r.stateAct?.name).toMatch(/California Consumer Privacy Act/);
    expect(r.stateAct?.inForce).toBe(true);
    expect(r.stateAct?.gpcFrom).toBe('2023-03-29');
  });

  it('Texas: opt-out with the signal under the state act; both state requirements; no CCPA wording', () => {
    const r = d({ country: 'US', region: 'TX' });
    expect(r.regime).toBe('opt-out-signal');
    expect(r.label).toBe('Opt-out, privacy signal honored (Texas)');
    expect(r.mustHave.join(' ')).not.toMatch(/Do Not Sell or Share/);
    expect(r.mustHave.join(' ')).toMatch(/Texas law/);
    const ids = r.laws.map((l) => l.requirementId);
    expect(ids).toEqual(expect.arrayContaining(['us-states.opt-out-signal', 'us-states.opt-out-method']));
    expect(ids.some((i) => i.startsWith('ccpa'))).toBe(false);
    expect(r.laws.find((l) => l.requirementId === 'us-states.opt-out-signal')?.since).toBe('2025-01-01');
    expect(r.laws.find((l) => l.requirementId === 'us-states.opt-out-method')?.since).toBe('2024-07-01');
    expect(r.stateAct?.name).toBe('Texas Data Privacy and Security Act');
    expect(r.summary).toMatch(/since 2025-01-01/);
  });

  it('Virginia: opt-out, act in force, no signal duty; the opt-out-method requirement only', () => {
    const r = d({ country: 'US', region: 'VA' });
    expect(r.regime).toBe('opt-out');
    expect(r.label).toBe('Opt-out (Virginia)');
    expect(r.mustHave.join(' ')).toMatch(/No duty to honor the browser’s opt-out signal/);
    expect(r.laws.map((l) => l.requirementId)).toEqual(['us-states.opt-out-method']);
    expect(r.stateAct?.inForce).toBe(true);
    expect(r.summary).toMatch(/Virginia Consumer Data Protection Act, in force since 2023-01-01/);
  });

  it('Florida: opt-out, no act; wiretap exposure only; the no-act bullets', () => {
    const r = d({ country: 'US', region: 'FL' });
    expect(r.regime).toBe('opt-out');
    expect(r.label).toBe('Opt-out (Florida, no state privacy law in force)');
    expect(r.laws.map((l) => l.requirementId)).toEqual(['fsca.934.03']);
    expect(r.laws[0].kind).toBe('exposure');
    expect(r.mustHave[0]).toMatch(/No comprehensive state privacy law/);
    expect(r.stateAct).toBeUndefined();
  });

  it('Oklahoma before its act: opt-out, nothing compared, a note with the start date', () => {
    const r = d({ country: 'US', region: 'OK' });
    expect(r.laws).toEqual([]);
    expect(r.notes.join(' ')).toMatch(/applies from 2027-01-01/);
    expect(r.stateAct?.inForce).toBe(false);
    const later = describeLocationRules(['us', 'us-ok'], '2027-01-01');
    expect(later.label).toBe('Opt-out (Oklahoma)');
    expect(later.laws.map((l) => l.requirementId)).toEqual(['us-states.opt-out-method']);
  });

  it('US with no verified state: baseline opt-out, nothing state-specific, the divergence note', () => {
    const r = d({ country: 'US' });
    expect(r.regime).toBe('opt-out');
    expect(r.label).toBe('Opt-out (US, state not verified)');
    expect(r.laws).toEqual([]);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatch(/consent tool treats a US visitor with no verified state as opt-out with the privacy signal honored/);
  });

  it('Brazil: unknown, nothing compared, the fail-closed note; country named', () => {
    const r = d({ country: 'BR' });
    expect(r.regime).toBe('unknown');
    expect(r.label).toBe('No rules encoded (Brazil)');
    expect(r.laws).toEqual([]);
    expect(r.notes[0]).toMatch(/consent tool fails closed to opt-in/);
  });

  it('an unverified location compares nothing, whatever codes are passed', () => {
    const r = describeLocationRules(['eu', 'eu-de'], ON, { verified: false });
    expect(r.verified).toBe(false);
    expect(r.regime).toBe('unknown');
    expect(r.label).toMatch(/Not verified/);
    expect(r.laws).toEqual([]);
    expect(d({ country: 'DE' }, false).laws).toEqual([]);
  });

  it('laws are exactly the requirements the rules apply (requirementScopeFor), for every place', () => {
    const places = [{ country: 'DE' }, { country: 'GB' }, { country: 'US', region: 'CA' }, { country: 'US', region: 'TX' }, { country: 'US', region: 'VA' }, { country: 'US', region: 'FL' }, { country: 'US', region: 'PA' }, { country: 'US' }, { country: 'JP' }];
    for (const p of places) {
      const codes = jurisdictionsFor(p);
      const expected = ALL_REQUIREMENTS.filter((q) => {
        const s = requirementScopeFor(q, codes, ON);
        return s && s !== 'any';
      }).map((q) => String(q.id)).sort();
      expect(describeLocationRules(codes, ON).laws.map((l) => l.requirementId).sort(), JSON.stringify(p)).toEqual(expected);
    }
  });

  it('never emits verdict vocabulary', () => {
    for (const p of [{ country: 'DE' }, { country: 'GB' }, { country: 'US', region: 'CA' }, { country: 'US', region: 'TX' }, { country: 'US', region: 'VA' }, { country: 'US', region: 'FL' }, { country: 'US' }, { country: 'BR' }]) {
      const r = d(p);
      const text = [r.label, r.summary, ...r.mustHave, ...r.notes, ...r.laws.map((l) => l.title)].join(' ');
      expect(containsBannedVocabulary(text), JSON.stringify(p)).toBe(false);
    }
  });
});

// PR A: the matrix, the compatibility expectations and the scenario planner read
// the shared regime, with dates.
describe('matrix, compatibility and planner agree with the shared regime (PR A)', () => {
  const places = [{ country: 'DE' }, { country: 'GB' }, { country: 'US', region: 'CA' }, { country: 'US', region: 'TX' }, { country: 'US', region: 'VA' }, { country: 'US', region: 'NY' }, { country: 'US' }, { country: 'JP' }];

  it('the matrix regime and label come from regimeForCodes / describeLocationRules', () => {
    for (const p of places) {
      const codes = jurisdictionsFor(p);
      const m = matrixRegimeFor(codes, ON);
      expect(m.regime, JSON.stringify(p)).toBe(regimeForCodes(codes, ON));
      expect(m.label, JSON.stringify(p)).toBe(describeLocationRules(codes, ON).label);
    }
  });

  it('the matrix respects the signal date', () => {
    expect(matrixRegimeFor(['us', 'us-or'], '2025-12-31').regime).toBe('opt-out');
    expect(matrixRegimeFor(['us', 'us-or'], '2026-01-01').regime).toBe('opt-out-signal');
  });

  it('compatibility regimeOf takes the date and agrees', () => {
    for (const p of places) {
      const codes = jurisdictionsFor(p);
      expect(regimeOf(codes, ON), JSON.stringify(p)).toBe(regimeForCodes(codes, ON));
    }
    expect(regimeOf(['us', 'us-or'], '2025-12-31')).toBe('opt-out');
  });

  it('optOutSignalStates(onDate) lists only duties in effect on that date', () => {
    expect([...optOutSignalStates(ON)].sort()).toEqual(US_OPT_OUT_SIGNAL_STATES.filter((s) => s.from <= ON).map((s) => `us-${s.state.toLowerCase()}`).sort());
    expect(optOutSignalStates('2025-12-31').has('us-or')).toBe(false);
    expect(optOutSignalStates('2024-01-01').has('us-ca')).toBe(true);
    expect(optOutSignalStates('2024-01-01').has('us-co')).toBe(false);
  });
});
