# Per-law scan progress and report tabs — implementation contract

Companion to `plans/multi-region-scans.md` (regional workers) and `plans/simple-report.md`
(the report page). Status: planned 2026-10-08, not built.

## Why

A five-law scan is five scans that end in one report. The page today shows them as one:
"Looking for a consent banner" once, one tools-and-cookies table, one "Now" line that flips
between locations, and law rows that say only "Waiting" or "Scanning". Two causes:

1. **No live report exists during a multi-law job.** A collect-only run (`consent
   --collect-only`, what every collector runs) deliberately writes no `owner-report.json`
   (`src/cli/commands/consent.ts`, `writeLive`: "a worker leaves no owner report"). The
   page's live data comes from `<jobDir>/consent/.comply/runs/*/owner-report.json`, which
   the merge writes only at the end. So banner, tools and cookies stay empty until the
   merge finishes.
2. **The job carries no per-law state.** `ConsentProgress` (`service/src/server/events.ts`)
   folds every collector's events into one `progress`/`metrics`; `metrics.location` and
   `metrics.banner` are whichever location reported last. Worker start-up, failure and
   location verdicts live only as text in `job.log`.

Target: a top summary with overall numbers and one status chip per law; below it one tab
per law with that law's banner line and its tools-and-cookies matrix, live while it runs;
one to-do list for the whole job, unchanged. The owner's words: "a general scanning
section at the top with collective numbers, then a tabbed view of each of the scans".

## Shape of the work

| PR | Tier | Worktree | Depends on |
|----|------|----------|------------|
| 0. Types, catalog fields, contract tests | Fable | `multi-region` (direct) | — |
| A. Core: collect-only writes a live owner report; per-location summary in the owner report | Sonnet | `pl-core` | 0 |
| B. Service server: per-law progress, worker `/report`, live files, `laws` in the report response | Sonnet | `pl-server` | 0 |
| C. Service client: status chips, law tabs, per-location split | Sonnet | `pl-client` | 0 |
| Area review: live plumbing (B) and the tabs on a real five-law scan | Fable | integrated branch | A, B, C |

A, B and C touch disjoint files and run in parallel. B's tests use fake CLIs that write
the files A will produce, so B does not wait for A. Branch base: `multi-region` (tracks
`main`). One worktree per PR, `service/node_modules` and `node_modules` symlinked from the
main checkout, never committed. **Never `git stash`**; park work with a WIP commit.

Browser tests: Playwright's pinned Chromium is not installed on this Mac; run them with
`COMPLYKIT_BROWSER_CHANNEL=chrome` or they skip silently.

Run before reporting done: `npx tsc --noEmit` (root, where files under `src/` change) and
`cd service && npx tsc --noEmit -p tsconfig.server.json && npx tsc --noEmit -p
tsconfig.client.json`; `npx vitest run <the test files named in your PR>`; `npm run
boundaries` (root) when `src/` changes. A contract test is not edited to make it pass: if
one looks wrong, stop and report which assertion and why.

---

## PR 0 — types, catalog, tests (Fable, before dispatch)

### 0a. `service/src/shared/laws.ts`

Add to `Law`: `regionLabel: string` — Frankfurt, London, Los Angeles, Dallas, Chicago. **Done in PR 0.**

### 0b. `service/src/shared/api.ts`

