import { ScenarioId } from '../../record/index.js';
import {
  ALL_REQUIREMENTS,
  EU_EEA_COUNTRIES,
  GUIDE_LAWS,
  GUIDE_MODELS,
  GUIDE_PLACE_NOTES,
  GUIDE_POSTURE,
  GUIDE_WIRETAP,
  INSTRUMENTS,
  US_STATE_NAMES,
  WIRETAP_STATES,
  citationLabel,
  describeLocationRules,
  isWiretapJurisdiction,
  regimeForCodes,
  requirementScopeFor,
  usStateAct,
} from '../../registry/index.js';
import type { Requirement } from '../../registry/index.js';
import { defaultScenarios } from './plan.js';


// The legal guide (plans/legal-guide-contract.md): complykit's testing policy
// and every place's rules as one deduplicated document, built from the
// registry alone, so the guide page and the scanner cannot disagree. Pure.
// service/src/shared/legal-guide.json is this function's output for a date;
// test/legal-guide.test.ts keeps the two in step.

/** What each scan visit does and why it exists — the guide's "how we test". Every ScenarioId has one. */
export const GUIDE_SCENARIOS: ReadonlyArray<{ id: ScenarioId; label: string; what: string; why: string }> = [
  {
    id: 'do-nothing',
    label: 'Before a choice',
    what: 'Loads the home page in a fresh browser and waits, never touching the banner.',
    why: 'What runs before the visitor has decided anything — the core question in opt-in places and in wiretap suits.',
  },
  {
    id: 'browse',
    label: 'Browse without choosing',
    what: 'Visits several pages and searches the site, ignoring the banner.',
    why: 'Some tools wait for a second page, a scroll or a search before they fire; a single landing misses them.',
  },
  {
    id: 'dismiss',
    label: 'Banner closed without choosing',
    what: 'Closes the banner with its X or by clicking away, then browses.',
    why: 'Closing a banner is not consent. Tools that treat it as a yes are a common finding in the EU and UK.',
  },
  {
    id: 'reject',
    label: 'After rejection',
    what: 'Rejects everything on the banner, reloads, and browses.',
    why: 'A rejection must stop the tools. A rejection that leaks is a violation in opt-in places and evidence in wiretap suits everywhere.',
  },
  {
    id: 'accept',
    label: 'After acceptance',
    what: 'Accepts everything on the banner and browses.',
    why: 'Shows which tools the banner was holding back, so they are known and listed even where they correctly waited.',
  },
  {
    id: 'partial',
    label: 'After accepting analytics only',
    what: 'Turns on analytics alone in the banner’s settings and browses.',
    why: 'Consent must be specific: accepting analytics must not switch on advertising.',
  },
  {
    id: 'withdraw',
    label: 'After withdrawal',
    what: 'Accepts, browses, reopens the site’s privacy settings and rejects everything, then reloads and browses.',
    why: 'Withdrawing must be as easy as consenting, and must actually stop the tools and remove what they stored.',
  },
  {
    id: 'return-visit',
    label: 'Returning after rejection',
    what: 'Rejects, then comes back later in the same browser.',
    why: 'A refusal must be remembered: tools must not run on the next visit, and the visitor should not be pestered again at once.',
  },
  {
    id: 'gpc',
    label: 'Privacy signal (GPC)',
    what: 'Visits with the browser sending Global Privacy Control from the first request, never touching the banner.',
    why: 'Several US states require honoring the signal as an opt-out with no click. California fined companies that ignored it.',
  },
  {
    id: 'opt-out-all',
    label: 'After opting out every way',
    what: 'Sends GPC, rejects on the banner and uses the site’s opt-out link, then counts what still runs.',
    why: 'The way California investigators test: opt out every way at once, then look for anything still sending data.',
  },
  {
    id: 'opt-out-link',
    label: 'After the opt-out link',
    what: 'Finds the “Do Not Sell or Share” link, uses it as a visitor would, and browses. Never submits personal information.',
    why: 'The link must exist where the law says, and must work without an account or extra information.',
  },
  {
    id: 'markers',
    label: 'Sample information test',
    what: 'Arrives with made-up ad-click IDs in the address and types a made-up email and search into the page, without submitting.',
    why: 'Shows whether what a visitor types or arrives with reaches a third party — the “contents” wiretap suits are built on.',
  },
];

