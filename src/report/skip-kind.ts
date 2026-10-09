import type { SkipCause } from '../record/index.js';

// Why a check was skipped, in three kinds the owner can tell apart (2026-10-09):
//
//   not-applicable  nothing to test: no banner where none is required, a banner with no close
//                   control. Not a pass and not a problem.
//   untestable      the scan could not do it: a click that did not land, a timeout, bot
//                   protection, an unverified location. Unknown — rerun or check by hand.
//   blocked         the site stopped the visitor: a settings control that opens nothing, no way
//                   to withdraw consent where consent is how choice is offered. A problem to fix:
//                   if the scan cannot do it, neither can a visitor.
//
// The scan records a cause code (record SkipCause); the location's rules decide the kind where
// it depends on them. Reports saved before cause codes fall back to the recorded reason.

export type SkipKind = 'not-applicable' | 'untestable' | 'blocked';

export interface SkipFacts {
  status: 'tested' | 'not-tested' | 'not-applicable' | 'not-run';
  cause?: SkipCause;
  reason?: string;
  /** The owner-words gap of a choice that did not complete (consent-model choiceGap). */
  choiceGap?: string;
}

export interface SkipPlace {
  regime: string;
  wiretap: boolean;
}

const LEGACY: Array<[RegExp, SkipCause]> = [
  [/offers no way to close it/, 'no-close'],
  [/showed no banner|no consent banner detected/, 'no-banner'],
  [/did not open the cookie settings/, 'settings-dead'],
  [/No opt-out link was found/, 'no-opt-out-link'],
  [/asks for .+ and the scan does not submit personal data/, 'opt-out-asks-personal-data'],
  [/bot protection/, 'bot-blocked'],
  [/exceeded its .+ budget/, 'timeout'],
  [/scenario crashed/, 'crashed'],
];

/** The cause code, from the record or (older reports) the recorded reason. */
export function skipCauseOf(f: SkipFacts): SkipCause | undefined {
  if (f.cause) return f.cause;
  const text = `${f.reason ?? ''} ${f.choiceGap ?? ''}`;
  return LEGACY.find(([re]) => re.test(text))?.[1];
}

export function skipKindOf(f: SkipFacts, where: SkipPlace): SkipKind {
  if (f.status === 'not-run') return 'untestable';
  // Where consent is how the visitor chooses (opt-in, or the wiretap posture), the banner's
  // controls are the visitor's only way to choose or take it back.
  const consentBased = where.regime === 'opt-in' || where.wiretap;
  switch (skipCauseOf(f)) {
    case 'no-banner':
    case 'no-close':
      return 'not-applicable';
    case 'settings-dead':
      return 'blocked';
    case 'no-category-choice':
      return where.regime === 'opt-in' ? 'blocked' : 'not-applicable';
    case 'no-withdraw-entry':
      return consentBased ? 'blocked' : 'not-applicable';
    case 'no-opt-out-link':
      return where.regime === 'opt-out-signal' || where.regime === 'opt-out' ? 'blocked' : 'not-applicable';
    default:
      return f.status === 'not-applicable' ? 'not-applicable' : 'untestable';
  }
}

/** The column note's opening words for each kind. */
export const SKIP_LEAD: Record<SkipKind, string> = {
  'not-applicable': 'Not applicable',
  untestable: 'Not checked',
  blocked: 'A visitor cannot do this',
};
