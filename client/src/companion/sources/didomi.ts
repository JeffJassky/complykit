// Didomi. Read 2026-10-14:
//   - Didomi.getCurrentUserStatus(): { vendors, purposes, regulation, user_id, created, updated, ... };
//     purposes is keyed by purpose id, each entry has a boolean `enabled` (the computed global status;
//     essential purposes are enabled). https://developers.didomi.io/cmp/web-sdk/reference/api
//   - Readiness: window.didomiOnReady = window.didomiOnReady || []; push(fn) (runs after the SDK is
//     initialised). Events: window.didomiEventListeners.push({event:'consent.changed', listener}) before
//     the SDK loads, or Didomi.on('consent.changed', fn) from inside didomiOnReady.
//     https://developers.didomi.io/cmp/web-sdk/reference/events
//   - Purpose ids are the site's own (the docs name measure_content_performance, create_ads_profile and
//     select_personalized_ads as examples; there is no fixed list), so besides every enabled raw id the
//     source reports 'analytics' for ids matching measure/analytic/statistic and 'advertising' for ids
//     matching ads/advertis/personali/marketing. A site with other ids sets companion.map.
import { win, type Source } from './types.js';

const ANALYTICS = /measure|analytic|statistic/i;
const ADVERTISING = /(^|_)ads?(_|$)|advertis|personali|marketing/i;

export const didomi: Source = (push) => {
  const w = win();
  const read = (): string[] | undefined => {
    const p = w.Didomi?.getCurrentUserStatus?.()?.purposes;
    if (!p || typeof p !== 'object') return undefined;
    const on = Object.keys(p).filter((k) => p[k]?.enabled === true);
    return [...on, ...(on.some((k) => ANALYTICS.test(k)) ? ['analytics'] : []), ...(on.some((k) => ADVERTISING.test(k)) ? ['advertising'] : [])];
  };
  const fire = (): void => {
    const g = read();
    if (g) push(g);
  };
  (w.didomiEventListeners = w.didomiEventListeners || []).push({ event: 'consent.changed', listener: fire });
  (w.didomiOnReady = w.didomiOnReady || []).push(fire);
  return read;
};
