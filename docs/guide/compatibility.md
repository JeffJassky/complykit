# Compatibility verdicts and the change list

A consent tool only controls what it loads. Any tracker with a different loader
is a hole, and the hole is invisible to whoever configured the consent tool. The
scan knows how every tool got onto the page, so the consent report has a
compatibility section: one row per tool, answering **"can a consent tool control
this, and what has to change?"**

This page explains the words that section uses. What the scan cannot see at all
is on [What a scan cannot tell you](./limits.md). The rest of the report is in
[Consent & tracking by location](./consent.md).

## Behavior outranks implementation

A verdict says **where** a fix has to be made. The behavior column says whether
the tool was actually held back. When the two disagree, behavior wins:

- A tool seen running where the location's rules expect it off is listed first,
  in the table and in the change list, under **"Fix first: tools observed running
  where they should be off"**. Whatever the implementation says, the current
  setup does not hold it back. Make the changes listed for it, then rescan.
- Nothing observed where a tool should be off reads "Nothing observed where it
  should be off, in N compared visits … captured activity only, not a guarantee".
- A tool only compared where it may run anyway reads "never tested where it
  should be off". A tool no visit could be compared for reads "Not established".
  None of these is ever shown as a pass.
- A consent call that is made while the vendor still sends data looks fine to an
  implementation check. Only behavior catches it.

## The verdicts

| In the report | Verdict | What it means | What you do |
|---|---|---|---|
| Yes, once its tag is rewritten | `gateable` | A `<script>` tag in your HTML, with no leak and no platform loader. The consent tool can hold it back once the tag is rewritten. It does not yet. | Rewrite each listed tag to `type="text/plain"` with the generated `data-category`. |
| Only through the tag manager | `tag-manager` | Loaded by Google Tag Manager or another tag manager. Only that tool's own consent settings hold it back. | Fix it in the container: a consent requirement on each tag, and a denied default before the container loads. |
| Only through the platform's consent setting | `platform` | The platform (Shopify, Wix, a WordPress plugin) injects it. A rewrite of your HTML does not reach it. | Turn on the platform's consent setting; the consent tool's platform bridge passes the visitor's choice to it. |
| No, no consent tool can control it | `uncontrollable` | An element in the HTML the browser fetches before any script runs, a DNS alias that makes its cookies first-party, or server-side forwarding. | Remove it, repoint the DNS alias, or accept the exposure in writing. |
| Unknown, its loader was not identified | `unknown` | The scan could not establish how the tool gets onto the page. | A developer has to find the code that loads it. |