// --- The guide's shape (a copy of service/src/shared/legal-guide.ts: rules/ may not import the service) ---

export type GuideModelId = 'opt-in' | 'opt-out-signal' | 'opt-out' | 'opt-out-no-act' | 'unresearched';
export type GuideLawKind = 'obligation' | 'exposure' | 'practice';
export type GuideRisk = 'high' | 'moderate' | 'moderate-low' | 'low';
export type GuideNoteKind = 'posture' | 'litigation' | 'exception' | 'pending';

export interface GuideSource { label: string; href: string }
export interface GuideNote { kind: GuideNoteKind; title: string; text: string; sources: GuideSource[] }

export interface GuideRequirement {
  id: string;
  title: string;
  citation: string;
  text: string;
  kind: GuideLawKind;
  since: string;
  urls: string[];
  authority: Array<{ ref: string; note?: string }>;
  volatile: boolean;
}

export interface GuideLaw {
  id: string;
  name: string;
  shortName: string;
  summary: string;
  kind: GuideLawKind;
  risk?: GuideRisk;
  scope: string;
  requirements: GuideRequirement[];
  placeCodes: string[];
  notes: GuideNote[];
}

export interface GuideModel { id: GuideModelId; label: string; summary: string; mustHave: string[] }

export interface GuideStateAct {
  name: string;
  citation: string;
  urls: string[];
  from: string;
  gpcFrom?: string;
  inForce: boolean;
  sensitive: 'opt-in' | 'notice-and-opt-out' | 'sale-banned';
}

export interface GuidePlace {
  code: string;
  name: string;
  group: 'europe' | 'us' | 'other';
  members?: string[];
  model: GuideModelId;
  label: string;
  wiretap: boolean;
  lawIds: string[];
  stateAct?: GuideStateAct;
  scenarios: string[];
  notes: GuideNote[];
}

export interface GuideScenario { id: string; label: string; what: string; why: string }

export interface LegalGuide {
  version: 1;
  asOf: string;
  posture: { title: string; principles: string[] };
  models: GuideModel[];
  wiretap: { summary: string; holds: string; states: string[] };
  scenarios: GuideScenario[];
  laws: GuideLaw[];
  places: GuidePlace[];
}

const KIND_RANK: Record<GuideLawKind, number> = { obligation: 0, exposure: 1, practice: 2 };
const NON_STATES = new Set(['PR', 'GU', 'VI', 'AS', 'MP']);