```ts
/** One law's collection, as the runner and the collectors' events report it. */
export type LawScanState = 'waiting' | 'starting' | 'verifying' | 'scanning' | 'collected' | 'done' | 'failed';

export interface LawScanProgress {
  id: LawId;
  locationId: string;          // the complykit location ('de', 'us-ca', …)
  region: string;              // Fly region ('fra'); the client labels it via LAWS
  local: boolean;              // runs on the primary itself
  state: LawScanState;
  /** failed: why. Also set for an unverified location (its verdict and note). */
  error?: string;
  visitsDone: number;
  visitsTotal: number;         // 0 until the location announces its plan
  verdict?: string;            // from the `location` event
  observed?: string;
  banner?: string;             // consent tool id as the events carry it, once a visit saw one
  /** The visit running now at this location. */
  current?: { scenario: string; run?: number };
}

export interface JobMetrics {
  // …existing fields unchanged…
  /** One entry per law the job scans under, in catalog order. Absent on jobs without laws and on jobs from before this existed. */
  laws?: LawScanProgress[];
}

export interface JobReportResponse {
  // …existing fields unchanged…
  /**
   * Multi-law jobs: one entry per law, catalog order. `report` is that law's live owner
   * report (its collector's, single location) while the job runs or when the merge
   * failed; null before the first visit finishes and null once the job is done (the
   * final `report` above covers every location; see OwnerReport.locations).
   */
  laws?: Array<{ id: LawId; progress: LawScanProgress; report: OwnerReport | null }>;
}
```

### 0c. `src/report/owner-report.ts` (interface only; A implements)

```ts
export interface OwnerLocationSummary {
  id: string;
  label: string;
  verified: boolean;
  observed?: string;
  note?: string;
  visitsDone: number;
  visitsTotal: number;
  banner: { state: 'pending' | 'detected' | 'none'; provider?: string; visitsWithBanner: number; visitsChecked: number };
}

export interface OwnerReport {
  // …existing fields unchanged…
  /** Every location of the scan, in plan order — always present on new reports; absent on reports written before it existed. */
  locations?: OwnerLocationSummary[];
}
```

The same interface is mirrored in `service/src/shared/api.ts` (the service never imports
the package; `test/service-api-drift.test.ts` or its equivalent must still pass — check
how `OwnerReport` is kept in sync today and follow it).

### 0d. `service/src/server/events.ts` — event union

Add `{ type: 'collected'; at: string; runId: string; runDir: string; locations: string[] }`
(the CLI already emits it in collect-only mode).

### 0e. Contract tests (written failing, by Fable) — **done in PR 0**

- `test/owner-report-locations.test.ts` (root) — PR A.
- `test/consent-merge-browser.test.ts` — new case "collect-only reports a live analysis
  after every visit when asked" — PR A.
- `service/test/events-laws.test.ts` — PR B.
- `service/test/multi-region-live.test.ts` — PR B.
- `service/src/client/lib/lawReport.test.tsx` (`.tsx`: the service's vitest only picks
  up `.test.tsx` under `src/client`), the `per-law chips from metrics.laws` block in
  `Laws.test.tsx`, the `law tabs` block in `ReportPage.test.tsx` — PR C.

Types 0a–0d are in the tree and compile. The tests are the spec where this document and
a test disagree; read them before coding. Sonnet does not edit them.

---

## PR A — core package (Sonnet)

### Files
`src/pipeline.ts`, `src/cli/commands/consent.ts`, `src/report/owner-report.ts`,
`test/fixtures/fake-*` only if a fixture needs the new field. Nothing under `service/`.

### A1. Collect-only runs write the live owner report

- `src/pipeline.ts`: `collectConsentScan` runs the live analysis when `opts.onPartial` is
  given (today `collect(opts, false)` ignores it). Change the signature's doc; the
  analysis uses `opts.knowledgeBase ?? DEFAULT_KB` as the live path does today. The
  returned collection is unchanged (no findings are written to disk).
- `src/cli/commands/consent.ts`: remove the `collectOnly` early return in `writeLive`.
  In the collect-only branch pass the same `onPartial` as the normal branch
  (`lastPartial = partial; liveSite = partial.evaluation.site; writeLive()`). The file
  lands at `<runDir>/owner-report.json` (where `out` defaults already). Stage is always
  `'live'` in a collect-only run — the merge writes the only `'final'`. Each write emits
  the existing `live` event.
- `--merge` behaviour unchanged.

### A2. Per-location summary in `buildOwnerReport`

Always set `report.locations` (one entry per location known to the input: the model's
locations plus `input.locations`, in the order they are known; the existing `locations`
local already builds this list). Per entry:

- `visitsTotal`: planned visits for that location (plan items × runs); on a final report
  with no plan, the number of its columns.
