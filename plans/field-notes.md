# Field notes — running complykit on real subjects

Per the build brief: after M1 and again after M3, run the tool against the maxed
repo (`~/Projects/Amplify11/MaxMarketing`) and record findings + rough runtimes.
Fix the tool's ergonomics before proceeding if they fight.

---

## M1 — static layer, maxed (2026-08-19)

**Command** (source repo untouched — run written to a scratch dir):

```
complykit static --repo ~/Projects/Amplify11/MaxMarketing --property maxed --cwd <scratch>
```

**Runtime:** 2.45s real (4.51s user) cold, 708 source files scanned. Well under
the <30s cold target in static-analysis-design.md.

**Result:** 302 findings.

| Producer | Count |
|---|---|
| engine (eslint vue-a11y) | 297 |
| rule (inventories) | 5 |

| Confidence | Count |
|---|---|
| needs-review | 297 |
| violation | 5 |

By requirement:

| Requirement | Count |
|---|---|
| wcag22.4.1.2 (Name Role Value) | 198 |
| wcag22.2.1.1 (Keyboard) | 80 |
| wcag22.3.2.2 (On Input) | 16 |
| gdpr.art13 (info to be provided) | 4 |
| wcag22.1.3.1 (Info & Relationships) | 2 |
| wcag22.1.1.1 (Non-text Content) | 1 |
| eu-ai-act.art50.1 (AI interaction disclosure) | 1 |

Top rules: vue-a11y `label-has-for` (118), `form-control-has-label` (78),
`no-static-element-interactions` (38), `click-events-have-key-events` (37),
`no-onchange` (16); `inventory.pii-surface` (4); `inventory.ai-framework` (1).

`has-ai-features` was **derived** from an `@anthropic-ai/*` import (not asserted),
so the Art. 50 lead fired correctly. The tracker inventory found **zero** —
maxed uses first-party telemetry, no third-party tracker packages — which is the
honest result, not a miss.

**Coverage (wcag22aa):** 16 requirements in scope, 13 auto-checked, 3 manual-only
(1.4.11 non-text contrast, 2.4.7 focus visible, 2.5.8 target size — all
rendered-page criteria that are the browser layer's job in M2, printed honestly
as the gap).

### Ergonomics — did the tool fight me?

No fixes needed. Observations carried forward:

- **`--cwd` separation works well.** Pointing `--repo` at the subject and `--cwd`
  at a scratch dir kept the source repo clean (verified: no `.comply` written to
  maxed, `git status` shows only pre-existing untracked files). This is the right
  pattern for the central audits repo.
- **Volume is real but navigable.** 198 findings against 4.1.2 is a lot; the
  per-(file,rule) ordinal anchor keeps them distinct rather than collapsing, and
  a report/`diff` groups by requirement. A future `--severity`/`--confidence`
  filter on `report` would help triage — noted, not blocking.
- **needs-review dominates (297/302),** exactly as the reliability policy intends:
  the static layer undercounts hard violations and routes the inferential bulk to
  the browser/LLM layers. Not noise to silence — leads to confirm.

## M2 — browser passive, maxedmarketing.ai (2026-08-19)

The static field subject (maxed) has no locally-served public site, so the
browser layer was field-tested against the **live** property the user owns,
`https://maxedmarketing.ai` (authorized — it is their own product).

**Command:** browser passive pass, homepage, desktop × light.

**Runtime:** 4.4s for the homepage (settle + scroll + screenshot + axe +
contrast + DOMSnapshot). Well under the 20s per-page budget.

**Result:** 36 findings from 4 artifacts, 0 coverage gaps.

| Requirement | Count |
|---|---|
| wcag22.1.4.3 (Contrast) | 31 |
| wcag22.4.1.2 (Name Role Value) | 5 |

The contrast findings came from the flat-colour path and the pixel-band
escalation; the name/role/value findings from axe. No cross-origin iframe or
closed-shadow gap on the homepage.

**Flake (DoD gate — <2% across 5 repeat runs):** 5 runs produced **identical**
finding sets (36 each), avg Jaccard 100.0%, **drift 0.00%**. The settle protocol
+ animation freeze + measurement-profile ad-blocking hold the page steady. DoD
met.

### Ergonomics

- The dynamic-import of the browser layer means `complykit static` never pays for
  Playwright, and a missing-peer error is a clear install message, not a
  module-resolution crash — verified by running the static tests with the browser
  layer present but unused.
- Determinism came for free once the freeze CSS + `networkidle` settle were in;
  no per-site tuning was needed for a real marketing site.
