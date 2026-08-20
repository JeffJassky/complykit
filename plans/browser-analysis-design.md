# compliance — browser layer design (2026-08-19)

Companion to [static-analysis-design.md](static-analysis-design.md). How the
Playwright layer actually inspects pages, what it covers, how computed-style
analysis works, and the pitfalls catalog.

## Three inspection channels

Everything in this layer is one of:

1. **In-page evaluation** — `page.evaluate()` runs script inside the live DOM:
   `getComputedStyle`, `getBoundingClientRect`, `elementFromPoint`,
   axe-core injection. Full cascade + composition visibility.
2. **CDP (Chrome DevTools Protocol)** — below-JS access: all cookies including
   HttpOnly (`Network.getAllCookies`), every network request with **initiator
   chains** (who injected what — GTM → tracker attribution), storage,
   `DOMSnapshot.captureSnapshot` (whole rendered tree + chosen computed styles
   + layout rects in ONE call — the perf backbone), the browser's own
   accessibility tree.
3. **Playwright high-level** — locators (pierce open shadow DOM), keyboard,
   `ariaSnapshot()`, screenshots, `browserContext` isolation, storageState auth.

## Check families

### A. Rules-engine pass (axe-core injected)

The ~57%-by-volume baseline. In the rendered DOM this *supersedes* the static
layer's template checks: accessible-name computation runs for real, ARIA refs
resolve, label associations work across component boundaries, landmark/heading
structure is the composed tree, duplicate IDs are post-render. axe results map
through the registry's engine-mapping table; axe's `incomplete` results become
`needs-review` findings routed to C1 — that channel is a feature, not noise.

### B. Computed-style checks (ours, beyond axe)

- **Contrast with escalation.** Deterministic where the effective background is
  a flat color (see pitfalls §1); where it isn't (image/gradient/overlap),
  crop the element's screenshot region → C1 vision judgment. Large-text
  thresholds from computed `font-size`/`font-weight` — reliable.
- **Target size** (WCAG 2.5.8 AA 24px, best-practice 44/48): bounding rects +
  `elementFromPoint` occlusion check (is the target actually hittable).
- **Reflow & spacing** (1.4.4, 1.4.10, 1.4.12): 320px viewport + 400% zoom
  emulation, inject the WCAG text-spacing override stylesheet, then detect
  clipping/overlap via `scrollWidth > clientWidth` and rect-intersection.
- **Focus indicator visibility** (2.4.7/2.4.13): focus each stop, diff
  computed styles and a cropped screenshot pre/post focus. `outline: none`
  with no substitute indicator = violation; ambiguous pixel diffs → C1 (this
  is the focus-ring case from the original concept).
- **Content on hover/focus** (1.4.13): trigger, detect new content,
  test Esc-dismissability.
- **Motion**: autoplaying >5s animation (2.2.2); `prefers-reduced-motion`
  emulation → does the page respect it.

### C. Interaction / behavioral probes

- **Keyboard walk**: Tab through the page recording focus order; compare to
  DOM and visual order (2.4.3); detect traps (2.1.2) and focus loss (focus
  landing on `body`); skip-link presence and function; visible focus at every
  stop; focused element not obscured by sticky chrome (2.4.11).
- **SPA focus management**: route transition → where did focus go; modal open
  → trapped + restored on close.
- **Form probes**: submit empty/invalid → are errors identified and
  programmatically associated (3.3.1/3.3.2).
- **State-space expansion**: each page gets a bounded interaction budget —
  open menus, modals, accordions, tabs — and axe + style checks re-run per new
  state. States covered are recorded in `run.json` (coverage honesty extends
  to states, not just routes).

### D. CDP evidence collection (GDPR)

Fresh profile per sequence. Three-way consent evidence:

1. **Pre-consent baseline**: load, settle, capture cookie jar + storage +
   request log with initiators. Any tracker before interaction →
   `auto-consent` violation with the initiator chain as evidence.
2. **Reject path**: locate CMP (known-vendor selectors: OneTrust, Cookiebot,
   Didomi… + heuristics), click reject-all, reload, re-capture. Anything
   persisting → violation. Click-count and button-metric capture happens here
   (dark-pattern ruleset: click-asymmetry, prominence-asymmetry, pre-ticked,
   buried-reject).
