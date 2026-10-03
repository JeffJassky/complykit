# complykit — consent & tracking evaluation (plan)

**Approved 2026-10-02; M6–M8 built 2026-10-02 (status below).** Build order, in this sequence:

1. **Evaluation and report** — find out what a site actually does, per visitor location and
   consent choice, and show it.
2. **Knowledge base and research workflow** — explain what was found (AI researches, a
   human confirms), remember it, and watch for change.
3. **Consent tool** — an in-house banner/consent manager, configured from the scan.
4. **Guard** — runtime blocking for scripts injected by other scripts.

Everything platform-specific (Shopify, WordPress) is an adapter on top of the generic core
and comes after it. Legal reference: [research-consent-law.md](research-consent-law.md).

## Build status (2026-10-02)

**M6–M9 built** (`complykit consent`, `complykit kb`; guide: docs/guide/consent.md). M10+ not started.

| | Where | Verified by |
|---|---|---|
| Capture (§2.4) | `src/collect/browser/evaluation/` — capture.ts, shim.ts | test/consent-capture.test.ts (multi-host fixture: frame, srcdoc, worker, service worker, exit beacon, insertion chain, HttpOnly, frame storage, redacted HAR) |
| Scenarios + journey + banner driving (§2.3) | scenarios.ts, journey.ts, autoconsent.ts, banner.ts | fixture tests; real Shopify banner (accept/reject confirmed by stored-state readout) |
| Locations (§2.2) | location.ts (I/O), rules/tracking/plan.ts (verdict) | test/consent-proxy.test.ts (lookups + visit through the proxy; mislabeled exit → not tested); unit tests |
| Facts → findings (§2.6) | `src/rules/tracking/` — analyze, fields, decoders, rules | test/consent-pipeline.test.ts (DE + US-CA + a mismatched FR), test/consent-analysis.test.ts |
| Registry (§8) | requirements/tracking.ts, jurisdictions.ts, kb/ | `jurisdictions` + `kind` on requirements; pre-consent rule now cites ePrivacy 5(3) |
| Report (§3) | report/consent-*.ts | test/consent-report.test.ts |
| Knowledge base + research (§4.1–4.2) | `src/research/` (queue, store, prompt), `cli/commands/kb.ts`, researcher in judge/client.ts | test/kb-research.test.ts (scan → queue → cited proposal → confirm → recognized; agent can't confirm; reject reopens with the reason in the next brief; drift) |

**Divergences from this plan, as built:**

- `srcdoc` / sandboxed frames: their *requests* turned out to be observable (context-level
  events see them); what is not observable is their *storage* (opaque origin) — that is
  what's reported as not tested.
- Location verification uses two **live** sources (ipinfo.io, ipwho.is) fetched from inside
  the browser through the location's proxy; no local MaxMind database (needs a licence
  key). Pluggable (`GeoSource`).
- "Markup leaks" are a `source` on findings (`markup-leak`, with its own fix text and
  pattern), not a separate rule — a separate rule would double-count the same party.
- US opt-out findings are needs-review unless the hand-set `ccpa-covered` /
  `us-state-privacy-covered` tag is present (thresholds aren't observable).
- `reject` added to the default US sets: a rejection that leaks is wiretap evidence.
- Proxies require `--authorized` on the command line (the §2.2 authorization rule as a gate).
- Knowledge base ships ~60 **seed** entries (proposedBy `complykit-seed`, unconfirmed);
  `kb confirm <seed-id>` confirms one into the local store.
- The research store is per machine (`~/.complykit/kb`, `COMPLYKIT_KB_DIR`), not in the
  repository: the queue names client sites. Confirmed entries are vendor facts and could be
  promoted into the seed later; not automated.
- Agent proposals are **not** used for recognition until confirmed (seed proposals are —
  they predate the workflow and the report marks them proposed).
- Research runs through two doors: the API (`kb research`, web search, forced-shape
  `propose_entry` tool) and a packet (`kb packet` → `kb propose`) for a person or a coding
  agent. Both are validated identically (cited sources required).
- Drift (§4.2 step 1, "behaving differently than its entry") is checked only where an
  entry makes a claim: undeclared stores, and undeclared sensitive fields.

**Still open for M7's "done when" on real exits:** no Mullvad/residential exits are wired
yet (pause point: before the first residential-proxy run); a full ≥3-location report on a
real site needs those exits.

---

## 0. The loop

```
scan ──► explain ──► remember ──► configure ──► verify ──► watch ──┐
 ▲      (AI + human)   (KB)      (consent tool)  (scan)   (agents)  │
 └──────────────────────────────────────────────────────────────────┘
```

- **Scan:** complykit visits the site the way a real visitor would, from each location, in
  each consent scenario, and records everything the browser does.
- **Explain:** anything not already understood gets researched by an AI agent, which
  proposes what it is with cited sources; a human confirms or corrects.
- **Remember:** the answer goes into the knowledge base once, per vendor — every later scan
  of every site reuses it.
- **Configure:** the consent tool's settings (what to hold back, per category, per
  location) come from the scan's inventory.
