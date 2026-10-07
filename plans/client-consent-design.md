# complykit — client-side consent tool and implementation checks (plan)

Written 2026-10-06 from a design conversation. Extends [consent-design.md](consent-design.md)
§§5–7 (consent tool, guard, platform adapters) with what was missing there: how trackers
actually get onto a page, what that means for control, what a scan can and cannot establish
about an implementation, and what two real demand letters say complykit must catch.

Status: **plan, not started.** The scanner work in §5 comes first; the client package in §6
consumes its output.

---

## 0. The loop, stated again

1. Scan the site (complykit as it exists today).
2. Classify anything unclassified (knowledge base, §4 of the consent plan).
3. The scan produces the consent tool's **configuration** and the owner's **change list**.
4. Owner installs the tool and makes the changes.
5. **Rescan.** The behavior matrix shows whether the tool works.

Step 5 is what no CMP vendor offers: proof. It is also the only honest answer to the
liability question — a consent tool that is wrong makes the client the defendant.
"We verified it with a rescan, on these pages, at this time, from these locations" is the
mitigation and the product.

---

## 1. What the demand letters ask for

Two demand letters and one client's own post-mortem were reviewed on 2026-10-06 (client
material; not in this repository). What they allege, and whether today's scan sees it:

| Allegation | Scan today |
|---|---|
| Trackers fire after "Reject All" (named: Meta, The Trade Desk, AppNexus/Xandr, LiveRamp, PubMatic; the client's own counsel then found GA, GTM and Klaviyo) | **Yes.** This is the behavior matrix: after-reject activity per party. Counsel built the same table by hand from DevTools. |
| Banner says "reject" but doesn't work → fraud / CIPA §631 / CDAFA §502 / ECPA claims (*Pemberton v. Restaurant Brands Int'l*, *Wiley v. Universal Music Group*, *Smith v. Rack Room Shoes*, *Riganian v. LiveRamp*, all N.D. Cal. 2025) | **Yes, the fact pattern.** The regime table maps California to opt-out-signal plus "the site offered a choice, so it must honor it." We do not name statutes per finding; [research-consent-law.md](research-consent-law.md) §2 covers the theories. |
| A search term reached Google Analytics through the page title after the visitor rejected | **Yes.** `page-title` and `search-term` field kinds are detected in outgoing requests — *if* the scan journey includes a search. The default journey may not. |
| Meta Pixel served by a CMS plugin, outside the tag manager's consent signals; cached into pages served to every logged-out visitor | **Yes, the symptom.** `source: injected` + `loadedBy` names the loader, so "Meta is loaded by the plugin, not GTM" is a finding. Scans run logged out, so a cached pixel shows as ordinary pre-choice activity. |
| Non-cookie trackers (cookieless pings) after opt-out; a marketing-email vendor treated the same as GA and Meta | **Yes.** The matrix counts data requests, not cookies. Consent Mode "cookieless pings" count as activity — the conservative reading, and the one counsel took. |
| Meta Pixel on a hosted-builder site sends PageView + referrer to facebook.com; CIPA §631(a) at $5,000 per visit | **Yes** for the on-page half: the request, what it carries (`page-address`, `browser-id`, `_fbp`), and that the platform injected it. |
| Meta's "off-Facebook activity" export proving Meta received and kept it | **No.** Vendor-side data. Outside any scanner. We prove the browser *sent* it; the plaintiff proves the vendor *kept* it. |
| ADA: slider controls without labels, thumbnails without alt text, contrast | **Partly.** The accessibility checker covers contrast, labels and alt text; custom sliders are a gap for every tool, WAVE included. |

**Two lessons to encode:**

- **A consent tool only controls what it loads.** Any tracker with a different loader is a
  hole, and the hole is invisible to the person who configured the consent tool. The scan
  knows every loader. The report must say, in one line: "N tools are loaded outside your
  consent tool's reach," and name them.
- **Counsel's evidence is our evidence.** Both letters rest on a network log and a HAR. The
  timeline and HAR a scan writes are the same artifact, produced before the letter arrives.

---

## 2. How a tracker is controlled — three mechanisms

In order of reliability.

1. **Gate the load.** `<script type="text/plain" data-category="analytics" data-src="…">`.
   The browser ignores a script whose `type` isn't JavaScript. On consent the tool creates a
   *new* `<script>` element with the same source or content and appends it. Changing the
   `type` attribute on the existing element does **not** execute it; it must be a fresh
   element. Works for every tool. **Revocation:** a running script cannot be unloaded. The
   honest withdrawal is: record it, delete the first-party cookies the page can reach, keep
   the script gated from the next page load on, and reload. Every CMP works this way; none
   has a runtime "off" for a gated script.
