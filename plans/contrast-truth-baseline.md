# Contrast ground-truth scoring

CLI: `../../../../../../private/tmp/claude-501/-Users-jeffjassky-Projects-foundry/4326ae29-0d4c-4a1a-8078-9fa229e5d7f9/scratchpad/ck-base/dist/cli.js`
Scan exit: 0, report exit: 0, wall time: 10078ms

| id | expect | exp.ratio | got | got.ratio | verdict | ratio-err |
| --- | --- | --- | --- | --- | --- | --- |
| C31 | pass | 18.88 | none |  | TN |  |
| C01 | pass | 4.54 | violation | 1.91 | FP | yes |
| C02 | fail | 4.48 | violation | 4.47 | TP |  |
| C03 | pass | 3.03 | none |  | TN |  |
| C04 | fail | 2.96 | violation | 2.95 | TP |  |
| C05 | pass | 3.03 | none |  | TN |  |
| C06 | fail | 3.03 | violation | 3.03 | TP |  |
| C07 | fail | 2.85 | none |  | FN |  |
| C08 | fail | 3.95 | violation | 3.94 | TP |  |
| C09 | fail |  | violation | 2.1 | TP |  |
| C10 | fail |  | none |  | FN |  |
| C11 | pass |  | none |  | TN |  |
| C12 | pass | 21 | none |  | TN |  |
| C13 | pass | 3.09 | none |  | TN |  |
| C14 | fail | 2.32 | violation | 2.32 | TP |  |
| C20 | fail | 2.32 | none |  | FN |  |
| C21 | pass | 4.54 | none |  | TN |  |
| C22 | fail | 1.92 | none |  | FN |  |
| C23 | fail | 2.85 | violation | 2.84 | TP |  |
| C24 | pass | 19.56 | none |  | TN |  |
| C25 | pass | 8.53 | none |  | TN |  |
| C26 | limitation |  | violation | 2.02 | skipped |  |
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
| C40 | fail | 1.92 | none |  | FN |  |
| C41 | none |  | none |  | TN |  |
| C42 | fail |  | violation | 1 | TP |  |
| C43 | pass |  | none |  | TN |  |
| C44 | fail |  | violation | 1 | TP |  |
| C45 | pass |  | none |  | TN |  |

**Totals** — TP: 12, TN: 19, FP: 1, FN: 5, unresolved: 0, ratio errors: 1, limitation (unscored): 1, wall time: 10078ms
## Notes (orchestrator, 2026-09-16)

- Scanner = HEAD before the glyph-mask change (`a96fb13`), rebuilt with ONE fix
  applied to `src/engines.ts`: axe shadow-root targets (`[["host","p"]]`) no
  longer fail the results schema. Without that fix every axe finding on this page
  was silently dropped (first baseline run: TP 2, FN 15). The same fix is on the
  `glyph-contrast` branch with regression tests in `test/engine-normalize.test.ts`.
- The C01 "FP" is not a C01 finding: it is C40's shadow-DOM violation
  (`ck-shadow40 >>> p`, ratio 1.91). The old `axe.ts` post-pass resolved the
  target with `querySelector("ck-shadow40,p")`, which matched the first `<p>` on
  the page (C01) and quoted its text. Read this row as C40 = TP, C01 = TN.
- The JS reveal cases (C32/C33) did not reproduce the field false positive on
  this page; the field cases are re-checked on the live sites after the change.
