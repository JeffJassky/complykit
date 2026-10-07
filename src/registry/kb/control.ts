import type { TagControl } from './schema.js';

// Control facts per vendor (plans/client-consent-design.md §2; ticket A8): how
// each tag is told the visitor's choice, whether it has a restricted mode,
// whether its install snippet fires without script, and whether it loads
// others. Data for the client adapters (D5) and the compatibility verdict
// (B1). Every fact cites the vendor documentation it was read from (researched
// 2026-10-06); where the docs show no consent call, `api` is absent — never
// invented — and the answer is "gate the load". An absent snippetLeak or
// loadsOthers means "not established", not "safe".
//
// Merged into the seed entries by id (entries.ts). Like the entries, these are
// proposals until a person confirms them.

const CM_GUIDE = 'https://developers.google.com/tag-platform/security/guides/consent';
const CM_CONCEPT = 'https://developers.google.com/tag-platform/security/concepts/consent-mode';
const CM_PINGS = 'https://support.google.com/google-ads/answer/10000067';
const GTAG_INSTALL = 'https://developers.google.com/tag-platform/gtagjs/install';
const GOOGLE_PRIVACY = 'https://developers.google.com/tag-platform/security/guides/privacy';
const GVL = 'https://vendor-list.consensu.org/v3/vendor-list.json';

const consentMode = (keys: string[]) => {
  const obj = (v: string) => `{${keys.map((k) => `${k}: '${v}'`).join(', ')}}`;
  return {
    name: 'Google Consent Mode v2',
    hold: `gtag('consent', 'default', ${obj('denied')})`,
    grant: `gtag('consent', 'update', ${obj('granted')})`,
    revoke: `gtag('consent', 'update', ${obj('denied')})`,
    afterRevoke: 'cookieless' as const,
    sources: [CM_GUIDE, CM_CONCEPT, CM_PINGS],
  };
};

/** The ~40 vendors most common on the sample sites; each must carry `control`. */
export const CONTROL_VENDOR_IDS = [
  'google.analytics',
  'google.ads.ccm',
  'google.ads.doubleclick',
  'google.tag-manager',
  'google.recaptcha',
  'google.maps',
  'google.youtube',
  'google.fonts',
  'google.services',
  'meta.pixel',
  'tiktok.pixel',
  'microsoft.uet',
  'microsoft.clarity',
  'pinterest.tag',
  'snap.pixel',
  'linkedin.insight',
  'reddit.pixel',
  'x.pixel',
  'klaviyo',
  'hubspot',
  'hotjar',
  'fullstory',
  'intercom',
  'drift',
  'zendesk',
  'elfsight',
  'judgeme',
  'yotpo',
  'vimeo',
  'paypal',
  'stripe',
  'cloudflare',
  'shopify.monorail',
  'criteo',
  'amazon.ads',
  'tradedesk',
  'magnite',
  'pubmatic',
  'indexexchange',
  'openx',
] as const;

const tcfOnly = (vendorId: number, privacy: string, disclosure: string, extra: Partial<TagControl> & { basis?: string[] } = {}): TagControl => {
  const { basis, notes, ...rest } = extra;
  return {
    tcf: { vendorId, sources: [GVL] },
    ...rest,
    notes: ['No documented JS consent call: it reads the IAB TCF string (and, where supported, GPP) from the page or the ad stack. Outside a TCF setup, gate the load.', notes].filter(Boolean).join(' '),
    sources: [GVL, privacy, disclosure, ...(basis ?? [])],
  };
};