- `visitsDone`: finished visits there (`done` keys matching the location; final = total).
- `banner`: computed exactly as the report-wide banner is today but over that location's
  grid cells only (`m.grid[l.id]`); `pending` when no finished visit there has a banner
  reading; `consentTools` is not per location (omit).
- `label`, `verified`, `observed`, `note` as in the existing `locations` list.

The report-wide `banner` and `scan.location` keep their current meaning (do not change
existing tests).

### Tests (Fable writes; must pass)

`test/owner-report-locations.test.ts`:
1. `buildOwnerReport` with a two-location model (de with a banner in 2 of 3 finished
   visits; us-ca with none finished) → `locations` has two entries in that order; de:
   `visitsDone 3, visitsTotal 3, banner.state 'detected', provider, visitsWithBanner 2,
   visitsChecked 3`; us-ca: `visitsDone 0`, `banner.state 'pending'`.
2. Live input with `locations` announced but no model → entries with `visitsTotal` from
   the plan, `visitsDone 0`, banner pending.
3. Single-location report → `locations` has one entry whose banner equals
   `report.banner` minus `consentTools`.
4. Existing `test/owner-report*.test.ts` unchanged and green.

`test/consent-merge-browser.test.ts`, new case: `collectConsentScan` with `onPartial`
calls it once per visit (DE 3, CA 2); the last partial's evaluation has the one location
and a non-empty inventory, and an owner report built from it has one `locations` entry and
tools. Tested at the library level because the CLI's local location calls real
geolocation services. The CLI wiring in A1 (`writeLive` in collect-only) is small and is
checked by the end-of-line review on Fly; keep it the same code path as the normal scan's.

### Invariants
- A collect-only run still writes exactly one `collection.json` and no findings/report
  files besides `owner-report.json`.
- `--merge` output byte-identical in content to before except the new `locations` field.
- Live analysis failures never stop a collection (existing try/catch in `collect`).

