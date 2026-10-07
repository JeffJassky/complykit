# Installing on WordPress

On WordPress the consent tool talks to the **WP Consent API**, the standard
that plugins such as WooCommerce, Site Kit and many analytics and marketing
plugins read to decide whether they may track. With the bridge on, those
plugins follow the choice made in our banner.

You need:

1. The [WP Consent API plugin](https://wordpress.org/plugins/wp-consent-api/)
   installed and active. It provides `wp_set_consent`, `wp_has_consent` and the
   consent cookies that other plugins read. Without it the bridge has nothing
   to talk to and does nothing.
2. The consent tool loaded **first** in the page head, with the inline config.
3. `"platform": "wordpress"` in the config (the generator sets it when you pick
   WordPress). The bridge also switches on by itself if `wp_set_consent`
   already exists on the page.

The bridge only informs other plugins. It does not stop a plugin that ignores
the WP Consent API. For those, use a gated script or see
[how each vendor is controlled](/guide/vendor-control).

## What the bridge does

- **Consent type.** Sets `window.wp_consent_type` from the visitor's regime:
  `opt-in` becomes `'optin'`; `opt-out-signal` and `opt-out` become `'optout'`.
  The WP Consent API expects the banner to set this value; its own plugin
  setting is only a fallback (`wp_fallback_consent_type`) that plugins use when
  the banner sets nothing. Setting it from our regime means the banner and the
  plugins apply the same rule. It fires `wp_consent_type_defined` when the
  value changes.
- **Our choice to WordPress.** On start and after every change (accept, reject,
  settings, withdrawal) it calls `wp_set_consent(category, 'allow' | 'deny')`.
  If several of your categories map to one WP category, it is `allow` only when
  **all** of them are granted.
- **WordPress to our choice, deny only.** When a plugin changes consent
  (`wp_listen_for_consent_change`), a `deny` is reflected into our store: the
  mapped categories become denied and that is recorded as the visitor's choice.
  An `allow` is **ignored**. A plugin never grants consent for the visitor;
  only the visitor's own choice in our banner can.

## Category mapping

| Our category id | WP Consent API category |
| --- | --- |
| `necessary`, `functional` | `functional` |
| `preferences`, `personalization` | `preferences` |
| `analytics`, `statistics` | `statistics` |
| `analytics-anonymous`, `statistics-anonymous` | `statistics-anonymous` |
| `marketing`, `advertising` | `marketing` |

`statistics-anonymous` is for first-party, non-identifying analytics only; map a
category to it only when that is true of the tools behind it. A category id
that is not in the table is not mirrored. Override the table before the tool loads:

```html
<script>
  window.ComplyKitWordPressMapping = {
    analytics: 'statistics-anonymous', // a cookieless analytics setup
    chat: 'functional',
    ads: ['marketing', 'statistics']   // one id may map to several
  };
</script>
```

## Install

Put this in a must-use plugin (`wp-content/mu-plugins/complykit-consent.php`) so
a theme change cannot remove it. The same `add_action` body works in a theme's
`functions.php`.

```php
<?php
// Load the consent tool first, synchronously, with the inline config.
add_action('wp_head', function () {
  $config = file_get_contents(__DIR__ . '/complykit-config.json'); // the generated config
  echo '<script type="application/json" id="complykit-config">' . $config . '</script>';
  echo '<script src="https://YOUR-HOST/complykit-consent.js"></script>';
}, 0); // priority 0: before every other script printed in the head
```

Then check:

- The tool's script comes before scripts from other plugins in the page source.
  Caching and "defer/combine JavaScript" plugins can reorder or delay it; exclude
  the tool from them. Loading late means other scripts run before the defaults
  are set.
- With the tool's `<script>` first, the WP Consent API plugin's scripts load
  after it. The bridge waits up to ten seconds for `wp_set_consent` to appear
  and then applies the current state.
- In the browser console, `wp_has_consent('marketing')` is false before the
  visitor chooses (opt-in) and follows the banner afterwards.

## Limits

- The WP Consent API stores its own cookies (`wp_consent_<category>`; the prefix is filterable), separate
  from our `complykit_consent` cookie. Both are kept in step by the bridge, but
  a visitor who clears only one will see the plugins re-sync from our choice on
  the next page load.
- Server-side code that reads `wp_has_consent()` in PHP reads those WP cookies,
  so it sees our choice only after the browser has made the first call.

## Sources

- WP Consent API plugin: <https://wordpress.org/plugins/wp-consent-api/>
- Plugin source checked: `assets/js/wp-consent-api.js`, `inc/api-functions.php`.
- Its readme and developer docs (categories, `wp_set_consent`,
  `wp_has_consent`, `wp_consent_type`, `wp_listen_for_consent_change`):
  <https://github.com/rlankhorst/wp-consent-level-api>
