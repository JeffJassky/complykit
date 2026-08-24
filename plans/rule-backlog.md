# Rule backlog — gaps surfaced by working the remediation waves

Each entry names the moment in a real triage where complykit was blind and a
human (or an agent) had to do the work by hand. Ranked within each tier by
value ÷ build cost.

## Tier 1 — the artifacts already exist; rules are cheap

### 1. Target size (WCAG 2.2 — 2.5.8, AA)
The focus-walk already records a document-absolute `box` for every stop, and
axe results carry boxes too. A rule flagging interactive targets smaller than
24×24 CSS px (with the spacing exception approximated by neighbor-box
distance) is nearly free — and 2.5.8 is a NEW 2.2 criterion most tooling
still misses. Today it sits in coverage as unchecked.

### 2. Token-pair contrast ledger (static+browser hybrid)
The session's biggest single sweep (24 defects, one line) came from hand-run
analysis: group contrast findings by (fg, bg), attribute to CSS custom
properties, find the definition site, do the math. The collector already
attributes matching vars per candidate. Invert it into a first-class report:
aggregate failing (fg-token, bg-token) pairs across the whole scan with usage
counts and definition sites (`tokens-dark.css:26`), and propose the nearest
passing palette step. This turns "452 findings" into "3 token decisions" —
the highest-leverage artifact complykit could emit.

### 3. Placeholder-only labeling (static)
Wave 4 repeatedly hit controls whose ONLY name source was `placeholder`. We
reused that text as aria-label (legal), but placeholder-as-only-label is
itself a flag-worthy pattern (vanishes on input; low-contrast). Neither the
lint plugin nor axe reports it as such. Cheap Vue-template rule: control has
placeholder, no label/aria-label/aria-labelledby → needs-review.

## Tier 2 — new browser probes (family C), directly from wave pain

### 4. Dialog dismissal probe (Escape parity)
We spent most of a wave hand-verifying "does Escape close this?" across ~20
dialogs — pure mechanical browser work. Probe: detect overlay/dialog
appearance (role=dialog, aria-modal, or fixed full-viewport element appearing
after a click), then press Escape and assert it disappears; flag
pointer-only-dismissable dialogs. This converts the exact judgment we made by
hand ("dismiss affordances need keyboard parity") into a measurement.

### 5. Focus restoration probe
Companion to #4: after a dialog closes, does focus return to the trigger (or
at least not fall to `<body>`)? The focus-walk already detects focus-lost-to-
body generally; scoping it around dialog open/close cycles catches the
specific failure users actually hit. (The app's `useDialogA11y` does this
right — nothing verifies it stays right.)

### 6. Content on Hover or Focus (1.4.13)
The sparkline/InfoTip work was all about hover-content parity. Probe:
elements that reveal content on hover — check the content is also reachable
by focus, dismissable (Esc), and persistent (hoverable itself). Currently
manual-only in coverage; partially probe-able.

### 7. Composite-widget arrow-key integrity
We ADDED arrow-key selection to a typeahead that had none; static lint could
only say "option must be focusable" (and was half-wrong about it). Probe:
find role=listbox/menu/tablist, focus the managing element, press arrows,
assert active option/descendant changes. Distinguishes real composite
widgets from ARIA-decorated dead markup.

## Tier 3 — adjacent-quality rules (worth discussing scope)

### 8. Inert-control detector (static, Vue-aware)
An unlabeled checkbox turned out to be wired to NOTHING (no v-model, no
handler, no bound state) — rendered UI that silently does nothing. Not a
WCAG criterion, but it surfaced during an a11y pass and is exactly the kind
of thing a template-AST rule can find: form control with no binding and no
listener. Possibly its own "quality" ruleset rather than a compliance one.

### 9. Reduced-motion coverage (2.3.3)
The measurement profile forces reduced-motion for stability — meaning we
never observe what motion-sensitive users get. An evidence-pass cell WITHOUT
the freeze could diff animation activity under `prefers-reduced-motion:
reduce` and flag ignored preferences.

## Tier 0 — instrument correctness gaps found in the first real engagement

These are not new rules; they are things the harness got WRONG on the first app
it ever scanned in anger, all now fixed. Recorded because each is a class of
assumption worth testing on every new target.

### A. The document does not necessarily scroll  (FIXED)
An app shell that pins the document (`body{overflow:hidden}`) and scrolls an
inner container defeated three subsystems at once, silently: `fullPage: true`
captured one screen, the lazy-load scroll pass scrolled nothing (so below-fold
content never even loaded), and every pixel measurement of a below-fold element
clipped to zero and reported "could not be proven". On the first target this hid
~84% of the page (4212px of overflow behind an 812px document). Detection is
framework-agnostic: `scrollHeight - clientHeight > 32` plus a computed
`overflow-y` of `auto`/`scroll`. Regression test: test/stitch-capture.test.ts.

### B. Geometry needs ONE definition shared by every collector  (FIXED)
Four collectors independently computed `rect + window.scrollY`. One shared
`contentBox()` (rect + the scroll offset of every scrolling ancestor), installed
per context, is now the single definition. Cross-producer matching is geometric,
so a drifting definition silently breaks reconciliation between engines.

### C. Capture time != measurement time  (FIXED)
See triage-methodology.md. Measurement now runs per band inside the capture.
Worth a standing self-check in any future pixel rule: could the page have moved
between the image and the box?

### D. Suppression must be counted  (FIXED)
Reconciliation drops findings. The run now prints
`N cleared / upgraded / downgraded / ceded`. Any future rule that suppresses
another producer's output should do the same.

## Meta-lesson backing the tier order

The waves showed the highest-value additions aren't new detectors of new
harm — they're (a) rules that AGGREGATE existing findings to the decision a
human must make (token ledger), and (b) probes that mechanize verification
we ended up doing by hand (Escape, focus return). Detection was rarely the
bottleneck; judgment-shaped output was.

## Rule ideas added by the scroll-container engagement

### 10. Content reachable only by an inner scroller (coverage, not WCAG)
The scanner now handles it, but a SITE that hides its main content behind a
non-standard scroll container also breaks browser find-in-page, anchor links,
and some AT navigation. Worth a needs-review flag naming the container.

### 11. Capture-completeness assertion (self-check)
After capture, assert that the union of captured bands covers the scrollable
extent, and that a sample of known text elements lands on non-empty pixels.
A tool that cannot see the page should say so loudly rather than report zero
findings for the part it never saw.