### Non-goals
Site workspace classifications on the worker (the worker's live cells use the bundled
KB; the merge's final report replaces them). Any change to events the CLI emits.

---

## PR B — service server (Sonnet)

### Files
`service/src/server/events.ts`, `runner.ts`, `worker.ts`, `job-report.ts`,
`service/test/fixtures/fake-worker-cli-regional.mjs` and the fake primary CLI the service
tests use (see `service/test/helpers.ts` → `testConfig().cliPath`).

### B1. `ConsentProgress` owns `metrics.laws`

Constructor: `new ConsentProgress(job, extraUnits, laws: readonly Law[] = [])` replacing
`expectedLocations` (derive `locations` from `laws.map(l => l.locationId)`; the no-laws
path passes nothing, as today). On construction, when `laws.length`, set `job.metrics.laws`
to one `waiting` entry per law in catalog order (`id, locationId, region: flyRegion,
local: !!local, state: 'waiting', visitsDone: 0, visitsTotal: 0`).

New method `setLaw(id: LawId, patch: Partial<Pick<LawScanProgress, 'state' | 'error'>>): boolean`
(returns true when something changed; the runner persists and broadcasts as it does for
`apply`). The runner calls it for states events cannot carry.

Event → entry transitions (`apply`, by `ev.location` → the law whose `locationId` matches;
events for unknown locations leave `laws` alone):
- `start` (its `locations` list): each listed law `waiting|starting → verifying`.
- `location`: `verdict`, `observed`; with scenarios → `scanning`, `visitsTotal =
  scenarios × runs`; without scenarios → `failed`, `error = verdict + (note ? ' — ' + note : '')`.
- `scenario-start`: `current = { scenario, run? }`; state `scanning` if it was `verifying`.
- `scenario-done`: `visitsDone++`, `current` cleared, `banner` set when the event has one.
- `collected`: each listed law → `collected`.
- `done` (the merge): every `collected` law → `done`; `failed` stays `failed`.
- `error` from a collector is not a law failure by itself (the runner decides; today it
  routes a collector's `error` event via its own tail; keep that).

Existing job-wide behaviour (`progress`, `metrics.scenarios`, `planned`, `location`,
`banner`) unchanged; existing `service/test/lifecycle.test.ts` and
`multi-region.test.ts` stay green.

### B2. Runner (`runConsentLaws`, `collectLocal`, `collectRemote`)

- Pass `laws` to `ConsentProgress`.
- `collectRemote`: `setLaw(id, { state: 'starting' })` right before `fleet.acquire`
  (after the region lock is taken). On any failure (acquire, refused, lost contact,
  timeout, worker ended failed, no `collection.json`): `setLaw(id, { state: 'failed',
  error })` with the same message that goes to `--failed`.
- `collectLocal`: `setLaw(id, { state: 'starting' })` before spawning; `failed` with the
  message on a non-zero exit or a missing run dir.
- **Live files.** Directory `<jobDir>/consent/live/`, file `<lawId>.json`, written
  atomically (tmp + rename).
  - Local collector: the forwarding tail (`fwd`) sees `live` events; on each, copy
    `ev.file` to `live/<lawId>.json`.
  - Remote collector: when a pulled line is a `live` event, `GET
    <worker>/internal/jobs/<jobId>/report` (secret header) and write the body to
    `live/<lawId>.json`; a 404 or a fetch error is ignored (next `live` event retries).
    At most one fetch in flight per law (skip while one is pending).
  - On a successful merge, delete `live/` together with `gather/`. On a failed or
    cancelled job, keep it (the page still shows what was collected).
- Forward `live` and `collected` lines into the job's events file as today (they fold
  into `laws`).

### B3. Worker: `GET /internal/jobs/:jobId/report`

Secret header required as the other `/internal` routes. Returns the collector's
`owner-report.json` from its single run dir (`singleRunDir`) as `application/json`,
unchanged; `404 { error: 'no report yet' }` while absent; `404` for an unknown job as the
others do.

### B4. `jobReport` → `laws`

When `job.metrics.laws?.length`: `laws = metrics.laws.map(p => ({ id, progress: p, report }))`
where `report` = `readOwnerReport(<jobDir>/consent/live/<id>.json)` (null when absent or
malformed). Never read live files for a `done` job (they are deleted; return null without
touching disk). The existing `report` field keeps its meaning.

### B5. Fixtures

Both fake CLIs gain hostname rule `hold.*`: wait ~500 ms before the first visit and
~1500 ms after the last, before `collected` (lets a test see a law mid-scan). The tests
default to `hold.example.com`.

- `fake-worker-cli-regional.mjs`: after each `scenario-done`, write
  `<run>/owner-report.json` — a minimal valid `OwnerReport` (`version 1, stage 'live'`,
  one location = `--locations`, `scan.visitsDone` = visits so far, `visitsTotal 2`,
  `banner.state 'detected'` with `provider 'FakeCMP'` after the first visit, one tool row
  with as many cells as columns, `locations` with one entry) — and emit `{ type: 'live',
  file, stage: 'live', visitsDone, visitsTotal }`. Hostname rule `nobanner.*`: banner
  `none`. Keep the existing `slow.`/`fail.`/`empty.` behaviours.
- The fake primary CLI, in `--collect-only` mode, does the same (the ca law runs locally).

### Tests (Fable writes; must pass)

`service/test/events-laws.test.ts` (pure, no server):
1. Construction with three laws → three `waiting` entries in catalog order.
2. Sequence for `de`: `start → location(scenarios: 3, runs 1) → scenario-start →
   scenario-done(banner 'onetrust') → … → collected` → states `verifying, scanning
   (visitsTotal 3), current set, visitsDone 1 + banner, …, collected`; `us-ca` untouched.
3. `location` without scenarios (verdict `mismatch`, note) → `failed` with
   `error` `"mismatch — <note>"`.
4. `setLaw('eu', { state: 'failed', error: 'x' })` → entry failed; `apply` of later
   events for `de` does not resurrect it (`failed` is terminal).
5. Merge `done` → every `collected` law `done`; `failed` stays.
6. Jobs without laws: `metrics.laws` undefined; existing counters as before.

`service/test/multi-region-live.test.ts` (service + in-process worker, like
`multi-region.test.ts`):
1. Five-law scan with workers for `fra` and a fleet that has no entry for `lhr`: while
   running, `GET /api/jobs/:id/report` → `laws` has five entries in catalog order; `eu`
   reaches `scanning` then `collected` with `report` non-null, `report.locations[0].id ===
   'de'`, `report.banner.provider === 'FakeCMP'`; `uk` is `failed` with an error naming
   the fleet; `ca` (local) also gets a non-null live report.
   (Use `waitFor` on the response, not sleeps.)
2. Worker `GET /internal/jobs/:id/report` → 404 before the first visit, 200 with the
   JSON after; 401 without the secret.
3. After the job is `done`: `laws[].report` all null, `live/` deleted, `gather/` deleted.
4. `fail.` host (both collectors fail, job `failed`): every law `failed`, each `error`
   contained in `job.error`; eu's starts `worker in fra failed:` and carries the worker's
   stderr.
5. Cancel mid-scan: `laws` still returned; no entry flips to `done`.
6. Jobs without laws: no `laws` field.

### Invariants
- One write path to `job.metrics` (`ConsentProgress`); the runner never pokes entries
  directly.
- A live file is never half-written (tmp + rename), and never read for a done job.
- `--failed` messages and `laws[].error` are the same string.
- No new dependency; `fleet.ts` untouched.

### Non-goals
ETags / conditional fetches for the worker report; retrying a failed law; per-law cancel.

---

## PR C — service client (Sonnet)

### Files
`service/src/client/lib/laws.ts` (chips), new `service/src/client/lib/lawReport.ts`
(pure split), `components/Laws.tsx`, `components/ReportPage.tsx`, `styles.css`. Tests
listed below.

### C1. `lawRows` from `metrics.laws`

`lawRows(job, report)` keeps its signature and output type, adds `region` (the law's
`regionLabel`, "Frankfurt") and `error?` to `LawRow`; tolerates `job.metrics` absent, and reads `job.metrics.laws` when present (fall back to today's column-derived
logic for jobs without it). `state` widens to `LawScanState`. Text per state:

| state | text |
|---|---|
| waiting | Waiting |
| starting | local: `Starting`; remote: `Starting the worker in <regionLabel>` |
| verifying | Checking the location |
| scanning | `Scanning <done> of <total>`; `Scanning` while total is 0 |
| collected | `Collected`; `Preparing findings` once `job.progress.phase === 'analyzing'` |
| done | Done |
| failed | `Failed` (the reason shows in the tab, not the chip) |

### C2. `lawReport.ts` — pure

```ts
/** That location's view of a multi-location owner report: its columns, its cells, its banner. */
export function reportForLocation(report: OwnerReport, locationId: string): OwnerReport;
/** The report to show in a law's tab: its live report while running, else the final report cut to its location; null when nothing is known yet. */
export function tabReport(data: JobReportResponse, law: LawId): OwnerReport | null;
```

`reportForLocation`: `matrix.columns` = columns with `column.location === locationId`;
every tool row's `cells` (and each cookie's `cells`) keep only the indices of kept columns;
`matrix.counts` recomputed from kept cells; `banner` from `report.locations?.find(id)`
(fallback `report.banner`); `scan.location` from the same entry (`{ id, label, verified,
observed, note }`), `scan.visitsDone/visitsTotal` from it when present; everything else
(decisions, todo, site, runId, stage) copied as is. Tools whose kept cells are all
`pending` on a `final` report are dropped (the tool was not seen there); on a live report
they stay.

