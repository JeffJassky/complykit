# Triage methodology — from diagnostic JSON to action plan

Field-tested notes from a full triage of a real app (452 defects → validated
remediation plan). These are the GENERALIZED patterns — no framework, schema,
class-name, or styling assumptions — destined to become the `report-triage`
skill. The input is `report.json` (the aggregated defect model the HTML report
shares); the output is an action plan ordered by leverage, with every sweep
claim validated by rescan.

## Mental model of the data

- One entry per **defect**; identical sightings are pre-rolled-up. `sightings`,
  `routes`, `cells` carry the spread. Evidence comes from the richest sighting.
- Three producer classes with different trust semantics:
  - **static linters** — file-anchored, cheap, and *config-sensitive*: their
    defaults encode opinions, not law
  - **browser engines** (axe) — runtime-anchored, generally reliable on what
    they assert, punt hard cases to needs-review
  - **first-party measurement** (pixel-band) — highest confidence where present
- `confidence` is an axis, not a detail: `violation` = asserted, `needs-review`
  = the instrument itself is unsure. Never mix them in a count you act on.
- A defect count is a *claim by an instrument*, not a fact about the app.

## Order of operations

The sequence matters — each step changes what the next step means.

### 1. Landscape (cheap, do first)
Counter by `requirementId`, then by `ruleId`. Tells you where the mass is and
which instruments produced it. Also grab `counts`, route spread, `gaps`.

### 2. Audit the instrument BEFORE trusting the mass
The single highest-leverage move. Any rule contributing an outsized share of
defects gets its own trial before its findings do:
- **Check rule defaults against the actual spec.** (Case: a label rule whose
  default demanded BOTH association mechanisms when the spec accepts either —
  62/118 findings were spec-valid code. One config line, zero app changes.)
- **Check for deprecated rules** — enable-everything configs run retracted
  guidance. (Case: 16 findings from a rule its own plugin marks deprecated.)
- Quantify the over-report hypothesis from the data itself before touching
  config: regex-probe the stored snippets for the pattern the rule *should*
  accept, count matches → that's your predicted drop. Then fix, rescan, verify
  the drop matches and that *unrelated rules stayed flat* (the control group).

### 3. Per-harm analysis — pick the aggregation that matches the fix shape

**Color/contrast** → group by (fg, bg) combo:
- Normalize colors first (hex + `rgb()` arrive mixed; lowercase, one format).
- Attach the var-attribution sets per combo (union across defects).
- Classify each combo into a treatment bucket:
  1. **token value** — combo maps to a design token; fix the token's value
  2. **token selection** — colors are tokens but the *wrong* token for this
     surface; change which one the component uses
  3. **literal/inline** — no token matches; per-component edits
  4. **non-flat/gradient** — no single ratio exists; one *design decision per
     surface* (darken stops, scrim, or lighten text) clears its whole bucket
- For a token-value hypothesis, verify in the repo before recommending:
  - find the **definition site**; check theme scoping (a dark-theme alias can
    move without touching light)
  - do the **contrast math** for the replacement against EVERY background the
    token sits on in the data (conflict check — a value that fixes dark bg can
    break light bg); prefer an existing palette step that passes over a novel hex
  - edit the **semantic alias, never the primitive** — primitives fan out to
    uses you haven't measured

**Structural rules (labels, keyboard, focus, ARIA)** → concentration + shape:
- Defects-per-file distribution (top-N share). Tight concentration = component
  work; flat spread = pattern work.
- Route-spread per defect: seen on many routes ⇒ shared chrome (one fix, wide
  blast radius); seen on one ⇒ page-local.
- **Read 3–5 snippets per rule.** The repeated shape tells you the fix class:
  the same wrapper markup everywhere ⇒ shared component / codemod; assorted
  one-offs ⇒ per-component punch list. (Case: two keyboard rules fired in
  pairs on the same elements — half the "count" was one pattern: clickable
  `<div>`s, two shapes, one shared-component fix.)

### 4. Every hypothesis gets a falsifiable prediction
State it as: "this change clears bucket X (~N defects), leaves bucket Y
untouched." Apply → rescan → diff buckets. The untouched buckets are your
control group; if they moved, coverage changed, not the code. Survivors of a
sweep falsify it for their sub-bucket and demote to component-level treatment.

### 5. Stability check before trusting any diff
Compare route/cell coverage between runs FIRST. A run that lost auth, hit a
different server, or crawled fewer pages produces a flattering diff that means
nothing. (Case: a static-only run "improved" 452→221; the browser layer had
crashed — recorded honestly in `gaps`, which is where to look.) Buckets that
reproduce run-over-run under equal coverage mean the fingerprinting is stable
enough to attribute future deltas to your fixes.

