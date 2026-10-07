# What a scan cannot tell you

Every result in a consent report is a claim about **these pages, at this time, from
this location, logged out, N runs**. The report never says a site is compliant. This
page lists what is outside what a browser session can establish, and how the report
says so.

## The scope line

The top of the report carries what each count is a claim about:

> 324 checks working as expected on 14 pages, 1 location, logged out, 1 run each

The compatibility section carries the same discipline:

> On what this scan saw: 3 pages with their HTML inspected, 1 verified location
> (…), logged out, desktop Chromium, 1 run per visitor action. Pages not visited
> can load other tools.

These results describe those pages, at that time, from those locations. They say
nothing about other pages, other times, or a logged-in visitor. Locations count
only when their exit was verified; an unverified location is "not tested".

## Blind spots

Every report carries this list under "What a scan cannot tell you".

- **Pages not visited.** Only the pages the scan visited are covered. A pixel on checkout, search results or a logged-in area is not seen unless the journey reached it.
- **Server-side.** Data a site's server sends to vendors directly never passes through the browser. It is possible and cannot be verified here; ask the owner for the server-side checklist.
- **Vendor-side.** Whether a vendor kept the data, matched it to a person or sold it is out of scope for any scanner.
- **Other browsers.** Evidence comes from Chromium on desktop. Safari and Firefox handle cookies and tracking protection differently.
- **Timing and repeat visits.** A tracker that only fires when the consent tool loads slowly can be missed. A single run cannot rule out a race.
- **Caching, A/B tests and personalization.** Different visitors can get different tags. One scan sees one variant for one logged-out visitor in one location.
- **Consent calls that do not work.** A consent API call can be made while the vendor still sends data. Observed behavior is the evidence; implementation is only the explanation.
- **Data already sent.** Withdrawing consent stops future sends. It does not recall anything already sent.

How these connect to the rest of the report:

- **Behavior is the ground truth.** A behavior mismatch always outranks an
  implementation verdict. See [Compatibility verdicts](./compatibility.md).
- **Server-side forwarding** is the one implementation class the browser cannot
  verify. A tool with a first-party collect endpoint is reported as "server-side
  forwarding is possible and cannot be verified from the browser", and it counts
  as outside your consent tool's reach.
- **Platform consent settings** reach only what the platform injects into the
  browser; server-side events are not covered.

## Always listed as not tested

Every consent run lists these under "Not tested", whatever the scan found. A flow
the browser cannot observe is never implied clean.

- Data the site's server sends to vendors directly (conversion APIs, server-side
  tagging): a configuration checklist item, not a browser test.
- What vendors do with data after receiving it.
- Vendor contracts (whether a disclosure is a "sale", processor terms).
- Whether consent records are stored correctly on the site's backend.
- Pages and flows the journey did not visit (logged-in areas, checkout beyond the
  cart, forms that were not submitted).

A run adds its own items as they happen: a banner the driver could not reject,
storage inside a sandboxed frame (opaque origin, unreadable),
`navigator.globalPrivacyControl` inside workers (init scripts do not run in
workers; the `Sec-GPC` header is still sent), page-exit sends from cross-origin
frames, an incomplete HAR export, and a visit that did not complete.

## "N of N runs"

By default each visitor action is visited once. `--runs N` (1 to 5) visits each
scenario N times:

```bash
complykit consent --url https://shop.example.com --runs 2
```

Each run after the first repeats the scenario under **Slow 3G network and 4x CPU
throttling**, to catch trackers that only fire when the consent tool loads slowly.

- A tool active in **any** run counts as active.
- The report states it as "Active in 1 of 2 runs". Zero is "Active in 0 of 2
  runs", never "clean".
- Cells with a tool active in some but not all runs are listed, because a race is
  exactly what a partial result looks like.
- The scope line counts the fewest runs any tested scenario had: "2 runs each"
  means at least two.
- If a throttled run does not complete, it is listed under "Not tested" and the
  count stays at the runs that did.

Two runs are better evidence than one. They are not proof: a race can still be
missed, and the report says so ("One run, whatever it shows, is not proof"). The
CLI default is one run, and so is the service's. On the service, tick **Also repeat
on a slow connection** (in **Scan options**, or on a full rescan) for the throttled
pass; `CONSENT_RUNS` sets how many runs such a scan makes (default 2). Quick scans
always run once.

Throttled runs are slow: each gets three times the scenario budget, so a scan with
two runs takes about three to four times as long as one. The service's per-scan time
limit grows the same way: 45 minutes for one run, 180 minutes for two.

## Site search in the journey

The journey lands, dwells, scrolls, opens a listing, a product and the cart, then
makes one more same-origin navigation to flush exit beacons. It never reaches
checkout and never submits forms, with one exception: **the site's search box**, a
GET form, searched with a marker text. Page titles and search terms are what
analytics tags carry to third parties on a results page.

When there is no usable search, the step records itself as not tested, never as a
pass:

- "site search: no usable search input was found on the landing page — search
  terms and page titles sent from a results page were not tested"
- "site search: the search form submits by POST, which the journey does not do —
  search terms and page titles sent from a results page were not tested"

Search runs at most once per scenario. A site whose search sits behind a login, on
a deeper page, or in a POST form is not covered.

## Google Fonts and CDN leaks

A script gate cannot hold back every request. **Google Fonts** arrives by
`<link rel="stylesheet">`, which `type="text/plain"` gating does not cover. Google
says the Fonts API sets no cookies but receives the visitor's IP address, the page
URL, the user agent and the referer. There is no consent call. The fix is to
self-host the fonts, which removes the request. See
[How each vendor is controlled](./vendor-control.md).

CDN, captcha, payments and "necessary" tools are not counted in the "outside your
consent tool's reach" line, because their purpose needs no consent decision. Fonts,
chat and embeds are listed in their own group, not counted: under opt-in rules
these need consent unless strictly needed for a feature the visitor asked for. The
scan reports that the request was made; whether it is strictly needed is your
team's decision.

## Where else to look

- [Compatibility verdicts and the change list](./compatibility.md): what each
  verdict means and what to change.
- [Consent & tracking by location](./consent.md): the report and how scenarios
  work.
- [Coverage & honesty](./coverage.md): the same rule for the rest of complykit.