`tabReport`: `data.laws?.find(id)?.report ?? (data.report ? reportForLocation(data.report,
LAWS[id].locationId) : null)`.

### C3. Components

- `ScanStatus`: unchanged facts (Visits, Pages, Time) — remove the `Now` fact when the
  job has ≥ 2 laws (it flips between locations); keep it otherwise. `LawProgress` becomes
  a chip row (`ul.law-progress`, `li[data-state]`): label + text; `failed` chips carry
  `title={error}`.
- New `LawTabs({ data, ui, actions })` in `ReportPage.tsx` (it needs `BannerLine` and
  `Matrix`), used by `ReportPageView` **instead of** the flat
  `BannerLine` + `Matrix` when `job.laws.length >= 2` (one law or none: page unchanged).
  Structure: `div.law-tabs` → `div[role=tablist]` with one `button[role=tab]` per law in
  catalog order (`aria-selected`, `aria-controls`, `id`; label + a small state dot
  `span.law-dot[data-state]`), then one `div[role=tabpanel]` for the selected law. Panel
  content by `progress.state`:
  - `failed`: `div.rp-alert[role=alert]` — "This law could not be scanned." + `error`.
  - `waiting | starting | verifying` with no report: one muted line with the chip text
    (e.g. "Starting the worker in Frankfurt…").
  - otherwise: `BannerLine` and `Matrix` fed a `JobReportResponse` whose `report` is
    `tabReport(data, law)` (spread `data`, replace `report`), so both components stay
    untouched.
  Selected tab: component state; initial = first law whose state is `scanning`, else the
  first law. Keyboard: Left/Right move selection (WAI-ARIA tabs). Export a stateless
  `LawTabsView({ data, selected, onSelect, ui, actions })` for tests; `LawTabs` wraps it.
