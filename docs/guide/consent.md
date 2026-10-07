# Consent & tracking by visitor location

`complykit consent` finds out what a site actually does with visitor data —
per visitor **location** and per consent **scenario** — and reports it against
the rules for that location: EU ePrivacy Art. 5(3), UK PECR reg. 6, the
California CCPA regulations and other US state opt-out-signal laws, and (as
*exposure* for counsel, never as violations) the California, Florida and
Pennsylvania wiretap statutes.

```bash
npx complykit consent --url https://shop.example.com
```

With no config, it runs from this machine's own location, verifies where that
is, and lists every other location as not tested.

Every green number carries its scope. Near the top, the HTML and Markdown
reports state it in one line, for example "324 checks working as expected on
14 pages, 1 location, logged out, 1 run each", with the scan time. Beside it
sits a "What a scan cannot tell you" box (shown once): pages not visited,
server-side flows, vendor-side handling, other browsers, timing races, caching
and A/B variants, consent calls that do not work, and data already sent. The
word "compliant" never appears in report output; a test asserts it.

## How it works

1. **An external browser, not a page script.** complykit drives a real Chromium
   (Playwright) as a first-time visitor and records at the browser level: every
   request from the page, its frames (including cross-site and `srcdoc`
   frames), workers and service workers; who caused each one (the call stack,
   then the chain of scripts that inserted those scripts); every cookie
   including HttpOnly ones and which response or script set it; storage in
   every frame; and page-exit beacons, which a small observer recovers on the
   next same-origin page because the browser's own events miss them.
2. **Verified locations.** Each location routes through its own proxy/VPN
   exit (`--proxy de=socks5://…`). Before anything is attributed to a place,
   the exit is looked up in **two** geolocation sources *through that same
   proxy*; only a **verified** location produces findings. A mismatch or a
   failed lookup is reported as not tested. A US state is trusted only when
   both sources agree on it — otherwise findings stay at country level.
3. **Scenarios.** Each runs in a brand-new browser profile with a short
   journey (land, dwell, scroll, a listing/product/cart page, a search of the
   site's search box when it has a usable one — see [site search](./limits.md#site-search-in-the-journey) —
   and one more same-origin page to flush exit beacons):

   | Scenario | What the browser does |
   |---|---|
   | `do-nothing` | load and wait; never touch the banner |
   | `browse` | full journey; never touch the banner |
   | `dismiss` | close the banner without choosing, then browse |
   | `reject` | reject all, reload, browse |
   | `accept` | accept all, browse |
   | `partial` | accept analytics only, browse |
   | `withdraw` | accept, browse, reopen settings and withdraw, reload, browse |
   | `gpc` | send Global Privacy Control from the first request |
   | `opt-out-all` | GPC + reject + the site's opt-out link, then browse |
   | `opt-out-link` | find and walk the "Do Not Sell or Share" link (never submits) |
   | `return-visit` | reject, then come back in the same profile |
   | `markers` | fake ad-click IDs in the URL; type marker text into search/email fields without submitting |

   Defaults per location: EU/UK get the banner scenarios plus withdraw,
   partial, return visit and markers; US states with opt-out-signal laws get
   reject, accept, the signal, "opt out every way" and the link walk; other US
   states get reject, accept, the signal and markers. Accept is planned in the
   US because a banner there can hold the main trackers until the visitor
   accepts; without that visit they would never be observed from that
   location. Like reject, it is not applicable (one landing) where no banner
   is shown. `--quick` runs a reduced set with shorter visits (US locations
   keep accept).
4. **Banner driving** uses `@duckduckgo/autoconsent` (rules for hundreds of
   consent tools) with its "hide the banner" rules off — hiding is not
   rejecting — and a heuristic fallback. Every click is confirmed by reading
   the stored consent state back (Google Consent Mode, OneTrust, Cookiebot,
   Shopify Customer Privacy, …); a click that didn't change it marks the
   scenario not tested rather than producing misleading evidence.

## From facts to findings

- **Every outside party is identified** — by the knowledge base when
  recognized, otherwise by what it did. The tracker pattern doesn't need a
  name: store a long-lived ID, then send it plus the page address to an outside
  domain on every page. Unrecognized parties showing it are reported as
  *unrecognized, behaves like a tracker* and queued for research.