3. **Accept path** (fresh profile): diff against reject → what consent
   actually gates, cross-referenced against the cookie DB classification and,
   later, against policy text (C1 drift).

Plus: fingerprinting instrumentation via `addInitScript` API wrappers
(canvas reads, font enumeration — Blacklight-style); response headers and
cookie flags (Secure/HttpOnly/SameSite); GPC signal emulation → behavior diff.

### E. AI Act rendered checks (feeds C1/C2)

Chat-widget detection (known vendors, `role="log"` patterns, websocket
traffic) → screenshot + DOM capture for the Art. 50 self-disclosure judgment;
AI-content marking checks (meta/C2PA where detectable).

### F. Screenshot substrate

Full-page + per-finding element crops, per route × viewport × color-scheme ×
state. Evidence for C1 whether or not any deterministic rule fired.

## How computed-style analysis actually works — and pitfall #1

`getComputedStyle` returns the resolved cascade per element. Text color:
trivial. **Effective background: the hard part.** An element's own
`background-color` is usually `rgba(0,0,0,0)` — the real background is the
composite of its ancestor stack, and *anything positioned underneath it*.
Ancestor-walk + alpha compositing handles the common case; it breaks on
background images, gradients, overlapping positioned elements (text over a
hero image lives in a different subtree than the image), `opacity`,
`mix-blend-mode`, filters. axe punts these to `incomplete`. Our answer is
architectural: deterministic verdicts only for flat-color stacks, screenshot
crop → C1 for everything else. Never guess a contrast ratio from styles the
cascade can't prove.

## Pitfalls catalog

1. **Effective background** — above. The canonical computed-style trap.
2. **Nondeterminism kills the diff.** Ads, carousels, A/B tests, animation
   timing make findings flap run-to-run, which poisons `comply diff` and the
   fingerprint history. Mitigations: settle = network-idle + double-rAF
   stability + `document.fonts.ready`; freeze animations and clock for
   measurement passes.
3. **Measurement vs evidence profiles conflict** — the subtle one. A11y
   measurement wants animations frozen, motion reduced, deterministic
   rendering; GDPR evidence needs a *pristine* browser (no blocking, no
   emulation quirks) or the captured tracker behavior isn't representative.
   → Two profiles per route, run separately. One profile cannot serve both.
4. **State pollution**: consent clicked in one check leaks into the next.
   Fresh `browserContext` per check family (cheap in Playwright).
5. **Interaction probes are destructive** (modals open, forms dirty): passive
   scans first, each probe in a fresh page.
6. **Overlays occlude everything**: cookie banner blocks visual checks and
   makes screenshots useless for C1 → scan pre- and post-dismiss states,
   tag screenshots with state.
7. **Cross-origin iframes are uninspectable** (Stripe, embeds): screenshot
   yes, DOM no. Recorded as an explicit coverage gap in `run.json`, not
   silently skipped.
8. **Closed shadow roots**: invisible to inspection; log as gap. Open roots:
   Playwright pierces.
9. **Lazy loading**: below-fold content and images don't exist until
   scrolled → scroll-through pass before scanning, else alt/contrast checks
   miss half the page.
10. **Per-element bridge calls are slow**: never loop
    `getComputedStyle` over the wire; batch in-page or use one
    `DOMSnapshot.captureSnapshot`. Target: a page-state in low single-digit
    seconds; parallelize across pages via a context pool.
11. **Bot defense on public properties** (Cloudflare et al.): politeness rate
    limits, real-browser headful fallback; some properties will only be
    scannable authed or from allowlisted infra — a Run coverage fact.
12. **Don't reimplement accessible-name computation** — that way lies a
    decade of edge cases. axe + the browser AX tree own it; `ariaSnapshot()`
    is structure evidence, not a rules engine.

## Mitigation decisions (2026-08-19)

Policy: every pitfall gets the cheapest mitigation that meaningfully recovers
coverage; anything unrecoverable becomes an explicit gap record in `run.json`
(no silent skips). Bounded cost only — no mitigation may make runs unbounded
or flaky itself.

