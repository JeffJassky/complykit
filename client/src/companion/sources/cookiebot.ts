// Cookiebot (Usercentrics). Read 2026-10-14: https://usercentrics.com/docs/web/cookiebot/cookiebot-sdk
//   - Cookiebot.consent: { necessary, preferences, statistics, marketing } booleans (read-only), plus
//     consent.method 'implied' | 'explicit' (null without consent). Cookiebot.consented / declined /
//     hasResponse are on Cookiebot itself.
//   - Events on window: CookiebotOnConsentReady ("consent state is ready, from a fresh submission or an
//     existing cookie"), CookiebotOnAccept and CookiebotOnDecline (also on visits where the visitor had
//     already accepted / declined), CookiebotOnLoad.
// Before the visitor answers, consent holds the defaults (only necessary true): that is the real state,
// so "Cookiebot.consent exists" is what counts as ready.
import { listen, win, type Source } from './types.js';

export const cookiebot: Source = (push) => {
  const read = (): string[] | undefined => {
    const c = win().Cookiebot?.consent;
    return c && typeof c === 'object' ? Object.keys(c).filter((k) => c[k] === true) : undefined;
  };
  listen(window, 'CookiebotOnConsentReady CookiebotOnAccept CookiebotOnDecline CookiebotOnLoad', () => {
    const g = read();
    if (g) push(g);
  });
  return read;
};
