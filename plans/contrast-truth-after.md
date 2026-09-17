# Contrast ground-truth scoring

CLI: `dist/cli.js`
Scan exit: 0, report exit: 0, wall time: 25878ms

| id | expect | exp.ratio | got | got.ratio | verdict | ratio-err |
| --- | --- | --- | --- | --- | --- | --- |
| C31 | pass | 18.88 | none |  | TN |  |
| C01 | pass | 4.54 | none |  | TN |  |
| C02 | fail | 4.48 | violation | 4.47 | TP |  |
| C03 | pass | 3.03 | none |  | TN |  |
| C04 | fail | 2.96 | violation | 2.95 | TP |  |
| C05 | pass | 3.03 | none |  | TN |  |
| C06 | fail | 3.03 | violation | 3.03 | TP |  |
| C07 | fail | 2.85 | violation | 2.84 | TP |  |
| C08 | fail | 3.95 | violation | 3.97 | TP |  |
| C09 | fail |  | violation | 1.52 | TP |  |
| C10 | fail |  | violation | 1.09 | TP |  |
| C11 | pass |  | none |  | TN |  |
| C12 | pass | 21 | none |  | TN |  |
| C13 | pass | 3.09 | none |  | TN |  |
| C14 | fail | 2.32 | violation | 2.32 | TP |  |
| C20 | fail | 2.32 | violation | 2.32 | TP |  |
| C21 | pass | 4.54 | none |  | TN |  |
| C22 | fail | 1.92 | violation | 1.91 | TP |  |
| C23 | fail | 2.85 | violation | 2.84 | TP |  |
| C24 | pass | 19.56 | none |  | TN |  |
| C25 | pass | 8.53 | none |  | TN |  |
| C26 | limitation |  | violation | 1.7 | skipped |  |
| C27 | fail | 1 | violation | 1 | TP |  |
| C28 | gap-ok |  | needs-review |  | TN |  |
| C29 | none |  | none |  | TN |  |
| C30 | none |  | none |  | TN |  |
| C32 | pass | 21 | none |  | TN |  |
| C33 | pass | 17.42 | none |  | TN |  |
| C36 | pass | 7 | none |  | TN |  |
| C37 | fail | 2.85 | violation | 2.84 | TP |  |
| C39 | pass | 12.63 | none |  | TN |  |
| C38 | fail | 2.32 | violation | 2.32 | TP |  |
| C40 | fail | 1.92 | violation | 1.91 | TP |  |
| C41 | none |  | none |  | TN |  |
| C42 | fail |  | violation | 1.48 | TP |  |
| C43 | pass |  | none |  | TN |  |
| C44 | fail |  | violation | 2.29 | TP |  |
| C45 | pass |  | none |  | TN |  |

**Totals** — TP: 17, TN: 20, FP: 0, FN: 0, unresolved: 0, ratio errors: 0, limitation (unscored): 1, wall time: 25878ms

## Before → after (Wave 4 V)

| | TP | TN | FP | FN | unresolved | ratio errors | limitation (unscored) | wall time |
|---|---|---|---|---|---|---|---|---|
| Before (pixel-band + histogram, `plans/contrast-truth-baseline.md`) | 12 | 19 | 1 | 5 | 0 | 1 | 1 | 10078ms |
| After (glyph-mask A/B diff, this run) | 17 | 20 | 0 | 0 | 0 | 0 | 1 | 25878ms |

The scan got slower (an extra A/hide/B/restore/A2 screenshot round-trip per
band, plus per-subject rest-pass measurement, replaces one histogram read per
band) but every wrong verdict on the corpus is gone.

Cases whose outcome changed:

- **C01** — FP → TN. Not actually a change in C01's own measurement; the old
  `axe.ts` post-pass resolved a shadow-DOM target (`ck-shadow40 >>> p`) with
  `querySelector("ck-shadow40,p")`, which matched the page's first `<p>`
  (C01) and quoted C01's text as evidence for what was really C40's
  violation. The shadow-target fix (below) plus `resolveAxeTargets` means the
  finding is now attributed to C40 itself.
- **C07** (`rgba(0,0,0,.4)` on `#fff`) — FN → TP. The old pixel-band
  background guess merged the translucent ink into "background"; the glyph
  mask isolates exactly the painted pixels.
- **C10** (background-clip:text gradient `#fff→#eee` on `#fff`) — FN → TP.
  Gradient text has no single CSS foreground colour; the old code had no
  rendered-pixel fallback. `fgSource: 'rendered'` (glyph-math §4.1) measures
  the actual ink.
- **C20** (`::before` pseudo-element content) — FN → TP. Pseudo-element text
  was never enumerated as a subject before; `glyph-init.ts enumerate` now
  walks `::before`/`::after` explicitly.
- **C22** (placeholder text) — FN → TP. Same coverage hole as C20:
  placeholders are now a first-class subject kind.
- **C40** (open shadow DOM custom element text) — FN → TP, and now correctly
  attributed to itself instead of leaking into C01 (see above). Shadow-root
  walking plus the axe shadow-target fix together close this gap.