- The local source repo was untouched (the live URL was scanned; runs written to
  a scratch dir).

## M3 — probes + GDPR evidence, maxedmarketing.ai (2026-08-19)

Full evidence pass (passive + keyboard probes + three-way consent) against the
live property.

**Runtime:** 20.9s for the full pass (passive + keyboard walk + pre/reject/accept
consent capture, each on a fresh evidence context). 0 coverage gaps.

**Consent (DoD — a property with a CMP):** maxed **has a CMP** (heuristic-
detected — not a known-vendor selector). Captured:
- `clicksToAccept: 1`, `clicksToReject: 2` — refusing costs an extra click
  (reject behind a "manage" step). That is a click-asymmetry dark pattern.
- Three phases captured: pre-consent (2 cookies, 23 requests with initiators),
  post-reject, post-accept.

**Keyboard walk:** 60 focus stops, 0 traps.

**Applicability gating in action** (the hand-set tags now do real work):

| Tags | Findings |
|---|---|
| untagged (US-style) | 33 — WCAG only |
| `targets-eu` + `processes-personal-data` | 34 — WCAG **+ `consent.click-asymmetry`** |

The consent dark-pattern finding appears **only** when the property is tagged EU
+ personal-data. An untagged US property gets no GDPR noise — exactly the intent.

### Ergonomics — one fix made mid-milestone

The field run surfaced **duplicate contrast findings**: axe's `color-contrast`
and our `contrast.text` both flagged 1.4.3 on the same flat-colour text (16 + 15
≈ 31, overlapping). Fixed per the design's intent — axe owns flat-colour
contrast; our rule now handles **only** the non-flat cases axe punts to
`incomplete` (text over images/gradients, resolved by the pixel-band pass). After
the fix: axe 16 flat + our rule 12 non-flat = 28 distinct, **no double-count**.
The 12 are genuinely axe-can't-do cases the pixel-band recovered.

## M4 — judge (C1), maxedmarketing.ai (2026-08-19)

The C1 layer adjudicates the deterministic `needs-review` queue: the DOM
localizes (element region), the model only judges the handed crop.

**End-to-end queue build:** a browser scan of maxedmarketing.ai (5 routes, 69
findings) produced **22 adjudicable needs-review items** — the non-flat contrast
crops the pixel-band left ambiguous. `complykit review --dry` reports the queue
without spending a token; with a key, `review` crops each region, pHash-dedupes,
checks the verdict cache, and adjudicates the misses.

**DoD — 2nd run of an unchanged site ≈ 0 tokens:** proven deterministically in
`test/judge.test.ts` with a counting stub adjudicator — the first `review` makes
N model calls, the second makes **0** (all cache hits), and pHash dedupe collapses
three identical crops to a single call. A bumped `rubricVersion` invalidates the
cache (a re-judge), as intended.

**Not run against the live API here** — the real Anthropic call (`client.ts`) is
gated behind `ANTHROPIC_API_KEY` and costs money; the harness is exercised with a
stub, which is what proves the cache economics. Publishing/paid runs are a
separate, explicitly-approved step.

## M16 — proving the loop on a GTM-heavy WordPress sample site (2026-10-07)

Design §7: generate the config from a scan, install the gate + GTM bridge + banner,
rescan, and see whether the matrix goes green where the verdicts said it would. Done
on one approved sample site (WordPress, two GTM containers plus gtag destinations,
Meta and TikTok pixels, a chat widget, session recording, a CRM loader) without
touching the site: `complykit consent --local-copy` (added for this) applies the
owner's change set inside the scanner's own browser — snippet first in `<head>`, the
change list's tag rewrites, the tool's two files served at the snippet's path, and
the GTM-side "require additional consent" settings simulated on the fetched
containers — and the report leads with "LOCAL COPY — not the live site".

**Location.** One verified location, this machine (US, opt-out-signal by law). Real
EU/UK locations are still pending (issue #1). Two injected runs: (1) the generated
config as is (`regimeSource: meta`; the page has no meta, so the tool fell back to
opt-in as D7 says), (2) the same config with `regimeSource` fixed to opt-in, so the
gate, GTM bridge and adapters are judged as for an EU visitor. The two runs agree
cell for cell; run 1 used `--runs 2`, run 2 one run per scenario.

**Before → after.** Baseline summary row `6X · 6X · no banner · 5X · (crashed)` (do
nothing, browse, reject, GPC, markers; X = exposure items for counsel) → `1X` in every
cell with the tool installed (seven scenarios incl. accept and withdraw; the one
remaining X is the same vendor everywhere, see below). Cookies before any choice: 27 →
6. Every gate rewrite matched the served HTML on every page (5/5 replacements, 60
documents), both containers rewritten in flight (55 + 5 tags).

**D10 proof.** Tool detected on every landing, config `ok`, hash equals the
workspace's, driven by exact selectors only (reject, accept, withdraw via the Privacy
choices control). Per vendor, both runs:

