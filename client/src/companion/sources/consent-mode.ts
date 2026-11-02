// Google Consent Mode, read from the data layer. Read 2026-10-14:
// https://developers.google.com/tag-platform/security/guides/consent
//   - A site (or its banner) calls gtag('consent', 'default' | 'update', { analytics_storage, ad_storage,
//     ad_user_data, ad_personalization, ... }) with values 'granted' | 'denied'. gtag() pushes its
//     `arguments` object on window.dataLayer, so each command is an array-like ['consent', command, {...}].
//   - The current state is the default merged with every later update, in order.
// We read the entries already in the data layer, then wrap dataLayer.push to see later ones (GTM, loading
// afterwards, keeps calling the push it finds). Waits until a consent command exists. ad_user_data and
// ad_personalization are not mapped by default (only ad_storage and analytics_storage).
// Answered: an `update` command has been seen (a CMP's live answer or its restored one); a `default` never is,
// and without an update the source cannot tell (undefined: the page's first state is not recorded).
import { win, type Read, type Source } from './types.js';

export const consentMode: Source = (push) => {
  const w = win();
  const state: Record<string, string> = {};
  let seen = false;
  let updated = false;
  const take = (e: any): boolean => {
    if (e && e[0] === 'consent' && (e[1] === 'default' || e[1] === 'update') && e[2] && typeof e[2] === 'object') {
      Object.assign(state, e[2]);
      if (e[1] === 'update') updated = true;
      return (seen = true);
    }
    return false;
  };
  const granted = (): Read => ({ granted: Object.keys(state).filter((k) => state[k] === 'granted'), answered: updated || undefined });
  const dl: any[] = (w.dataLayer = w.dataLayer || []);
  for (const e of Array.from(dl)) take(e);
  const orig = dl.push;
  dl.push = function (this: unknown, ...a: unknown[]) {
    const r = orig.apply(this, a as any);
    if (a.map(take).some(Boolean)) push(granted());
    return r;
  };
  return () => (seen ? granted() : undefined);
};
