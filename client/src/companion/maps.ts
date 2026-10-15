// Built-in maps: the banner's own ids (what each source reports as granted) -> complykit category ids.
// A site overrides the whole map for its cmp with config.companion.map. A complykit category is granted
// when ANY banner id mapped to it is granted (a site that does not use one of several ids, e.g. OneTrust's
// social-media group C0005, must not lose the category). Ids the config does not have are ignored.
// `necessary` is never mapped: the store always grants it. See each source for the id vocabulary.
import type { CompanionCmp } from '../../../src/record/consent-config-guard.js';

type Map = Record<string, string[]>;

const WP_LIKE: Map = { statistics: ['analytics'], marketing: ['advertising'], preferences: ['functional'] };

export const DEFAULT_MAPS: Record<CompanionCmp, Map> = {
  onetrust: { C0002: ['analytics'], C0003: ['functional'], C0004: ['advertising'], C0005: ['advertising'] },
  cookiebot: WP_LIKE,
  // Usercentrics' default categories are essential / functional / marketing; analytics follows marketing
  // (fail closed), and a site with a statistics / analytics category gets analytics from it.
  usercentrics: { functional: ['functional'], marketing: ['advertising', 'analytics'], statistics: ['analytics'], analytics: ['analytics'] },
  didomi: { analytics: ['analytics'], advertising: ['advertising'] },
  // TrustArc levels are cumulative (the source reports '1'..'n'): 2 = functional, 3 = advertising (+ analytics).
  trustarc: { '2': ['functional'], '3': ['advertising', 'analytics'] },
  shopify: { analytics: ['analytics'], marketing: ['advertising'], preferences: ['functional'] },
  wordpress: WP_LIKE,
  // TCF purposes: 7 measure ad performance, 8 measure content performance, 9 market research -> analytics;
  // 2 basic ads, 3 ads profile, 4 personalised ads -> advertising.
  tcf: { '7': ['analytics'], '8': ['analytics'], '9': ['analytics'], '2': ['advertising'], '3': ['advertising'], '4': ['advertising'] },
  'consent-mode': { analytics_storage: ['analytics'], ad_storage: ['advertising'] },
  manual: {},
};
