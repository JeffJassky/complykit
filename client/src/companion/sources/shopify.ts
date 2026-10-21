// Shopify Customer Privacy API (Shopify's own cookie banner, or an app using the same API).
// Read 2026-10-06 and cited in full in bridges/shopify.ts; rechecked 2026-10-14: https://shopify.dev/docs/api/customer-privacy
//   - window.Shopify.customerPrivacy.currentVisitorConsent() -> { analytics, marketing, preferences,
//     sale_of_data } each 'yes' | 'no' | '' (undeclared).
//   - analyticsProcessingAllowed(), marketingAllowed(), preferencesProcessingAllowed(): the effective answer,
//     region default included ("for regions requiring consent ... not allowed until consent is given; for
//     other regions the default is to allow"). Preferred when present: it is what Shopify itself enforces.
//   - saleOfDataAllowed(): the sale/sharing opt-out (US opt-out page or GPC). Shopify's own app pixels that declare
//     SALE_OF_DATA stop on it, so a refused sale is a refused advertising category here too (marketing alone stays 'yes').
//   - document event 'visitorConsentCollected', detail {analyticsAllowed, marketingAllowed,
//     preferencesAllowed, saleOfDataAllowed}; "published only when consent changes", so we re-read.
//   - The API exists only once something calls Shopify.loadFeatures([{name: 'consent-tracking-api', version: '0.1'}], cb)
//     ("When invoked without an error, the API is globally available at window.Shopify.customerPrivacy"). Shopify's banner
//     does not expose it on its own, so the add-on asks for it once (as bridges/shopify.ts does) and reads in the callback.
import { listen, win, type Source } from './types.js';

export const shopify: Source = (push) => {
  let requested = false;
  const read = (): string[] | undefined => {
    const s = win().Shopify;
    const p = s?.customerPrivacy;
    if (typeof p?.currentVisitorConsent !== 'function') {
      if (!requested && typeof s?.loadFeatures === 'function') {
        requested = true;
        try {
          s.loadFeatures([{ name: 'consent-tracking-api', version: '0.1' }], () => {
            const g = read();
            if (g) push(g);
          });
        } catch {
          // A throwing loader leaves the poll to find the API if something else loads it.
        }
      }
      return undefined;
    }
    const c = p.currentVisitorConsent() ?? {};
    const eff: Record<string, string> = { analytics: 'analyticsProcessingAllowed', marketing: 'marketingAllowed', preferences: 'preferencesProcessingAllowed' };
    // Advertising also needs the sale of data not refused: effective function when present, else sale_of_data !== 'no'.
    const saleOk = typeof p.saleOfDataAllowed === 'function' ? p.saleOfDataAllowed() === true : c.sale_of_data !== 'no';
    return Object.keys(eff).filter((k) => (typeof p[eff[k]] === 'function' ? p[eff[k]]() === true : c[k] === 'yes') && (k !== 'marketing' || saleOk));
  };
  listen(document, 'visitorConsentCollected', () => {
    const g = read();
    if (g) push(g);
  });
  return read;
};
