// Built-in maps: the banner's own ids (what each source reports as granted) -> complykit category ids.
// A site overrides the whole map for its cmp with config.companion.map. A complykit category is granted
// when ANY banner id mapped to it is granted (a site that does not use one of several ids, e.g. OneTrust's
// social-media group C0005, must not lose the category). Ids the config does not have are ignored.
// `necessary` is never mapped: the store always grants it. See each source for the id vocabulary.
import type { CompanionCmp } from '../../../src/record/consent-config-guard.js';

type Map = Record<string, string[]>;

// `performance` (speed / errors measurement) follows analytics wherever a banner has no separate id for it.
const WP_LIKE: Map = { statistics: ['analytics', 'performance'], marketing: ['advertising'], preferences: ['functional'] };

export const DEFAULT_MAPS: Record<CompanionCmp, Map> = {
  onetrust: { C0002: ['analytics', 'performance'], C0003: ['functional'], C0004: ['advertising'], C0005: ['advertising'] },
  cookiebot: WP_LIKE,
  // Usercentrics' default categories are essential / functional / marketing; analytics follows marketing
  // (fail closed), and a site with a statistics / analytics category gets analytics from it.
  usercentrics: { functional: ['functional'], marketing: ['advertising', 'analytics', 'performance'], statistics: ['analytics', 'performance'], analytics: ['analytics', 'performance'] },
  // Didomi / TCF have no functional vocabulary: no purpose id is a "preferences / functional" signal that
  // can be told from the site's own ids, so `functional` is unreachable here and stays at its current value
  // (companion/index.ts never revokes or sweeps it); a site that has such a purpose sets companion.map.
  didomi: { analytics: ['analytics', 'performance'], advertising: ['advertising'] },
  // TrustArc levels are cumulative (the source reports '1'..'n'): 2 = functional, 3 = advertising (+ analytics).
  trustarc: { '2': ['functional'], '3': ['advertising', 'analytics', 'performance'] },
  shopify: { analytics: ['analytics', 'performance'], marketing: ['advertising'], preferences: ['functional'] },
  wordpress: WP_LIKE,
  // TCF purposes: 7 measure ad performance, 8 measure content performance, 9 market research -> analytics;
  // 2 basic ads, 3 ads profile, 4 personalised ads -> advertising. No purpose maps to functional (see didomi).
  tcf: { '7': ['analytics', 'performance'], '8': ['analytics', 'performance'], '9': ['analytics', 'performance'], '2': ['advertising'], '3': ['advertising'], '4': ['advertising'] },
  'consent-mode': { analytics_storage: ['analytics', 'performance'], ad_storage: ['advertising'], functionality_storage: ['functional'], personalization_storage: ['functional'] },
  manual: {},
};
