/** Human purpose labels are distinct from the vendor library's technical tags. */
export const COOKIE_PURPOSES = ['necessary', 'functional', 'analytics', 'performance', 'advertising', 'other'] as const;
export const COOKIE_PURPOSE_LABELS: Record<string, string> = {
  necessary: 'Necessary', functional: 'Functional', analytics: 'Analytics', performance: 'Performance', advertising: 'Advertisement', other: 'Other',
};
export const COOKIE_PURPOSE_DESCRIPTIONS: Record<string,string> = {
  necessary:'Essential for a service the visitor requests; every use must be necessary.',
  functional:'Optional features or preferences, such as chat or personalization.',
  analytics:'Measures visits and how people use the site.',
  performance:'Measures speed, reliability or errors.',
  advertising:'Ads, audiences, targeting or campaign measurement.',
  other:'Describe the purpose and decide which controls apply.',
};
export function cookiePurposes(categories: string[]): string[] {
  return [...new Set(categories.map(category => {
    if (category === 'session-recording') return 'analytics';
    if (category === 'error-monitoring') return 'performance';
    if (['chat', 'embed', 'fonts', 'reviews', 'payments'].includes(category)) return 'functional';
    if (['identity-resolution', 'marketing-email'].includes(category)) return 'advertising';
    if (category === 'advertisement') return 'advertising';
    return (COOKIE_PURPOSES as readonly string[]).includes(category) ? category : 'other';
  }))];
}

/**
 * Which rule set a verified location's visitors fall under, for the behavior
 * comparison. Mirrors the finding rules (rules/tracking): EU/UK opt-in; US
 * states whose law requires honoring an opt-out signal; other US states; and
 * everywhere else, where no expectation is applied automatically.
 */
export type PrivacyRegime = 'opt-in' | 'opt-out-signal' | 'opt-out' | 'unknown';

export interface ComparisonFacts {
  scenario: string;
  unavailable?: {status: 'unknown' | 'not-tested'; reason: string};
  hasActivity: boolean;
  /** Every request was a consent-denied or restricted-mode request (Google
   *  Consent Mode denied, rdp / LDU), with no storage. */
  limitedOnly: boolean;
  captureGap: boolean;
  /** Absent in reports saved before regimes existed: treated as 'opt-in', the old behavior. */
  regime?: PrivacyRegime;
  regimeLabel?: string;
  /** The location carries wiretap-litigation exposure (CA, FL, PA): ad, recording, chat and identity tools are expected off until the visitor accepts. Absent in reports saved before this posture: today's behavior. */
  wiretap?: boolean;
}
export interface PurposeDecision {
  categories: string[];
  control?: string;
  userChosen?: boolean;
}

/**
 * The standard behavior for a purpose category in one visitor action, under
 * the location's rules — then whether the scan's observation matched it.
 * The same expectation table applies to a tool and to each of its cookies.
 * This closure-free function runs unchanged on the server and inside saved HTML.
 */