function regionName(code: string): string {
  try {
    const n = new Intl.DisplayNames(['en'], { type: 'region' }).of(code.toUpperCase());
    return n && n !== code.toUpperCase() ? n : code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

const copyNotes = (notes: ReadonlyArray<{ kind: GuideNoteKind; title: string; text: string; sources: ReadonlyArray<GuideSource> }>): GuideNote[] =>
  notes.map((n) => ({ kind: n.kind, title: n.title, text: n.text, sources: n.sources.map((x) => ({ label: x.label, href: x.href })) }));

/**
 * The legal guide as of a date (YYYY-MM-DD): built from the registry alone, deduplicated —
 * each model, law and scan visit once; each place points at them by id. Pure.
 */
export function buildLegalGuide(asOf: string): LegalGuide {
  const scoped = (ALL_REQUIREMENTS as Requirement[]).filter((r) => r.jurisdictions?.length);

  // Places first: the laws' reach is derived from them.
  const placeSpecs: Array<{ code: string; name: string; group: GuidePlace['group']; codes: string[]; members?: string[] }> = [
    { code: 'eu', name: 'European Union & EEA', group: 'europe', codes: ['eu'], members: EU_EEA_COUNTRIES.map(regionName) },
    { code: 'uk', name: 'United Kingdom', group: 'europe', codes: ['uk'] },
    ...Object.entries(US_STATE_NAMES)
      .filter(([st]) => !NON_STATES.has(st))
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([st, name]) => ({ code: `us-${st.toLowerCase()}`, name, group: 'us' as const, codes: ['us', `us-${st.toLowerCase()}`] })),
    { code: 'other', name: 'Everywhere else', group: 'other', codes: ['zz'] },
  ];

  // Guide order is GUIDE_LAWS's key order (the spec's explicit list); INSTRUMENTS lists gdpr before eprivacy.
  const instrumentIds = Object.keys(GUIDE_LAWS).filter((id) => scoped.some((r) => String(r.instrument) === id));

  const reaches = (law: string, codes: string[]): boolean =>
    scoped.some((r) => String(r.instrument) === law && requirementScopeFor(r, codes, asOf) !== undefined);

  const places: GuidePlace[] = placeSpecs.map((spec) => {
    const { code, codes } = spec;
    const isOther = code === 'other';
    const regime = regimeForCodes(codes, asOf);
    const act = spec.group === 'us' ? usStateAct(code) : undefined;
    const model: GuideModelId = isOther
      ? 'unresearched'
      : spec.group === 'europe'
        ? 'opt-in'
        : regime === 'opt-out-signal'
          ? 'opt-out-signal'
          : act && act.from <= asOf
            ? 'opt-out'
            : 'opt-out-no-act';
    const notes = copyNotes(GUIDE_PLACE_NOTES[code] ?? []);
    if (act && act.from > asOf) {
      const gpc = act.gpcFrom ? ` and honoring the browser’s privacy signal from ${act.gpcFrom}` : '';
      notes.push({
        kind: 'pending',
        title: `${act.name} takes effect ${act.from}`,
        text: `${act.name} is enacted and takes effect ${act.from}${gpc}. Until then nothing is compared under it.`,
        sources: act.urls.map((u) => ({ label: act.name, href: u.href })),
      });
    }
    return {
      code,
      name: spec.name,
      group: spec.group,
      ...(spec.members ? { members: spec.members } : {}),
      model,
      label: isOther ? 'Not researched' : describeLocationRules(codes, asOf).label,
      wiretap: isWiretapJurisdiction(codes),
      lawIds: instrumentIds.filter((id) => reaches(id, codes)),
      ...(act
        ? {
            stateAct: {
              name: act.name,
              citation: act.citation,
              urls: act.urls.map((u) => u.href),
              from: act.from,
              ...(act.gpcFrom ? { gpcFrom: act.gpcFrom } : {}),
              inForce: act.from <= asOf,
              sensitive: act.sensitive,
            },
          }
        : {}),
      scenarios: defaultScenarios(codes, asOf),
      notes,
    };
  });

  const laws: GuideLaw[] = instrumentIds.map((id) => {
    const words = GUIDE_LAWS[id];
    if (!words) throw new Error(`legal guide: no GUIDE_LAWS entry for instrument ${id}`);
    const reqs = scoped.filter((r) => String(r.instrument) === id);
    const kind = reqs.map((r): GuideLawKind => r.kind ?? 'obligation').reduce((a, b) => (KIND_RANK[b] < KIND_RANK[a] ? b : a));
    return {
      id,
      name: INSTRUMENTS.find((i) => String(i.id) === id)?.name ?? id,
      shortName: words.shortName,
      summary: words.summary,
      kind,
      ...(words.risk ? { risk: words.risk } : {}),
      scope: words.scope,
      requirements: reqs.map((r) => ({
        id: String(r.id),
        title: r.title,
        citation: citationLabel(r),
        text: r.text,
        kind: r.kind ?? 'obligation',
        since: r.effective.from,
        urls: r.urls.map((u) => u.href),
        authority: (r.authority ?? []).map((a) => ({ ref: a.ref, ...(a.note !== undefined ? { note: a.note } : {}) })),
        volatile: r.volatile === true,
      })),
      placeCodes: places.filter((p) => p.lawIds.includes(id)).map((p) => p.code),
      notes: copyNotes(words.notes),
    };
  });

  return {
    version: 1,
    asOf,
    posture: { title: GUIDE_POSTURE.title, principles: [...GUIDE_POSTURE.principles] },
    models: GUIDE_MODELS.map((m) => ({ id: m.id, label: m.label, summary: m.summary, mustHave: [...m.mustHave] })),
    wiretap: { summary: GUIDE_WIRETAP.summary, holds: GUIDE_WIRETAP.holds, states: [...WIRETAP_STATES].sort() },
    scenarios: ScenarioId.options.map((id) => {
      const s = GUIDE_SCENARIOS.find((x) => x.id === id);
      if (!s) throw new Error(`legal guide: no GUIDE_SCENARIOS entry for ${id}`);
      return { id, label: s.label, what: s.what, why: s.why };
    }),
    laws,
    places,
  };
}
