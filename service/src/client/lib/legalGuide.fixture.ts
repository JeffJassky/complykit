import type { GuideLaw, GuidePlace, LegalGuide } from '../../shared/legal-guide';

// A small guide for the client tests (plans/legal-guide-contract.md, PR 2):
// five places, five laws — enough to exercise every filter without the real file.

const law = (id: string, shortName: string, kind: GuideLaw['kind'], placeCodes: string[], extra: Partial<GuideLaw> = {}): GuideLaw => ({
  id,
  name: `${shortName} (full name)`,
  shortName,
  summary: `${shortName} summary text.`,
  kind,
  scope: placeCodes.join(', '),
  requirements: [{ id: `${id}.req`, title: `${shortName} duty`, citation: `${shortName} §1`, text: `${shortName} text.`, kind, since: '2020-01-01', urls: [], authority: [], volatile: false }],
  placeCodes,
  notes: [],
  ...extra,
});

const place = (p: Partial<GuidePlace> & Pick<GuidePlace, 'code' | 'name' | 'group' | 'model' | 'label' | 'lawIds'>): GuidePlace => ({ wiretap: false, scenarios: ['do-nothing'], notes: [], ...p });

export const FIXTURE_GUIDE: LegalGuide = {
  version: 1,
  asOf: '2026-10-08',
  posture: { title: 'How complykit decides what to expect', principles: ['Principle one.', 'Principle two.'] },
  models: [
    { id: 'opt-in', label: 'Opt-in', summary: 'Opt-in summary.', mustHave: ['Opt-in must.'] },
    { id: 'opt-out-signal', label: 'Opt-out, privacy signal honored', summary: 'Signal summary.', mustHave: ['Signal must.'] },
    { id: 'opt-out', label: 'Opt-out', summary: 'Opt-out summary.', mustHave: ['Opt-out must.'] },
    { id: 'opt-out-no-act', label: 'No state privacy law', summary: 'No-act summary.', mustHave: ['No-act must.'] },
    { id: 'unresearched', label: 'Not researched', summary: 'Unresearched summary.', mustHave: ['Unresearched must.'] },
  ],
  wiretap: { summary: 'Wiretap summary.', holds: 'Wiretap holds text.', states: ['us-ca', 'us-il'] },
  scenarios: [
    { id: 'do-nothing', label: 'Before a choice', what: 'Loads and waits.', why: 'Why waiting.' },
    { id: 'gpc', label: 'Privacy signal (GPC)', what: 'Sends GPC.', why: 'Why GPC.' },
  ],
  laws: [
    law('eprivacy', 'ePrivacy Directive', 'obligation', ['eu']),
    law('ccpa', 'CCPA / CPRA', 'obligation', ['us-ca']),
    law('cipa', 'CIPA', 'exposure', ['us-ca'], { risk: 'high', notes: [{ kind: 'litigation', title: 'Only prior consent counts', text: 'Prior consent text.', sources: [] }] }),
    law('ilea', 'Illinois Eavesdropping Act', 'exposure', ['us-il'], { risk: 'moderate' }),
    law('enforcement-practice', 'Regulator practice', 'practice', ['eu', 'us-ca', 'us-il', 'us-ga', 'other']),
  ],
  places: [
    place({ code: 'eu', name: 'European Union & EEA', group: 'europe', members: ['Germany', 'France', 'Norway'], model: 'opt-in', label: 'Opt-in (EU/EEA)', lawIds: ['eprivacy', 'enforcement-practice'] }),
    place({
      code: 'us-ca',
      name: 'California',
      group: 'us',
      model: 'opt-out-signal',
      label: 'Opt-out, privacy signal honored (California)',
      wiretap: true,
      lawIds: ['ccpa', 'cipa', 'enforcement-practice'],
      stateAct: { name: 'California Consumer Privacy Act', citation: 'Cal. Civ. Code §1798.100', urls: [], from: '2020-01-01', gpcFrom: '2023-03-29', inForce: true, sensitive: 'notice-and-opt-out' },
      scenarios: ['do-nothing', 'gpc'],
    }),
    place({ code: 'us-ga', name: 'Georgia', group: 'us', model: 'opt-out-no-act', label: 'Opt-out (Georgia, no state privacy law in force)', lawIds: ['enforcement-practice'] }),
    place({
      code: 'us-il',
      name: 'Illinois',
      group: 'us',
      model: 'opt-out-no-act',
      label: 'Opt-out (Illinois, no state privacy law in force)',
      wiretap: true,
      lawIds: ['ilea', 'enforcement-practice'],
      notes: [{ kind: 'exception', title: 'Face scanning is a separate, stricter law', text: 'BIPA text.', sources: [] }],
    }),
    place({ code: 'other', name: 'Everywhere else', group: 'other', model: 'unresearched', label: 'Not researched', lawIds: ['enforcement-practice'] }),
  ],
};