## Query patterns that earned their keep

- `Counter` over: requirementId, ruleId, file (path only!), producer,
  normalized (fg,bg), confidence.
- Var-attribution set union per color combo.
- Route-spread threshold (e.g. ≥8 routes) as a shared-chrome detector; also
  sightings/defects ratio (high = chrome).
- Snippet regex probes to classify finding shapes into fix classes.
- Top-N-file share as the global-vs-component discriminator.
- Contrast math (WCAG relative luminance) inline in the analysis script —
  propose AND verify replacement values, don't eyeball.

## Pitfalls (each cost a wrong number before being caught)

- `file` may carry `:line` — strip it before per-file grouping or every
  static finding becomes its own "file".
- Var attribution is **exact-value resolution, not usage proof**: a listed var
  resolves to that color in that element's context; the element may use a
  different var (or a literal) with the same value. Multiple matches = confirm
  in source before editing. Tolerance-matching (nearest var to a sampled
  pixel) is worse than nothing — it accuses the wrong token confidently.
- Mixed color formats break grouping silently — normalize first.
- Comparing runs with unequal coverage (routes, cells, auth state) — check
  `gaps` and route counts before reading any before/after.
- Counting `needs-review` and `violation` together inflates urgency; lead
  with measured violations, schedule needs-review for human/LLM adjudication.
- Environment prereqs are findings too: a scan that lands on a login page
  reports honestly but measures almost nothing — verify target liveness and
  auth freshness before scanning, and read `gaps` after.

## Treatment taxonomy (order the plan by cleared ÷ (risk × effort))

1. **Instrument calibration** — scanner config; zero app changes; validate by
   rescan with unrelated rules as control
2. **Token value change** — theme-scoped one-liner; widest app-side sweep
3. **Token selection change** — component uses the wrong token
4. **Pattern fix** — shared component/composable + mechanical migration
5. **Per-component punch list** — literals, one-off structure fixes
6. **Design decision per surface** — gradients/scrims; needs a human call
7. **Singletons** — list them; don't let 1-count items clutter the sweeps

Ship the plan with the method visible: each item states its hypothesis, the
evidence that tested it, the predicted delta, and (after rescan) the observed
delta. A plan whose numbers were validated once is a baseline forever.

## Execution patterns (learned working the waves, not just planning them)

- **A bucket can be an instrument defect wearing an app costume.** When findings
  contradict work you KNOW shipped (here: focus-visible findings on components
  that already had focus rings), re-derive what the instrument actually
  measures before editing the app. (Case: rings lived on an ancestor via
  `.card:has(a:focus-visible)`; the probe read only the focused element. The
  fix was the probe.) Corollary: when extending such a heuristic, keep its
  false-positive discipline — ancestor *outline* counts as a ring, ancestor
  *box-shadow* does not (cards carry static shadows).
- **Dismiss-scrim taxonomy** (generalizes to any framework):
  - empty sibling backdrop (no children; dialog is a sibling) → hide it from
    assistive tech (`aria-hidden="true"`) — it is pure pointer affordance
  - wrapping overlay (dialog is a child, dismiss on self-click): do NOT
    aria-hidden it (hides the dialog) and do NOT role="presentation" it —
    presentation on an element with focusable descendants trips its own rule
    (`no-role-presentation-on-focusable`; we shipped that mistake and the next
    full pass caught it). The universally-legal shape is the **scrim-sibling
    restructure**: wrapper keeps layout only; an EMPTY absolutely-positioned
    `aria-hidden` hit-layer child takes the dismiss click; the dialog stacks
    above it. Every wrapping case becomes the (legal) empty-sibling case.
  - either way the exemption is only honest paired with a real keyboard
    equivalent (Escape). Semantic exemption without parity is lint-silencing.
- **Rule-pair conflicts are real: verify waves UNFILTERED.** A fix that
  satisfies rule A can violate rule B (presentation satisfied
  no-static-element-interactions, violated no-role-presentation-on-focusable).
  Rule-filtered targeted scans verify the FIX; they are blind to collateral.
  Close every wave with an unfiltered pass of the cheap layer (static lint is
  seconds) and reconcile the full-baseline arithmetic — the 14-defect surplus
  that exposed this was only visible because the predicted total didn't add up.
- **Re-bucketing ≠ regression.** Aggregation keys (e.g. source file) can shift
  between runs as enrichment improves, splitting one defect into several with
  the SAME underlying sightings. Before declaring new debt, compare sighting
  counts and the underlying element, not defect counts.
