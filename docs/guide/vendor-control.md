# How each vendor is controlled

A tracker can be held back three ways, in order of reliability
(design §2): **gate the load** (`<script type="text/plain">`, then a fresh
`<script>` on consent), **call the vendor's consent API**, or **delete its
cookies afterwards** (cleanup, not control). Gating works for every tag that
arrives as a script, so the knowledge base doesn't record it. What it records
per vendor, in each entry's `control` field, is what varies:

| Field | Meaning |
|---|---|
| `api` | The vendor's documented runtime consent call: `hold` (run before the tag loads so it starts denied), `grant`, `revoke`, and `afterRevoke` — what the running tag does once denied: `stops`, `cookieless` (keeps sending pings without its identifiers — still requests before consent), `stops-storage` (stops its cookies, requests may continue) or `unknown`. **Absent means the vendor documents no consent API**: gate the load. |
| `restrictedMode` | A restricted / limited data mode (Google `rdp`, Meta LDU) and how to turn it on. |
| `snippetLeak` | Markup in the official install snippet that fires without script, so `type="text/plain"` does not hold it: `noscript-img` (a `<noscript><img>` pixel) or `iframe` (GTM's `<noscript><iframe>`, or an embed that *is* an iframe). `none`: the snippet has no such fallback. |
| `loadsOthers` | Its script loads other vendors (a tag manager, a widget platform, an exchange syncing to partners): gating it gates them, and each needs its own control. |
| `platform` | Part of a platform (e.g. Shopify): site code can't gate it; only the platform's consent API controls it. |
| `tcf` | The IAB TCF vendor id, for vendors whose only consent signal is the TCF (or GPP) string. |
| `sources` | The vendor documentation each fact was read from. Every fact cites one. |

An unset `snippetLeak` or `loadsOthers` means **not established** — the vendor
docs we could read didn't show it — never "safe".

These are seed **proposals** (researched 2026-10-06 from the vendors' own
docs), like every seed entry, until a person confirms them. The full data,
including notes and every source URL, is in
[`src/registry/kb/control.ts`](https://github.com/JeffJassky/complykit/blob/main/src/registry/kb/control.ts).

## Things worth knowing before reading the table

- **A consent API is not a substitute for gating where opt-in applies.**
  Google Consent Mode (advanced), Microsoft UET and Clarity keep sending
  cookieless pings while denied. Those are requests before consent. For opt-in
  locations: gate the load *and* call the API.
- **Revoking can't unload a running script.** Even `stops` means "stops
  sending from now"; data already sent stays sent (TikTok says so explicitly).
  Honest withdrawal is: record it, call `revoke`, delete reachable first-party
  cookies, keep the tag gated from the next page load on.
- **Some "APIs" are load-time only.** Vimeo `dnt=1`, Stripe
  `advancedFraudSignals=false` and YouTube's `youtube-nocookie.com` are fixed
  when the embed or script loads, so they're recorded as restricted modes, not
  APIs.
- **`<noscript>` and `<iframe>` leaks** have to be removed from the page or
  replaced with a click-to-load placeholder; a script gate doesn't touch them.
  Google Fonts arrives by `<link rel="stylesheet">`, which a script gate doesn't
  cover either: self-host.
- **Ad-tech exchanges** (Criteo, Amazon, The Trade Desk, Magnite, PubMatic,
  Index Exchange, OpenX) take no JS consent call; they read the TCF / GPP
  string. Without a TCF setup, gate the load.

## Per vendor

| Vendor | Consent API (grant / revoke) | After revoke | Restricted mode | Snippet leak | Loads others |
|---|---|---|---|---|---|
| [Google Analytics 4](https://developers.google.com/tag-platform/security/guides/consent) `google.analytics` | Google Consent Mode v2: `gtag('consent', 'update', {analytics_storage: 'granted'})` / `gtag('consent', 'update', {analytics_storage: 'denied'})` | cookieless | ad personalization off / Google signals off | none | no |
| [Google Ads (conversion / remarketing)](https://developers.google.com/tag-platform/security/guides/consent) `google.ads.ccm` | Google Consent Mode v2: `gtag('consent', 'update', {ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted'})` / `gtag('consent', 'update', {ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied'})` | cookieless | Restricted data processing (rdp=1) / non-personalized ads (npa=1) | none | no |
| [Google Marketing Platform (DoubleClick)](https://developers.google.com/tag-platform/security/guides/consent) `google.ads.doubleclick` | Google Consent Mode v2: `gtag('consent', 'update', {ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted'})` / `gtag('consent', 'update', {ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied'})` | cookieless | non-personalized ads (npa=1) | noscript-img | not established |
| [Google Tag Manager / gtag.js](https://support.google.com/tagmanager/answer/14847097) `google.tag-manager` | none — gate the load | — | — | iframe | yes |
| [Google reCAPTCHA](https://developers.google.com/recaptcha/docs/faq) `google.recaptcha` | none — gate the load | — | — | none | no |
| [Google Maps](https://developers.google.com/maps/documentation/javascript/load-maps-js-api) `google.maps` | none — gate the load | — | — | not established | no |
| [YouTube embed](https://developers.google.com/youtube/player_parameters) `google.youtube` | none — gate the load | — | Privacy Enhanced Mode | iframe | not established |
| [Google Fonts](https://developers.google.com/fonts/faq/privacy) `google.fonts` | none — gate the load | — | — | not established | no |
| [Google (google.com services)](https://policies.google.com/technologies/cookies) `google.services` | none — gate the load | — | — | not established | not established |
| [Meta Pixel](https://developers.facebook.com/docs/meta-pixel/implementation/gdpr) `meta.pixel` | Meta Pixel consent: `fbq('consent', 'grant')` / `fbq('consent', 'revoke')` | stops | Limited Data Use (LDU) | noscript-img | no |
| [TikTok Pixel](https://business-api.tiktok.com/portal/docs/pixel-cookie-consent-mode/v1.3) `tiktok.pixel` | TikTok Pixel cookie consent mode: `ttq.grantConsent()` / `ttq.revokeConsent()` | stops | — | none | not established |
| [Microsoft Advertising UET](https://help.ads.microsoft.com/apex/index/3/en/60119) `microsoft.uet` | UET Consent Mode: `window.uetq.push('consent', 'update', {ad_storage: 'granted'})` / `window.uetq.push('consent', 'update', {ad_storage: 'denied'})` | cookieless | — | not established | not established |
| [Microsoft Clarity](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-consent-api-v2) `microsoft.clarity` | Clarity Consent API v2: `window.clarity('consentv2', {ad_Storage: 'granted', analytics_Storage: 'granted'})` / `window.clarity('consentv2', {ad_Storage: 'denied', analytics_Storage: 'denied'})` | cookieless | — | not established | not established |
| [Pinterest Tag](https://help.pinterest.com/en/business/article/install-the-base-code) `pinterest.tag` | Pinterest tag setconsent: `pintrk('setconsent', true)` / `pintrk('setconsent', false)` | stops | — | noscript-img | not established |
| [Snap Pixel](https://businesshelp.snapchat.com/s/article/pixel-website-install) `snap.pixel` | none — gate the load | — | — | not established | not established |
| [LinkedIn Insight Tag](https://www.linkedin.com/help/lms/answer/a427660) `linkedin.insight` | none — gate the load | — | — | not established | not established |
| [Reddit Pixel](https://business.reddithelp.com/s/article/Reddit-Pixel) `reddit.pixel` | none — gate the load | — | — | not established | not established |
| [X (Twitter) Pixel](https://business.x.com/en/help/campaign-measurement-and-analytics/conversion-tracking-for-websites) `x.pixel` | none — gate the load | — | — | not established | not established |
| [Klaviyo](https://help.klaviyo.com/hc/en-us/articles/360034666712-Understanding-cookies-in-Klaviyo) `klaviyo` | none — gate the load | — | — | none | not established |
| [HubSpot](https://developers.hubspot.com/docs/api/events/cookie-banner) `hubspot` | HubSpot cookie consent (_hsp): `window._hsp = window._hsp \|\| []; window._hsp.push(['setHubSpotConsent', {analytics: true, advertisement: true, functionality: true}])` / `window._hsp.push(['revokeCookieConsent'])` | stops-storage | — | none | yes |
| [Hotjar](https://help.hotjar.com/hc/en-us/articles/115011789248-Hotjar-Cookie-Information) `hotjar` | none — gate the load | — | — | not established | not established |
| [FullStory](https://developer.fullstory.com/browser/fullcapture/capture-data/) `fullstory` | FullStory capture start/shutdown: `FS('start')` / `FS('shutdown')` | stops | — | not established | not established |
| [Intercom](https://www.intercom.com/help/en/articles/2361922-intercom-messenger-cookies) `intercom` | Messenger disabled flag + boot/shutdown: `window.Intercom('boot', {app_id: '<APP_ID>', disabled: false})` / `window.Intercom('shutdown')` | unknown | — | not established | not established |
| [Drift](https://devdocs.drift.com/docs/using-a-drift-facade-with-a-cookie-manager) `drift` | none — gate the load | — | — | not established | not established |
| [Zendesk](https://developer.zendesk.com/api-reference/widget-messaging/web/core) `zendesk` | Messaging Web Widget cookies setting: `zE('messenger:set', 'cookies', 'all')` / `zE('messenger:set', 'cookies', 'none')` | stops | functional cookies only | not established | not established |
| [Elfsight widgets](https://help.elfsight.com/article/418-elfsight-and-gdpr) `elfsight` | none — gate the load | — | — | not established | yes |
| [Judge.me reviews](https://judge.me/help/en/articles/8364277-gdpr-compliance) `judgeme` | none — gate the load | — | — | not established | not established |
| [Yotpo](https://support.yotpo.com/docs/how-to-disable-cookie-collection-for-yotpo-reviews-widgets) `yotpo` | none — gate the load | — | — | not established | not established |
| [Vimeo embed](https://help.vimeo.com/hc/en-us/articles/12426260232977-Player-parameters-overview) `vimeo` | none — gate the load | — | Do Not Track player parameter | iframe | no |
| [PayPal](https://developer.paypal.com/sdk/js/configuration/) `paypal` | none — gate the load | — | — | none | no |
| [Stripe](https://docs.stripe.com/disputes/prevention/advanced-fraud-detection) `stripe` | none — gate the load | — | advanced fraud signals off | none | yes |
| [Cloudflare](https://developers.cloudflare.com/fundamentals/reference/policies-compliances/cloudflare-cookies/) `cloudflare` | none — gate the load | — | — | not established | no |
| [Shopify analytics (Monorail)](https://shopify.dev/docs/api/customer-privacy) `shopify.monorail` | Shopify Customer Privacy API: `window.Shopify.customerPrivacy.setTrackingConsent({analytics: true, marketing: true, preferences: true, sale_of_data: true}, () => {})` / `window.Shopify.customerPrivacy.setTrackingConsent({analytics: false, marketing: false, preferences: false, sale_of_data: false}, () => {})` | unknown | — | not established | yes (platform: shopify) |
| [Criteo](https://vendor-list.consensu.org/v3/vendor-list.json) `criteo` | none — TCF only (vendor 91) | — | — | not established | not established |
| [Amazon Advertising](https://vendor-list.consensu.org/v3/vendor-list.json) `amazon.ads` | none — TCF only (vendor 793) | — | — | not established | not established |
| [The Trade Desk](https://vendor-list.consensu.org/v3/vendor-list.json) `tradedesk` | none — TCF only (vendor 21) | — | — | not established | not established |
| [Magnite (Rubicon Project)](https://vendor-list.consensu.org/v3/vendor-list.json) `magnite` | none — TCF only (vendor 52) | — | — | not established | yes |
| [PubMatic](https://vendor-list.consensu.org/v3/vendor-list.json) `pubmatic` | none — TCF only (vendor 76) | — | — | not established | yes |
| [Index Exchange](https://vendor-list.consensu.org/v3/vendor-list.json) `indexexchange` | none — TCF only (vendor 10) | — | — | not established | yes |
| [OpenX](https://vendor-list.consensu.org/v3/vendor-list.json) `openx` | none — TCF only (vendor 69) | — | — | not established | yes |