- **What each request carried** is classified by value, not parameter name:
  the page address, the title, an ID the browser stores (and which cookie it
  came from), ad-click IDs, and typed marker text — plain, URL-encoded,
  base64 or hashed (the normalized-email SHA-256 ad platforms use).
- **What each vendor was told** is decoded from its own requests (Google
  `gcs`/`gcd`/`npa`/`rdp`, Meta Limited Data Use, IAB strings). A Consent Mode
  "advanced" ping with every signal denied is *needs review*, not a violation.
- **Why it wasn't held back** decides the fix: in the site's own markup; an
  HTML tag that leaks past script gating (`<img>`, `<iframe>`, preload); injected
  by another script (a tag manager or app — named); a platform sandbox or
  worker; or a first-party subdomain whose DNS points at a tracker.

Each finding is **violation**, **needs review**, or **exposure** (a wiretap
theory, labelled for counsel). One finding per party per jurisdiction, listing
every location × scenario where it happened. US opt-out findings stay *needs
review* until you set the hand-set `ccpa-covered` / `us-state-privacy-covered`
tag — the law's thresholds aren't observable from a browser.

## The report

`<run>/consent-report.html` (self-contained) and a JSON model next to it:

1. **Cookie and tool matrix** — one compact result per storage item/tool and
   visitor-choice/location combination. Summary totals count the same cells as
   the grid. Red crosses show behavior mismatches, yellow question marks show
   review or missing evidence, green checks show matching behavior or work
   recorded by the reviewer, and gray dashes show untested/allowed results.
   Matching checks and user-completed checks have separate totals.
2. **Selected result workspace** — selecting a symbol opens one panel below
   the matrix with the expectation, observation, next step and progress controls.
   Specific research and verification questions, purpose review, related rule
   findings and technical evidence are available there. The report does not
   repeat full action, cookie and tool inventories below the grid. Original rule
   actions remain available through a collapsed index, including site-wide work.
3. **Checklist and scan coverage** — collapsed sections retain task totals,
   progress backup/restore, tested locations, limitations, original finding counts
   and evidence files. Evidence links need the accompanying run files. Values
   are redacted unless you pass `--raw-evidence`.

The HTML includes a short disclaimer and contextual notes about uncertainty.
Behavior comparisons and legal rule findings remain separate in the JSON.
HTML summary totals describe grid checks; checklist totals describe tasks and
research reviews, which can cover several cells. Those counts can overlap.

Research tools and individual cookies or browser-storage items by recording their
category, actual purpose, owner, information collected/read/stored/sent, consent
or other control decision, decision rationale, and supporting source/reviewer.
Partial answers save as you type and survive reloads. The report lists missing
answers; a review is complete only when each of these fields is answered.
Older category/purpose-only answers are preserved as incomplete research.
Actions have finding-specific questions (such as consent test results, legal
review decisions, or accessibility corrections and verification), plus assignee
and sources. Unanswered action questions are counted independently of task status. Remaining questions update
immediately. Tasks support To do, In progress, Done, and notes; use the checklist
filter to focus on unfinished work. A saved purpose choice recalculates the behavior comparison; it does not change
observations or legal rule findings. Marking a task done does not verify the fix.

Progress is stored in browser local storage under a key specific to the report
kind, site, scan ID, and finding fingerprints. A new scan starts a separate
checklist. Download a progress backup before switching browsers or moving the
report; Restore progress accepts only backups for that report. If browser storage
is unavailable, the checklist still works during the session and explains that a
backup is needed. Reset clears only the current report's progress. User answers
and notes are local work records and do not alter the scan JSON or evidence.

Re-render any time: `complykit report --format consent-html|consent-md|consent-json|consent-changes`.

### Consent tool compatibility and the change list

The words used below, the seven ways a tool gets onto a page, and what each
change asks of a developer are in [Compatibility verdicts and the change
list](./compatibility.md). What the whole report cannot establish is on [What a
scan cannot tell you](./limits.md).

Below the matrix, one row per tool answers "can a consent tool control this, and
what has to change?": the behavior (from the matrix — a tool seen running where
it should be off comes first), the verdict in plain words, how it loads, the
loader (container id, script URL, element at `page:line`) and the change.