- **Verify:** complykit re-scans with the configuration in place and shows what changed.
- **Watch:** recurring agents re-scan sites and vendors and flag changes.

---

## 1. What the tool can and cannot establish

**It can prove what happened in the browser:** which outside parties received data, what
the data was, when it was sent (before the banner appeared, before the visitor chose, after
they refused), and what was stored on the device.

**A finding is a rule for a location applied to those facts.** Some are close to
mechanical — "an advertising vendor received a page view 0.6s after load from a verified
German location, with no choice made" is a violation of the EU rule. Others depend on facts
a browser can't see, such as whether a vendor's contract makes a disclosure a "sale" under
California law; those are marked **needs review** with the evidence attached.

**It never says "compliant."** The strongest statement is "no finding observed" for the
locations, scenarios and pages actually tested.

**It cannot see** — and the report lists these as *not tested*, never as clean:

- data the site's server sends directly to vendors (server-to-server, e.g. conversion APIs)
  — handled as a configuration checklist item, not a browser test;
- what vendors do with data after receiving it;
- vendor contracts;
- whether consent records are stored correctly on the site's backend;
- pages and flows the scan didn't visit (logged-in areas, checkout beyond the cart);
- frames the browser exposes to no observer (sandboxed `srcdoc` iframes).

---

## 2. How an evaluation works

### 2.1 The mechanism: an external browser session

complykit launches a real browser (Playwright driving Chrome — the same idea as Puppeteer),
visits the site as a first-time visitor, and records everything at the browser level
through the Chrome DevTools Protocol: the data a person sees in DevTools' Network and
Application tabs, captured automatically and completely. It drives the visit — waits,
scrolls, clicks the banner's buttons, moves between pages — and runs each scenario in a
brand-new browser profile so nothing carries over.

Why not a script on the page:

| | Script on the page | External browser |
|---|---|---|
| Needs to be installed on the site | yes | no — it just visits |
| Sees requests from embedded frames and background workers | no | yes |
| Sees cookies page scripts can't read (HttpOnly) | no | yes |
| Sees what loads before it | no | yes |
| Can appear to come from another location | no | yes, through a VPN or proxy |
| Repeatable, controlled evidence | weak | yes |

An on-page script has a later, different job: observing real visitors in production (part
of §6). It is not the auditor.

### 2.2 Locations

Sites decide what to show from the visitor's IP address, so a scan from Florida only shows
Florida behavior. Each **location** routes the browser's traffic out through an exit in
that place, with timezone and language set to match.

**Every run verifies its location** before any finding is attributed to it:

1. look up the exit IP in two independent geolocation sources (a local database plus a live
   service);
2. where the site or its consent tool reports what region it thinks the visitor is in, read
   that too (platforms and consent tools often expose it);
3. record the verdict — *verified*, *mismatch* or *unknown*. Only *verified* locations
   produce findings under that location's rules; anything else is reported as not tested.

Country-level geolocation is reliable; state-level is reliable only for exits well inside
a state, so exits are pinned to an allowlist and re-verified weekly.

| Exit option | Cost (approx.) | Use |
|---|---|---|
| Mullvad VPN + `gluetun` container, each browser context exiting through a different Mullvad relay | ~$10–20/mo | routine scans |
| Residential proxies with US-state targeting | ~$40–150/mo, usage-based | evidence shared with clients |
| Cloud regions | per-minute | quick CI checks only — datacenter IPs attract bot blocking |

Scanning a site needs the owner's authorization, in writing when residential proxies are
used. Zero-config `scan --url` uses the machine's own location only, labels it with the
verified region, and prints every other location as not tested.

