# Installing on Shopify

Shopify injects tracking itself: app pixels and custom pixels from **Settings >
Customer events**, Shopify's own analytics, and everything on checkout, where theme
code does not run. The script gate cannot hold those back. Shopify gates them on its
own consent signal, the **Customer Privacy API**, so the tool writes the visitor's
choice into that signal. Your config needs `"platform": "shopify"`
([config](/guide/config)); the bridge also switches itself on if it finds
`window.Shopify` on the page.

## Install

There is no complykit Shopify app yet, so the install path is the theme.

1. In the Shopify admin open **Online Store > Themes**, then **... > Edit code** on
   the live theme. Open `layout/theme.liquid`. (Duplicate the theme first if you
   want a way back.)
2. Paste the consent tool snippet (the config element and the script) **directly
   after `<head>`**, above everything else, and in particular above
   `{{ content_for_header }}`. That tag is where Shopify injects its own scripts,
   the pixel manager and app embeds that load in the head. Anything above the tool
   can run before it does.

   ```html
   <head>
     <script type="application/json" id="complykit-config">{ … "platform": "shopify", "regimeSource": { "kind": "platform" } … }</script>
     <script src="{{ 'complykit-consent.js' | asset_url }}"></script>
     …
     {{ content_for_header }}
   ```

   Upload `complykit-consent.js` to the theme's **Assets** (or host it on your own
   domain). Do not load it from a third-party CDN: that request would happen before
   consent.
3. Repeat step 2 on any other layout that has its own `<head>` (some themes ship
   `layout/password.liquid` or alternate layouts).
4. Set Shopify's own banner as described below.
5. Mark the scripts the change list names (pasted snippets in the theme) for the
   script gate. Those are not Shopify-injected.

**App embeds.** An app embed block from a theme app extension can target the
`<head>` ([app embed blocks](https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/configuration#app-embed-blocks)),
but Shopify places it inside `content_for_header`, after other injected content,
with no ordering guarantee we could find documented. That is fine for the bridge
(it waits for the API either way) but not for the script gate or the Google
Consent Mode defaults, which must run first. When a complykit app exists it will
use an app embed; until then, `theme.liquid` is the supported path.

## Shopify's own cookie banner

In **Settings > Customer privacy > Cookie banner**, turn Shopify's banner **off**,
or set its **Regions** to none. Two banners writing the same consent signal fight,
and the visitor may be asked twice.

What happens then, and what the bridge does about it:

- Shopify treats regions where its banner does not show as allow-by-default:
  "For other regions, the default behavior is to allow all processing purposes"
  ([cookie banner guide](https://shopify.dev/themes/trust-security/cookie-banner),
  [Customer privacy settings](https://help.shopify.com/en/manual/privacy-and-security/privacy/customer-privacy-settings/privacy-settings)).
  With the banner off, that is every region.
- So, before the visitor chooses, the bridge compares what Shopify would allow with
  what our tool allows. For every purpose Shopify would allow and we do not (all of
  them under opt-in, marketing and sale of data under GPC), it records a **denial**.
  It never records a grant the visitor did not make.
- Shopify's guidance is to record consent only on a visitor interaction. Recording a
  denial without one goes against the letter of that, in the safe direction. We
  chose failing closed over letting Shopify's region default grant for the visitor.
- If the store keeps banner regions on but hides the banner some other way,
  Shopify already denies in those regions and the bridge has nothing to record
  until the visitor chooses. `ComplyKit.diagnostics.shopify.shopifyWouldAsk` is
  `shouldShowBanner()`; when it is true, check that Shopify's banner is really off.
- Whether turning the banner off also turns off the consent requirement Shopify
  applies per region is not stated in Shopify's docs. The bridge does not depend on
  the answer: it reads the effective `*Allowed()` values, not the setting.

## How the purposes map

The tool calls `Shopify.customerPrivacy.setTrackingConsent` with all four purposes
when the visitor chooses and on every change:

| Shopify purpose | True only when the tool category is granted |
|---|---|
| `analytics` | `analytics` (or `statistics`) |
| `marketing` | `advertising` (or `marketing`) |
| `preferences` | `functional` (or `preferences`, `personalization`) |
| `sale_of_data` | `advertising` (or `marketing`), **and** marketing granted, **and** no GPC |

Only the ids your config lists are used; a purpose with none of its categories
listed is always false. Override per site with
`installShopifyBridge(config, store, { map: { preferences: ['preferences'] } })`.

Before a choice, only denials are sent (above). Under an opt-out regime the tool's
defaults grant, and Shopify already allows outside its banner regions, so nothing is
sent. A store that keeps banner regions covering US visitors can pass
`pushOptOutDefaults: true` to record the defaults; it never applies under opt-in.

**Shopify never grants for us.** If Shopify's stored consent says yes where the
visitor said no (`currentVisitorConsent()`), the bridge pushes ours. It does the same
when `visitorConsentCollected` fires with a grant we did not make (for example
Shopify's banner left on), up to five times, recorded in
`ComplyKit.diagnostics.shopify.reasserted`.

## Location

Use `"regimeSource": { "kind": "platform" }` ([location](/guide/location#shopify)).
The tool reads `getRegion()` at start if the API is already loaded. Usually it is
not (our script runs first), so the visitor starts on `opt-in`. When the bridge has
loaded the API it runs the same location resolver again and moves the defaults to
the visitor's real regime, unless they have already chosen.

## Customer events pixels

Pixels added in **Settings > Customer events** run in Shopify's sandbox and follow
the consent signal through their **Customer privacy** settings
([manage custom pixels](https://help.shopify.com/en/manual/promoting-marketing/pixels/custom-pixels/manage)):

- **Permission: Required**, with the purposes the pixel actually serves (marketing,
  analytics, preferences). A pixel set to **Not required** runs whatever the visitor
  chose; the bridge cannot stop it.
- **Data sale**: set it to treat the pixel's data as a sale where it is one, so a
  `sale_of_data: false` (opt-out or GPC) stops it.

App pixels declare their own purposes ([pixel privacy](https://shopify.dev/docs/api/web-pixels-api/pixel-privacy));
an app pixel that declares none is not gated by Shopify. A scan lists each pixel's
declared purposes.

## What this cannot guarantee

- **The first page view.** The Customer Privacy API loads asynchronously
  (`loadFeatures`). Shopify does not document when the pixel manager reads consent
  relative to that, so a pixel that starts before our denial is recorded may see
  Shopify's region default for that one view. The proof scan (load the site,
  choose nothing, then reject) is what shows whether anything slipped.
- **The API not loading.** If `Shopify.customerPrivacy` does not appear within 15
  seconds the choice is **not** sent, and `ComplyKit.diagnostics.shopify.gaveUp` is
  true. Nothing is reported as compliant on that basis.
- **Checkout.** Theme code does not run on checkout. Checkout reads the consent
  Shopify stored on the storefront, which is what the bridge writes; it is not
  verified until a scan walks through checkout.
- **What Shopify itself sends while denied.** Shopify's own analytics requests are
  not documented per purpose.

## Checking it

Load a page and run `ComplyKit.diagnostics.shopify` in the console. `apiSeen` should
be true, `region` should be the visitor's region, and after a choice `lastSet` shows
what was sent. `Shopify.customerPrivacy.currentVisitorConsent()` should match it.