The change list groups the work: tags to rewrite (with the exact before/after,
`<script type="text/plain" data-category="…" data-src="…">`), GTM tags to gate
(container, tag id, the consent types to require — see
[Setting up Google Tag Manager](./gtm-setup.md)), consent defaults, platform
settings ([Shopify](./platform-shopify.md), [Wix](./platform-wix.md),
[WordPress](./platform-wordpress.md)), vendor consent calls, leaks to remove,
DNS aliases, accepted exposures and tools that need a look. The same list is
written beside the report as `change-list.md` for the developer (the service
offers it as a download).

One line counts the holes: **"N tools are loaded outside your consent tool's
reach: …"**. A tool counts when its purpose needs consent (or is not classified
yet, or it is a tag manager) **and** it is loaded by an element in the HTML, a
DNS alias or a server (`uncontrollable`), by a loader the scan could not
identify (`unknown`), or by a tag manager without a proven consent setting. A
GTM tag is proven only when it requires consent **and** a denied Consent Mode
default was observed before the container fired. Not counted: tags you can
rewrite, platform-injected tools (the platform's consent setting reaches them —
in the browser only, not server-side), and tools whose purpose needs no consent
(necessary, CDN, captcha, payments, the consent tool), which are listed in a
collapsed "not counted" line. The line always carries what was scanned: pages,
locations, logged out, runs. See [Compatibility verdicts](./compatibility.md#gtm-required-consent-is-counted-only-with-a-denied-default) for how a GTM tag is proven.

## The knowledge base and research

A party is only as well described as the knowledge base's entry for it. complykit
ships a seed set of common vendors (marked *proposed* in reports until someone
confirms them); everything else is learned once, per vendor, and reused on every
later scan of every site.

```
scan ──► queue ──► proposal (cited) ──► a person confirms ──► recognized next scan
```

- **Queue.** Each consent scan adds the parties it could not recognize to a
  research queue, and recognized ones that behaved differently than their entry
  says (a cookie or a sensitive field the entry doesn't list). One item per
  vendor domain, with the evidence from every site it was seen on. The queue
  lives outside the project, at `~/.complykit/kb` (or `COMPLYKIT_KB_DIR`,
  or `--kb-dir`), because it names the sites you scanned.
- **Proposal.** `complykit kb research` asks the Anthropic API (with web search;
  needs `ANTHROPIC_API_KEY`) to research the most widespread open items and
  propose entries **with cited sources**. Without a key, `complykit kb packet <domain>`
  prints the same brief for a person or a coding agent, and
  `complykit kb propose <domain> --file result.json --by <who>` imports the result.
  What complykit observed outranks a vendor's documentation; where they disagree,
  the proposal records it.
- **Confirmation.** `complykit kb proposals` lists what's waiting.
  `complykit kb confirm <id> --by <you>` accepts one, optionally corrected
  (`--category advertising,identity-resolution`); `kb reject <id> --reason …`
  sends it back with the reason in view for the next attempt. A seed entry can be
  confirmed the same way, by its id. Agents never confirm their own proposals.
- **Reuse.** Only confirmed entries join the knowledge base, from the next scan
  on; the queue item is marked resolved.

```bash
complykit kb queue                 # most widespread first
complykit kb research --top 5      # or: kb packet <domain> → kb propose
complykit kb proposals
complykit kb confirm p-pixelco.io-1 --by jeff
```

`complykit kb ingest <run-dir…>` adds earlier runs to the queue; `kb dismiss <domain>`
removes noise (the site's own infrastructure) without an entry. The web
service exposes the same queue and review under **Knowledge base**.

## Configuration

```js
// complykit.config.js
export default {
  properties: [{
    id: 'shop',
    targets: { public: { url: 'https://shop.example.com' } },
    tags: ['ccpa-covered'],               // hand-set, after counsel confirms
    consent: {
      locations: [
        { id: 'de', country: 'DE', proxy: { server: 'socks5://127.0.0.1:1081' } },
        { id: 'us-ca', country: 'US', region: 'CA', proxy: { server: 'http://gluetun-ca:8888' } },
        { id: 'us-fl', country: 'US', region: 'FL' },
      ],
      journey: { paths: ['/collections/all', '/products/example', '/cart'] },
      knowledgeBase: {
        entries: './kb/confirmed.json',   // extra entries for this site (the kb store's are used too)
        overrides: [{ id: 'intercom', categories: ['functional'], note: 'support portal only' }],
      },
    },
  }],
};
```

Running through proxies requires `--authorized`: scanning needs the site
owner's authorization, in writing when residential proxies are used.

## From scan to a verified install

After a consent scan, the service turns the change list into an ordered checklist with a
**Verify** button per change and a rescan at the end; the report's "Your complykit
consent tool: what it controls" section is the result. The whole path, including what
Verify proves and what it cannot, is in [From scan to verified
install](./remediation.md).

## Local-copy mode

`complykit consent --local-copy <spec.json>` proves a change set **before** it is
deployed — the loop's step 5 without touching the site. The scanner applies the
change set to the site's pages inside its own browser (route interception), runs
the normal scenarios on that copy, and reports it the normal way, with one
difference that comes first in the report, the terminal summary and the record:
**LOCAL COPY — not the live site.** Nothing is installed, published or written
anywhere; the live site is not what was tested, and the report says so before any
number.

The spec is a JSON file; paths are relative to it:

```json
{
  "head": "snippet-head.html",
  "replace": [
    { "label": "gtag loader", "from": "<script src=\"https://www.googletagmanager.com/gtag/js?id=G-XXXX\"></script>",
      "to": "<script type=\"text/plain\" data-category=\"advertising\" data-src=\"https://www.googletagmanager.com/gtag/js?id=G-XXXX\"></script>" },
    { "label": "GTM noscript", "pattern": "<noscript>\\s*<iframe[^>]*ns\\.html[^]*?</noscript>", "flags": "g", "to": "" }
  ],
  "serve": {
    "/complykit/v1/complykit-consent.js": "../client/dist/complykit-consent.js",
    "/complykit/v1/complykit-consent-ui.js": "../client/dist/complykit-consent-ui.js"
  },
  "containers": [
    { "url": "https://www.googletagmanager.com/gtm.js?id=GTM-XXXX01",
      "tags": { "110": ["analytics_storage"] },
      "templates": { "__gaawe": ["analytics_storage"] } }
  ]
}
```

- `head` — a file inserted first in `<head>` of every document the site's origin
  serves (after a `<meta charset>` that directly follows `<head>`): the generated
  snippet's Part 1 (`complykit consent-config` writes it as `snippet.html`).
- `replace` — exact-string (`from`) or regular-expression (`pattern`, `flags`)
  replacements on every document: the change list's tag rewrites ("Now" →
  "Becomes") and the leaks to remove. Each one reports how many documents it
  matched; **0 means the "Now" markup is not what the server sends** — check that
  first when a tool stays red.
- `serve` — same-origin paths answered from local files: the tool's core and UI
  file at the snippet's script path.
- `containers` — the change the owner makes **inside Google Tag Manager** ("Require
  additional consent for tag to fire"), simulated on the fetched container the way
  a published container encodes it. By tag id (`tags`) or for every tag of a
  template (`templates`). The container is rewritten only if it reads back as the
  same container; otherwise it is left as served and the record says why.

A spec that applies nothing fails to load; a replacement that never matches, a
file that never gets requested and a container that could not be rewritten are
all in the record (`localCopy`) and in the report's first paragraph — a local copy
that silently changed nothing would read as "the tool did nothing".

This mode exists for the owner's developer and for complykit's own field runs
(`plans/field-notes.md`). It is not a deployment path, and a green matrix on a
local copy is a prediction: only a rescan of the deployed site is proof.

## Limits, stated

The full list, with the exact wording the report uses, is [What a scan cannot
tell you](./limits.md).

The report never says a site is fine. It cannot see server-to-server flows,
what vendors do afterwards, contracts, backend consent records, unvisited
pages, storage inside sandboxed frames, or `navigator.globalPrivacyControl`
inside workers (the `Sec-GPC` header is still sent) — each run lists these as
not tested.

## Agent-readable research questions

The consent JSON includes `researchWorkflow`: explicit questions, evidence
pointers and a cited-answer schema. Agents can research provider, purpose,
information used, recipients and proposed controls, while internal assignment
and legal approval remain human decisions. See [Agent research](agent-research.md)
for the answer format and boundaries.

## Cookie and tool behavior matrix

The first report section compares each storage item and tracking tool across
visitor actions and locations. Select a cell to see the expectation, recorded
behavior and interpretation in the workspace below the grid. Filter to storage,
tools, unresolved results, or matching/completed results.
Each category has a standard behavior per visitor action, under the rules of
the verified location:

| | Before a choice | After rejection / withdrawal | Privacy signal (GPC) / opt-out | After acceptance |
|---|---|---|---|---|
| **EU/UK** — analytics, advertising, session recording, identity | off | off | off (no permission given) | may run |
| **US state with an opt-out-signal law** — advertising, identity (sale/share) | may run | off (the site offered the choice) | off, or restricted mode | may run |
| **US state with an opt-out-signal law** — analytics | may run | off (the site offered the choice) | may run | may run |
| **Other US states** | may run | off (the site offered the choice) | may run (not required) | may run |
| **Necessary, CDN, payments, consent tool** | may run | may run | may run | may run |

Chat, embeds, fonts and reviews are a judgment under EU/UK rules (allowed only when
needed for a feature the visitor uses), so activity there is "review". Restricted-mode
traffic (Google restricted data processing, Meta limited data use) with nothing stored
counts as honoring a US opt-out; consent-denied pings under EU/UK rules stay in review.
Locations outside these rule sets get no automatic expectation.

**A cookie inherits its tool's category.** A cookie set by an identified tool is checked
against that tool's category; a known cookie name (Shopify, Cloudflare, AWS load balancer
cookies on the site's own domain) classifies it directly. Only a cookie of an unidentified
tool stays unclassified — and only those, unidentified tools, and identified tools that
behaved differently than their library entry become research items. A cookie that any
product of the same company declares (Microsoft's `MUID`, Google's conversion linker) is
not treated as different behavior.

A red mismatch describes observed behavior against the standard; it is not an
additional legal finding. Columns appear only for visitor actions that actually ran.
Successful acceptance allows activity, but does not require a tool to run.

Green cells mean no conflicting activity was observed in the captured visit,
with usable evidence and a successful choice where required. Green checks can
also indicate work recorded by the reviewer; cell details retain the original
scan result, and the summary counts completed work separately from observed
matches. Resolving an item’s mismatch task updates that row’s red cells. Answering
its purpose questions changes the expected behavior and recalculates the row
against its recorded activity. Research completion alone never marks a comparison
as passed. Completing a
retest-preparation task never turns missing/untested evidence green. Missing timelines,
unsuccessful choices, unverified locations and capture gaps are not passes.
Scenario-specific capture gaps apply only to their visitor-choice column.
Request phases and repeated storage writes are retained so activity before a
choice is not mistaken for activity after rejection. Cookie cells use that
storage item's observations, not every request from its associated tool.
The JSON includes the same `behaviorMatrix` and `behaviorObservations`.
`report` can rebuild these observations from saved timelines for older runs.

Vendor categories are already supplied for recognized platforms, including
unconfirmed seed entries. Those entries remain labeled as seed knowledge;
research is required for unknown purposes or behavior that differs from an
entry, rather than simply because a familiar seed entry has not been confirmed.
Confirm the specific implementation and controls when needed. Storage-name
patterns suggest individual categories and remain distinct from verified
site-specific use. Library confirmation remains a separate human workflow.


### Classifying a cookie in the report

Each selected cookie/storage item has a visible main-purpose selector:
**Necessary, Functional, Analytics, Performance, Advertisement, Other**.
Performance describes speed, reliability and errors; analytics describes visits
and site use. Optional checkboxes record additional actual purposes. The vendor
library retains granular technical tags (such as session-recording or chat);
`purposeCategories` presents their human equivalents in the machine matrix.

Choosing a purpose immediately recalculates that item's checks using saved
`comparisonFacts`. Optional functional, analytics, performance and advertising
uses follow the report's opt-in expectation. Necessary-only uses are marked
allowed, not verified passes. A necessary purpose never overrides an optional
secondary purpose. An explicit consent decision also applies to a necessary or
Other item. Alternative controls or claimed exceptions remain contextual reviews.
These are comparison policies, not universal legal categories or legal approval.

The category stays visible while detailed research answers are folded. Selecting
or saving it confirms your site-specific purpose decision; editing unrelated
research does not silently confirm a prefilled library suggestion. Old saved
categories migrate to the human vocabulary and keep their answers. Classification
is scoped to the selected cookie/tool and this report. Completed tasks reopen
when their purpose/control decision changes. The original library categories,
observations, legal findings and report JSON remain available unchanged by local
answers; progress backups include main and additional purposes.
