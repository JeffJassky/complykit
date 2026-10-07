# Installing the consent tool

This is the whole install, start to finish, for a developer working without us. The
consent tool is two small JavaScript files plus a block of JSON that you generate
from a scan of your own site. You put them first in `<head>`, make the changes the
scan listed, and rescan to check that it worked.

::: warning Status
The tool is built and tested, and the steps below were exercised on local copies of
real sites (the scanner applied the changes inside its own browser; see [Local-copy
mode](./consent.md#local-copy-mode)). This guide has **not yet been reviewed against a
real, deployed install**, and the default banner words are still pending agency review
([Banner copy](./banner-copy.md)). Where a step depends on something we have not
watched happen on a live site, it says so. Nothing here is legal advice, and a clean
rescan is evidence about the pages it visited, not a statement that a site complies.
:::

This page is the install reference. For the guided path (classify tools, get a
checklist, verify each change in seconds, then rescan), see [From scan to verified
install](./remediation.md).

The steps, in order:

1. [What you get](#_1-what-you-get)
2. [Generate the config, snippet and change list](#_2-generate-the-config-snippet-and-change-list)
3. [Paste the snippet first in `<head>`](#_3-paste-the-snippet-first-in-head)
4. [Apply the change list](#_4-apply-the-change-list)
5. [Script attributes](#_5-script-attributes)
6. [Look and words](#_6-look-and-words)
7. [Location and regime](#_7-location-and-regime)
8. [Consent records](#_8-consent-records)
9. [Verify by rescan](#_9-verify-by-rescan)

## 1. What you get

Two files, built from `client/` in this repository (`cd client && npm run build`; the
output is in `client/dist/`):

| File | What it does | Size budget (gzip) |
|---|---|---|
| `complykit-consent.js` | The core: consent store, script gate, vendor adapters, Google Tag Manager bridge, location, platform bridges, the `ComplyKit` API. Blocking, first in `<head>`. | 15 KB |
| `complykit-consent-ui.js` | The banner, the settings layer and the Privacy choices control. Loaded by the core, asynchronously. | 12 KB |

(`client/dist/` also has an ES-module build and a source map for bundlers. The snippet
uses the two plain files.)

Put both in **one folder** on your own domain, under a versioned path. The generator's
default is `/complykit/v1/`, so the snippet loads `/complykit/v1/complykit-consent.js`
and the core finds `complykit-consent-ui.js` next to it. The `v1` is the config schema
major version: a 1.x config keeps a 1.x tool until you reinstall from a new scan
([Versioning](./config.md#versioning-and-migration)).

**Why self-hosted.** A request to a third party before the visitor has chosen is
exactly the thing the scan reports as a finding. The tool and its config therefore
make no network request of their own before consent: the config is in the page, the
script is on your origin, and nothing is fetched from us at runtime. Do not put the
files on a public CDN.

**Distribution.** There is no npm package yet, and none is published. Until there is,
you copy the two files out of a build of this repository into your own static assets.
The `client` package is private. The files are plain browser scripts with no
dependencies.

## 2. Generate the config, snippet and change list

Run a consent scan of your site first ([Consent & tracking by location](./consent.md)).
It records which tools load, how, and what ran with consent denied. Then generate
the install material from that run.

**CLI.**

```sh
complykit consent --url https://www.example-shop.test
complykit consent-config .comply/runs/<run-id>
```

`consent-config <run-dir>` writes four files to `<run-dir>/consent-config/`:

| File | What it is |
|---|---|
| `complykit-config.json` | The config: categories, vendors, gate rules, GTM, platform, location source. Validated against the schema and hashed. |
| `snippet.html` | What to paste in `<head>` (step 3), followed by each tag to rewrite as before and after markup. |
| `change-list.md` | The same change list as the report: everything in step 4. |
| `generator-notes.md` | What the generator refused or could not decide, and what to check before deploying. **Read this before you deploy.** |

Useful options: `--workspace <file>` (your classifications override the scan's),
`--script-src <path>` (where you will host the files, if not `/complykit/v1/`),
`--privacy-policy <url>`, `--record-endpoint <path>`, and `--regime-source`
(`meta`, `platform`, `fixed:opt-in`, or `header:<header>:<path>`). Full option list:
`complykit consent-config --help`, and [How the generator decides](./config.md#generating-it).

**The service.** If you run the complykit service, `POST /api/jobs/<id>/consent-config`
does the same for a finished consent job, using the site's workspace, and stores the
result as the site's latest config. The Sites page then offers the config, the snippet
and the change list as downloads. On a site's page in the service UI, press **Generate
consent tool config** next to a finished consent run (the primary button uses the latest
run); the downloads appear when it finishes. The endpoint's body is optional: `by`, `scriptSrc`,
`recordEndpoint` (a path, or `true` for this service's own endpoint),
`privacyPolicyUrl`.

The config's fields are listed in [Config reference](/reference/config-schema) and
explained in [Consent tool config](./config.md). You should not need to hand-edit it;
if you do, the hash will no longer match and the rescan will say so.

## 3. Paste the snippet first in `<head>`

`snippet.html` starts with this block (the JSON is your generated config):

```html
<script type="application/json" id="complykit-config">{ "version": "1.0", … }</script>
<script src="/complykit/v1/complykit-consent.js"></script>
```

Both elements go **first in `<head>`**, as the first things after `<meta charset>`:

- **Above Google Tag Manager** and every other script or tag. The tool sets Consent
  Mode defaults and starts holding tags only from the point it runs. Anything above it
  can run before it does.
- **Blocking.** No `async`, no `defer`, no `type="module"`. A deferred tool is a late
  tool.
- **Not inside a performance plugin's reach.** Page optimizers that combine, delay or
  defer JavaScript can reorder or wrap the tool. Exclude both elements from them. If
  an optimizer delays the tool, it also delays the thing that holds everything else
  back.

Server-rendered pages: put it in the shared layout, so it covers every template.
Several layouts (a checkout, a password page, a landing-page builder): each layout
with its own `<head>` needs it. Platform sites have their own place to paste it; see
[platform bridges](#platform-bridges) below.

If the tool loads but the config is missing, malformed, or from a newer major version,
the tool does nothing and gated scripts stay inert. That fails closed, but it also
means a broken snippet looks like "the site stopped tracking". The rescan reports it
([Verify](#_9-verify-by-rescan)).

## 4. Apply the change list

The paste is the easy half. The tool can hold back only what it controls, and the
tools on your site load in different ways. The change list says, per tool, what has
to change. The groups and how the verdicts are decided are in [Compatibility
verdicts](./compatibility.md); this section is what to actually do.

### Tag rewrites

For each script tag in your HTML the list names, change it as shown. A tag like

```html
<script async src="https://widgets.example-vendor.test/loader.js" id="vendor-loader"></script>
```

becomes

```html
<script type="text/plain" data-category="analytics"
        data-src="https://widgets.example-vendor.test/loader.js" id="vendor-loader"></script>
```

The browser neither fetches nor runs a script whose type is `text/plain`. When the
visitor's choice grants the category, the tool inserts a working copy right after it
and runs that. Rules that follow from how it does this:

- **The copy owns the `id`.** Vendor loaders often find their own tag by id
  (`document.getElementById('…').src`, to read an account id out of it). The tool
  moves the `id` to the working copy, so the lookup finds the script that is actually
  running. The held original stays in the page as a marker, without the id. Other
  attributes are copied; `async`, `defer` and `nonce` are handled separately.
- **`data-category` must be a category in your config.** An unknown or unlisted
  category is never released, whatever the visitor chose. This is deliberate: a typo
  cannot turn a tracker on.
- **Inline scripts** use `type="text/plain"` and `data-category` on the same tag, with
  the code as the body. If the vendor needs `type="module"`, add `data-type="module"`.
- **`<iframe>` and `<img>`** get `data-category` and `data-src` and no `src`; the tool
  sets `src` on grant.

**Ordering caveats.** The released copy runs after the page has been parsed, not in
place:

- Within one category, released scripts run in document order. A non-async external
  script holds the line until it loads or fails; an inline classic script runs
  immediately. `async` scripts do not wait. Categories do not wait on each other.
- A script that was `defer` is not released before `DOMContentLoaded`.
- Code that depends on a gated script (a call to `fbq(...)` in an inline tag lower
  down) must itself be gated into the same category, or guard against the global being
  undefined. A page that works only because a tracker loaded synchronously first will
  break in a visitor who has not consented. Test with a fresh browser profile.
- **Withdrawal un-runs nothing.** A script that already ran cannot be unloaded. After a
  withdrawal the tool stops releasing, reloads the page by default, and holds the
  category from the start of the next load ([reload attribute](#_5-script-attributes)).

**Things that cannot be gated as written.** The generator flags these in
`generator-notes.md`; a tag it flags is not silently rewritten.

- **`document.write` vendors.** Older ad and widget tags write markup into the page as
  they load. A released copy runs after parsing, where `document.write` is ignored or
  replaces the page, so the tag appears to do nothing. Ask the vendor for an
  asynchronous snippet, or leave the tag out and record the decision.
- **`data:` URL loaders.** Some performance plugins ("delay JavaScript") turn an
  inline snippet into `<script src="data:text/javascript;base64,…">`. There is no URL
  for a gate rule to match and the payload is not in the record. Make the change in the
  source snippet, or exclude it from the plugin's inline-JavaScript option, and check
  the served HTML afterward. (The scanner does not yet see inside these; see [What a
  scan cannot tell you](./limits.md).)
- **Optimizer-wrapped loaders.** If a plugin rewrites your tag's `type` or `src` at
  serve time, your edit in the source is not what the browser receives. Always verify
  against the HTML the server sends, not your template. [Local-copy
  mode](./consent.md#local-copy-mode) reports how many documents each replacement
  matched; zero means the "now" markup was not what the server sends.
- **Tags the platform writes**, and **theme app embeds** you cannot edit. The change
  list points at the platform setting instead; see below.

### Leaks to remove

Some elements the browser fetches by itself, before any script runs: tracking pixels
in `<img>`, `<noscript>` fallbacks (including GTM's `<noscript><iframe src=…ns.html>`),
iframes. No consent tool can hold these. Remove them. The cost is real: visitors with
JavaScript disabled lose that fallback, and they are the visitors no tool could ask.

### Google Tag Manager

Tags inside a container are not in your HTML; the container decides. Follow
[Setting up Google Tag Manager](./gtm-setup.md): put the tool above the container
snippet, turn on the consent overview, set each listed tag's "Require additional
consent for tag to fire", and add the `complykit_consent` trigger so tags fire when
consent arrives later. A requirement only holds a tag when a **denied default** was
set first; the tool sets one before the container runs, which is why step 3's order
matters.

**Consent Mode default.** With a `gtm` section in the config, the tool pushes
`gtag('consent', 'default', …)` with every signal denied (unless the visitor's
regime grants it by default), then `update` on every decision. Without one, the Google
adapter derives the signals from your vendors. An unmapped signal stays denied.
Do not also run a CMP template in the container: two sources of defaults means the
last one wins.

### Platform bridges

Tools a platform injects are outside your HTML. The tool tells the platform what the
visitor chose, through the platform's own consent API, and the platform gates its own
scripts on it. Set `platform` in the config and install on the platform's terms:

- [Shopify](./platform-shopify.md): paste into `layout/theme.liquid`, directly after
  `<head>` and above `{{ content_for_header }}`. **App-embed route:** an app embed
  block can target `<head>` but Shopify places it inside `content_for_header`, after
  other injected content, with no documented ordering. That is fine for the Customer
  Privacy bridge and wrong for the gate and the Consent Mode defaults, so until a
  complykit app exists `theme.liquid` is the supported path. Turn off Shopify's own
  banner so only one tool writes the choice.
- [WordPress](./platform-wordpress.md): a must-use plugin that prints the config and
  script at the earliest `wp_head` priority; bridges to the WP Consent API. Exclude the
  tool from caching and minifying plugins.
- [Wix](./platform-wix.md): Settings > Custom Code, all pages, in the head, above every
  other entry; turn off Wix's own banner.

A platform bridge reaches only what the platform injects in the browser. It does not
reach server-side sends, and some platform-owned analytics keep sending whatever the
stored choice says (observed on a Shopify sample site, where the platform's own
analytics requests continued after a refusal). The report shows these per cell rather
than calling them handled.

### Remove the existing consent tool

If the site already runs a cookie banner or consent plugin (CookieYes, WebToffee,
Cookiebot, a CMP template in GTM), **remove it when you install this**. Two tools mean
two banners, two stored choices and two sources of Consent Mode defaults; the one that
runs last wins, and neither is the record you can show.

The generator flags a consent plugin it recognizes (`generator-notes.md`, code
`existing-consent-tool`). Two details from a real WordPress site:

- While the old tool is active it holds tags itself, so the scan may have seen only
  some of your trackers. Scan with an **accept** visit before generating, so the
  config knows what the old tool was holding back.
- After removal, tags the old plugin used to hold are now plain scripts. Re-run the
  scan and apply the tag rewrites from the new change list.

## 5. Script attributes

Attributes on the core `<script src=…complykit-consent.js>` tag, and on your own
elements:

| Attribute | On | Values | Effect |
|---|---|---|---|
| `data-complykit-ui` | core `<script>` | a URL, or `none` | Where `complykit-consent-ui.js` is. Default: the core's own folder. Required if the core is inlined or served from another path; `none` means you render your own UI on the `ComplyKit` API. If the UI file fails to load, no choice is made and the defaults stand (nothing non-necessary under opt-in). |
| `data-complykit-choices` | core `<script>` | `bottom-left`, `bottom-right`, `none` | Where the Privacy choices control sits. `none` hides it, so supply your own link with `data-complykit-open`. |
| `data-complykit-reload` | core `<script>` | `withdraw` (default), `revoke`, `none` | Page reload after a change. `withdraw`: after a full withdrawal that revoked something. `revoke`: also after a partial change that turns a category off. `none`: never (the gate still holds from the next load). |
| `data-complykit-open` | any element | (presence) | A click opens the settings layer. Put it on a footer "Privacy choices" or "Cookie settings" link. Every site should have one: withdrawing must be as easy as choosing. |

Also available from script: `ComplyKit.open()`, `ComplyKit.withdraw()`,
`ComplyKit.on('change' | 'open' | 'withdraw', fn)` and `ComplyKit.diagnostics`
(what the rescan reads).

## 6. Look and words

Theming is a handful of tokens, not an engine: `theme` sets `--ck-bg`, `--ck-fg`,
`--ck-accent`, `--ck-border` and `--ck-radius`; `layout` is `bar`, `box` or `modal`;
the font is always inherited ([theme and layout](./config.md#theme-and-layout)).

Words come from per-regime defaults inside the tool; the config carries overrides
only, per language and regime ([strings](./config.md#strings), [Banner
copy](./banner-copy.md)). The generator refuses overrides that make the visitor read
something the law or the dark-pattern findings rule out (a reject label that does not
say reject, "By continuing to browse…", and so on). Design rules the rescan checks,
not config options: [Banner design rules](./banner-rules.md).

## 7. Location and regime

The tool picks a regime (`opt-in`, `opt-out-signal`, `opt-out`) from where the
visitor is, and an unknown location is `opt-in`. The browser does not know its own
location, so your server or CDN has to provide it: a `<meta name="complykit-region">`
written at the edge, a same-origin endpoint that echoes a country header, the platform
(Shopify), or `fixed`. If you have no source, set `fixed` to `opt-in`. Recipes for
Cloudflare, Vercel, Netlify, Fly and your own server, and the caching trap with the
meta tag: [Visitor location and regime](./location.md).

## 8. Consent records

Optional. The tool can POST a small record of each choice (categories, timestamp,
tool version, config hash) to an endpoint you run, or to the complykit service's.
Without one the choice is stored only in the visitor's browser and still enforced.
What a record contains, retention and exporting: [Consent records](./consent-records.md).
Set it with `--record-endpoint` at generation time or `record.endpoint` in the config.

## 9. Verify by rescan

A deployed install is proven by scanning it, not by reading the snippet. The service
walks this as a checklist with a **Verify** button per change and a **Rescan site**
button at the end: [From scan to verified install](./remediation.md). From the command
line, run the same consent scan again, with the site's workspace so the scan knows your config:

```sh
complykit consent --url https://www.example-shop.test --workspace workspace.json
```

### Preview before you deploy

To test the change set without touching the site, use [local-copy
mode](./consent.md#local-copy-mode). The scanner applies the snippet, your tag
rewrites and (simulated) GTM consent settings inside its own browser and scans that
copy. The report is labeled **LOCAL COPY, not the live site**. Use it to find tags that
stay red and to count whether each replacement matched. A green local copy is a
prediction. Only a rescan of the deployed site is proof.

### The "consent tool detected" section

When the rescan finds the tool, the report adds a section (anchor `#consent-tool-proof`,
nav link "Your consent tool") headed by one line, for example:

> complykit consent tool detected: version 0.1.0, config generated 6 Oct 2026: 3
> vendors controlled, 2 not (GA4, session recording), 6 not observed.

Under it: the config status (found, parsed, hash matches, same as the workspace's,
generated for this site), then one row per vendor. A vendor is one of:

| Result | Meaning |
|---|---|
| **Controlled** | Held in every visit where the config denied it, **and** seen running when granted, and behaved consistently across the journey. Evidence in this scan, for these pages. |
| **Not controlled** | Seen running where the config says it must be off (after a refusal, under Global Privacy Control, after a withdrawal). The row names the visit and the request or cookie. Fix first. |
| **Not observed** | The scan has no proof either way: the vendor never appeared, or never in a state that tests the claim (for example, held in every denied visit but never seen after an accept, or a necessary tool that needs no consent). **Not a pass.** It is never folded into controlled. |

Not observed is common and honest. A tag a vendor has switched off server-side, or one
that only loads on a page the journey did not reach, reads this way. On a WordPress
sample site, most vendors were "held in every denied visit" and unseen after accept
because the tags that load them were held; three were fully proven.

The section also lists findings. The ones that mean the install is wrong rather than
incomplete: **no config element** or **config refused** (the tool does nothing),
**tool loaded after Google Tag Manager** (step 3), **banner file did not load**
(`data-complykit-ui`), **gated script never rewritten** (a change-list item you
missed), **tracker listed as necessary**, **vendors not controlled**, **Global Privacy
Control not recorded**, and **trackers the config does not list ran** (the config is
behind the site; regenerate). **Config edited by hand** and **config behind the
workspace** are advisory.

### Reading what stays red

Rescan after each change. A cell that stays red after you did what its row said
means the change was incomplete, or the config does not match the site, and the
behavior column says what was seen. From field runs on real sites, red cells that
remained after a correct install were, in practice, one of:

- a loader the scan could not rewrite (a `data:` URL tag; a theme app embed);
- a GTM destination that is not a container tag (a `gtag('config', …)` that GTM reads
  from the data layer), which has no "require consent" setting;
- activity in the first moments after a withdrawal click, before the reload, inside
  a short grace window;
- platform-owned requests the bridge cannot reach.

Each is classified in [Compatibility verdicts](./compatibility.md) and the report names
it per cell.

### Limits

What a scan cannot establish: pages not visited, server-side sends, vendor-side use of
data, locations not tested, logged-in areas, and more. Every report carries the list;
read [What a scan cannot tell you](./limits.md). In short, the rescan shows what the
browser did on the pages and locations it covered. It does not certify compliance, and
one location is not the world: real EU and UK exits need verified proxies
([CLI: `--locations`](/reference/cli#consent)).

## See also

- [Config reference](/reference/config-schema): every field, generated from the schema
- [Consent tool config](./config.md): what the fields mean and how the generator fills them
- [Compatibility verdicts and the change list](./compatibility.md)
- [How each vendor is controlled](./vendor-control.md) and [Adapters](./adapters.md)
- [From scan to verified install](./remediation.md): the checklist, Verify and Rescan
- [CLI reference](/reference/cli)