### 2.3 Scenarios

Each scenario is a short visit (a **journey**): land on the home page and wait for activity
to settle (dwell ≥10s), scroll in steps, open a listing page, a product page and the cart
(never checkout, never submit forms), then make one more same-origin navigation so
"page exit" beacons get flushed. Roughly 70–90 seconds per scenario. Some trackers only fire
after a delay, a scroll or a second page, which is why the journey exists.

| Scenario | What the browser does |
|---|---|
| Do nothing | load and wait; never touch the banner |
| Ignore and browse | full journey; never touch the banner |
| Dismiss | close the banner (X, Escape, outside click), then browse |
| Reject | reject all (first layer if offered; clicks counted), reload, browse |
| Accept | accept all, browse |
| Partial | accept one category only (e.g. analytics), browse |
| Withdraw | accept, browse, note the tracker IDs created, withdraw via the site's settings link, reload, browse |
| Do-not-sell signal | browser sends Global Privacy Control from the first request; banner untouched |
| Opt out every way | GPC + reject + the site's "Do Not Sell or Share" link, then browse |
| Opt-out link walk | find the opt-out link, count steps and required fields, check the page confirms the opt-out |
| Return visit | after reject/accept, come back: choice remembered, no re-prompt |
| Markers | arrive with fake ad-click IDs in the URL; type marker text into search/email fields without submitting |

Default sets per location (configurable): EU/UK run the banner scenarios plus withdraw,
partial and markers; US states with privacy laws add the do-not-sell signal, "opt out every
way" and the link walk; other US states run do nothing, browse, the signal and markers
(the last two because of wiretap-law exposure — see the law doc §2).

The banner is driven by `@duckduckgo/autoconsent` (MPL-2.0, rules for hundreds of consent
tools, opt-in and opt-out), with complykit's own selector table and text matching as the
fallback. Its "hide the banner" rules are turned off — hiding is not rejecting — and every
click is confirmed by reading the stored choice back plus a screenshot.

### 2.4 What gets recorded

For every scenario, a **timeline**: an ordered log, each entry timestamped from the start
of the visit.

- **Every request** from the page, its frames, and its workers — including beacons sent as
  the page closes and websocket messages (session-recording tools use these).
- **What each request carried:** URL parameters and body, parsed into named fields
  (page address, page title, search terms, product, cart value, form values, identifiers,
  hashed emails). Values are stored hashed or redacted; full bodies go only into the
  evidence export.
- **Which script caused it:** the full chain of calls back to the first script, and where
  that script came from.
- **Cookies,** including ones page scripts can't read, and which response or script set
  each one.
- **Storage** (local, session, IndexedDB) in every frame.
- **DNS** for the site's own subdomains — some point at tracking companies.
- **What everyone believed the consent state was:** the consent tool, the platform, and
  each vendor (decoded from its own requests — §2.6).
- **Screenshots** of the banner at each step, and the user actions themselves.

**Current complykit capture has gaps that must be fixed first.** It attaches to the page
only, so it misses requests from cross-site frames, background workers (where some platform
pixels run) and service workers; it never sees page-exit beacons; it reads cookies through a
deprecated call and storage from the main frame only; it doesn't record who set a cookie or
the full initiator chain; and it waits far too briefly. The fixes: listen at the
browser-context level (which sees frames and workers), attach a second DevTools connection
for initiator chains, add a small injected logger for page-exit beacons, read cookies and
`Set-Cookie` headers properly, and read storage in every frame.

### 2.5 Where HAR files fit

A HAR file is a recording format: a log of every network request in a browser session
(URL, headers, cookies sent and received, timing, responses). Chrome DevTools exports one
with "Save all as HAR." complykit **exports** one per location × scenario as evidence,
because it's the standard exhibit regulators and lawyers use, anyone can open it without
complykit, and it can be re-analyzed later. It is not the detection method: a HAR doesn't
say which script caused a request, doesn't contain storage, and misses some background
traffic — the timeline is what analysis runs on.

### 2.6 From facts to findings

1. **Identify each outside party.** Recognized ones get a label from the knowledge base
   (§4). Unrecognized ones are described by what they did. The tell-tale tracking pattern
   doesn't depend on a name: store a long-lasting ID on the device, then send that ID plus
   the page address to an outside domain on every page. An unrecognized party showing it
   is reported as *unrecognized, behaves like a tracker*, with every observed fact, and
   queued for research.