A tag-manager tool whose every container tag was proven held back reads **"Yes,
held back by the tag manager's consent setting (proven in this scan)"** and the
change column says "Nothing in the container". See
[GTM "required" consent](#gtm-required-consent-is-counted-only-with-a-denied-default).

The report never says a tool is "gated" unless that proof exists, and it never
says "compliant".

### Tools that need no consent

A verdict describes how a tool loads. Whether it needs a change depends on what it
is for:

- **Needs no consent** (necessary, CDN, captcha, payments, the consent tool
  itself): no row, no change, and not counted. These appear in a collapsed "not
  counted" line.
- **Chat, embeds, fonts and other feature tools**: their changes are listed
  separately, not counted. "Under opt-in rules these need consent unless strictly
  needed for a feature the visitor asked for. The changes apply where they are
  not."
- **Not classified yet**: listed as "Classify first — then, if it tracks visitors:
  …". It is held under the strictest category until your team classifies it.

## What each change asks of the developer

The change list is written beside the report as `change-list.md`. Each group
below is one kind of change.

| Group in the list | What to do |
|---|---|
| **Fix first: tools observed running where they should be off** | Make the changes listed for the tool, then rescan. Behavior is the ground truth. |
| **Tags to rewrite** | Each tag is a `<script>` in your HTML. Change it as shown (exact before and after are generated). The browser does not run a `type="text/plain"` script, and the consent tool inserts a working copy once the visitor agrees to its category. The `data-category` must be a category id in your [consent tool config](./config.md). |
| **GTM tags to gate** | In Google Tag Manager open each tag, then Advanced Settings → Consent Settings → "Require additional consent for tag to fire", and add the listed consent types. Publish the container. A requirement only holds a tag when a denied default is set first. See [Setting up Google Tag Manager](./gtm-setup.md). |
| **Consent defaults to set before tags load** | Google treats a consent type that was never set as granted. A denied default must run before the container or tag loads. The complykit consent tool sets it when installed above the container snippet; otherwise add the generated snippet. |
| **Other tag managers** | This scan cannot read these containers. In the tag manager, require consent on each tag that loads the tool. |
| **Platform settings** | Turn on the platform's consent setting. It covers only what the platform injects into the browser, see [the platform caveat](#platform-the-server-side-caveat). |
| **Vendor consent calls (alongside the block, never instead)** | These vendors also take a consent signal. The consent tool's adapters make these calls; a hand-made setup must make them too. See [How each vendor is controlled](./vendor-control.md). Additive: the call is made alongside gating, never in place of it. |
| **Leaks to remove** | The browser fetches these elements itself, before any script runs. `<noscript>` content fires exactly for visitors without JavaScript, when no consent tool can run. Remove them from the HTML. |
| **DNS aliases** | A first-party subdomain points at the vendor, so its cookies are first-party and no consent tool can remove them. Repoint the alias, or accept the exposure in writing. |
| **Accepted exposures** | Nothing on the page controls these. Remove the integration, or record in writing that the exposure is accepted. A decision for the owner, not a developer task. |
| **Needs a look** | See [Needs a look](#needs-a-look). |

## The seven implementation classes

Each tool gets one class: how it gets onto the page. The class decides where the
owner has to make the change for the tool to be controllable.

| # | Class (report wording) | Where the fix is |
|---|---|---|
| 1 | Script tag in the page HTML (`direct-script`) | Rewrite the tag to `type="text/plain"`. |
| 2 | Image, iframe or `<noscript>` element in the HTML (`markup-leak`) | Remove the element. No gate is possible: the browser fetches it before any script runs. |
| 3 | Google Tag Manager (`gtm`) | The container's consent settings and Consent Mode defaults. |
| 4 | Another tag manager (`other-tag-manager`) | That tag manager's own consent controls. |
| 5 | Injected by the platform (`platform`) | The platform's consent setting. |
| 6 | First-party subdomain, DNS alias (`cname`) | DNS. The script can be gated; the cookies it sets stay first-party. |
| 7 | Server-side forwarding, suspected (`server-side-suspected`) | Nowhere in the browser. A server-side checklist item. |

A tool that matches none of these is **Not traced** (`unknown`). The scan fails
closed: the evidence list says why.

### Why the precedence

A tool is often loaded more than one way. A Meta Pixel can be in GTM and also ship
a `<noscript>` image. The class is the one that **decides control**, so the order
is:

1. **Markup leak wins over everything.** The browser fetches the element before any
   script runs, so no consent tool, container setting or platform bridge stops it.
   Whatever else loads the tool, this copy keeps firing until it is removed from
   the HTML. A GTM-loaded pixel that also ships a `<noscript>` image is a markup
   leak for control purposes. Frames pass this on: what loads inside an `<iframe>`
   in the HTML is as ungated as the iframe.
2. **DNS alias next.** A leak needs no script at all; an alias leaves cookies that
   survive even when the script is gated.
3. **The controllable paths**, ranked first by how the evidence was obtained:
   *observed* (the scan saw the tool's request arrive that way), then *static* (a
   tag in the HTML, or a tag in a parsed GTM container), then *inherited*
   (injected by another party's script whose own load could not be traced).
   Within the same strength, in this order:
   - **Google Tag Manager**: the nearest decision point. The tag fires when the
     container's tag fires, whatever loaded the container. GTM comes before other
     managers only because its container is readable.
   - **Another tag manager.**
   - **Platform**: a rewrite of the HTML does not reach it, only the platform's
     consent setting does. The platform's own cookies and scripts on its own store
     count as observed platform evidence.
   - **Script tag in the HTML**: last, because the tag-rewrite list already carries
     this copy. When a tool is both in the HTML and in a container, the path the
     scan saw fire wins; the other is kept as also seen.
4. **Server-side, suspected.** An inference (a first-party collect endpoint such as
   `/g/collect`, or a server-container URL in a GTM tag), never seen reaching the
   vendor. It decides the class only when no direct path explains the tool;
   otherwise the report says server-side forwarding is possible and cannot be
   verified.
5. **Not traced** if nothing above has evidence.

A tag that is already `type="text/plain"` is a script you have already switched
off. A `dns-prefetch` or `preconnect` hint loads nothing and is not an
implementation.

## GTM "required" consent is counted only with a denied default

In Google Tag Manager a tag can carry a "required" consent setting. That alone
proves nothing: **Google treats a consent type that was never set as granted.**

A GTM tag counts as **held back** only when all of these hold:

- the container was fetched and parsed;
- the tag carries "required" consent for every type its category needs;
- a **denied**, non-regional Consent Mode default covering every required type was
  observed in the scan;
- no default set after load, and no grant on load, was seen for Google.

Every other tag gets a change:

- no default observed: **set a denied consent default before it loads**;
- container unreadable, not fetched, or no tag mapped to the tool: **require
  consent on the GTM tag** without a tag id ("verify in the UI").

The "outside your consent tool's reach" line counts a tag-manager tool unless this
proof holds for every container tag that loads it. Another tag manager is never
proven.

### A Google tag destination GTM loads from the page's `gtag('config')`

A page can carry both a GTM container and a hand-written Google tag snippet:
`<script src=".../gtag/js?id=G-…">` plus `gtag('config', 'G-…')`. When the
container sees that `config` command in the dataLayer it loads the destination
itself (`gtag/js?id=G-…&cx=c`, initiated by `gtm.js`). No container tag carries
that id, so there is no tag to "require consent" on, and holding the gtag.js
loader alone does not stop it.

When GTM is on the destination's load chain, every GTM container was parsed, and
no tag in them names the id (and none could: no Google tag with an unresolved id,
no Custom HTML tag for the tool), the change list says instead:

- **Tags to rewrite**: the `gtag('config')` snippet, at its page and line, with
  why. If it was not located: **Needs a look**, naming the call to find.
- **Consent defaults**: a denied default before the container.
- On the gtag.js loader's own rewrite: holding it is not enough while a GTM
  container is on the page.

The alternative is moving the config into GTM as a Google tag with a consent
requirement. If any condition above is not established, the usual GTM changes
are listed.

## Tags served as `data:` URLs, and optimizer delays

WordPress performance plugins ("delay / defer inline JavaScript") often serve an
inline vendor snippet as `<script src="data:text/javascript;base64,…">`. The scan
decodes the URL (base64 or percent-encoded, size-capped) and matches its code like
an inline snippet. The record keeps only `data:<type>,…`, never the payload. The
rewrite moves the URL to `data-src` unchanged (`type="text/plain"
data-category="…" data-src="data:…"`); the consent tool runs a `data:` URL
`data-src` like any other. Make the change in the source snippet, or exclude it
from the plugin's option, and check the served HTML afterwards.

Scripts a plugin re-types to run later (WP Rocket `type="rocketlazyloadscript"` /
`data-rocket-src`, LiteSpeed `type="litespeed/javascript"`, Perfmatters
`type="pmdelayedscript"`, Cloudflare Rocket Loader) still run for every visitor,
on the first interaction or after load. That delay is not consent gating: they
are listed as tags to rewrite, with the plugin named.

## Platform: the server-side caveat

A platform's consent setting governs what the platform injects **into the
browser** only. The platform row carries this caveat: events the platform or a
vendor's app forwards server-side (Shopify server pixels, the Meta and Google apps'
conversions APIs) are not covered and cannot be verified from the browser. For a
WordPress site where the WP Consent API was not detected, the row also says the
plugin that injects the tag may not read consent at all.

Platform tools are not counted in the "outside your consent tool's reach" line,
because the platform's setting reaches them. The caveat still applies.

## Needs a look

**Needs a look** means the scan could not establish how the tool gets onto the page,
so it cannot say what to change. A developer has to find the code that loads it.
The row says why:

- "its loader was not identified";
- "traced to a script whose tag was not located in the inspected HTML": the HTML
  was not inspected, the tag is only in `type="text/plain"` form, or no tag was
  found;
- "traced to a script in the HTML, but whether that is its only path is not
  established";
- "injected by a platform or app that was not identified".

A tool seen only at runtime, with no initiating URL and no element located, is also
`unknown`: a redirect hop or a script-created image looks the same. Unknown tools
count as outside your consent tool's reach, because the scan cannot show they are
inside it.

## Outside your consent tool's reach

One line counts the holes:

> N tools are loaded outside your consent tool's reach: …

A tool is counted when its purpose needs consent (or is not classified yet, or it
is a tag manager, which loads others) **and** its verdict leaves it out of the
consent tool's hands:

- `uncontrollable`: an element in the HTML, a DNS alias, or server-side
  forwarding;
- `unknown`: its loader was not identified;
- `tag-manager`: unless every container tag that loads it was proven held back.

Not counted: tools in a script tag you can rewrite, tools the platform injects, and
tools whose purpose needs no consent. The line always carries what the scan
covered; see [What a scan cannot tell you](./limits.md).

## Reading the verdicts after a rewrite

Rescan after each change. A verdict is a prediction of where to fix; the matrix is
the check. A tool that stays red after you made its listed change was not held back by it:
the change is incomplete, or the consent tool config does not match, and the
behavior column says what was seen.
`complykit report --format consent-changes` regenerates the change list from a
saved run; see [the CLI reference](../reference/cli.md#consent).