2. **The vendor's consent API.** Only the large platforms have one: Google Consent Mode
   (`gtag('consent','update',…)`), Meta `fbq('consent','grant'|'revoke')`, TikTok
   `ttq.grantConsent()/revokeConsent()`, Microsoft UET `consent update`, Microsoft Clarity
   `clarity('consentv2',…)`. These support runtime revocation. **Caveat:** Consent Mode
   does not stop gtag loading; it switches it to cookieless pings, and those are still
   requests before consent under the strictest EU reading and under the opt-out reading
   counsel took above. For opt-in locations: gate the load *and* call the API.
3. **Delete cookies after the fact.** Reaches first-party, non-HttpOnly cookies only.
   Third-party and HttpOnly cookies are unreachable from the page. Cleanup, not control.

**Consequence for the adapter database.** Of the ~285 entries in the knowledge base, perhaps
fifteen have an API. For the rest the answer is the same: gate the load. So the per-vendor
research is small and already has fields: `consentApi` and `restrictedMode` on each entry
(filled for 27 seed entries today). The questions per vendor are: API? restricted mode
(`rdp=1`, LDU)? loaded by a platform or tag manager? markup leak in its install snippet?

---

## 3. How trackers get onto a page — seven implementations

Each has a different control point and a different detectability. A scan must know which
one it is looking at before it can say whether the consent tool can control it.