2. **Check the markers.** Search every outgoing request for the typed marker text — plain,
   URL-encoded, base64, and hashed (SHA-256/MD5, including the normalized-email form ad
   platforms use) — and for the fake ad-click IDs.
3. **Decode what each vendor was told.** "Respecting the choice" looks different per
   vendor: Google's requests carry consent parameters (`gcs`, `gcd`) and restriction flags
   (`npa`, `rdp`); Meta's carry limited-data-use fields; some vendors simply shouldn't be
   sending anything. A raw request is never a finding by itself — Google tags, for example,
   still send cookieless pings with every consent type denied — so the decoded state is
   compared with the rule.
4. **Explain why something wasn't held back.** Any non-essential request before consent
   means that script wasn't gated. The reason decides the fix: a tag in the site's own
   markup (mark it up), a script injected by another script such as an app or tag manager
   (gate it at the injector, or block it at runtime — §6), or a platform pixel (fix its
   settings). Some things leak even when everything is marked up correctly — `<img>`
   pixels, preload hints, `<noscript>` tags — and get their own finding type.
5. **Apply the rules for each verified location.** Each finding is one of:
   - **violation** — evidence against a statute or regulation (EU ePrivacy Art. 5(3), UK PECR
     reg. 6, CCPA regulations on opt-out signals…);
   - **needs review** — evidence that a person must judge (restricted vendor modes, unknown
     parties, contract-dependent questions);
   - **exposure** — evidence that feeds a lawsuit theory rather than a regulation (California
     and Florida wiretap statutes), labelled for counsel, never presented as a violation.

---

## 3. The report

Four parts:

1. **Summary grid** — locations × scenarios, with the number of findings in each cell;
   cells that don't apply ("no banner") and locations not tested are shown as such.
2. **Findings** — each one written in plain language, with: location and scenario; *when*
   (timestamp relative to load, banner and choice); *sent* (which fields); *stored*;
   *came from* (the script and where it was loaded); *rule*; *evidence* (HAR excerpt,
   screenshot, timeline).
3. **Inventory** — every outside party seen, recognized or not, and what each did
   (stored, sent, when). The quarterly tracker inventory that regulators have ordered
   companies to keep (law doc §1.5) is this section.
4. **Not tested** — locations, scenarios, pages and data flows the run couldn't cover.

An unrecognized party reads like this:

> **Needs review · all locations · do nothing** — *Unrecognized: `px.example-widget.io`
> behaves like a tracker.* Not in the knowledge base. Loaded by `widget.js` from
> `cdn.example-widget.io`, which a script in the page head adds. Fired 1.4s after load,
> before any choice. Sent the page address and a 32-character ID; stored the same ID in a
> cookie lasting 400 days and sent it again on the next three pages. Evidence: HAR
> excerpt, cookie record, DNS lookup.

The same findings can be sorted two ways: the way regulators test (signal on vs off; on
arrival, after refusal, after withdrawal) and the way plaintiffs build demand letters
(third-party data before any interaction, from a California or Florida location, with the
contents of what was sent).

**Evidence export** per run: HAR per location × scenario, screenshots, timeline, consent
readouts, location verification record, knowledge-base version. HARs contain cookies and
tokens, so exports are redacted by default with raw data behind a flag.

---

## 4. Knowledge base and research workflow

### 4.1 Entries

One entry per vendor or flow signature (a domain + path pattern, a cookie name, or a storage
key), not per site:

```ts
{
  id: 'meta.pixel.event',
  vendor: 'Meta', owner: 'Meta Platforms, Inc.',
  match: { host: /(^|\.)facebook\.com$/, path: /^\/tr\/?$/ },
  categories: ['advertising'],            // necessary · functional · analytics · advertising ·
                                          // session-recording · chat · identity-resolution ·
                                          // fingerprinting · embed · fonts · captcha · cdn · payments
  sends: ['page-address', 'browser-id', 'hashed-email?'],
  stores: [{ name: '_fbp', lifetimeDays: 90 }],
  consentApi: 'fbq consent revoke/grant; limited data use',   // or 'none — must be held back'
  decoder: 'meta',                        // how to read what it was told from its requests
  provenance: { proposedBy: 'agent', confirmedBy: 'jeff', confirmedAt: '2026-10-02',
                sources: ['https://developers.facebook.com/docs/meta-pixel/…'] },
}
```