export const CONTROL_FACTS: Record<string, TagControl> = {
  // --- Google ---------------------------------------------------------------
  'google.analytics': {
    api: consentMode(['analytics_storage']),
    restrictedMode: {
      name: 'ad personalization off / Google signals off',
      set: "gtag('set', 'allow_ad_personalization_signals', false); gtag('set', 'allow_google_signals', false)",
      sources: [GOOGLE_PRIVACY],
    },
    snippetLeak: 'none',
    loadsOthers: false,
    notes: "Advanced mode keeps sending cookieless pings while denied — requests before consent. window['ga-disable-<ID>'] = true, set before any gtag() call, stops sending entirely. Defaults must run before the tag, or they don't apply.",
    sources: [GTAG_INSTALL, GOOGLE_PRIVACY, CM_GUIDE],
  },
  'google.ads.ccm': {
    api: consentMode(['ad_storage', 'ad_user_data', 'ad_personalization']),
    restrictedMode: {
      name: 'Restricted data processing (rdp=1) / non-personalized ads (npa=1)',
      set: "gtag('config', '<TAG_ID>', {restricted_data_processing: true}); gtag('set', 'allow_ad_personalization_signals', false)",
      sources: ['https://support.google.com/google-ads/answer/9606827', 'https://support.google.com/google-ads/answer/9614122', GOOGLE_PRIVACY],
    },
    snippetLeak: 'none',
    loadsOthers: false,
    notes: "Denied ad_storage routes pings to alternative domains with IP truncated; gtag('set', 'ads_data_redaction', true) also redacts click ids.",
    sources: [GTAG_INSTALL, CM_GUIDE],
  },
  'google.ads.doubleclick': {
    api: consentMode(['ad_storage', 'ad_user_data', 'ad_personalization']),
    restrictedMode: {
      name: 'non-personalized ads (npa=1)',
      set: "gtag('set', 'allow_ad_personalization_signals', false); AdSense: (adsbygoogle = window.adsbygoogle || []).requestNonPersonalizedAds = 1",
      sources: [GOOGLE_PRIVACY, 'https://support.google.com/adsense/answer/9042142'],
    },
    snippetLeak: 'noscript-img',
    tcf: { vendorId: 755, sources: ['https://business.safety.google/tcfv2policies/', GVL] },
    notes: 'Floodlight on gtag follows Consent Mode; the Floodlight tag carries a <noscript><img> to ad.doubleclick.net. AdSense has its own pause: (adsbygoogle = window.adsbygoogle || []).pauseAdRequests = 1 until consent, = 0 after. CM360 reads the GPP US National string. Google bridges TCF to Consent Mode via window.gtag_enable_tcf_support = true.',
    sources: ['https://support.google.com/campaignmanager/answer/7554821', 'https://support.google.com/campaignmanager/answer/10031693', 'https://support.google.com/adsense/answer/9042142', 'https://developers.google.com/tag-platform/security/guides/implement-TCF-strings'],
  },
  'google.tag-manager': {
    snippetLeak: 'iframe',
    loadsOthers: true,
    notes: 'No consent of its own: it relays Consent Mode to the tags it fires. Set defaults before the container (Consent Initialization trigger, or a gtag default above the snippet). The container snippet includes <noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-…">.',
    sources: ['https://support.google.com/tagmanager/answer/14847097', 'https://developers.google.com/tag-platform/tag-manager/templates/consent-apis', 'https://developers.google.com/tag-platform/tag-manager/datalayer'],
  },
  'google.recaptcha': {
    snippetLeak: 'none',
    loadsOthers: false,
    notes: 'No consent API. Sets _GRECAPTCHA ("necessary", per Google) when executed; www.recaptcha.net can replace www.google.com. v3 is meant to load on every page — load it only where a form needs it.',
    sources: ['https://developers.google.com/recaptcha/docs/faq', 'https://developers.google.com/recaptcha/docs/v3'],
  },
  'google.maps': {
    loadsOthers: false,
    notes: 'No consent API or cookie documentation. The JS API is a script (gateable); the Embed API is a plain <iframe> (gate with a click-to-load placeholder).',
    sources: ['https://developers.google.com/maps/documentation/javascript/load-maps-js-api', 'https://developers.google.com/maps/documentation/embed/get-started'],
  },
  'google.youtube': {
    restrictedMode: {
      name: 'Privacy Enhanced Mode',
      set: 'embed from https://www.youtube-nocookie.com instead of https://www.youtube.com',
      sources: ['https://support.google.com/youtube/answer/171780'],
    },
    snippetLeak: 'iframe',
    notes: 'No consent API. Privacy Enhanced Mode limits personalization; Google does not say it sets no storage. The embed is an <iframe>: gate with a click-to-load facade.',
    sources: ['https://developers.google.com/youtube/player_parameters', 'https://support.google.com/youtube/answer/171780'],
  },
  'google.fonts': {
    loadsOthers: false,
    notes: 'No consent API. Loaded by a <link rel="stylesheet">, which type="text/plain" gating does not cover; Google says the API sets no cookies but receives IP, URL, user agent and referer. Self-host to remove the request.',
    sources: ['https://developers.google.com/fonts/faq/privacy'],
  },
  'google.services': {
    notes: 'Widgets served from google.com (e.g. merchant-review badge) document no consent call: load on interaction or after consent.',
    sources: ['https://policies.google.com/technologies/cookies'],
  },

  // --- Ad pixels ------------------------------------------------------------
  'meta.pixel': {
    api: {
      name: 'Meta Pixel consent',
      hold: "fbq('consent', 'revoke')", // before fbq('init', …)
      grant: "fbq('consent', 'grant')",
      revoke: "fbq('consent', 'revoke')",
      afterRevoke: 'stops',
      sources: ['https://developers.facebook.com/docs/meta-pixel/implementation/gdpr'],
    },
    restrictedMode: {
      name: 'Limited Data Use (LDU)',
      set: "fbq('dataProcessingOptions', ['LDU'], 0, 0) before fbq('init', …)",
      sources: ['https://developers.facebook.com/docs/marketing-apis/data-processing-options'],
    },
    snippetLeak: 'noscript-img',
    loadsOthers: false,
    notes: 'The base code carries <noscript><img src="https://www.facebook.com/tr?id=…&ev=PageView&noscript=1">.',
    sources: ['https://developers.facebook.com/docs/meta-pixel/get-started'],
  },
  'tiktok.pixel': {
    api: {
      name: 'TikTok Pixel cookie consent mode',
      hold: 'ttq.holdConsent()', // before ttq.load(…)
      grant: 'ttq.grantConsent()',
      revoke: 'ttq.revokeConsent()',
      afterRevoke: 'stops',
      sources: ['https://business-api.tiktok.com/portal/docs/pixel-cookie-consent-mode/v1.3'],
    },
    snippetLeak: 'none',
    notes: 'The base code must list holdConsent/grantConsent/revokeConsent in ttq.methods or the calls are not queued. Held events are sent on grant and dropped on revoke; revoke does not recall data already sent.',
    sources: ['https://business-api.tiktok.com/portal/docs/pixel-cookie-consent-mode/v1.3'],
  },
  'microsoft.uet': {
    api: {
      name: 'UET Consent Mode',
      hold: "window.uetq = window.uetq || []; window.uetq.push('consent', 'default', {ad_storage: 'denied'})",
      grant: "window.uetq.push('consent', 'update', {ad_storage: 'granted'})",
      revoke: "window.uetq.push('consent', 'update', {ad_storage: 'denied'})",
      afterRevoke: 'cookieless',
      sources: ['https://help.ads.microsoft.com/apex/index/3/en/60119'],
    },
    notes: 'With no default UET assumes granted. Denied: no first-party cookies, third-party cookies read only for fraud; "anonymized data" is still collected (advanced mode). Cookie _uetmsdns=1 stops sending events. Also reads TCF (vendor 1126).',
    sources: ['https://help.ads.microsoft.com/apex/index/3/en/60119', GVL],
  },
  'microsoft.clarity': {
    api: {
      name: 'Clarity Consent API v2',
      grant: "window.clarity('consentv2', {ad_Storage: 'granted', analytics_Storage: 'granted'})",
      revoke: "window.clarity('consentv2', {ad_Storage: 'denied', analytics_Storage: 'denied'})",
      afterRevoke: 'cookieless',
      sources: ['https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-consent-api-v2'],
    },
    notes: "With consent required in the project, Clarity runs in no-consent mode (a unique id per page view, no cookies) until granted — still recording. On rejection it deletes its cookies and restarts without them; window.clarity('consent', false) erases cookies.",
    sources: ['https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-consent-api-v2'],
  },
  'pinterest.tag': {
    api: {
      name: 'Pinterest tag setconsent',
      grant: "pintrk('setconsent', true)",
      revoke: "pintrk('setconsent', false)",
      afterRevoke: 'stops',
      sources: ['https://help.pinterest.com/en/business/article/install-the-base-code'],
    },
    snippetLeak: 'noscript-img',
    notes: 'false: events are not sent and first-party cookies/storage for the session are deleted. The base code carries <noscript><img src="https://ct.pinterest.com/v3/?tid=…&event=init&noscript=1">.',
    sources: ['https://help.pinterest.com/en/business/article/install-the-base-code'],
  },
  'snap.pixel': {
    notes: 'No consent call in Snap’s pixel docs (TCF vendor 27 per third-party CMP docs, unconfirmed): gate the load. Install snippet not verified (help pages render client-side).',
    sources: ['https://businesshelp.snapchat.com/s/article/pixel-website-install'],
  },
  'linkedin.insight': {
    notes: 'No consent API in LinkedIn’s Insight Tag docs: gate the load. The Campaign Manager tag is commonly reproduced with a <noscript><img> to px.ads.linkedin.com — not verified against LinkedIn’s own pages (sign-in required), so snippetLeak is left unset.',
    sources: ['https://www.linkedin.com/help/lms/answer/a427660', 'https://www.linkedin.com/help/lms/answer/a418880'],
  },
  'reddit.pixel': {
    notes: "No consent API documented: gate the load. The base code's rdt('init', id, {optOut}) option is not documented as consent. Snippet not verified.",
    sources: ['https://business.reddithelp.com/s/article/Reddit-Pixel'],
  },
  'x.pixel': {
    notes: 'No consent API documented: gate the load. Snippet not verified (docs not readable without an account).',
    sources: ['https://business.x.com/en/help/campaign-measurement-and-analytics/conversion-tracking-for-websites'],
  },

  // --- Marketing / recording / chat ----------------------------------------
  klaviyo: {
    snippetLeak: 'none',
    notes: 'No JS consent API. The cookie __kla_off=true toggles onsite tracking off (an opt-out flag); Klaviyo advises blocking static-tracking.klaviyo.com to stop all tracking. On Shopify it honours the Customer Privacy API.',
    sources: ['https://help.klaviyo.com/hc/en-us/articles/360034666712-Understanding-cookies-in-Klaviyo', 'https://help.klaviyo.com/hc/en-us/articles/360020342232'],
  },
  hubspot: {
    api: {
      name: 'HubSpot cookie consent (_hsp)',
      grant: "window._hsp = window._hsp || []; window._hsp.push(['setHubSpotConsent', {analytics: true, advertisement: true, functionality: true}])",
      revoke: "window._hsp.push(['revokeCookieConsent'])",
      afterRevoke: 'stops-storage',
      sources: ['https://developers.hubspot.com/docs/api/events/cookie-banner'],
    },
    snippetLeak: 'none',
    loadsOthers: true,
    notes: "Before consent (opt-in policy) the code runs without cookies and still records anonymized page views. _hsq.push(['doNotTrack']) stops all collection. Ad pixels installed through HubSpot Ads load wherever the tracking code is.",
    sources: ['https://developers.hubspot.com/docs/api/events/tracking-code', 'https://knowledge.hubspot.com/ads/install-pixels-from-external-ad-networks'],
  },
  hotjar: {
    notes: 'No consent call in Hotjar’s official docs (hj optIn/optOut appear only in third-party blogs): gate the load.',
    sources: ['https://help.hotjar.com/hc/en-us/articles/115011789248-Hotjar-Cookie-Information'],
  },
  fullstory: {
    api: {
      name: 'FullStory capture start/shutdown',
      hold: "window['_fs_capture_on_startup'] = false",
      grant: "FS('start')",
      revoke: "FS('shutdown')",
      afterRevoke: 'stops',
      sources: ['https://developer.fullstory.com/browser/fullcapture/capture-data/'],
    },
    notes: "shutdown does not persist across page loads: keep the hold on every page. FS('setIdentity', {consent}) is element-level consent only, not a global switch.",
    sources: ['https://developer.fullstory.com/browser/fullcapture/capture-data/', 'https://developer.fullstory.com/browser/fullcapture/user-consent/'],
  },
  intercom: {
    api: {
      name: 'Messenger disabled flag + boot/shutdown',
      hold: "window.intercomSettings = {app_id: '<APP_ID>', disabled: true}",
      grant: "window.Intercom('boot', {app_id: '<APP_ID>', disabled: false})",
      revoke: "window.Intercom('shutdown')",
      afterRevoke: 'unknown',
      sources: ['https://www.intercom.com/help/en/articles/2361922-intercom-messenger-cookies'],
    },
    notes: 'disabled: "No cookies will be used" and the Messenger is hidden. shutdown clears the session cookie; Intercom frames it as logout, not consent withdrawal.',
    sources: ['https://www.intercom.com/help/en/articles/2361922-intercom-messenger-cookies'],
  },
  drift: {
    notes: 'No consent API: loading the widget always sets cookies. Drift documents delaying drift.load() until consent, or a facade.',
    sources: ['https://devdocs.drift.com/docs/using-a-drift-facade-with-a-cookie-manager'],
  },
  zendesk: {
    api: {
      name: 'Messaging Web Widget cookies setting',
      grant: "zE('messenger:set', 'cookies', 'all')",
      revoke: "zE('messenger:set', 'cookies', 'none')",
      afterRevoke: 'stops',
      sources: ['https://developer.zendesk.com/api-reference/widget-messaging/web/core'],
    },
    restrictedMode: {
      name: 'functional cookies only',
      set: "zE('messenger:set', 'cookies', 'functional')",
      sources: ['https://developer.zendesk.com/api-reference/widget-messaging/web/core'],
    },
    notes: "'none' hides the widget and deletes its local/session storage. Messaging widget only; the Classic widget is not covered.",
    sources: ['https://developer.zendesk.com/api-reference/widget-messaging/web/core'],
  },

  // --- Reviews / widgets / embeds ------------------------------------------
  elfsight: {
    loadsOthers: true,
    notes: 'No consent API. Facebook Feed, YouTube Gallery and Tumblr widgets may set those platforms’ cookies (Elfsight cannot disable them); the Google Maps widget loads Google Fonts. Its own cookie is disabled only via Elfsight support, account-wide.',
    sources: ['https://help.elfsight.com/article/418-elfsight-and-gdpr'],
  },
  judgeme: {
    notes: 'No storefront consent API or cookie documentation found. Installed as a Shopify app/theme embed rather than a pasted snippet.',
    sources: ['https://judge.me/help/en/articles/8364277-gdpr-compliance'],
  },
  yotpo: {
    notes: 'No consent API. Reviews-widget cookies can be disabled account-wide only by Yotpo support (not self-serve, not per visitor).',
    sources: ['https://support.yotpo.com/docs/how-to-disable-cookie-collection-for-yotpo-reviews-widgets'],
  },
  vimeo: {
    restrictedMode: {
      name: 'Do Not Track player parameter',
      set: 'dnt=1 on the player URL (data-vimeo-dnt / the dnt Player SDK option)',
      sources: ['https://help.vimeo.com/hc/en-us/articles/12426260232977-Player-parameters-overview'],
    },
    snippetLeak: 'iframe',
    loadsOthers: false,
    notes: 'No consent API: dnt is fixed at load ("blocks the player from collecting session data and analytics"; essential cookies remain). With dnt only player_clearance, cf_clearance, _cf_bm and _cfuvid are set. The embed is an <iframe>: gate with a facade.',
    sources: ['https://help.vimeo.com/hc/en-us/articles/12426260232977-Player-parameters-overview', 'https://help.vimeo.com/hc/en-us/articles/26080940921361-Vimeo-Player-Cookies'],
  },

  // --- Payments / infrastructure / platform --------------------------------
  paypal: {
    snippetLeak: 'none',
    loadsOthers: false,
    notes: 'No consent setting in the JS SDK or Pay Later messaging. The separate FraudNet snippet (c.paypal.com) carries a <noscript><img>.',
    sources: ['https://developer.paypal.com/sdk/js/configuration/', 'https://developer.paypal.com/platforms/checkout/apm/pay-upon-invoice/fraudnet.md'],
  },
  stripe: {
    restrictedMode: {
      name: 'advanced fraud signals off',
      set: "https://js.stripe.com/…/stripe.js?advancedFraudSignals=false, or loadStripe.setLoadParameters({advancedFraudSignals: false}) from '@stripe/stripe-js/pure'",
      sources: ['https://docs.stripe.com/disputes/prevention/advanced-fraud-detection', 'https://github.com/stripe/stripe-js'],
    },
    snippetLeak: 'none',
    loadsOthers: true,
    notes: 'No runtime consent API; the opt-out is load-time only and stops m.stripe.com fraud signals, not field-interaction events. Stripe.js may load hCaptcha.',
    sources: ['https://docs.stripe.com/disputes/prevention/advanced-fraud-detection'],
  },
  cloudflare: {
    loadsOthers: false,
    notes: 'Bot-management cookies (__cf_bm, cf_clearance) are set at the edge and called strictly necessary — no page control. The Web Analytics beacon documents no client state and no consent control. Zaraz (a separate tag manager) has its own consent API: zaraz.consent.set({purpose: bool}).',
    sources: ['https://developers.cloudflare.com/fundamentals/reference/policies-compliances/cloudflare-cookies/', 'https://developers.cloudflare.com/web-analytics/data-metrics/data-origin-and-collection/', 'https://developers.cloudflare.com/zaraz/consent-management/api/'],
  },
  'shopify.monorail': {
    api: {
      name: 'Shopify Customer Privacy API',
      grant: 'window.Shopify.customerPrivacy.setTrackingConsent({analytics: true, marketing: true, preferences: true, sale_of_data: true}, () => {})',
      revoke: 'window.Shopify.customerPrivacy.setTrackingConsent({analytics: false, marketing: false, preferences: false, sale_of_data: false}, () => {})',
      afterRevoke: 'unknown',
      sources: ['https://shopify.dev/docs/api/customer-privacy'],
    },
    loadsOthers: true,
    platform: 'shopify',
    notes: "Load the API first: window.Shopify.loadFeatures([{name: 'consent-tracking-api', version: '0.1'}], cb). In regions set to require consent, non-essential purposes are off until granted. The pixel manager loads a web pixel only with the permissions it declares. What Monorail sends while denied is undocumented.",
    sources: ['https://shopify.dev/docs/api/customer-privacy', 'https://shopify.dev/docs/apps/build/marketing-analytics/pixels', 'https://shopify.dev/docs/api/web-pixels-api/pixel-privacy'],
  },

  // --- Ad tech: TCF only ----------------------------------------------------
  criteo: tcfOnly(91, 'https://www.criteo.com/privacy/', 'https://privacy.criteo.com/iab-europe/tcfv2/disclosure.json', {
    notes: 'Criteo: in TCF mode the choices are "enforced by Criteo"; otherwise trigger OneTag only after consent.',
    basis: ['https://help.criteo.com/kb/guide/en/transparency-and-consent-framework-bbFLejr6XZ/Steps/1842462'],
  }),
  'amazon.ads': tcfOnly(793, 'https://www.amazon.co.uk/gp/help/customer/display.html?nodeId=201909010', 'https://m.media-amazon.com/images/G/01/adprefs/deviceStorageDisclosure.json', {
    notes: 'Amazon also accepts its own Amazon Consent Signal (amzn_user_data / amzn_ad_storage = GRANTED|DENIED) or GPP; one signal suffices and TCF wins when several are present. The page-side call (amzn-consent.js) is not documented in prose, so it is not recorded as an api.',
    basis: ['https://advertising.amazon.com/resources/ad-policy/consent-signal-requirements'],
  }),
  tradedesk: tcfOnly(21, 'https://www.thetradedesk.com/us/privacy', 'https://ttd-misc-public-assets.s3.us-west-2.amazonaws.com/deviceStorageDisclosureURL.json'),
  magnite: tcfOnly(52, 'https://www.magnite.com/legal/advertising-technology-privacy-policy/', 'https://gdpr.rubiconproject.com/dvplus/devicestoragedisclosure.json', {
    loadsOthers: true,
    notes: 'An exchange: user syncs to partners.',
    basis: ['https://docs.prebid.org/dev-docs/bidders/rubicon.html'],
  }),
  pubmatic: tcfOnly(76, 'https://pubmatic.com/legal/privacy/', 'https://cdn.pubmatic.com/devicestorage.json', {
    loadsOthers: true,
    notes: 'An exchange: iframe user syncs with DSPs (per-DSP KRTBCOOKIE_* cookies).',
    basis: ['https://docs.prebid.org/dev-docs/bidders/pubmatic.html'],
  }),
  indexexchange: tcfOnly(10, 'https://www.indexexchange.com/privacy', 'https://cdn.indexexchange.com/device_storage_disclosure.json', {
    loadsOthers: true,
    notes: 'An exchange: iframe/image user syncs; its wrapper runs ID partners.',
    basis: ['https://docs.prebid.org/dev-docs/bidders/ix.html'],
  }),
  openx: tcfOnly(69, 'https://www.openx.com/privacy-center/openx-ad-exchange-privacy-policy/', 'https://www.openx.com/device-storage.json', {
    loadsOthers: true,
    notes: 'An exchange: iframe user syncs with DSPs.',
    basis: ['https://docs.prebid.org/dev-docs/bidders/openx.html'],
  }),
};