| result | count | who |
|---|---|---|
| controlled (held in every denied visit, ran after accept) | 3 | chat widget (GTM Custom HTML), Google Ads (GTM), Microsoft UET (GTM) |
| not controlled | 6 | Meta Pixel, TikTok Pixel, GA4, DoubleClick, session recording, Google Fonts |
| not observed | 6 | CRM loader + 5 necessary (CDN, captcha, static) |

Every remaining red cell is accounted for:

- **Meta / TikTok base code (every scenario).** Both loaders are `<script defer
  src="data:text/javascript;base64,…">` — a "delay JS" optimizer's output — which the
  markup inspection skips, so no gate rewrite was generated for them and removing the
  `<noscript>` leak changed nothing. Scanner gap, issue #47. The adapters did their
  part: zero pixel event sends in any denied visit (no `/tr`, no TikTok events); what
  remains is the base code and its config fetch carrying the page host.
- **GA4 / DoubleClick (after withdrawal).** Holding the external gtag.js loader is not
  enough while GTM is on the page: a container that sees `gtag('config','G-…')` in the
  dataLayer loads that destination itself (`cx=c`), it is not a container tag, so no
  "require consent" setting exists for it, and under denial it sends cookieless pings.
  Verdict/generator gap, issue #48 (the config snippet is also base64 here, #47).
- **Session recording (after withdrawal).** Two flushes 0.4–0.8 s after the withdraw
  click, before the tool's reload — inside the 1 s grace, but counted. D10 attribution
  bug, issue #52. Nothing after the reload.
- **Google Fonts.** Loaded by stylesheet; the generator wrote `control: gate` with no
  rule. Generator bug, issue #49 (the limit itself is documented).
- **CRM loader (not observed).** Released after accept and fetched on every page, but
  the vendor's endpoint answers HTTP 410 JSON, which the browser blocks (ORB) — it is
  dead on the live site as well. Correct result; wording issue #53. The duplicate-id
  trap the generator warned about on that tag was real and is now fixed in the gate
  (the released twin takes the id), though it was not what stopped this one.
- **Throttled repeats.** Every second (Slow-3G) run of a scenario with a banner flow
  exceeded the 300 s budget on this 400–700-request site. Issue #50.