Sites can override an entry (the same chat widget can be a requested service on one site
and marketing on another). The knowledge base is versioned; each run records the version it
used.

### 4.2 Research workflow

1. A scan surfaces an unrecognized party, or a recognized one behaving differently than its
   entry says.
2. An AI agent researches it: who owns the domain, what the script is, the vendor's own
   documentation, its privacy policy, whether it has a consent API — **with cited sources**
   — and combines that with what complykit actually observed.
3. The agent proposes an entry.
4. A human confirms or corrects it. The entry records who confirmed it and when.
5. Every later scan of every site reuses it.

Agents never confirm their own proposals. Observed behavior outranks documentation when they
disagree, and the disagreement itself is recorded.

### 4.3 Recurring agents

| What changes | How it's caught |
|---|---|
| **Sites** — new apps, theme updates, new tags | scheduled re-scans; a cheap daily check that fetches only the HTML and compares the script inventory; full scenario scans weekly or quarterly; `complykit diff` flags new pre-consent requests, new unknown parties, new trackers under the do-not-sell signal |
| **Vendors** — new endpoints, cookies, consent APIs | a few fixed reference pages per vendor, re-scanned and compared; agents read vendor changelogs and docs |

Agents propose knowledge-base changes with evidence. Any change that would flip a finding's
verdict needs human approval.

### 4.4 Sources and licensing

| Source | Use | License |
|---|---|---|
| Open Cookie Database | starting set of cookie/storage names | Apache-2.0 |
| AdGuard cname-trackers | subdomains secretly pointing at trackers | MIT |
| EasyPrivacy | long-tail request patterns | GPLv3 / CC BY-SA — optional, fetched separately |
| DuckDuckGo Tracker Radar, Disconnect, Ghostery | domain owners and categories | CC BY-NC-SA (non-commercial) |
| Our own entries (§4.2) | everything confirmed | ours |

The non-commercial databases are fine for private, internal evaluation. **This repository is
public with an MIT license**, so their data must not be committed to it: fetch it at run time
into an ignored cache, or make the repository private.

---

## 5. Consent tool (in-house) — after §§1–4

