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
  other:'Any other use. complykit treats it as needing consent.',
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
  /** The location carries wiretap-litigation exposure (CA, FL, PA): ad, analytics, recording, chat and identity tools are expected off until the visitor accepts. Absent in reports saved before this posture: today's behavior. */
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
  // complykit decides policy; the site never does (2026-10-09). A place with no mapped privacy law gets the strictest rules, opt-in.
  var unmapped = facts.regime === 'unknown';
  var regime = !facts.regime || unmapped ? 'opt-in' : facts.regime;
  var where = unmapped ? 'complykit’s default for places without a mapped privacy law (opt-in)' : facts.regimeLabel || (regime === 'opt-in' ? 'opt-in rules (EU/UK)' : regime === 'opt-out-signal' ? 'a US state that requires honoring opt-out signals' : regime === 'opt-out' ? 'US rules without an opt-out-signal law' : 'this location');
  // Purpose groups. Consent-type uses need permission under opt-in rules;
  // sale/share uses must stop under a US opt-out; context uses depend on how
  // the site uses them; the rest may always run.
  var CONSENT = ['analytics','performance','advertising','session-recording','identity-resolution','fingerprinting','marketing-email','other'];
  var SALE_SHARE = ['advertising','identity-resolution','marketing-email'];
  var CONTEXT = ['functional','chat','embed','fonts','reviews','error-monitoring'];
  // A recorded control never changes the expectation: what a tool does is a fact the site may supply; what that requires is complykit's call.
  var needsConsent = cats.some(function(c){return CONSENT.indexOf(c) >= 0;}) || (decision.userChosen === true && cats.indexOf('functional') >= 0);
  var saleShare = cats.some(function(c){return SALE_SHARE.indexOf(c) >= 0;});
  var context = !needsConsent && cats.some(function(c){return CONTEXT.indexOf(c) >= 0;});
  var analyticsOnly = cats.length > 0 && cats.every(function(c){return c === 'analytics' || c === 'performance' || c === 'error-monitoring';});
  // Wiretap posture (CA/FL/PA, opt-out regimes): these categories are held until the visitor accepts. Inline list: this function runs inside saved HTML (registry WIRETAP_CATEGORIES, plus the legacy 'advertisement').
  var WIRETAP = ['session-recording','chat','identity-resolution','advertising','advertisement','analytics'];
  var wiretap = facts.wiretap === true && (regime === 'opt-out-signal' || regime === 'opt-out') && cats.some(function(c){return WIRETAP.indexOf(c) >= 0;});
  var s = facts.scenario;
  var noChoice = ['do-nothing','browse','dismiss','markers'].indexOf(s) >= 0;
  var refused = ['reject','withdraw','return-visit'].indexOf(s) >= 0;
  var optedOut = ['gpc','opt-out-all','opt-out-link'].indexOf(s) >= 0;
  var off = false; var expected = 'May run';
  if (!cats.length || cats.indexOf('unknown') >= 0) expected = 'Depends on the purpose, which is not classified yet';
  else if (needsConsent && regime === 'opt-in') {
    if (s === 'accept') expected = 'May run after permission';
    else if (s === 'partial') { off = !analyticsOnly; expected = off ? 'Off: the visitor accepted analytics only' : 'May run: the visitor accepted analytics'; }
    else { off = true; expected = refused ? 'Off after the visitor refused' : 'Off until the visitor gives permission'; }
  } else if (wiretap) {
    if (s === 'accept') expected = 'May run: the visitor accepted';
    else if (s === 'partial') { off = !analyticsOnly; expected = off ? 'Off: the visitor accepted analytics only' : 'May run: the visitor accepted analytics'; }
    else { off = true; expected = refused ? 'Off: the site offered a choice and the visitor refused' : optedOut ? 'Off after the visitor opted out' : 'Off until the visitor accepts: firing before a choice is what wiretap suits in this state are built on'; }
  } else if (needsConsent && (regime === 'opt-out-signal' || regime === 'opt-out')) {
    if (refused) { off = true; expected = 'Off: the site offered a choice and the visitor refused'; }
    else if (optedOut && saleShare && (regime === 'opt-out-signal' || s !== 'gpc')) { off = true; expected = s === 'gpc' ? 'Off or restricted while the browser sends the opt-out signal' : 'Off or restricted after the visitor opted out'; }
    else if (optedOut && saleShare) expected = 'May run: this state does not require honoring the signal';
    else if (s === 'accept') expected = 'May run: the visitor accepted';
    else expected = noChoice ? 'May run before a choice under these rules' : 'May run: opting out of sale/sharing does not cover this use';
  } else if (context && regime === 'opt-in') {
    // A chat, embed, font or review widget is exempt only when the visitor asks for it; the scan never asks, so loading it unasked needs consent.
    if (s === 'accept') expected = 'May run after permission';
    else { off = true; expected = 'Off until the visitor accepts or asks for the feature (click to load)'; }
  } else if (context) expected = 'May run';
  var result = function(status: 'match'|'mismatch'|'review'|'unknown'|'not-tested'|'allowed', reason: string) { return {status:status,expected:expected,reason:reason}; };
  if (facts.unavailable) return result(facts.unavailable.status, facts.unavailable.reason);
  if (!cats.length || cats.indexOf('unknown') >= 0) return result('review','Classify the purpose before an expectation can be checked.');
  // Reports saved before location rules existed: a privacy-signal visit had no expectation; keep that.
  if (!facts.regime && optedOut) return result('review','This report predates location-specific expectations for privacy signals. Re-run the scan to check this automatically.');
  // "May run" is an expectation like any other: running (or not) meets it.
  if (!off) return result('match', 'Working as expected: ' + (facts.hasActivity ? 'it ran, and ' : 'it did not run; ') + 'it may run here under ' + where + '.');
  if (facts.limitedOnly) {
    // Consent-denied pings (Google Consent Mode "advanced", Meta LDU) carry the IP address and the page address. EU/UK regulators treat that
    // as needing consent, and wiretap suits have not ruled them out, so complykit's verdict is that they wait for consent there. After an
    // explicit opt-out under US rules, restricted mode is what the law asks for.
    var contested = regime === 'opt-in' || (wiretap && (noChoice || refused));
    if (!contested) return result('match','Only restricted-mode requests were sent (e.g. Google restricted data processing, Meta limited data use), with nothing stored. That is the expected opt-out behavior.');
    return result('mismatch', regime === 'opt-in'
      ? 'Consent-denied pings were sent (e.g. Google Consent Mode "advanced"). They set no cookies but carry the IP address and the page address, which EU/UK regulators treat as needing consent. Load these tags only after the visitor accepts (Consent Mode "basic").'
      : 'Consent-denied pings were sent (e.g. Google Consent Mode "advanced"). They set no cookies but carry the IP address and the page address, and no court has ruled them safe under this state’s wiretap law. Load these tags only after the visitor accepts (Consent Mode "basic").');
  }
  if (facts.hasActivity) return result('mismatch', wiretap && noChoice ? 'Active before any choice in a wiretap-litigation state, where complykit holds this tool until the visitor accepts: the pattern wiretap suits are built on.' : 'Active when ' + where + ' expect it to be off.');
  if (facts.captureGap) return result('unknown','Capture limits could hide activity; absence is not a pass.');
  return result('match','No activity was recorded, as expected. This covers the captured behavior and duration only.');
}