- **Keyboard-fix policy ladder**, most to least preferred: native
  `<button>`/link → `role` + `tabindex` + keydown handlers invoking the SAME
  function as click (extract inline expressions; never duplicate logic) →
  `role="presentation"` where a real interactive child already covers the
  action → leave unchanged WITH A NOTE when no honest mechanical equivalent
  exists. aria-hidden on interactive content is never a fix.
- **Wave discipline**:
  - never edit the app while a scan is measuring it (hot reload mutates pages
    mid-measurement); sequence edits → scan → diff
  - batch by risk class: instrument/config fixes, then style-only sweeps, then
    behavioral edits — each wave gets its own validation
  - state the prediction BEFORE the verifying scan, including the expected
    survivor count; survivors are the next wave's inventory, not noise
  - cleared-count arithmetic must reconcile exactly against the targeted
    buckets (452→377→333, 44 = 24+8+12); an unexplained delta means an
    unpredicted change or a coverage shift
- **Targeted partial scans are the verify loop** — narrow routes/matrix/layer/
  rules to the slice under test (~10x faster), but stamp the run as partial so
  its totals can never be read as a baseline. Full scans remain the only
  baselines.
- **Delegating mechanical waves**: hand agents a per-site inventory (file:line
  + snippet + interaction found), the policy ladder, house conventions to
  mirror, and an explicit leave-with-note escape hatch. Disjoint file sets per
  agent; verify with one targeted scan after, not per-edit. With a prompt that
  specific, a mid-tier model does the work — spend the strong model on the
  prompt, not the worker. Warn agents that line numbers drift (earlier waves
  edited the same files): locate sites by code shape, not line.
- **The copy boundary (labeling waves)**: an accessible name may only REUSE
  text already in the template (label text, placeholder, adjacent caption) —
  verbatim. Prefer real `for`/`id` association over `aria-label` (visible
  association helps everyone). A control with NO naming text anywhere is not
  lint debt, it is naming debt — route it to a human as a copy decision;
  never invent. The honest survivor list is a deliverable, not a failure.
- **Linter-legibility constraints shape the fix**: dynamic `:role` bindings
  are invisible to static analysis — conditionally interactive elements need
  `<component :is="cond ? 'button' : 'div'">`, which is also just better
  (native semantics, free keyboard). Managed-focus containers
  (listbox/menu with activedescendant or roving focus) satisfy
  "interactive role must be focusable" with `tabindex="-1"` — tabbable would
  be WRONG there. Nested controls inside a role="button" row need `.self`
  key modifiers so a child input's Enter doesn't trigger the row.
- **Findings can surface adjacent functional bugs** (an unlabeled checkbox
  turned out to be wired to nothing). Don't fix out-of-scope in the wave —
  file it visibly and keep the wave's diff reviewable.
- **An under-evidenced finding blocks its own triage.** A "keyboard trap at
  stop 15" with no element attached cannot be judged or fixed. When a finding
  arrives evidence-poor, fix the INSTRUMENT to attach identity (here: the walk
  broke out before recording the trapped stop; one push + a lookback fallback)
  and re-run targeted — the enriched finding then judged ITSELF: three sibling
  buttons sharing one label had fooled an advance-detector keyed on
  appearance (tag+name). Identity checks must key on element identity
  (selector path), never on appearance — labels legitimately repeat.
- **Measured pixel extremes beat assumed backgrounds.** For text over
  gradients, compute replacement colors against the SAMPLED lightest/darkest
  stops carried in the evidence, not against an eyeballed background — and
  when a light color can't mathematically pass on a bright surface (white on
  the primary gradient topped out at 3.1:1), the fix flips polarity (ink on
  bright), which the palette's own bright-accent+ink pairings usually already
  license.

### Measurement outranks inference — and check WHICH elements got measured

An engine that reports "could not determine" is confessing an INFERENCE FAILURE,
not reporting a harm. Where a physical measurement of the same element exists,
it governs. But the trap is subtler than wiring up precedence:

- **The disputed elements are often exactly the ones nobody measured.** Our
  collector kept only candidates its own cascade walk found suspect, dropping
  flat-and-passing ones as uninteresting. The overlap case is where "the cascade
  passes" and "the pixels pass" diverge — so the disputed set had no measurement
  and precedence was a no-op (37 findings, 2 moved). Fix the COLLECTION gate
  before concluding the precedence logic is wrong. Ask: for the elements in
  dispute, does a measurement exist at all?
