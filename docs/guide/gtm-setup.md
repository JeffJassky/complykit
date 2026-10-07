# Setting up Google Tag Manager

The consent tool can hold back a `<script>` in your HTML. It cannot hold back
a tag that Google Tag Manager loads: GTM decides, tag by tag, whether to fire.
So the tool tells GTM what the visitor chose, and **your container has to be
set up to listen**. This page is that setup. The change list from the scan
names the tags in your container that need it; this page says what to do to
each one.

Nothing here works until both halves are in place: the tool on the page
(below), and the consent settings inside the container.

## How the tool talks to GTM

Two signals, both written to the data layer named in `gtm.dataLayer`
([config](/guide/config#gtm)):

1. **Google Consent Mode.** Before the container runs, the tool queues
   `gtag('consent', 'default', …)` with every signal **denied** unless the
   config grants its category by default in the visitor's regime. A signal no
   category maps to stays denied, and so does a tracking signal
   (`ad_storage`, `ad_user_data`, `ad_personalization`, `analytics_storage`)
   mapped to `necessary`. The default carries `wait_for_update: 500`.
   On every decision (accept, reject, a change in settings, a withdrawal) it
   queues `gtag('consent', 'update', …)`.
2. **A `complykit_consent` event**, pushed once when the tool starts and again
   after every decision:

   ```js
   {
     event: 'complykit_consent',
     complykit: {
       categories: { necessary: true, analytics: false, advertising: false },
       regime: 'opt-in' // or 'opt-out-signal' / 'opt-out'
     }
   }
   ```

   The Consent Mode update is always queued **before** the event, so a tag
   that fires on the event already sees the new consent state.

## 1. Put the tool above the GTM snippet

The Consent Mode default must be in the data layer before the container
processes its first event (`gtm.js`, which the GTM snippet queues
immediately). A default queued after that does not apply to tags that fire on
page load.

```html
<head>
  <!-- 1. The consent tool: first, synchronous (no async, no defer) -->
  <script src="…/complykit-consent.js"></script>
  <script>/* the snippet the generator gave you */</script>

  <!-- 2. Then the Google Tag Manager snippet -->
  <script>(function(w,d,s,l,i){ … })(window,document,'script','dataLayer','GTM-XXXX01');</script>
</head>
```

- Load the tool synchronously. `async` or `defer` lets the container run first.
- **Remove GTM's `<noscript><iframe src="…/ns.html?id=GTM-…">`** from the
  `<body>`. It loads without JavaScript, so no consent tool can hold it back.
- Don't run a second consent tool or a CMP template in the container
  (a tag on the *Consent Initialization* trigger that sets its own defaults).
  Two sources of defaults means the one that runs last wins.

If the container was already on the page when the tool ran, the tool still
sets the defaults (late is better than never), logs a `[complykit]` warning
in the console, and records the problem in
`window.ComplyKit.diagnostics.gtm` (`orderOk: false`, plus which check
failed). The proof scan reads that flag. Treat it as a broken install.

## 2. Turn on the consent overview

In GTM: **Admin → Container Settings → Enable consent overview**. The Tags
list then shows a shield icon that opens a table of every tag and its consent
setting. That table is the quickest way to work through the change list.

## 3. Set each tag's consent requirement

Each tag has **Advanced Settings → Consent Settings** with three options:
*Not set*, *No additional consent required*, and *Require additional consent
for tag to fire* (where you pick consent types such as `analytics_storage`).

**Built-in consent checks.** Google's own tags (Google Analytics, Google Ads,
Floodlight, the Conversion Linker) read Consent Mode themselves. The consent
overview lists the signals each one checks. They still load and fire when
consent is denied; they just change what they send. In Google's *advanced*
Consent Mode that means cookieless pings, and those are still requests
before consent.

**Additional consent.** With *Require additional consent*, GTM does not fire
the tag at all unless every listed consent type is `granted` at the moment its
trigger fires. This is the only setting that stops a tag from firing.

What to set:

| Tag | Consent setting | Trigger |
|---|---|---|
| Google tag / GA4 / Google Ads, **opt-in locations** | *Require additional consent*: the signals your config maps to the tag's category (`analytics_storage` for GA4; `ad_storage`, `ad_user_data`, `ad_personalization` for Ads) | Its usual trigger **plus** the `complykit_consent` trigger below |
| Google tag / GA4 / Google Ads, opt-out locations only | Built-in checks are enough | Its usual trigger |
| **Custom HTML** (a Meta, TikTok, LinkedIn… pixel pasted as HTML) | *Require additional consent*, always: the signal mapped to the vendor's category (e.g. `ad_storage` for advertising) | The `complykit_consent` trigger below |
| Community template tag | Check the consent overview. If it lists no built-in checks, treat it like Custom HTML | Same as Custom HTML |
| A tag that is genuinely necessary | *No additional consent required* | Its usual trigger |

The first row is design §2 made concrete: for opt-in locations, a Consent
Mode-aware tag must be held back *and* told, because its "denied" mode still
sends requests.

### Why Custom HTML tags need "additional consent"

GTM only knows what a tag reads if the tag declares it. A Custom HTML tag is
arbitrary code: GTM cannot see inside it, so it has **no built-in consent
checks** and Consent Mode does not touch it. Left at *Not set*, it fires on
its trigger whatever the visitor chose. Most pasted pixels (`fbq`, `ttq`,
`_linkedin_partner_id`) also set their own cookies the moment they run, so
even a pixel with its own consent API gets one hit out before it's told.
*Require additional consent* is what makes GTM check the consent state
first.

## 4. Fire tags when consent arrives: the `complykit_consent` trigger

A tag blocked by *additional consent* is not retried when consent is granted
later. If the visitor accepts after the page loaded, the *All Pages* trigger
has already fired and been refused. Add a trigger that fires after the
decision:

1. **Variables → New → Data Layer Variable**, one per category you use:
   name `complykit.categories.analytics`, version 2. Repeat for
   `complykit.categories.advertising` and so on.
2. **Triggers → New → Custom Event**:
   - Event name: `complykit_consent`
   - This trigger fires on: *Some Custom Events* →
     <code v-pre>{{complykit.categories.analytics}}</code> *equals* `true`
     (one trigger per category).
3. Add that trigger to each tag in the category, next to its existing trigger.
4. In the tag's **Advanced Settings → Tag firing options**, choose
   **Once per page**. The event fires on load (for returning visitors who
   already chose, and in regimes that grant by default) and again on every
   change, so without this a tag can fire twice.

Revoking works the other way round: Consent Mode `update` with `denied`
switches Google tags to their denied behaviour from that moment; a Custom
HTML tag that already ran cannot be unloaded. The tool records the
withdrawal, deletes the first-party cookies it can reach, and the tag stays
blocked from the next page load on (design §2).

## 5. Check it

- Open GTM **Preview**. On page load the first entries in the data layer
  should be `consent default` (from the tool), then `gtm.js`. In the
  *Consent* tab the *On-page Default* column should read `denied` for an
  opt-in visitor.
- Accept a category. A `complykit_consent` event should appear with that
  category `true`, the *On-page Update* column should change, and the tags in
  that category should fire on that event.
- In the console, `ComplyKit.diagnostics.gtm.orderOk` should be `true`.
- Rescan. Tags the change list named should no longer fire before a choice.