export function compareCookieBehavior(facts: ComparisonFacts, decision: PurposeDecision): {status:'match'|'mismatch'|'review'|'unknown'|'not-tested'|'allowed'; expected:string; reason:string} {
  var cats = decision.categories;
  var regime = facts.regime || 'opt-in';
  var where = facts.regimeLabel || (regime === 'opt-in' ? 'opt-in rules (EU/UK)' : regime === 'opt-out-signal' ? 'a US state that requires honoring opt-out signals' : regime === 'opt-out' ? 'US rules without an opt-out-signal law' : 'this location');
  // Purpose groups. Consent-type uses need permission under opt-in rules;
  // sale/share uses must stop under a US opt-out; context uses depend on how
  // the site uses them; the rest may always run.
  var CONSENT = ['analytics','performance','advertising','session-recording','identity-resolution','fingerprinting','marketing-email'];
  var SALE_SHARE = ['advertising','identity-resolution','marketing-email'];
  var CONTEXT = ['functional','chat','embed','fonts','reviews','error-monitoring'];
  var needsConsent = cats.some(function(c){return CONSENT.indexOf(c) >= 0;}) || decision.control === 'consent' || (decision.userChosen === true && cats.indexOf('functional') >= 0);
  var saleShare = cats.some(function(c){return SALE_SHARE.indexOf(c) >= 0;});
  var context = !needsConsent && cats.some(function(c){return CONTEXT.indexOf(c) >= 0;});
  var analyticsOnly = cats.length > 0 && cats.every(function(c){return c === 'analytics' || c === 'performance' || c === 'error-monitoring';});
  // Wiretap posture (CA/FL/PA, opt-out regimes): these categories are held until the visitor accepts. Inline list: this function runs inside saved HTML (registry WIRETAP_CATEGORIES, plus the legacy 'advertisement').
  var WIRETAP = ['session-recording','chat','identity-resolution','advertising','advertisement'];
  var wiretap = facts.wiretap === true && (regime === 'opt-out-signal' || regime === 'opt-out') && cats.some(function(c){return WIRETAP.indexOf(c) >= 0;});
  var s = facts.scenario;
  var noChoice = ['do-nothing','browse','dismiss','markers'].indexOf(s) >= 0;
  var refused = ['reject','withdraw','return-visit'].indexOf(s) >= 0;
  var optedOut = ['gpc','opt-out-all','opt-out-link'].indexOf(s) >= 0;
  var off = false; var expected = 'May run';
  if (!cats.length || cats.indexOf('unknown') >= 0) expected = 'Depends on the purpose, which is not classified yet';
  else if (decision.control === 'other' || (needsConsent && decision.control === 'none' && decision.userChosen)) expected = 'Depends on the control you recorded';
  else if (needsConsent && regime === 'opt-in') {
    if (s === 'accept') expected = 'May run after permission';
    else if (s === 'partial') { off = !analyticsOnly; expected = off ? 'Off: the visitor accepted analytics only' : 'May run: the visitor accepted analytics'; }
    else { off = true; expected = refused ? 'Off after the visitor refused' : 'Off until the visitor gives permission'; }
  } else if (wiretap) {
    if (s === 'accept') expected = 'May run: the visitor accepted';
    else { off = true; expected = refused ? 'Off: the site offered a choice and the visitor refused' : optedOut ? 'Off after the visitor opted out' : 'Off until the visitor accepts: firing before a choice is what wiretap suits in this state are built on'; }
  } else if (needsConsent && (regime === 'opt-out-signal' || regime === 'opt-out')) {
    if (refused) { off = true; expected = 'Off: the site offered a choice and the visitor refused'; }
    else if (optedOut && saleShare && (regime === 'opt-out-signal' || s !== 'gpc')) { off = true; expected = s === 'gpc' ? 'Off or restricted while the browser sends the opt-out signal' : 'Off or restricted after the visitor opted out'; }
    else if (optedOut && saleShare) expected = 'May run: this state does not require honoring the signal';
    else if (s === 'accept') expected = 'May run: the visitor accepted';
    else expected = noChoice ? 'May run before a choice under these rules' : 'May run: opting out of sale/sharing does not cover this use';
  } else if (context) expected = regime === 'opt-in' ? 'May run only when needed for a feature the visitor uses' : 'May run';
  else if (regime === 'unknown' && needsConsent) expected = 'No automatic expectation for this location';
  var result = function(status: 'match'|'mismatch'|'review'|'unknown'|'not-tested'|'allowed', reason: string) { return {status:status,expected:expected,reason:reason}; };
  if (facts.unavailable) return result(facts.unavailable.status, facts.unavailable.reason);
  if (!cats.length || cats.indexOf('unknown') >= 0) return result('review','Classify the purpose before an expectation can be checked.');
  if (cats.indexOf('other') >= 0 && !needsConsent) return result('review','"Other" purposes have no standard behavior. Decide which control applies.');
  // Reports saved before location rules existed: a privacy-signal visit had no expectation; keep that.
  if (!facts.regime && optedOut) return result('review','This report predates location-specific expectations for privacy signals. Re-run the scan to check this automatically.');
  if (decision.control === 'other' || (needsConsent && decision.control === 'none' && decision.userChosen)) return result('review','Your recorded control differs from the standard expectation for this category. Review it against the location and evidence.');
  if (regime === 'unknown' && needsConsent) return result('review','No standard expectation is applied automatically for this location.');
  if (context && regime === 'opt-in' && !refused && s !== 'accept') return facts.hasActivity ? result('review','Allowed without consent only when strictly needed for a feature the visitor asked for. Check how the site uses it.') : result('match','Not active during this visit.');
  // "May run" is an expectation like any other: running (or not) meets it.
  if (!off) return result('match', 'Working as expected: ' + (facts.hasActivity ? 'it ran, and ' : 'it did not run; ') + 'it may run here under ' + where + '.');
  if (facts.limitedOnly) return regime === 'opt-in' ? result('review','Only consent-denied pings were sent, with nothing stored (e.g. Google Consent Mode "advanced"). Whether that is acceptable without consent is contested in the EU/UK.') : result('match','Only restricted-mode requests were sent (e.g. Google restricted data processing, Meta limited data use), with nothing stored. That is the expected opt-out behavior.');
  if (facts.hasActivity) return result('mismatch', wiretap && noChoice ? 'Active before any choice in a wiretap-litigation state, where this tool is expected off until the visitor accepts. This is a behavior mismatch and litigation exposure, not a legal verdict.' : 'Active when ' + where + ' expect it to be off. This is a behavior mismatch, not a legal verdict.');
  if (facts.captureGap) return result('unknown','Capture limits could hide activity; absence is not a pass.');
  return result('match','No activity was recorded, as expected. This covers the captured behavior and duration only.');
}