Building one is ordinary engineering; open-source examples to learn from include Klaro! and
orestbida/cookieconsent (both gate scripts via markup) and Complianz on WordPress (rewrites
the page on the server before it's sent).

**Its four jobs:**

1. **Ask and remember** — show the banner, store the choice (categories, timestamp, version)
   in a first-party cookie, and log it to a small first-party endpoint so consent can be
   proven (EU/UK law requires this). Withdrawal updates the record.
2. **Hold back** scripts until their category is allowed. The browser won't run a script
   whose `type` isn't JavaScript, so tagged scripts wait:

   ```html
   <script type="text/plain" data-category="marketing" data-src="https://vendor.example/pixel.js"></script>
   ```

   On consent the tool re-inserts them as real scripts. Using `data-src` instead of `src`
   also keeps the browser from downloading the file early.
3. **Tell already-loaded scripts** what the choice is, in whatever language each speaks:

   | Kind | Protocol |
   |---|---|
   | Standard | Google Consent Mode — `gtag('consent','update',{ad_storage, analytics_storage, ad_user_data, ad_personalization})` |
   | Standard | IAB TCF (`__tcfapi`) — EU programmatic ads; only if a site needs it (official use requires IAB Europe registration) |
   | Standard | IAB GPP (`__gpp`) — US state opt-out strings |
   | Standard | Global Privacy Control — set by the visitor's browser; the tool reads it and treats it as an opt-out |
   | Vendor | Meta `fbq('consent', …)`; TikTok `ttq.holdConsent/grantConsent/revokeConsent`; Microsoft Clarity `clarity('consentv2', …)`; Microsoft UET consent |
   | Platform | Shopify `customerPrivacy.setTrackingConsent(…)`; WordPress Consent API |
   | None | vendors without a consent API can only be held back (job 2) |

4. **Withdraw** — reopen settings, update the stored choice and the log, signal again,
   delete the cookies it can, reload.

**Configuration comes from the scan.** complykit's inventory says which scripts exist, which
category each belongs to (from the knowledge base), and which ones weren't marked up — that
is the tool's configuration.

**Location decision.** The tool must know the visitor's location before any tracker loads,
so it comes from the server, the CDN, or the platform (some platforms expose the region
directly) — not from a client-side call to a geo service, which would itself send the
visitor's IP to a third party. When unsure, err cautious; the exact rules are open (§10),
with these candidates: unknown or failed lookup → strictest posture; VPN/datacenter IPs →
unknown; trust country, be wary of state; honor the do-not-sell signal everywhere; and, as a
per-client option, opt-in everywhere (simplest and safest, at the cost of marketing data
where the law doesn't require it).

**Verified by complykit.** A scan can inject a candidate configuration (or the tool itself)
before the page's own scripts run, re-run the scenarios, and show which findings disappear
and which still need a source fix — before anything ships. Cross-browser: Chromium is the
evidence standard; Firefox and WebKit runs (Playwright drives all three) check the tool's
own behavior, since Safari carries much of mobile traffic.

---

## 6. Guard — after the consent tool

Markup only covers scripts in the site's own code. Apps, plugins and tag managers inject
scripts at runtime, which can't be marked up. The **guard** is a small script that runs
first in the page and holds those back: it watches for scripts being inserted, intercepts
network calls (`fetch`, XHR, beacons, image pixels), and cookie writes, and releases or
mutes them according to the stored choice. After withdrawal it keeps muting scripts that
already loaded. Optionally it reports hostnames it didn't recognize (sampled, no
identifiers, off by default where consent is required first).

It has hard limits, so it complements fixing at the source rather than replacing it. It
cannot:

- stop the browser downloading scripts and images written directly in the page (the browser
  fetches them before any script runs);
- block `<noscript>` pixels, CSS-loaded resources or fonts;
- reach cross-origin frames, workers or platform pixel sandboxes;
- see server-side or first-party-proxied flows;
- touch cookies page scripts can't read;
- recall data already sent.

No maintained open-source guard exists (Yett, the best-known, stopped working when Firefox
removed the event it relied on); commercial ones (e.g. Transcend's airgap.js) are
enterprise-priced. It is verified the same way as the consent tool: injected into a scan,
scenarios re-run, results compared. Design detail (order of operations, must-never list)
is deferred to its milestone.

---

## 7. Platform adapters — after the generic core

An adapter adds what a platform knows that the generic scan has to infer: its consent
settings, its own region detection, how its pixels are gated, where theme code ends and app
code begins, its cookie list, and the fix route for each finding source. Generic
attribution (initiator chain → script URL → host) works everywhere without one.

**Shopify** — readable without admin access: the theme name and version; the pixel list in
the page source with each pixel's declared consent purposes (a pixel declaring none runs
without Shopify's consent gate); app-embed boundaries in HTML comments; where Shopify's
injected head content starts and ends; the banner's configured regions (the Storefront API
query the banner itself makes); the visitor region and consent state (`customerPrivacy`
API, and a `Server-Timing` response header readable with a plain GET — useful for location
verification); `?preview_privacy_banner=1` renders the native banner anywhere for UI
testing without changing behavior. Theme code doesn't run on checkout. Several of these are
undocumented and re-verified per release.

**WordPress** — plugin and theme identified from asset paths; the WP Consent API; settings
of common consent plugins.

Patterns field probes have already shown, each worth a generic rule once the adapter
exists: analytics and session-recording pixels declared with no consent purposes; app
embeds loading trackers before any choice; a session-recording embed that loads first and
passes consent state afterwards; a theme-bundled banner using the platform's old
all-or-nothing consent call with no withdrawal entry point; an opt-out link worded "Your
Privacy Choices" without the icon California requires for that wording.

---

## 8. Registry and legal mapping

- **New instruments:** EU ePrivacy (Art. 5(3)), UK PECR (reg. 6 and the 2026 exceptions),
  CCPA (statute + regulations on opt-out signals, links, dark patterns), the US state
  privacy laws' opt-out-signal requirements with effective dates, Florida §501.715
  (sensitive data), and — as *exposure*, not obligation — California CIPA, Florida
  ch. 934, Pennsylvania WESCA, VPPA. Detail and citations: the law doc.
- **Requirements gain a `jurisdictions` field**, matched against the evidence's *verified
  location*. Property tags (`targets-eu`, `ccpa-covered`, `sells-video`…) stay hand-set; the
  visitor's location is measured, never tagged.
- **Requirements gain `kind: obligation | exposure`** and per-jurisdiction effective dates.
- **Fix the existing rule's legal hook:** `consent.pre-consent-tracker` cites GDPR Art. 7(4);
  the operative rule is ePrivacy Art. 5(3) (EU) and PECR reg. 6 (UK).
- **Fingerprints (v1 is frozen):** v1 ignores interaction state, so the same request seen
  from Germany and California would merge into one finding even though they cite different
  laws. Proposed convention with no algorithm change: one rule per legal family, the
  jurisdiction code in `locator.landmark`, the knowledge-base entry id in `locator.name`,
  site-wide locus. The alternative is a v2 fingerprint with a migration.

---

## 9. Milestones

Numbering continues from the build plan (M0–M5 done).

| M | Scope | Done when |
|---|---|---|
| **M6** | Capture correctness (§2.4 fixes), timeline artifact, scenario runner + journey, banner driving, marker checks, HAR export — local location only. Legal-hook fix (§8). | a fixture page with frame, worker, service-worker, exit-beacon and `srcdoc` traffic: everything observable is recorded, `srcdoc` reported as not tested |
| **M7** | Locations: exits, timezone/language matching, two-source verification, findings gated on verified location, not-tested reporting | a deliberately mislabeled exit produces a not-tested entry, not findings |
| **M8** | Findings and report: identification (recognized + behavior-based unknowns), vendor decoding, rules by location, violation/needs-review/exposure, summary grid, findings, inventory, not tested, evidence export | fixture-tested rules; a full report on a real site from ≥3 verified locations |
| **M9** | Knowledge base + research workflow: entries with provenance and overrides, agent proposals with cited sources, human confirmation, reuse across sites | an unknown party goes scan → proposal → confirmation → recognized on the next scan |
| **M10** | Recurring agents and monitoring: daily HTML inventory diff, scheduled scenario scans, vendor reference pages, `diff` gates | a planted script change is caught the next day; a vendor reference-page change produces a proposal |
| **M11** | In-house consent tool, configured from scan inventory; consent log endpoint; verified by injected re-scans across Chromium/Firefox/WebKit | re-scan shows the targeted findings gone and lists what still needs a source fix |
| **M12** | Guard | same verification; no breakage on the journey (cart, payment buttons, no new errors) |
| **M13** | Platform adapters (Shopify, then WordPress) — can start once M8 lands | attribution and settings checks on a real store of each platform |

**Pause points (human review):** after M6 (capture correctness is the foundation); before
the first residential-proxy evidence run; before the consent tool or guard runs on any live
site; before any npm publish (standing rule).

---

## 10. Decisions

**Locked (2026-10-02):**

1. Build order: evaluation and report → knowledge base and research → consent tool → guard;
   platform adapters after the generic core.
2. The audit mechanism is an external browser session; on-page scripts are only for later
   real-visitor monitoring.
3. Unknown parties are researched per vendor by AI with cited sources, confirmed by a human,
   stored once with provenance, and reused across sites.
4. complykit identifies scripts that weren't held back and why (markup, injected, platform).
5. Location comes from geo lookup with a cautious fallback (rules below are open).
6. Recurring agents watch sites and vendors; they propose, humans approve verdict-changing
   edits.
7. Cross-browser verification is complykit's job.
8. The consent tool is built in-house (supersedes the earlier "buy a CMP" suggestion).

**Open:**

| # | Question | Who |
|---|---|---|
| 1 | Exact cautious-fallback rules for location (§5) | agency |
| 2 | Treat California, Florida, Pennsylvania, Washington as opt-in for session recording, chat and identity-resolution scripts, given wiretap-law exposure? | client + counsel |
| 3 | Honor the do-not-sell signal everywhere in the US, or only where required? (recommended: everywhere) | client + counsel |
| 4 | Fingerprint convention vs v2 (§8) | Jeff |
| 5 | Exit provider tiers and written scanning authorization | Jeff + agency |
| 6 | Evidence redaction and retention policy | Jeff + agency |
| 7 | Server-to-server checklist: format and who fills it in | Jeff |
| 8 | Repository visibility: it is public today — make it private, or keep non-commercial data and client material out of it permanently | Jeff |