**Verdict on §7.** The design holds where the verdict said "gateable" or "tag-manager
with a consent requirement": those went green. Where it stayed red, the gap was in §3
(two loader shapes the markup pass does not see; a GTM destination that is not a tag)
and in one D10 edge, not in the gate, bridge or adapters. Next: #47 and #48 are the
two that would turn the remaining cells; then the same loop on a Shopify site (E4) and
from a real EU location (#1). A local copy is a prediction — only a rescan of the
deployed site is proof.

Ergonomics: the local-copy spec was hand-built from the report JSON and the generated
files by a scratch script; `consent-config` should emit it (#51). The environment lost
its Playwright browser mid-session; `COMPLYKIT_BROWSER_CHANNEL=chrome` (new) drove the
installed Chrome instead, and the record names it.

## M17 — closing the loop on a Shopify and a WordPress sample site (2026-10-07)

Same method as M16, on two more approved sample sites, nothing installed on either:
baseline consent scan → `consent-config` → a local-copy spec (snippet first in `<head>`,
the change list's tag rewrites, leaks removed, GTM consent simulated) → `consent
--local-copy` rescan with the generated config as the workspace config → a second run
with `regimeSource` fixed to opt-in → every remaining red cell classified. One verified
location (this machine, a US state), Chrome through `COMPLYKIT_BROWSER_CHANNEL`.

### The Shopify sample site

A theme with Shopify's Web Pixels Manager (Google & YouTube, Meta and TikTok app pixels,
a session-recording app that ships both a theme app embed and its own web pixel), the
Customer Privacy API present, no banner. The generator chose `regimeSource: platform`
and `control: platform` for the ten platform-injected tools; the change list had one
tag to rewrite (the session-recording embed) and one video `<iframe>` to deal with.

- **The bridge works.** `setTrackingConsent` all-false ~50 ms after the reject click
  (and, under opt-in, ~1–2 s into the first page before any pixel loaded); Shopify's
  Google app answers with `consent update` denied + restricted data processing, the
  Meta app with Limited Data Use, within ~200 ms. No Meta `/tr` or TikTok event request
  in any visit — the app pixels do not send events from the browser at all.
- **Before → after.** Platform regime (the store reports a US region → opt-out, so
  pre-choice activity is allowed): the row stays X in every column (FL exposure theory).
  Fixed opt-in: cookies before a choice 24 → 6, the X count drops in every column.
- **D10 proof** (both regimes, 2 + 1 runs): 2 controlled (Google services; UET, held via
  the session-recording gate), 8 not controlled, 10 not observed (7 necessary).

Red cells:
- **Predicted — Shopify's own analytics.** Monorail / OTLP requests go out on every page
  whatever the stored consent. No bridge reaches them (guide: "what Shopify itself sends
  while denied" is undocumented).
- **Predicted — the first page view.** Meta and TikTok app pixels load their base code
  and config and write their first-party id cookie on the first page(s) of a denied
  visit and on the first page after a withdrawal reload, before Shopify applies the
  stored "no" to that page; later pages do not load them. The guide's "first page view"
  limit, observed.
- **Predicted — an app pixel without declared purposes.** The session-recording app's
  own web pixel loads on every page regardless of consent.
- **Gap — #54.** The Google & YouTube app pixel sets a Consent Mode default from
  Shopify's *region* rule (granted, once Shopify's banner is off) on every page, queues
  its page_view, then updates to denied; gtag processes in order, so Ads conversion and
  remarketing hits leave with `gcs=G111` after a refusal and under GPC.
- **Gap — #57.** A reject that revokes a granted default (opt-out regime) gets no grace:
  the session-recording vendor's flush 0.05–1 s after the click counts as "after reject".
- **Gap — #55, #58.** The video `<iframe>` was held by the gate's `data-src` form in every
  denied visit and loaded on accept, yet the verdict says "no consent tool can hold it";
  the session-recording tag lives in a theme app embed the owner cannot edit, and the
  change list points at "the template".
- **Fixed in E4.** The tool's own withdrawal cleanup (`Max-Age=0`) and a vendor expiring
  its cookies were counted as storage *writes* after rejecting; that alone had made Meta
  and TikTok red on reject.
- **Knowledge base.** The Merchant Center analytics entry decodes no Consent Mode state,
  so its `gcs=G100` pings count as data; the entry needs the Google decoder.

### The WordPress sample site

Two inline gtag snippets and a GTM container (one Custom HTML tag), Meta and Quantcast
base code inline with `<noscript>` pixels, and an existing consent plugin (served from the
site's own plugin folder, with Consent Mode) that holds every tag until accept. No WP
Consent API on the page, so the WordPress bridge stays inert — as expected.

- **The baseline hid the site.** With the existing tool holding tags, the default
  scenarios saw 3 tools; an accept visit saw 39 (Quantcast's cookie-sync cascade
  included). Two scanner faults showed up and are fixed: the consent plugin's release of
  every held tag was filed as "injected by the wordpress platform", and the plugin was not
  identified (not an outside party, so the generator never said "remove it"). The
  generator now flags a fingerprinted consent plugin and asks for an accept visit.
  Tracing a release back to the tag it held is #56.
- **Before → after.** `none observed` in every column before (the existing tool) and
  after (ours, existing tool removed in the local copy), 0 findings; cookies before a
  choice 1 → 0. Eight replacements matched on every document; the container was rewritten
  in flight.
- **D10 proof** (both runs agree): 3 controlled (Meta, DoubleClick, UET), 2 not controlled
  (GA4, session recording — withdraw only), 32 not observed (28 vendors with control
  none held in every denied visit, 24 of them seen after accept: held because the tags
  that load them are).

Red cells: the session-recording flush 0.4–1.0 s after the withdraw click and one GA4
`user_engagement` ping at +0.9 s are #52; the same GA4 ping at +1.3 s in the second run
is outside the grace — the already-running tag's own consent-denied ping, predicted
(withdrawal un-runs nothing).

### Verdict on M17

Done when "loop closes on one Shopify and one WordPress sample site": on the WordPress
site yes — the change set plus the tool reproduce what the existing consent tool did,
with three vendors proven and the rest held. On Shopify the bridge does its part, but
"control: platform" is not a green light: Shopify's own analytics, the first-page pixel
race and the Google app's granted default are outside the theme's reach, and the report
says so per cell. #54 is the one that changes an outcome. A local copy is a prediction;
only a rescan of the deployed sites is proof, and real EU/UK locations are still #1.