- **Cross-producer matching must be geometric, not by selector.** Different
  generators emit different strings for the same node; document-absolute boxes
  from the same page load are the shared key. Keep the tolerance tight (centre
  AND both dimensions) or a parent inherits its child's measurement — which
  re-creates the very element-vs-overlapper confusion you are resolving.
- **Asymmetric precedence.** A measured pass may silently drop an `incomplete`
  (the engine never claimed a ratio), but should only DOWNGRADE an asserted
  violation — two methods disagreeing is real uncertainty, not a clean win.
- **A blanket "drop when measured" rule leaks.** If the rule that normally
  reports that harm skips a sub-class (ours owns non-flat only), a measured
  FAILURE in that sub-class has no reporter and vanishes. Upgrade, don't drop.
- **Count every suppression and print it.** An instrument that silently deletes
  its own output cannot be audited, and mass disappearances are indistinguishable
  from a bug. `144 cleared, 504 ceded` is the difference between a defensible
  drop and a mystery.

### A measurement is only valid against a capture of the SAME INSTANT

The correction to the section above, learned the hard way in the same session.
Having fixed WHERE elements are (capture space) and WHICH elements get measured,
the measurement was still wrong, because capture and measurement happened at
different times and the app was still loading: one route's scroll container grew
from 2208px to 3703px in between. Every box then addressed pixels that had since
moved, and the tool reported 16 contrast VIOLATIONS with confident two-decimal
ratios — including white-on-dark text "measured" at 1.02:1 that renders
perfectly readable.

That is a worse failure than the one it replaced. "Could not be proven" is
honest; a precise fictional ratio is a false accusation wearing the costume of
rigor, and it is the kind of thing an agent will dutifully "fix" — changing
correct colors to satisfy a phantom.

Rules that follow:

- **Sample pixels in the same instant as the geometry.** Interleave: scroll to a
  band, capture it, read the DOM, measure — all before moving. Never measure
  against an image assembled earlier in the pass.
- **Off-screen at measurement time means unmeasured, not measured wrong.** Record
  it as unproven. Never let a stale image stand in for absent pixels.
- **Never drop what you failed to measure.** An element off-screen in every band
  must still appear as unproven. Silently dropping it converts a coverage hole
  into a clean bill of health — the same sin as silent suppression.
- **Implausible precision is an instrument alarm, not a finding.** A ratio near
  1.0 between two colors that are obviously different, a perfect 0, a suspiciously
  round number — verify the instrument before filing. Physical impossibility in
  the output is the cheapest bug detector available.
- **Crop the evidence and LOOK at it before believing a mass of new findings.**
  Not a unit test — an eyeball on the actual pixels, cross-checked against a live
  render of the same element. Two independent corroborations make a finding safe
  to act on: the measured ratio should agree with what the cascade colors predict.
  When those two disagree, something in the pipeline is lying.
- **A sudden mass of new violations deserves the same suspicion as a sudden mass
  of cleared ones.** Both mean the instrument changed. Neither is self-evidently
  a discovery about the app.

### Comparing two builds (did the remediation actually work?)

Proving a wave worked means scanning the old build and the new one and diffing.
Three things must be held constant or the diff measures the wrong thing:

1. **The instrument.** Scan both builds with the SAME complykit build. Fixing
   the tool mid-campaign (as happens on a first engagement) invalidates every
   earlier baseline — those numbers describe an older instrument, not an older
   app. Re-scan the old build; never diff against a stale historical number.
2. **The route set — this is the one that bites.** Crawl-discovered routes are a
   function of what each build RENDERS, so the two runs wander to different
   pages. Our first attempt covered 4 routes before vs 18 after (the old build
   bounced through /login and crawled footer links), making the fixed build look
   worse per page. Pin an explicit route list present in both builds, then
   intersect the actual routes reached and diff only the shared set.
3. **Data and identity.** Same backend, same account, same viewports/schemes.
   Entity-id routes are fine when both builds hit one backend.

Then diff by (ruleId, file, element) rather than by count, and report three
numbers: FIXED, STILL PRESENT, and NEW. **The NEW bucket is the point** — a
count that merely went down can still hide regressions the wave introduced.

Worktree, not checkout: when the remediation is uncommitted (common — the wave
IS the working tree), `git checkout <old>` carries the modified files along and
yields a hybrid that is neither build. `git worktree add <dir> HEAD` gives a
pristine old checkout, served on its own port, with the working tree untouched.
Note localStorage is origin-scoped INCLUDING the port, so an auth storage-state
snapshot must be retargeted at the second port; cookies ignore port and carry
over as-is.