- `TodoList` stays below the tabs, one list, untouched.
- `JobLaws` in the header unchanged.

### C4. Styles
`.law-tabs [role=tablist]`: horizontal, `overflow-x: auto`, no wrap, 16px gutters at phone
width; selected tab underlined with the existing accent token; `.law-dot` colours by
`data-state` using existing status tokens (waiting grey, scanning accent, done green,
failed red). Dark mode via the existing tokens only. No new colours.

### Tests (Fable writes; must pass)

`service/src/client/lib/lawReport.test.tsx`:
1. `reportForLocation` on a two-location final report keeps only that location's columns
   and the matching cell indices for tools and cookies; counts recomputed; banner and
   `scan.location` from `locations`; drops a tool whose cells there are all pending.
2. Live report (stage `live`) keeps every tool.
3. No `locations` field (old report) → banner falls back to `report.banner`.
4. `tabReport` prefers `laws[].report`; falls back to the cut final report; null when
   neither.

`Laws.test.tsx` additions: `lawRows` from `metrics.laws` for every state and text in the
C1 table (remote and local `starting`); fallback to the column logic without
`metrics.laws`.

`ReportPage.test.tsx` additions (renderToStaticMarkup): `LawTabsView` with five laws →
five tabs in catalog order, `aria-selected` on the chosen one, one tabpanel; failed law
panel has the alert and the error text; starting law panel has the "Starting the worker
in Frankfurt" line; scanning law panel renders `[data-testid=banner]` and
`[data-testid=matrix]` with that law's columns only; `ReportPageView` with one law renders
no tablist; with two laws renders a tablist and exactly one `[data-testid=todo]`; with
several laws `[data-testid=current]` is absent even when the job's phase would show it.

### Invariants
- `BannerLine`, `Matrix`, `TodoList` are not modified.
- Single-law and no-law report pages render exactly as before (existing tests green).
- No colour literals in new CSS; phone width shows no horizontal page scroll.

### Non-goals
Tab in the URL hash; per-law to-do tagging (a possible follow-up: tasks carry no location
today); changes to the Home/Sites pages.

---

## Area review (Fable, after A–C land)

1. Deploy to Fly, run a real five-law full scan; watch tabs fill in; confirm workers
   stop; read `live/` lifecycle in the job dir over ssh.
2. Read `runner.ts` live-file plumbing and `events.ts` transitions for races (a `live`
   event arriving after `collected`; a worker report fetched after the job was cancelled).
3. Read `LawTabs` at phone width in dark mode.
