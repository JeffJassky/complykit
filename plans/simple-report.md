# The simple report page — contract and layout

Status: built 2026-10-07. Owner's brief: "dead simple" — start a scan, the report
loads at once and fills in; four parts, nothing else. Builds on the remediation flow
(`remediation-flow.md`): same model, same workspace, same checklist and endpoints.

## 1. Layout (service web UI, `#report/<jobId>`)

In this order, and nothing else on the page:

1. **Scan status** — only while the job is queued or running: visits done of total,
   pages visited, elapsed, the visit running now, a progress bar, **Cancel**. A failed
   or cancelled scan shows one line instead, with **Scan again**.
2. **Consent banner** — "Consent banner: <provider>" / "No consent banner detected"
   (naming a consent tool that loaded without one) / "Looking for a consent banner…"
   until the first visit reports.
3. **Tools and cookies** — rows: each tool, its cookies under it (discovery order;
   cookies by name). Columns: the planned visitor actions in plain words. Cells:
   spinner (pending) / ✓ ok / ✕ mismatch / ? needs your decision / – not checked; a
   not-checked column gets one note below the table. Selecting a cell shows expected /
   what we saw / why; selecting an unclassified tool's row opens the purpose picker.
   The legend is one line.
4. **Your to-do list** — one numbered list: the decisions (what is X for? —
   Necessary / Functional / Analytics / Advertising), then the install and the code
   changes (steps, snippet + Copy, before, pages, install zip on the install item,
   **Verify** where a check exists, "Mark done without checking" / "I've done this"),
   optional items folded, and last **Run the final scan** (enabled when every required
   item is verified, decided or marked done; it calls the rescan endpoint and opens the
   new job's page). While the scan runs, the decisions found so far are listed with a
   placeholder for the rest.

Footer: one link, **Technical details** — the full HTML report (legal scope, findings,
evidence, coverage, compatibility, change list, proof), unchanged and still generated.

Home (`#`): an address field + **Scan** (checks and scan options behind **Options**),
then **Your sites**: one row per host, its newest job's status and to-do progress,
linking to its report page. Submitting opens the report page. The Sites page links
to a site's latest report page.

## 2. The owner report model (root: `src/report/owner-report.ts`)

`buildOwnerReport(input) → OwnerReport`, pure, over the same `ConsentReportModel` and
`buildBehaviorMatrix` as the HTML report. Mirrored as types in
`service/src/shared/api.ts` (the service never imports the package);
`test/owner-report.test.ts` assigns the builder's output to the mirror (compile-time).

```
OwnerReport {
  version: 1, stage: 'live' | 'final', runId, generatedAt, site { url, host, domain }
  scan { startedAt, finishedAt?, visitsDone, visitsTotal, pagesVisited, current?, location? { id, label, observed?, verified, note? } }
  banner { state: 'pending' | 'detected' | 'none', provider?, visitsWithBanner, visitsChecked, consentTools? }
  matrix {
    columns: [{ id '<loc>:<scenario>', location, scenario, label, locationLabel?, state: 'pending'|'running'|'done'|'not-checked', note? }]
    tools:   [{ id, partyId, label, domain, purpose, categories, classified, recognized, classKey 'class:<id>', cells, cookies: [{ id, name, kind, purpose, classified, cells }] }]
    counts { ok, mismatch, needsDecision, pending, notChecked }
  }
  decisions: [{ partyId, label, domain, classKey }]      // unclassified tools: the first to-dos
  todo? { tasks: RemediationTask[], configAt?, runId? } // the model's checklist; the service replaces it
}
cell { state: 'pending'|'ok'|'mismatch'|'needs-decision'|'not-checked', expected?, observed?, reason?, runs? }
```

Mapping from the matrix: match / allowed → ok; mismatch → mismatch; review →
needs-decision; unknown / not-tested → not-checked. A column is pending until every
planned run of it is done (repeats included), running while its visit runs. A done
column the matrix dropped (no banner to act on, visit not completed) is not-checked
with one note; a column the matrix marks `unavailable` keeps its reason. Column order
is the report's scenario order, live and final alike. A cookie of a tool the team
classified takes the tool's purpose (judged on the same facts).

## 3. Who writes it

- `complykit consent --events <file>`: after every finished visit (repeats included)
  the collector's `onProgress` hands the partial collection to the pipeline's
  `onPartial`, which runs the same analysis as the final result
  (`analyzeConsentCollection`: workspace, rules, evaluation, proof, compatibility) over
  the visits so far (no DNS records, no containers yet). The CLI builds the report
  model and the owner report and writes `owner-report.json` beside the HTML report
  (tmp + rename), then appends `{ type: 'live', file, stage, visitsDone, visitsTotal }`
  to the events file. Also written on the `location` event (all pending) and on each
  `scenario-start` (running column). Final: once more when the run is written, stage
  `final` (with or without `--events`). Failures are logged and never stop the scan.
- `complykit report --format consent-html --out <file>` writes it (final) beside the
  report, with the `--workspace` classifications applied — so every service rerender
  refreshes it (`rerender.ts` swaps it in with the report).

## 4. Service

- `GET /api/jobs/:id/report → JobReportResponse { job, domain, report, todo, updating,
  technicalReportUrl?, accessibilityReportUrl?, installZipUrl? }`. `report` is the job's
  `owner-report.json` (beside the report once done; while running, the newest in its
  run directory), null until written. `todo.state`: waiting (scan running) / preparing
  (list being made) / ready (`tasks` = the site's checklist with status from the
  workspace, `progress`, `runId`, `fromThisRun`) / error / none. `updating` = a rerender
  of the job is running or queued.
- Automatic to-do list (`ChecklistMaker`, `config.autoChecklist`, env
  `AUTO_CHECKLIST=0` turns it off; off in the test helper): when a consent job finishes
  `done`, `rerenderJob(job, { generate, by: 'complykit' })`. `generate` is true when the
  site has no checklist, the checklist came from this run, or nobody has worked it
  (every change still to do; decisions don't count). Otherwise the earlier list is kept
  (a regeneration could move the install hash under a deployed tool) and the report is
  re-rendered with the current workspace.
- After a classification the page PATCHes the `class:` entry and, for a finished job,
  requests `POST /api/jobs/:id/rerender` through a coalescing queue (debounce 800 ms,
  one more after a running one). The client polls every 2 s while the job runs, the
  list is being made or a rerender runs; every 15 s otherwise, and on focus.

## 5. Tests

- `test/owner-report.test.ts` — builder: pending / running columns, rows appearing,
  decisions, repeats, final, not-checked column note, cookie inheritance, the mirror.
- `service/test/job-report.test.ts` — the endpoint with the fake CLI (which writes
  `owner-report.json` live and final, and on `report`): live → final, the automatic
  list, classify → rerender → decided, accessibility-only, failed, `shouldGenerate`.
- `service/src/client/components/ReportPage.test.tsx` — each section and state, home,
  routing, polling, the rerender queue.
- `test/owner-report-browser.test.ts` — real CLI + service + built client + fixture
  site, driven in a browser: home → scan → status / banner / matrix filling in →
  list → classify → automatic rerender → install + Verify pass → mark the rest →
  final scan → its page.

## 6. Known limits

- `pagesVisited` counts distinct page URLs of the finished visits; the final from a
  re-render uses the most pages any one visit loaded.
- A classification made while the scan runs is saved at once but judged only when the
  scan finishes (the live analysis uses the workspace read at scan start).
- The live analysis runs synchronously between visits; on a very large run it adds a
  little time per visit.
