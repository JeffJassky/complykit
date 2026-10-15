// Shopify Customer Privacy API (Shopify's own cookie banner, or an app using the same API).
// Read 2026-10-06 and cited in full in bridges/shopify.ts; rechecked 2026-10-14: https://shopify.dev/docs/api/customer-privacy
//   - window.Shopify.customerPrivacy.currentVisitorConsent() -> { analytics, marketing, preferences,
//     sale_of_data } each 'yes' | 'no' | '' (undeclared).
//   - analyticsProcessingAllowed(), marketingAllowed(), preferencesProcessingAllowed(): the effective answer,
//     region default included ("for regions requiring consent ... not allowed until consent is given; for
//     other regions the default is to allow"). Preferred when present: it is what Shopify itself enforces.
//   - document event 'visitorConsentCollected', detail {analyticsAllowed, marketingAllowed,
//     preferencesAllowed, saleOfDataAllowed}; "published only when consent changes", so we re-read.
import { listen, win, type Source } from './types.js';

export const shopify: Source = (push) => {
  const read = (): string[] | undefined => {
    const p = win().Shopify?.customerPrivacy;
    if (typeof p?.currentVisitorConsent !== 'function') return undefined;
    const c = p.currentVisitorConsent() ?? {};
    const eff: Record<string, string> = { analytics: 'analyticsProcessingAllowed', marketing: 'marketingAllowed', preferences: 'preferencesProcessingAllowed' };
    return Object.keys(eff).filter((k) => (typeof p[eff[k]] === 'function' ? p[eff[k]]() === true : c[k] === 'yes'));
  };
  listen(document, 'visitorConsentCollected', () => {
    const g = read();
    if (g) push(g);
  });
  return read;
};
