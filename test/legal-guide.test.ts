import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ScenarioId } from '../src/record/index.js';
import {
  ALL_REQUIREMENTS,
  EU_EEA_COUNTRIES,
  GUIDE_LAWS,
  GUIDE_MODELS,
  GUIDE_PLACE_NOTES,
  GUIDE_POSTURE,
  US_STATE_NAMES,
  WIRETAP_STATES,
  citationLabel,
  describeLocationRules,
} from '../src/registry/index.js';
import { buildLegalGuide, defaultScenarios, GUIDE_SCENARIOS } from '../src/rules/tracking/index.js';
import type { LegalGuide as ServiceLegalGuide } from '../service/src/shared/legal-guide.js';

// plans/legal-guide-contract.md, PR 1: the guide is built from the registry
// alone — the same rules the scanner applies — deduplicated: each model and
// each law explained once, every place pointing at them by id.

const AS_OF = '2026-10-08';
const g = buildLegalGuide(AS_OF);
const place = (code: string) => {
  const p = g.places.find((x) => x.code === code);
  if (!p) throw new Error(`no place ${code}`);
  return p;
};
const codesOf = (code: string): string[] => (code === 'eu' ? ['eu'] : code === 'uk' ? ['uk'] : code === 'other' ? ['zz'] : ['us', code]);
const US_50_DC = Object.keys(US_STATE_NAMES).filter((s) => !['PR', 'GU', 'VI', 'AS', 'MP'].includes(s));
const LAW_ORDER = ['eprivacy', 'gdpr', 'pecr', 'uk-gdpr', 'ccpa', 'us-state-privacy', 'cipa', 'fsca', 'wesca', 'mdwa', 'ilea', 'enforcement-practice'];

describe('legal guide: shape', () => {
  it('is version 1, dated, and matches the service’s mirror type (compile-time)', () => {
    const typed: ServiceLegalGuide = g;
    expect(typed.version).toBe(1);
    expect(g.asOf).toBe(AS_OF);
    expect(g.posture).toEqual({ title: GUIDE_POSTURE.title, principles: [...GUIDE_POSTURE.principles] });
  });

  it('explains every scan visit once, in the scanner’s order', () => {
    expect(g.scenarios.map((s) => s.id)).toEqual([...ScenarioId.options]);
    expect(GUIDE_SCENARIOS.map((s) => s.id).sort()).toEqual([...ScenarioId.options].sort());
    for (const s of g.scenarios) expect(s.what && s.why && s.label).toBeTruthy();
  });

  it('explains each model once, in order', () => {
    expect(g.models.map((m) => m.id)).toEqual(['opt-in', 'opt-out-signal', 'opt-out', 'opt-out-no-act', 'unresearched']);
    expect(g.models).toEqual(GUIDE_MODELS.map((m) => ({ id: m.id, label: m.label, summary: m.summary, mustHave: [...m.mustHave] })));
  });
});

describe('legal guide: places', () => {
  it('EU & EEA as one place with its member countries, the UK, the 50 states and DC by name, then everywhere else', () => {
    expect(g.places[0]).toMatchObject({ code: 'eu', name: 'European Union & EEA', group: 'europe' });
    expect(g.places[0].members).toHaveLength(EU_EEA_COUNTRIES.length);
    expect(g.places[0].members).toEqual(expect.arrayContaining(['Germany', 'Norway', 'Ireland']));
    expect(g.places[1]).toMatchObject({ code: 'uk', name: 'United Kingdom', group: 'europe' });
    const us = g.places.filter((p) => p.group === 'us');
    expect(us).toHaveLength(US_50_DC.length);
    expect(us.map((p) => p.name)).toEqual([...us.map((p) => p.name)].sort((a, b) => a.localeCompare(b)));
    expect(us.map((p) => p.code).sort()).toEqual(US_50_DC.map((s) => `us-${s.toLowerCase()}`).sort());
    expect(g.places.at(-1)).toMatchObject({ code: 'other', name: 'Everywhere else', group: 'other', model: 'unresearched' });
    expect(new Set(g.places.map((p) => p.code)).size).toBe(g.places.length);
  });

  it('each place’s model and label are the scanner’s own (describeLocationRules on the same date)', () => {
    expect(place('eu').model).toBe('opt-in');
    expect(place('uk').model).toBe('opt-in');
    expect(place('us-ca').model).toBe('opt-out-signal');
    expect(place('us-tx').model).toBe('opt-out-signal');
    expect(place('us-va').model).toBe('opt-out');
    expect(place('us-ga').model).toBe('opt-out-no-act');
    expect(place('us-il').model).toBe('opt-out-no-act');
    expect(place('us-ok').model).toBe('opt-out-no-act'); // act enacted for 2027
    for (const p of g.places.filter((x) => x.code !== 'other')) expect(p.label, p.code).toBe(describeLocationRules(codesOf(p.code), AS_OF).label);
    expect(place('other').label).toBe('Not researched');
  });

  it('wiretap posture: exactly the registry’s wiretap states, explained once at the top', () => {
    const states = [...WIRETAP_STATES].sort();
    expect(g.wiretap.states).toEqual(states);
    expect(g.places.filter((p) => p.wiretap).map((p) => p.code).sort()).toEqual(states);
    expect(states).toEqual(['us-ca', 'us-fl', 'us-il', 'us-md', 'us-pa']);
    expect(g.wiretap.summary).toBeTruthy();
    expect(g.wiretap.holds).toBeTruthy();
  });

  it('each place lists the laws that reach it in guide order (obligations, exposure, practice); practice reaches everywhere', () => {
    expect(place('eu').lawIds).toEqual(['eprivacy', 'gdpr', 'enforcement-practice']);
    expect(place('uk').lawIds).toEqual(['pecr', 'uk-gdpr', 'enforcement-practice']);
    expect(place('us-ca').lawIds).toEqual(['ccpa', 'cipa', 'enforcement-practice']);
    expect(place('us-tx').lawIds).toEqual(['us-state-privacy', 'enforcement-practice']);
    expect(place('us-md').lawIds).toEqual(['us-state-privacy', 'mdwa', 'enforcement-practice']);
    expect(place('us-il').lawIds).toEqual(['ilea', 'enforcement-practice']);
    expect(place('us-ga').lawIds).toEqual(['enforcement-practice']);
    expect(place('us-ok').lawIds).toEqual(['enforcement-practice']); // not in force yet
    expect(place('other').lawIds).toEqual(['enforcement-practice']);
  });

  it('a US state with an act carries it, in force or not; an enacted act not yet in force adds a pending note', () => {
    expect(place('us-tx').stateAct).toMatchObject({ name: 'Texas Data Privacy and Security Act', from: '2024-07-01', gpcFrom: '2025-01-01', inForce: true, sensitive: 'opt-in' });
    expect(place('us-ok').stateAct).toMatchObject({ from: '2027-01-01', inForce: false });
    const pending = place('us-ok').notes.filter((n) => n.kind === 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].text).toContain('2027-01-01');
    expect(place('us-ga').stateAct).toBeUndefined();
    expect(place('eu').stateAct).toBeUndefined();
  });

  it('each place’s scan visits are the scanner’s default plan for it', () => {
    for (const p of g.places) expect(p.scenarios, p.code).toEqual(defaultScenarios(codesOf(p.code), AS_OF));
  });

  it('place notes come from the registry’s place notes (plus generated pending notes); law notes stay on the law', () => {
    for (const code of Object.keys(GUIDE_PLACE_NOTES)) expect(g.places.some((p) => p.code === code), `note key ${code} is a place`).toBe(true);
    expect(place('us-wa').notes.map((n) => n.title)).toEqual(GUIDE_PLACE_NOTES['us-wa'].map((n) => n.title));
    expect(place('us-wa').wiretap).toBe(false);
    // CIPA's notes appear once, on CIPA — not copied onto California.
    expect(place('us-ca').notes.some((n) => n.title === 'Only prior consent counts')).toBe(false);
  });
});

