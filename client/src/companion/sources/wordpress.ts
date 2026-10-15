// WordPress Consent API (the wp-consent-api plugin; banners such as Complianz, CookieYes, Borlabs set it).
// Read 2026-10-14: https://wordpress.org/plugins/wp-consent-api/ (and the plugin source cited in
// bridges/wordpress.ts, 2026-10-06).
//   - Categories: functional, preferences, statistics, statistics-anonymous, marketing.
//   - wp_has_consent(category): true when allowed (optout and no cookie yet also counts as allowed).
//   - document event `wp_listen_for_consent_change`, dispatched when a category's value changes;
//     event.detail carries { [category]: 'allow' | 'deny' }. `wp_consent_type_defined` fires on document
//     once the banner has set window.wp_consent_type (region detected late). We re-read on both.
import { listen, win, type Source } from './types.js';

const CATS = ['functional', 'preferences', 'statistics', 'statistics-anonymous', 'marketing'];

export const wordpress: Source = (push) => {
  const read = (): string[] | undefined => {
    const has = win().wp_has_consent;
    return typeof has === 'function' ? CATS.filter((c) => has(c)) : undefined;
  };
  listen(document, 'wp_listen_for_consent_change wp_consent_type_defined', () => {
    const g = read();
    if (g) push(g);
  });
  return read;
};
