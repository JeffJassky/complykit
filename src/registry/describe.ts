import type { Requirement, RequirementKind } from './schema.js';
import { ALL_REQUIREMENTS } from './requirements/index.js';
import { INSTRUMENTS } from './instruments.js';
import { requirementScopeFor } from './jurisdictions.js';
import { regimeForCodes, type RegimeVerdict } from './regime.js';
import { US_STATE_NAMES, usStateAct, type UsStatePrivacyAct } from './us-states.js';
import { citationLabel } from './citation.js';

// "Which rules did the scan compare this location against?" — derived from the
// registry alone, so the report's location line, its popover and the rules
// cannot disagree: the laws listed are exactly the requirements whose
// `jurisdictions` reach these codes on this date (requirementScopeFor, the same
// gate the rules use), and the regime is the shared regimeForCodes().
//
// Copy is for a site owner. It states what the model requires; it never says a
// site meets it (assertReportVocabulary).

export interface LocationRuleLaw {
  requirementId: string;
  instrument: string;
  instrumentName: string;
  title: string;
  /** citationLabel(): "ePrivacy Directive Art. 5(3)", "11 CCR §7025(b)–(c)". */
  citation: string;
  kind: RequirementKind;
  urls: string[];
  /** When the duty started applying at this location (the scope's `from`, else the requirement's). */
  since: string;
}

export interface LocationRules {
  regime: RegimeVerdict;
  /** "Opt-in (EU/EEA)", "Opt-out, privacy signal honored (Texas)", "Opt-out (Florida)", "No rules encoded (Brazil)". */
  label: string;
  /** One paragraph: what this model means for a visitor from here. */
  summary: string;
  /** What a site under this model must have. Bullets, owner vocabulary. */
  mustHave: string[];
  /** The requirements the rules apply at this location on this date. Obligations first, then exposure. */
  laws: LocationRuleLaw[];
  /** The state's comprehensive privacy act, for US states that have one (in force or enacted). */
  stateAct?: { state: string; name: string; citation: string; urls: string[]; from: string; gpcFrom?: string; inForce: boolean; sensitive: UsStatePrivacyAct['sensitive'] };
  /** Documented divergences and caveats (unverified state; unresearched country; nothing compared). */
  notes: string[];
  /** The scan verified the location (codes are trustworthy). False ⇒ nothing compared. */
  verified: boolean;
}

export interface DescribeLocationOptions {
  /** The verification verdict; anything but 'verified' means the codes are empty and nothing is compared. Default: codes.length > 0. */
  verified?: boolean;
  /** The measured place, for the label when the codes carry no state/country name ("US-CA", "BR"). */
  observed?: string;
}

const KIND_ORDER: Record<RequirementKind, number> = { obligation: 0, exposure: 1, practice: 2 };

