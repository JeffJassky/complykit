// Bundled cookie classification snapshot — the `classify` adapter's default
// (build-plan §4). A representative slice of the Open-Cookie-Database vocabulary:
// name pattern -> category. A host can override/extend via the classify adapter;
// unknown keys are reported so the DB can grow. Pure data — registry imports
// nothing.

export type CookieCategory = 'necessary' | 'functional' | 'analytics' | 'advertising' | 'unknown';

interface CookiePattern {
  test: RegExp;
  category: CookieCategory;
  vendor?: string;
}

// Order matters: first match wins. Patterns are anchored to the cookie NAME.
const PATTERNS: CookiePattern[] = [
  // Analytics
  { test: /^_ga(_.+)?$/, category: 'analytics', vendor: 'Google Analytics' },
  { test: /^_gid$/, category: 'analytics', vendor: 'Google Analytics' },
  { test: /^_gat/, category: 'analytics', vendor: 'Google Analytics' },
  { test: /^__utm[a-z]$/, category: 'analytics', vendor: 'Google Analytics (legacy)' },
  { test: /^_hj/, category: 'analytics', vendor: 'Hotjar' },
  { test: /^mp_[a-f0-9]+_mixpanel$/, category: 'analytics', vendor: 'Mixpanel' },
  { test: /^ajs_/, category: 'analytics', vendor: 'Segment' },
  { test: /^amplitude_/, category: 'analytics', vendor: 'Amplitude' },
  { test: /^_clck$|^_clsk$/, category: 'analytics', vendor: 'Microsoft Clarity' },
  { test: /^_pk_/, category: 'analytics', vendor: 'Matomo' },
  // Advertising
  { test: /^_gcl_/, category: 'advertising', vendor: 'Google Ads' },
  { test: /^_fbp$|^_fbc$|^fr$/, category: 'advertising', vendor: 'Meta Pixel' },
  { test: /^IDE$|^test_cookie$/, category: 'advertising', vendor: 'DoubleClick' },
  { test: /^personalization_id$/, category: 'advertising', vendor: 'X/Twitter' },
  { test: /^MUID$|^_uetsid$|^_uetvid$/, category: 'advertising', vendor: 'Microsoft Advertising' },
  { test: /^li_sugr$|^bcookie$|^lidc$/, category: 'advertising', vendor: 'LinkedIn' },
  // Functional
  { test: /^__stripe_(mid|sid)$/, category: 'functional', vendor: 'Stripe' },
  { test: /^intercom-/, category: 'functional', vendor: 'Intercom' },
  { test: /^__cf_bm$|^cf_clearance$/, category: 'necessary', vendor: 'Cloudflare' },
  // Necessary (session/CSRF/consent)
  { test: /(session|sess|sid|csrf|xsrf|token)/i, category: 'necessary' },
  { test: /(consent|cookieconsent|CookieConsent|OptanonConsent|euconsent)/i, category: 'necessary' },
];

export interface CookieClassification {
  category: CookieCategory;
  vendor?: string;
}

/** Classify a cookie by name (the adapter default). Unknown -> 'unknown'. */
export function classifyCookie(name: string): CookieClassification {
  for (const p of PATTERNS) {
    if (p.test.test(name)) return { category: p.category, vendor: p.vendor };
  }
  return { category: 'unknown' };
}

/** A tracker cookie is analytics or advertising — the categories that need
 *  consent before being set (not strictly necessary / functional). */
export function requiresConsent(category: CookieCategory): boolean {
  return category === 'analytics' || category === 'advertising';
}