| # | Implementation | Can the tool control it? | Can a scan detect it? | How |
|---|---|---|---|---|
| 1 | `<script src>` or inline `<script>` in the site's HTML | Yes, after the owner rewrites it to `type="text/plain"` | **Yes** | Fetch the raw HTML, inspect every `<script>`: `type`, `src`, inline content matching KB patterns (`fbq(`, `gtag(`, `clarity(`, `ttq.`). Today: `source: markup`. |
| 2 | `<img>`, `<iframe>`, `<link rel=preload>`, `<noscript>` pixel in the HTML | **No.** The browser fetches these before any script runs. No gate is possible. | **Yes** | Today: `source: markup-leak`. The Meta Pixel install snippet ships a `<noscript><img>` by default; most sites keep it. |
| 3 | Through Google Tag Manager | Only through GTM's own consent settings (per-tag consent requirements, Consent Mode defaults before the container loads) | **Mostly** | `gtm.js?id=GTM-…` is a public file. Parse it: every tag, its trigger, whether it has consent requirements. "Tag X in your container has no consent requirement" needs no site access. Also check `gtag('consent','default',…)` runs *before* the container. |
| 4 | Through another tag manager (Tealium, Segment, Adobe Launch) | Through that tool's API | **Partly.** The loader is identified (`loadedBy`); container internals are vendor-specific. | One adapter per tag manager; otherwise "needs a look." |
| 5 | Platform-injected (Shopify, Wix, Squarespace, a WordPress plugin) | Only through the platform's consent API (`Shopify.customerPrivacy`, Wix `consentPolicy`, WordPress Consent API) | **Yes** | Platform fingerprint in the page (`window.Shopify`, `wixBiSession`, `wp-content/plugins/…`), loader is the platform script. Both demand letters were platform-injected cases: a Wix dashboard pixel and a WordPress plugin. |
| 6 | CNAME'd / first-party subdomain (`metrics.site.com` → tracker) | The script tag can be gated; the cookies it sets are first-party and survive | **The CNAME, yes.** What is behind it, no. | DNS lookup. Today: `source: first-party-proxy`. |
| 7 | Server-side tagging / backend forwarding (Meta Conversions API, GA4 server container, Shopify server pixels) | **Not from the browser.** | **No.** Nothing leaves the browser. | Indirect signal only: a first-party collect endpoint (`/g/collect` on the site's own domain). Report as "server-side forwarding is possible and cannot be verified from the browser." |

Two more that are **states**, not implementations:

- **Consent-API misuse.** Meta loaded through GTM but `fbq('consent','revoke')` never
  called; Consent Mode defaults set *after* gtag loaded (an ordering bug); `grant` called
  on page load regardless of the stored choice. Detectable: hook `fbq`, `gtag`,
  `dataLayer.push`, `ttq`, `clarity`, `__tcfapi`, `__gpp` inside the page and record each
  call with its time relative to the visitor's choice. Not done today; cheap to add.
- **Consent already granted.** A consent cookie carried over, a default value of
  "accepted," or a CMP configured to treat silence as consent. Detectable: read the consent
  tool's own cookie and `localStorage` on a fresh profile before any interaction. Scans
  already use a fresh profile per scenario, so a default-accept state surfaces as
  pre-choice activity; naming the cause is the addition.

---

## 4. What a scan cannot tell you — and must say

Every green cell is a claim about **these pages, at this time, from this location, logged
out, N runs.** Never "compliant." The following are outside what a browser session can
establish, and the report has to carry them as qualifiers, not footnotes.

| Blind spot | Why | What the report says |
|---|---|---|
| **Pages not visited** | A pixel on checkout only, a search-results page, a logged-in area. Coverage is per path. | `notTested` / unvisited stays on the first screen. The journey (§2.3 of the consent plan) decides what counts as visited. |
| **Timing races** | A tracker that fires only when the consent tool loads slowly. One clean run proves nothing about a race. | Run each scenario twice, once with throttled network. Report "N of N runs," never "clean." |
| **Caching tiers** | A pixel baked into a cached page for one audience (logged-out visitors, one region, one device class). Scans see one tier. | State the tier: logged out, desktop Chromium, one location. |
| **A/B tests and personalization** | Different visitors get different tags. One scan is one variant. | State that a variant was observed; offer repeat runs. |
| **Server-side (#7)** | Nothing leaves the browser. | "Possible; cannot be verified from the browser. Ask the owner for the server-side checklist" (open decision 7 in the consent plan). |
| **Vendor-side** | Whether Meta kept the data, matched it to a person, or sold it. | Out of scope for any scanner; say so. |
| **Consent-API calls that happen but don't work** | `fbq('consent','revoke')` called, Meta still sends. An implementation check alone passes it. | Behavior is the ground truth; implementation is the explanation. A behavior mismatch always outranks an implementation "compatible." |
| **Other browsers** | Chromium is the evidence standard. Safari carries much of mobile traffic and partitions cookies differently. | Firefox/WebKit runs verify the tool's own behavior (consent plan §5). |
| **Data already sent** | A withdrawal stops future sends. It recalls nothing. | Never imply otherwise in the withdrawal copy. |

**Rule for the summary line.** The report's top-line counts carry the qualifiers inline:
"324 checks working as expected on 14 pages, 1 location, logged out, 1 run each." Per-cell
evidence pointers already exist; the summary needs the same discipline.

---

## 5. Scanner additions: the compatibility finding

A third finding class beside *behavior* (the matrix) and *rules* (the legal findings).
One row per tool, answering "can the consent tool control this, and what has to change?"

| Verdict | Meaning | What the owner does |
|---|---|---|
| `gateable` | Direct script (#1), no markup leak, no platform loader | Rewrite the listed tags to `type="text/plain"` with the generated `data-category`; the tool takes over. We generate the exact tags. |
| `tag-manager` | Loaded by GTM (#3) or another manager (#4) | Fix in the container: consent requirement on tag X, Consent Mode defaults before load. We generate the list of tags. |
| `platform` | Injected by Shopify / Wix / WordPress plugin (#5) | Use the platform bridge; name the API and the dashboard setting. |
| `uncontrollable` | Markup leak (#2), CNAME cookies (#6), server-side (#7) | Remove it from markup, or accept the exposure in writing. No tool fixes this. |
| `unknown` | Loader unidentified | Needs a look. |

**Mechanics that exist:** `PartySource`, `loadedBy`, `cnameOf`, the fresh profile per
scenario, field-kind detection (`page-title`, `search-term`).

**New work, in order of coverage gained on the sample sites:**

1. **GTM container parser.** Fetch `gtm.js` for every container seen, list tags with
   trigger and consent settings, map each tag to a KB entry. Largest single gain: most
   tracking on the sample sites loads through GTM.
2. **Static script-tag inspection.** Raw HTML (not the rendered DOM): every `<script>`,
   `<img>`, `<iframe>`, `<link rel=preload>`, `<noscript>`; type, src, inline matches.
   Produces the `gateable` tag list and the `markup-leak` list with line numbers.
3. **In-page consent-API hooks.** Record calls to `gtag`, `fbq`, `ttq`, `clarity`, `uetq`,
   `dataLayer.push`, `__tcfapi`, `__gpp`, `Shopify.customerPrivacy.*` with timestamps
   relative to banner shown / choice made. Produces the consent-API-misuse state.
4. **Consent-state read on a fresh profile.** Name the consent tool (known cookie names:
   OneTrust, Cookiebot, CookieYes, Complianz, Shopify's `_tracking_consent`, …), its stored
   default, and whether that default grants anything.
5. **Platform fingerprint.** Shopify, Wix, Squarespace, WordPress + which consent plugin.
   Mostly exists for Shopify (consent plan §7).
6. **The compatibility verdict** itself, and the report section: per-tool row, the owner's
   change list grouped by verdict, and the "outside your consent tool's reach" line from §1.
7. **Second run with throttling** per scenario, and "N of N" in the summary.

---

## 6. The client package

`@jeffjassky/complykit-consent` (name open). Vanilla JS, no dependencies, under 15 KB.
Configured from a scan. The four jobs from the consent plan §5 still hold (ask and remember,
hold back, tell loaded scripts, withdraw); the pieces:

- **Consent state store** — first-party cookie + `localStorage`, versioned, with a consent
  record (categories, timestamp, tool version, config hash) posted to a first-party
  endpoint for proof.
- **Banner UI** — must pass complykit's own accessibility checker and the dark-pattern
  rules in [research-consent-law.md](research-consent-law.md) (reject as prominent as
  accept, no pre-ticked boxes, withdrawal as easy as consent, the California opt-out
  wording and icon).
- **Script gate** — the mechanism in §2.1; re-inserts gated tags per category.
- **Vendor adapters** — the ~15 consent APIs in §2.2, each a few lines.
- **GTM bridge** — pushes consent state to `dataLayer` and sets Consent Mode defaults
  before the container loads.
- **Platform bridges** — Shopify `customerPrivacy`, Wix `consentPolicy`, WordPress Consent
  API.
- **GPC** — `navigator.globalPrivacyControl`; honored as an opt-out everywhere in the US
  (consent plan open decision 3, recommended: everywhere).
- **Location** — the browser does not know where it is. Comes from the server, the CDN
  (`cf-ipcountry` and equivalents) or the platform, never from a client-side call to a
  third-party geo service. `regimeFor()` in the scanner decides opt-in vs opt-out; the same
  function ships in the package. Unknown → strictest posture.
- **Config generator** — from a scan: tools, categories, verdicts, the gated-tag list, the
  GTM tag list, the platform bridge needed, and the owner's change list.

**Not in the first version:** IAB TCF v2 (large spec, needs CMP registration with IAB
Europe, only needed for programmatic ads), IAB GPP, the guard (consent plan §6).

---

## 7. Proving it before building the UI

Before any banner styling: close the loop on one GTM-heavy sample site.

1. Generate the config from the current scan.
2. Install the gate and the GTM bridge with a plain, unstyled banner.
3. Rescan from the local location.
4. Watch the matrix. Every row that stays red is either an `uncontrollable` verdict (which
   the compatibility finding should have predicted) or a bug.

If the matrix goes green where the verdicts said it would, the design holds. If it doesn't,
the gap is in §3 or §4, and that is where to look.

---

## 8. Milestones

Continues from the consent plan (M6–M13; M11 "in-house consent tool" is re-sliced here).

| M | Scope | Done when |
|---|---|---|
| **M14** | Scanner: GTM container parser, static script-tag inspection, consent-API hooks, fresh-profile consent-state read, platform fingerprint | On the sample sites, every recognized tool has a loader and a verdict; the GTM tag list matches the container |
| **M15** | Compatibility finding + report section + change list + the "outside reach" line + "N of N runs" summary qualifiers | A report reader can hand the change list to a developer without reading anything else |
| **M16** | Client package core: state store, gate, GTM bridge, vendor adapters, GPC, location hook, config generator; unstyled banner | §7 loop closes on one sample site |
| **M17** | Platform bridges (Shopify, Wix, WordPress) | Loop closes on one Shopify and one WordPress sample site |
| **M18** | Banner UI, accessibility pass, dark-pattern rules, withdrawal flow, consent-record endpoint; Firefox/WebKit verification | Passes complykit's own checks; cross-browser matrix green |

**Pause points:** before M16 runs on any live site (consent plan standing rule); before any
npm publish.

---

## 9. Decisions

**Locked (2026-10-06):**

1. Implementation checks explain behavior; they never override it. A behavior mismatch
   outranks any `compatible` verdict.
2. The report never says "compliant." Every pass carries pages / time / location / login
   state / run count.
3. Gating is the universal control; vendor APIs are additive, used alongside gating in
   opt-in locations, never instead of it.
4. Location never comes from a client-side third-party lookup.
5. TCF/GPP deferred; the guard stays after the client package.

**Open:**

| # | Question | Who |
|---|---|---|
| 1 | Package name and whether it ships from this repository or its own | Jeff |
| 2 | Consent-record endpoint: part of the complykit service, or a per-client endpoint the owner hosts | Jeff |
| 3 | Default journey: include a site search so the page-title / search-term leak is always exercised? (recommended: yes) | Jeff |
| 4 | Throttled second run by default, or opt-in per scan (cost: roughly doubles scan time) | Jeff |
| 5 | How the change list is delivered — in the report, as a file for the developer, or both | agency |

---

## 10. State, configuration and theming (locked 2026-10-06)

**Scans stay ephemeral.** No site has an account. A rescan judges the site fresh, detects
complykit's tool if installed, and never needs the previous run to produce a verdict.

**What persists, and where.** Three layers, three owners:

| Layer | Contents | Lives | Why there |
|---|---|---|---|
| Shared knowledge base | Vendor facts: "Judge.me is reviews," consent APIs, cookie patterns | Ours — the store today, shipped as seed entries (issue #2) | Universal; once anyone confirms it, every site's next scan recognizes it. Covers most of what ever gets classified. |
| **Site workspace** | Site-specific classifications and overrides; task status and notes; the latest generated tool config; pointers to runs | The service's volume, `/data/sites/<registrable-domain>/workspace.json` (same JSON + lock pattern as the KB store) | A team reads and edits the same report; exported reports get shared. Browser `localStorage` is per viewer and carries nothing to a teammate or an export, so it is demoted to an offline fallback. |
| Deployed config | The config inside the snippet pasted on the site | The site itself | The site carries what it runs. The rescan reads it back and compares it with the workspace: "deployed config is behind the workspace." |

Fly supports the workspace with what the service already has: the `complykit_data` volume at
`/data`, daily snapshots kept five days, one machine in one region. If replication ever
matters, Fly's Tigris (S3-compatible) replaces the file layer behind the same interface.
Site names on the volume, never in the repository, same as the KB queue.

**Workspace behavior.** Each classification and task is its own key with a timestamp;
different keys merge, same key latest wins. A rescan of the same domain applies the
workspace automatically (site-specific classifications feed recognition, done tasks stay
done, the report lists what changed since the last run). Exported HTML embeds a dated
snapshot of the workspace plus a link to the live page. Attribution — a name asked once per
browser and stamped on each change — is included because it is cheap; it is not a security
measure, and the service stays open by decision.

**Configuration is inline.** Everything the tool needs is in the pasted snippet: categories
present (from the scan, so a site with no advertising tools shows no advertising toggle),
the vendor list per category for the second layer (from observation, so it is accurate by
construction), gated-tag and GTM-tag lists, the platform bridge required, theme tokens,
strings, location source, `version`, `generatedFrom` (run id) and a hash. No runtime fetch
from us. The script is **self-hosted by default**; a CDN URL is the lazy option, and the
scan notes it, since a request to our CDN before consent is the kind of thing we police.
The config schema is versioned separately from the package.

**Theming is tokens, not an engine.** `font: inherit` by default; a handful of CSS custom
properties (`--ck-bg`, `--ck-fg`, `--ck-accent`, `--ck-border`); three layouts (bottom bar,
corner box, centered modal) plus the per-category settings layer; a string table with
defaults per regime. Guardrails are enforced by the rescan, not the config: reject and
accept with equal weight and contrast, no pre-ticked boxes, required strings present
(California's "Your Privacy Choices" and icon; a reject in opt-in locations), no cookie
wall. A theme that fails is a finding like any other.

**Languages.** English only now. The string table is the i18n mechanism; a second language
is a second table, chosen by `navigator.language` when present. Note for later: in the EU a
banner the visitor cannot read is not valid consent.

**Open questions resolved by this section:** §9 open 2 (consent-record endpoint: part of
the service, optional per client) and open 5 (change list: in the report and as a file).
**Added:** config schema versioning (resolved: separate from the package).