function countryName(code: string): string {
  try {
    const n = new Intl.DisplayNames(['en'], { type: 'region' }).of(code.toUpperCase());
    return n && n !== code.toUpperCase() ? n : code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

function instrumentName(id: string): string {
  return INSTRUMENTS.find((i) => String(i.id) === id)?.name ?? id;
}

function lawsFor(codes: readonly string[], onDate: string): LocationRuleLaw[] {
  const out: LocationRuleLaw[] = [];
  for (const req of ALL_REQUIREMENTS as Requirement[]) {
    const scope = requirementScopeFor(req, codes, onDate);
    if (!scope || scope === 'any') continue;
    const scoped = req.jurisdictions?.find((j) => j.code === scope);
    out.push({
      requirementId: String(req.id),
      instrument: String(req.instrument),
      instrumentName: instrumentName(String(req.instrument)),
      title: req.title,
      citation: citationLabel(req),
      kind: req.kind ?? 'obligation',
      urls: req.urls.map((u) => u.href),
      since: scoped?.from && scoped.from > req.effective.from ? scoped.from : req.effective.from,
    });
  }
  return out.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.since.localeCompare(b.since) || a.requirementId.localeCompare(b.requirementId));
}

const OPT_IN_MUST = [
  'Nothing non-essential runs until the visitor agrees: no analytics, advertising or social scripts, cookies or storage before a choice (ePrivacy Art. 5(3) / PECR reg. 6).',
  'A banner where rejecting is as easy as accepting — one click each, equal prominence.',
  'Proof of consent, and a way to withdraw it that is as easy as giving it (GDPR Art. 7(3)).',
];

const OPT_OUT_SIGNAL_MUST = (state: string, ca: boolean): string[] => [
  'Tracking may run by default; the visitor can opt out of the sale or sharing of their data and of targeted advertising.',
  'The browser’s opt-out signal (Global Privacy Control) must be treated as that opt-out — on the first page, with no popup.',
  ca
    ? 'A “Do Not Sell or Share My Personal Information” link, or “Your Privacy Choices” with the opt-out icon, in the header or footer; opting out may not demand an account or extra information; since 2026 the site must show that the signal was honored.'
    : `A clear and conspicuous way to opt out, reachable from the site, that works without an account or extra information (${state} law).`,
  'Disclosure of the processing and the opt-out right in the privacy policy (not checked by a scan).',
];

const OPT_OUT_MUST = (state: string): string[] => [
  'Tracking may run by default; the visitor can opt out of targeted advertising and of the sale of their data.',
  `A clear and conspicuous way to opt out, reachable from the site, that works without an account or extra information (${state} law).`,
  'No duty to honor the browser’s opt-out signal (GPC) here. complykit’s consent tool honors it anyway.',
  'Disclosure of the processing and the opt-out right in the privacy policy (not checked by a scan).',
];

const NO_ACT_MUST = [
  'No comprehensive state privacy law is in force here. Federal rules (COPPA, the FTC Act) and wiretap statutes may still apply; nothing is compared automatically.',
  'The behavior matrix still compares each tool with its category’s standard behavior under US opt-out rules.',
];

/**
 * Describe the rules the scan applies at a location given as jurisdiction codes
 * (jurisdictions.ts) on a date (YYYY-MM-DD). Pure.
 */
export function describeLocationRules(codes: readonly string[], onDate: string, opts: DescribeLocationOptions = {}): LocationRules {
  const verified = opts.verified ?? codes.length > 0;
  if (!verified || !codes.length) {
    return {
      regime: 'unknown',
      label: 'Not verified — no rules compared',
      summary: 'The scan could not verify where this browser was. Nothing was compared against any location’s rules, and this location’s observations are not evidence for the intended place.',
      mustHave: [],
      laws: [],
      notes: ['Re-run from a verified exit to get rules applied here.'],
      verified: false,
    };
  }
  const regime = regimeForCodes(codes, onDate, { unverifiedUs: 'baseline' });
  const laws = lawsFor(codes, onDate);

  if (regime === 'opt-in') {
    const uk = codes.includes('uk');
    const cc = codes.find((c) => /^eu-[a-z]{2}$/.test(c))?.slice(3);
    const where = uk ? 'UK' : cc ? `${countryName(cc)}, EU/EEA` : 'EU/EEA';
    return {
      regime,
      label: `Opt-in (${uk ? 'UK' : 'EU/EEA'})`,
      summary: `A visitor from ${where} is under the opt-in model: nothing non-essential may run until they say yes, a banner is required, and rejecting must be as easy as accepting. ${uk ? 'UK PECR reg. 6 and the UK GDPR' : 'The ePrivacy Directive and the GDPR'} apply.`,
      mustHave: OPT_IN_MUST,
      laws,
      notes: [],
      verified: true,
    };
  }

  if (regime === 'unknown') {
    const cc = codes[0] ?? '';
    const name = countryName(cc);
    return {
      regime,
      label: `No rules encoded (${name})`,
      summary: `complykit has not researched the law of ${name}. Nothing was compared against a legal model at this location; the behavior matrix shows observations only. complykit’s consent tool treats visitors from here as opt-in, the strictest model.`,
      mustHave: [],
      laws,
      notes: [`${name} is not researched. The scanner compares nothing here; the consent tool fails closed to opt-in.`],
      verified: true,
    };
  }

  // US.
  const stateCode = codes.find((c) => /^us-[a-z]{2}$/.test(c))?.slice(3).toUpperCase();
  const act = stateCode ? usStateAct(stateCode) : undefined;
  const stateName = stateCode ? US_STATE_NAMES[stateCode] ?? stateCode : undefined;
  const stateAct = act
    ? { state: act.state, name: act.name, citation: act.citation, urls: act.urls.map((u) => u.href), from: act.from, ...(act.gpcFrom ? { gpcFrom: act.gpcFrom } : {}), inForce: act.from <= onDate, sensitive: act.sensitive }
    : undefined;
  const notes: string[] = [];

  if (!stateCode) {
    notes.push(
      'The state could not be verified, so no state-specific duty (the privacy signal in the signal states, the opt-out link) is asserted here. complykit’s consent tool treats a US visitor with no verified state as opt-out with the privacy signal honored — the strictest US model — because the visitor may be in California.',
    );
    return {
      regime,
      label: 'Opt-out (US, state not verified)',
      summary: 'A US visitor whose state is not verified is compared under the baseline US opt-out model: tracking may run by default and the visitor must be able to opt out. State-specific duties are not asserted.',
      mustHave: OPT_OUT_MUST('state'),
      laws,
      notes,
      verified: true,
    };
  }

  if (regime === 'opt-out-signal') {
    const ca = stateCode === 'CA';
    return {
      regime,
      label: `Opt-out, privacy signal honored (${stateName})`,
      summary: `A visitor from ${stateName} is under the opt-out model with a signal duty: tracking may run by default, but the visitor can opt out of sale, sharing and targeted advertising, and the browser’s Global Privacy Control must be honored as that opt-out${ca ? ' (CCPA regulations §7025)' : ` (${act?.name ?? 'state law'}, since ${act?.gpcFrom ?? 'its effective date'})`}.`,
      mustHave: OPT_OUT_SIGNAL_MUST(stateName ?? stateCode, ca),
      laws,
      ...(stateAct ? { stateAct } : {}),
      notes,
      verified: true,
    };
  }

  if (act && act.from <= onDate) {
    return {
      regime,
      label: `Opt-out (${stateName})`,
      summary: `A visitor from ${stateName} is under the opt-out model: tracking may run by default, and the visitor can opt out of targeted advertising and the sale of their data (${act.name}, in force since ${act.from}). The law does not require honoring the browser’s opt-out signal.`,
      mustHave: OPT_OUT_MUST(stateName ?? stateCode),
      laws,
      ...(stateAct ? { stateAct } : {}),
      notes,
      verified: true,
    };
  }

  if (act) notes.push(`${act.name} is enacted and applies from ${act.from}${act.gpcFrom ? ` (privacy signal from ${act.gpcFrom})` : ''}. Until then nothing is compared under it.`);
  return {
    regime,
    label: `Opt-out (${stateName}, no state privacy law in force)`,
    summary: `A visitor from ${stateName} is compared under the baseline US opt-out model. ${stateName} has no comprehensive privacy law in force on ${onDate}; only wiretap exposure and federal rules can apply.`,
    mustHave: NO_ACT_MUST,
    laws,
    ...(stateAct ? { stateAct } : {}),
    notes,
    verified: true,
  };
}