describe('legal guide: laws', () => {
  it('one entry per instrument with a location-scoped requirement, in guide order, with the registry’s words', () => {
    expect(g.laws.map((l) => l.id)).toEqual(LAW_ORDER);
    expect(Object.keys(GUIDE_LAWS).sort()).toEqual([...LAW_ORDER].sort());
    for (const l of g.laws) {
      const w = GUIDE_LAWS[l.id];
      expect(l).toMatchObject({ shortName: w.shortName, summary: w.summary, scope: w.scope });
      expect(l.risk).toBe(w.risk);
      expect(l.notes).toEqual(w.notes);
      expect(l.name).toBeTruthy();
    }
    expect(g.laws.find((l) => l.id === 'cipa')).toMatchObject({ kind: 'exposure', risk: 'high' });
    expect(g.laws.find((l) => l.id === 'enforcement-practice')?.kind).toBe('practice');
    expect(g.laws.find((l) => l.id === 'ccpa')?.kind).toBe('obligation');
  });

  it('carries every location-scoped requirement exactly once, under its instrument, with its citation label', () => {
    const scoped = ALL_REQUIREMENTS.filter((r) => r.jurisdictions?.length);
    const listed = g.laws.flatMap((l) => l.requirements.map((r) => ({ law: l.id, ...r })));
    expect(listed.map((r) => r.id).sort()).toEqual(scoped.map((r) => String(r.id)).sort());
    for (const r of scoped) {
      const got = listed.find((x) => x.id === String(r.id))!;
      expect(got.law).toBe(String(r.instrument));
      expect(got).toMatchObject({ title: r.title, text: r.text, citation: citationLabel(r), kind: r.kind ?? 'obligation', since: r.effective.from, volatile: r.volatile === true });
      expect(got.urls).toEqual(r.urls.map((u) => u.href));
    }
  });

  it('placeCodes are the places each law reaches on the date — the inverse of the places’ lawIds', () => {
    for (const l of g.laws) {
      const reach = g.places.filter((p) => p.lawIds.includes(l.id)).map((p) => p.code);
      expect(l.placeCodes, l.id).toEqual(reach);
    }
    expect(g.laws.find((l) => l.id === 'ccpa')?.placeCodes).toEqual(['us-ca']);
    expect(g.laws.find((l) => l.id === 'enforcement-practice')?.placeCodes).toHaveLength(g.places.length);
    expect(g.laws.find((l) => l.id === 'us-state-privacy')?.placeCodes).not.toContain('us-ok');
  });
});

describe('legal guide: the service’s copy', () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'service', 'src', 'shared', 'legal-guide.json');
  const today = new Date().toISOString().slice(0, 10);

  it('service/src/shared/legal-guide.json is the guide as of today (UPDATE_GUIDE=1 rewrites it)', () => {
    const fresh = buildLegalGuide(today);
    if (process.env.UPDATE_GUIDE) fs.writeFileSync(file, JSON.stringify(fresh, null, 2) + '\n');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as ServiceLegalGuide;
    // Its own date may be older; nothing else may differ — a law coming into force since then fails here.
    expect({ ...fresh, asOf: saved.asOf }).toEqual(saved);
  });
});
