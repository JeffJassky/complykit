// The legal guide page's data (plans/legal-guide-contract.md). One deduplicated
// reference: the rule models are explained once, each law once, and every place
// points at them by id. Generated from complykit's registry into
// legal-guide.json (test/legal-guide.test.ts fails when the file is behind the
// registry; `UPDATE_GUIDE=1` rewrites it). No imports: the service never
// imports the complykit package — this file mirrors its types.

/** The rule model a place falls under. `opt-out-no-act`: a US state with no comprehensive privacy act in force. */
export type GuideModelId = 'opt-in' | 'opt-out-signal' | 'opt-out' | 'opt-out-no-act' | 'unresearched';

/** obligation = a duty the law imposes; exposure = a litigation theory (wiretap suits); practice = what regulators order. */
export type GuideLawKind = 'obligation' | 'exposure' | 'practice';

/** Litigation risk for an exposure law, from the research (plans/research-consent-law.md §2.5). */
export type GuideRisk = 'high' | 'moderate' | 'moderate-low' | 'low';

/**
 * A callout. posture = a decision complykit made (what it tests, what it left out and why);
 * litigation = how suits actually play out; exception = a carve-out or special rule;
 * pending = something enacted or decided but not yet in force, or awaiting a decision.
 */
export type GuideNoteKind = 'posture' | 'litigation' | 'exception' | 'pending';

export interface GuideSource {
  label: string;
  href: string;
}

export interface GuideNote {
  kind: GuideNoteKind;
  title: string;
  text: string;
  sources: GuideSource[];
}

export interface GuideRequirement {
  /** Registry requirement id, e.g. 'eprivacy.art5.3'. */
  id: string;
  title: string;
  /** "ePrivacy Directive Art. 5(3)", "11 CCR §7025(b)–(c)". */
  citation: string;
  /** The normative excerpt (EU/UK official text) or a close paraphrase (US). */
  text: string;
  kind: GuideLawKind;
  /** YYYY-MM-DD the requirement took effect. */
  since: string;
  urls: string[];
  /** Cases, orders and guidance behind the reading. */
  authority: Array<{ ref: string; note?: string }>;
  /** Recheck before relying on it: pending bills, unsettled readings. */
  volatile: boolean;
}

export interface GuideLaw {
  /** The registry instrument id: 'eprivacy', 'gdpr', 'pecr', 'uk-gdpr', 'ccpa', 'us-state-privacy', 'cipa', 'fsca', 'wesca', 'mdwa', 'ilea', 'enforcement-practice'. */
  id: string;
  /** Full name. */
  name: string;
  /** Chip label: 'ePrivacy Directive', 'CIPA'. */
  shortName: string;
  /** What it is, in one plain paragraph. */
  summary: string;
  kind: GuideLawKind;
  /** Exposure laws only. */
  risk?: GuideRisk;
  /** Where it reaches: display text ('EU & EEA', 'California', '11 US states'). */
  scope: string;
  requirements: GuideRequirement[];
  /** Codes of the places it reaches as of `asOf` (every place for a practice that applies anywhere). */
  placeCodes: string[];
  notes: GuideNote[];
}

/** A rule model, explained once. */
export interface GuideModel {
  id: GuideModelId;
  /** 'Opt-in', 'Opt-out with privacy signal', … */
  label: string;
  summary: string;
  /** What a site under this model must have. */
  mustHave: string[];
}

export interface GuideStateAct {
  name: string;
  citation: string;
  urls: string[];
  /** In force from (YYYY-MM-DD). */
  from: string;
  /** Duty to honor the browser's opt-out signal (GPC) from. */
  gpcFrom?: string;
  inForce: boolean;
  /** How the act treats sensitive data — reported, never checked by a scan. */
  sensitive: 'opt-in' | 'notice-and-opt-out' | 'sale-banned';
}

export interface GuidePlace {
  /** 'eu', 'uk', 'us-ca' … 'us-wy', 'us-dc', 'other'. */
  code: string;
  /** 'European Union & EEA', 'United Kingdom', 'California', 'Everywhere else'. */
  name: string;
  group: 'europe' | 'us' | 'other';
  /** The countries a grouped place covers (EU & EEA). */
  members?: string[];
  model: GuideModelId;
  /** describeLocationRules() label: 'Opt-out, privacy signal honored (Texas)'. */
  label: string;
  /** In complykit's wiretap posture: tracking tools held until the visitor accepts. */
  wiretap: boolean;
  /** GuideLaw ids reaching this place as of `asOf`: obligations, then exposure, then practice. */
  lawIds: string[];
  stateAct?: GuideStateAct;
  /** The visits a full scan makes from here (GuideScenario ids, in run order). */
  scenarios: string[];
  notes: GuideNote[];
}

/** One visit a scan makes: what the browser does, and why. */
export interface GuideScenario {
  id: string;
  label: string;
  what: string;
  why: string;
}

export interface LegalGuide {
  version: 1;
  /** The date the guide was generated for (YYYY-MM-DD): what is "in force" is as of this day. */
  asOf: string;
  /** complykit's testing policy: the principles every expectation follows. */
  posture: { title: string; principles: string[] };
  models: GuideModel[];
  /** The wiretap posture, explained once; `states` are its place codes. */
  wiretap: { summary: string; holds: string; states: string[] };
  scenarios: GuideScenario[];
  laws: GuideLaw[];
  places: GuidePlace[];
}