| # | Pitfall | Mitigation | Cost |
|---|---|---|---|
| 1 | Effective background | Flat stacks: deterministic. Image/gradient stacks: **pixel-sample the element's screenshot crop first** — min contrast over sampled background pixels vs text color gives a measured range; clear fail/pass on the range resolves deterministically, only the ambiguous band escalates to C1 | ~free (crop already captured); shrinks C1 volume a lot |
| 2 | Flake / nondeterminism | Settle protocol (network-idle + double-rAF + `fonts.ready`); measurement profile freezes animations (`reducedMotion` + injected CSS) and clock (`page.clock`); ad/analytics domains blocked **in measurement profile only**; plus **confirm-on-new**: a finding absent from the baseline run gets one re-scan of that page before it's reported "new" | ~0.5s/page settle; re-scan cost proportional to new findings only |
| 3 | Measurement vs evidence profile conflict | Keep both, but **evidence profile runs per-property, not per-page**: consent/tracker behavior is site-wide — entry page + a small representative route sample (default 5). Measurement profile covers every scanned page | Evidence pass ≈ constant per property instead of ×routes |
| 4 | State pollution | Fresh `browserContext` per check family; one shared browser process | Contexts are ~ms; negligible |
| 5 | Destructive probes | Passive scans first; each probe family in a fresh page; interaction budget (default 5 states/page) | Extra page loads only for probe families |
| 6 | Overlay occlusion | CMP detection already exists for GDPR pass → capture banner state, dismiss via reject-all, run visual checks post-dismiss; screenshots tagged with banner state | ~free (reuses CMP machinery) |
| 7 | Cross-origin iframes | DOM uninspectable — screenshot the iframe region → C1 visual pass; iframe origins land in the third-party inventory regardless; gap recorded | Cheap; partial coverage recovered |
| 8 | Closed shadow roots | **CDP `DOMSnapshot` pierces shadow trees where the JS API can't** (debugger-level access, same as DevTools) → style/structure checks recover; coordinate-based interaction works regardless (pointer events don't care about shadow boundaries). Verify pierce behavior in the spike; if it fails, gap record | Free if it works; spike item |
| 9 | Lazy loading | Incremental scroll-through before scanning; infinite-scroll detection (height keeps growing) stops after N screens (default 10) and records the cap | 1–3s/page |
| 10 | Bridge perf | One `DOMSnapshot.captureSnapshot` per page-state + in-page batch evaluation; context-pool parallelism for measurement (evidence runs stay serial per property); **hard per-page time budget** (default 20s) — overrun = partial-coverage record, run continues | Engineering discipline; the time budget also caps pathological pages |
| 11 | Bot defense | Politeness rate limit on public properties; headful persistent-context fallback; prefer configured staging/preview target when available; blocked pages = gap records | Slower only where triggered |
| 12 | Accessible-name edge cases | Non-issue by policy: axe + browser AX tree own it | — |

**The pitfall the list missed: matrix combinatorics.** routes × instances ×
viewports × schemes × interaction-states multiplies into hours if applied
naively. Decision — **tiered matrix**:

- *Cheap passive checks* (axe, styles, screenshots): full matrix.
- *Expensive probes* (keyboard walk, form probes, state expansion): default
  viewport × light scheme only — keyboard behavior almost never varies by
  color scheme, and when it does the style checks catch the symptom.
- *Evidence pass*: per-property sample (row 3).

`run.json` records the exercised matrix per check family, so tier trimming is
visible coverage fact, not silent omission.

Resilience defaults: page crash → one retry → gap record; run never dies from
one page. Findings deduped by fingerprint across states/instances so re-scans
and confirm-on-new don't multiply counts.

## Coverage summary

Browser layer = axe's automated WCAG baseline **plus** the behavioral families
axe can't do (keyboard, focus management, reflow/spacing/zoom, hover content,
target size, motion) **plus** the entire GDPR behavioral evidence space
(cookies, trackers, consent flows, dark patterns — invisible to static)
**plus** the screenshot/evidence substrate C1 runs on. With C1 escalation of
`needs-review`, this is the bulk of everything automatable; the remainder
(cognitive/judgment criteria, media alternatives quality, policy substance) is
the manual-only slice the coverage matrix prints.
