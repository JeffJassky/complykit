# Guided remediation flow — contract and plan

Status: contract + pure core built (2026-10-07; this document, `src/record/remediation.ts`,
`src/remediation.ts`, `src/rules/remediation/verify.ts`, ids on the change list). The
UI, service, browser spot-check, install bundle, e2e and docs are parallel builds (§9).
Design authority stays `client-consent-design.md`; this plan adds the owner-facing loop on
top of B2 (change list), D8 (generator), C1–C4 (workspace), D10 (proof).
The owner-facing page that carries this loop (live matrix, one to-do list, no Generate /
Update buttons) is `simple-report.md`.

## 1. The workflow, end to end

The owner runs the service locally (`service/`), scans their site, and works one report.

1. **Scan.** `complykit consent --url …` through the service (a job). The report is served
   with the site workspace (C2): classifications and task state are shared, not per browser.
2. **Classify.** In the report the owner classifies a few tools / cookies (the workbench
   writes `class:<key>` entries, C1). The report's grid recomputes in place today; the
   compatibility section and change list do **not** (B2 is rendered once per run) — R2.
3. **Generate.** "Generate consent tool config" (D8; `POST /api/jobs/:id/consent-config`)
   runs the generator with the current workspace and stores `config.value = { config,
   snippet, changeList, notes, tasks, scriptSrc }` — `tasks` is new: the checklist (§3).
   R2 makes this automatic after a classification changes, so the config, the change list
   and the checklist always reflect the latest classifications.
4. **Follow the to-do list.** The report (and the site page) shows ONE ordered list: the
   decisions first ("Decide: what is getscrolly.com?" — one per tool the scan cannot
   classify, §3), then install, remove the old consent tool, then each change — with plain
   steps, the before/after markup, and a **Verify** button per task.
5. **Verify one change.** Verify fetches *one thing* — the page the change is on, or the
   published GTM container — and runs the pure checker for that task (§5). Seconds, no
   browser, no full scan. Platform / API / behavior changes get a one-page browser spot
   check (reject, then accept) instead; DNS and owner decisions are manual. The result
   lands in the workspace under `task:change:<id>` as `{ status, lastVerify }`.
6. **Rescan.** When every required task is verified or marked done (install included),
   the checklist offers the rescan (the same job with the workspace, C3). The report's
   proof section (D10) then says per vendor: **controlled / not controlled / not observed**,
   scoped to the pages and locations it visited. Never "compliant".

What a verified task means: the served markup (or container) carries the change. What a
rescan means: the vendors were held where the config denies them, on what it visited.
The checklist never promotes one to the other.

## 2. What exists, what is new

| Piece | Status | Where |
|---|---|---|
| Change list items and groups (B2) | exists; **now carries `id` + `signature`** | `src/report/consent-compatibility.ts` |
| Generator: config + snippet + change list + notes (D8) | exists; **now also `scriptSrc`, `compatibility`, `tasks`**; CLI `--json` prints them | `src/consent-generator.ts`, `src/cli/commands/consent-config.ts` |
| Workspace keys `class:` / `task:` (C1–C4) | exists; **task values under `task:change:<id>` use the remediation vocabulary** (the workbench's `done` reads as `done-unverified`) | `src/site-workspace.ts`, `src/record/remediation.ts` |
| Stable change ids | **new** | `src/record/remediation.ts` (`changeId`, `elementSignatureOf`) |
| Task model (zod) + builder | **new** | `src/record/remediation.ts`, `src/remediation.ts` (`buildRemediationTasks`) |
| Pure verify checkers + spot-check judge | **new** | `src/rules/remediation/verify.ts` |
| Markup parser (A1), container parser (A2), config parser (D2) | exist; the checkers run on them | `src/record/markup.ts`, `src/rules/tracking/gtm.ts`, `src/record/consent-config.ts` |
| Proof scanner (D10), local-copy mode (D11) | exist; the final rescan and the preview | `src/rules/tracking/consent-tool-proof.ts`, `src/local-copy.ts` |
| Recompute-in-place after a classification | R2 | service + report JS |
| Checklist UI (report + site page) | R3 | `src/report/…`, `service/src/client/components/Sites.tsx` |
| Verify endpoints + browser spot check | R4 | service, `src/collect/browser`, CLI |
| Install task + zip | R5 | service |
| e2e | R6 | `service/test`, `test/` |
| Docs | R7 | `docs/guide` |

## 3. The task model

`RemediationTask` (zod, `src/record/remediation.ts`; published in `types/index.d.ts`):

```
id          '<kind>:<12 hex>' | 'install'          §4
kind        'classify' | 'install' | 'remove-existing-tool' | CompatibilityChangeKind | 'confirm-in-browser'
group       'install' | the change-list group id | 'other' (optional items)
title, summary                                        one line each
party?, tools[], partyIds[]
steps[]     plain language, in order (numbered by position in the UI)
snippet?    { before?, after? }                       the change list's markup, or Part 1 of the snippet for install
pages[]     the page it was seen on, then the pages with the same tag
verify      RemediationVerifySpec                     §5 — everything a checker needs, no record lookup
status      'todo' | 'done-unverified' | 'verified' | 'failed' | 'cannot-verify'
lastVerify? { at, result, message, evidence[] }
optional    context-purpose tools (chat, embeds, fonts): listed last, not required
classifyFirst?, notes[], guide?, order
classKey?   'classify' only: the workspace key class:<id> whose classification decides it
waitingOn?  the 'classify' task ids a change waits on (its tools are all unclassified)
```

Built by `buildRemediationTasks(generated, evaluation, { workspace?, kb? })` — pure. The
generator calls it and returns `tasks`, so the service's stored `config.value.tasks` is
the checklist; a stored value without `compatibility` still works (the report is rebuilt
from the evaluation). Order (polish pass, 2026-10-07; decisions added the same day):
**decisions** (`classify`, one per tool the change list could not classify — purpose
`unclassified` — plus those the workspace already classified that the KB does not, so a
made decision stays on the list, done), **install** (`id: 'install'`, first of the changes), **remove the existing consent tool** (one per `existing-consent-tool`
generator note — an outside tool by its hosts, or a platform plugin by its asset-path
fingerprint), a behavior mismatch no other task fixes, **tags to hold** (grouped by page,
in document order), **leaks**, **GTM / tag manager**, **platform**, **consent defaults**,
vendor calls / DNS / find-what-loads / decisions that stay, **confirm in the browser**,
then optional items in the same order. Titles are short and imperative ("Hold the Meta
Pixel tag until consent"); a repeated title gains its page / line or GTM tag number.

**Folding.** The change list explains; the checklist is what the owner does. A party's
`behavior-mismatch` is folded into every task that fixes that party (rewrite, leak, GTM
tag, tag manager, platform, vendor default, DNS, find-what-loads); a `call-consent-api`
into the install task when the config lists an adapter for the vendor; an
`accepted-exposure` into the leak / DNS task that removes it. The fixing task shows "This
also fixes: …" (`alsoFixes`) and keeps the folded ids in `aliases`; its verify is its own.
Where no fixing task checks the party itself (a static check, or a spot check of that
party), one `confirm-in-browser` task per party (id `confirm-in-browser:<hash of party>`)
keeps the folded spot check, near the end. A mismatch nothing else addresses is never
folded: it stays, first after install. The Google Consent Mode default task says "nothing
to paste — the complykit tool sets this; verify after installing" (no snippet) when the
config's gtm section or its google-consent-mode adapter covers every expected signal
(`toolConsentDefault`, the rule `verifyConsentDefault` applies); otherwise the paste steps.

**Decisions in the same list (2026-10-07, after a field run: "two task lists").** A tool
the scan cannot classify used to show up twice: as a classification in the workbench and
as changes flagged "classify first", grouped apart. Now its decision is a task — `kind:
'classify'`, id `classify:<hash of party>`, `verify` manual (nothing on the site to
check), `classKey` the tool's `class:` key — placed before install: the answer decides
which changes apply *and* what the generated config (so the install snippet, whose
Verify checks the config hash) says. A change whose tools are all unclassified carries
`waitingOn: [classify ids]` and shows "Waiting on: your decision on what X is" (its
buttons hidden) instead of a "classify first" of its own; it stays required. A decision's
status is **not** a `task:change:` entry: it is `verified` ("Decided ✓") when the
workspace's `class:` entry holds a chosen purpose other than "Other"
(`classificationDecided`; mirrored in the service and live in the report script, so the
card flips the moment the owner classifies, before "Update report"), else `todo` ("To
decide"). "Update report" regenerates the config from the run, which drops or keeps the
waiting changes and keeps the decision, done. Progress is "N of M done": required = not
optional (decisions and waiting changes included), done = `verified` (passed checks and
made decisions); "marked done" is still counted apart.

Status lives only in the workspace: `task:change:<id>` → `RemediationTaskValue
{ status, note?, lastVerify? }`. A task with no entry of its own reads the first entry
stored under one of its `aliases` (`resolveRemediationTaskValue`; mirrored in the service
and the site page): a status set before a fold is not lost, and a carried `verified`
reads as `done-unverified` unless the task's own check is a spot check too. Verify writes `pass → verified`, `fail → failed`,
`cannot-verify → cannot-verify`; the owner can set `done-unverified` by hand (shown apart
from verified, never folded in). `remediationTotals(tasks)` gives the header counts.

## 4. Stable change ids

`changeId(input)` = `<kind>:<first 12 hex of sha-256(canonical JSON of changeSignature(input))>`.
Line numbers and page URLs are never in it. Golden values are pinned in
`test/remediation-ids.test.ts`; changing the scheme moves every workspace key.

| kind | signature |
|---|---|
| rewrite-tag, remove-leak | the **element signature**: tag kind, context (document / noscript), lower-case host + path of its URL, tag ids in the query (`G-…`, `GTM-…`, upper-cased, sorted); for an inline or data: URL body: the vendor text the KB matched + the ids in the body (never the body). The party is *not* in it: a KB update that recognizes a second vendor in the same tag must not move the task. Fallback when no element was located: party + host/path of the URL. |
| gate-gtm-tag | container id + tag id (the number the GTM UI shows); container + party without a tag id |
| set-consent-default | `google` (one shared item) or api + party |
| use-platform-api | the platform (one shared item) or the party |
| configure-tag-manager | manager + party |
| call-consent-api | party + api |
| change-dns | the alias host, lower-case |
| behavior-mismatch, accepted-exposure, needs-a-look, remove-existing-tool, classify | the party |
| install | constant `install`; the config hash lives in its verify spec |

`ChangeItem.id` and `ChangeItem.signature` are set in `buildCompatibilityReport`; the
change-list markdown anchors each item (`<a id="change-<id>">` + "Change id"), the HTML
item has `id="change-<id>" data-change-id`. `SnippetRewrite.id` carries it into the
snippet's rewrites. Workspace key: `remediationTaskKey(id)` = `task:change:<id>`.

Known limit: two `call-consent-api` items for one party and api with different notes
share an id (the report merges by note). Not seen in fixtures; if it shows up, the api
string should carry the call.

## 5. Verify: method per kind, and what each can prove

| kind | method | input | check |
|---|---|---|---|
| install | static | the home page HTML | `verifyInstall`: exactly one `<script type="application/json" id="complykit-config">`, valid JSON, parses, hash verifies **and equals the latest generated hash**; a `complykit-consent.js` script present, executing, no async/defer/module, no optimizer, config element before it, and **no GTM / gtag / KB-matched vendor script before it** |
| rewrite-tag | static | the page HTML | `verifyRewriteTag`: no element with the signature executes (an original left next to the copy fails: loads twice); at least one held twin with `type="text/plain"` and `data-category` = the vendor's category; a held body calling `document.write` fails; nothing matching → cannot-verify (removed? mark done) |
| remove-leak | static | the page HTML | `verifyRemoveLeak`: no element with the signature is fetched / connected / executed; a held `data-src` form passes with a note |
| gate-gtm-tag | static | the **published container file** (`containerUrl`) | `verifyGtmTagConsent`: the tag's `consent` list carries every expected type; no `consent` → fail; tag id absent (republished, renumbered) or container unreadable → cannot-verify; paused → cannot-verify with a note |
| set-consent-default (Google) | static | the page HTML | `verifyConsentDefault`: before the first Google script, either the installed tool with a `gtm` section, or an inline `gtag('consent','default',…)` denying every expected type; after the tag or missing → fail; no Google script → cannot-verify |
| remove-existing-tool | static | the page HTML | `verifyRemoveExistingTool`: nothing matching the old tool's hosts / KB entry / plugin asset path is loaded |
| behavior-mismatch (unfolded), use-platform-api, call-consent-api (unfolded), configure-tag-manager, set-consent-default (vendor API), confirm-in-browser | **browser** | one page, two visits | `judgeSpotCheck`: pass only if **no request to the vendor's hosts after the reject AND some request after the accept** (the vendor is still there and the tool is what holds it); tool absent, reject not made, accept not made, or vendor gone → cannot-verify |
| change-dns, accepted-exposure, needs-a-look, any item without a located element | manual | — | the owner records it; a rescan decides |

Fail closed, everywhere: `cannot-verify` is its own status and is never a pass. A static
check proves **markup**, not behavior: it cannot see a script that releases the held tag,
a CDN variant, a later republish, server-side forwarding, or another page. The rescan
(D10) is the behavior proof and the checklist says so on every static pass. The spot
check proves one page, one visit, one vendor; it is not the rescan either.

`runVerify(spec, { html?, containerJs?, observation? }, { kb?, site? })` dispatches; the
service gives it what it fetched and stores the outcome. Observation schema for R4:
`SpotCheckObservation { page, toolPresent?, phases: [{ scenario: 'reject'|'accept',
choiceMade, requests: [{url}], stores }] }`.

## 6. UI surfaces

**Report checklist (R3).** A new section `#remediation` above the compatibility table
(heading and nav "Your to-do list"; the workbench panel `#report-workspace` is "Saved
progress" in the consent report, so there is one list), rendered from `config.value.tasks` when the service serves the
report with a workspace (`<script id="ck-service">`); without the service (an exported
report) it renders the tasks the run's generator output carries, read-only. Each task:
number, title, status badge (verified / done, unverified / failed / cannot verify / to
do), the steps, before/after `<pre>`, pages, notes, guide link, a **Verify** button
(static and browser kinds) or "Mark done" (manual), the last verify message and
evidence, a note field. A decision (`classify`) card instead: "To decide" / "Decided ✓",
a button that opens the tool's classify form in the grid, what it unblocks; no buttons of
its own. Header: "3 of 9 done" (verified + decided), then "1 more marked done, not
verified yet · 1 failed", and the **Rescan** button enabled when every required task is verified or
done-unverified (it stays a button, never a verdict). Optional items collapsed under
"Chat, embeds, fonts…". Every item in the compatibility change list links to its task
by `data-change-id`.

**Site page (R3).** `Sites.tsx` gains the same checklist for the latest config (counts in
the site row; the full list on the site), Generate config, download the install zip
(R5), and the rescan button. The site page is where the owner lands between scans.

Wording rules carry over: never "compliant"; a static pass says "the served HTML carries
the change"; a spot-check pass names the page and the visit.

## 7. Endpoints (service; the service never imports the package — it spawns the CLI)

| Endpoint | Does |
|---|---|
| `GET /api/sites/:domain/remediation` | `{ tasks, totals, configAt, runId }` — `config.value.tasks` with status from the `task:change:*` entries (pure merge; no CLI) |
| `PATCH /api/sites/:domain/workspace` (exists) | status / note: `entries: [{ key: 'task:change:<id>', value: { status, note } }]` — the report workbench already writes `task:` keys this way |
| `POST /api/sites/:domain/remediation/:id/verify` | (as built, R4) writes the stored task to a temp file and runs `complykit verify-change --task task.json --site <domain> --json`, which fetches what the spec needs itself (static: the page's served HTML or the container, through a browser context; browser: the spot check) → `{ result, message, evidence, at, check, fetched?, observation? }`; then PATCHes `task:change:<id>` with `{ status, note (kept), lastVerify }` by `verify` and returns `{ task, outcome, stale }`. One verify per site at a time (409 while one runs); a manual task is a 409 |
| `POST /api/jobs/:id/consent-config` (exists) | now also returns `tasks` and `scriptSrc` in `value` (the CLI prints them; the service's `ConsentConfigValue` type gains the two fields) |
| `POST /api/jobs/:id/rerender` (R2, built) | regenerates the stored config when it came from this run, then `complykit report --format consent-html --workspace ws.json [--previous <run>]` on the saved run; the new report replaces `<run>/consent-report.html` (+ `change-list.md`, `.json`), the old one kept as `*.prev.*`; → `{ ok, at, runId, reportUrl, previousReportUrl, classifications, config: { regenerated, stale? } }`. The report embeds `<script id="ck-render">` (the `class:` stamps it applied); the workbench compares them with the workspace's and highlights "Update report with my classifications" (click → endpoint → reload at the same scroll). Offline: the command + a workspace-file download. |
| `GET /api/sites/:domain/install.zip` (R5) | `complykit-consent.js`, `complykit-consent-ui.js`, `complykit-config.json`, `snippet.html`, `change-list.md`, `checklist.md` |
| `POST /api/sites/:domain/rescan` (R6) | the checklist's last step: a new consent job with the URL, checks and quick flag of the site's latest job (else the workspace's newest run URL); body `{ quick? }` picks full or quick (the location is fixed text in the UI: the service scans from its own connection only); 409 while a scan of the site is queued or running → `{ domain, job, from }`. Both checklists follow the new job inline (the jobs stream) and, when done, link to `<report>#consent-tool-proof` |
| `POST /api/jobs/:id/rerender` `{ generate: true }` (R6) | the report's and the site page's **Generate**: makes the config from this run (even when the stored one came from elsewhere), then re-renders, so config, change list and both checklists agree in one step; the report reloads at the same scroll. When the config was stored but the report step failed, the error body carries `configStored: true` (+ `configAt`) and both surfaces say "Your checklist was generated; the report couldn’t refresh — reload or press Update report", with that button (a rerender without `generate`) |
| `GET /api/sites` (R6) | each row carries `checklist: { verified, required, doneUnverified, failed }` over the required tasks |

New CLI (R4, as built): `complykit verify-change --task <task.json | -> [--json]` (or
`--workspace <file> --id <task id>`; `--site`, `--kb-dir`). One command for every
method: static checks fetch the page's served HTML (the top-level navigation response,
subresources blocked) or the container through a browser context, ≤ 20 s; a spot check
runs one page reject-then-accept in two fresh contexts through complykit's exact hooks
(reject falls back to `ComplyKit.withdraw()`), ≤ 60 s; manual is always cannot-verify.
A bot challenge served instead of the page (Cloudflare, Akamai, PerimeterX, DataDome,
Sucuri, Imperva markers; `src/rules/remediation/challenge.ts`) is cannot-verify, "the site
served a bot challenge instead of the page", before any checker runs — static and spot check.
Exit 0 with any result, 2 on bad input. Code: `src/remediation-verify.ts`,
`src/collect/browser/evaluation/verify-change.ts`, `src/cli/commands/verify-change.ts`.

## 8. Rescan and the end state

The last checklist item is the rescan (not a task with a verify spec: it is the job).
The proof section (D10) is the result: controlled / not controlled / not observed per
vendor, with the scope line (pages, locations, runs). `configBehaviorCells` already
turns "fired where the config denies it" into a behavior mismatch, so the change list of
the rescan lists what is still wrong — with the same ids, so the checklist shows which
tasks regressed. The checklist header after a rescan reads the proof totals; it never
reads "compliant" and never counts "not observed" as controlled.

## 9. Work breakdown (parallel after this contract)

- **R2 recompute-in-place.** After a `class:` entry changes for a site: regenerate the
  config for the site's latest finished consent job (debounced; `POST
  /api/jobs/:id/consent-config` internally) so `config.value.{config,snippet,changeList,
  tasks}` follow the classification; serve the report's compatibility section + checklist
  from the live config (a `GET /api/jobs/:id/sections?workspace=1` that runs `complykit
  report --format consent-html --workspace ws.json` and returns the two sections, swapped
  in by the report JS), so the table, the change list and the checklist update without a
  rescan. The `report` command needs `--workspace` (apply `applyWorkspaceToRecord` +
  `reconcileCompatibility` before rendering, as the generator does). Keep ids stable
  across the recompute (they are, by construction) so task status survives.
- **R3 guided checklist UI.** The `#remediation` section renderer in `src/report`
  (pure, from `RemediationTask[]`; tests on wording and structure), its JS (Verify / Mark
  done / note → the endpoints in §7; offline fallback read-only), and the site page list
  in `Sites.tsx`. Depends on R4's endpoint shape only (fixed above).
- **R4 verify endpoints + browser spot check.** `complykit remediation verify` and
  `spot-check` commands; a one-page driver in `src/collect/browser` that lands, rejects
  through the existing choice drivers (autoconsent / our own `ComplyKit` API), records
  requests + stores for a short settle, then a fresh context that accepts, and emits
  `SpotCheckObservation`; the service endpoint that fetches, runs, stores. Chrome channel
  via `COMPLYKIT_BROWSER_CHANNEL=chrome`. Tests: the judge is already covered; the driver
  gets a fixture site test like `test/consent-browser.test.ts`.
- **R5 install task + zip.** Service config for the client build folder; the zip
  endpoint; `checklist.md` rendered from the tasks (R3's markdown renderer or a small
  one); the install task's Verify is `verifyInstall` through R4's endpoint.
- **R6 e2e.** Service test: scan a fixture site (`test/fixtures/tracking-site.ts`),
  classify one tool, see the config and tasks regenerate (R2), apply the snippet and a
  rewrite to the fixture site, Verify passes for install + rewrite and fails for an
  untouched one, mark the rest done, rescan, proof section shows controlled for the
  rewritten vendor and never "compliant".
- **R6 as built (2026-10-07).** Integration fixes: one reconcile for every consumer
  (`reconcileRecord` in `src/consent-compatibility.ts`: the deployed tool's denied-state
  misfires, D10, are behavior mismatches in the generator and the checklist as in the
  report); Generate = rerender with `generate: true` + reload at the same scroll (report
  and site page); the report announces a config regenerated elsewhere (`data-rem-config-at`
  vs the workspace's `config.at`) and offers the same reload; "Rescan site" at the end of
  both checklists, naming the rescan's proof section as the final word; sites-list
  progress; `verifyConsentDefault` accepts the google-consent-mode adapter (no gtm section)
  and held Google tags; `complykit consent` reads `COMPLYKIT_BROWSER_ARGS`. The e2e is
  `test/remediation-e2e.test.ts` over `test/fixtures/remediation-e2e-site.ts` (real CLI,
  service in-process, browser; the fixture answers the geolocation lookups as Germany).
- **R7 docs.** `docs/guide/remediation.md` (the flow, what Verify proves and does not,
  the statuses), a section in `consent-tool.md` §9, sidebar entry; `npm run docs:build`.

## 10. Open points for the owner's workflow

- A rewrite task verifies on the page it was seen on; the other pages in `pages[]` are
  listed but not fetched (one fetch per Verify by design). The rescan covers them.
- "Remove the existing consent tool" and the install should land in one deploy; the
  checklist says so, nothing enforces it.
- The GTM container Verify reads the *published* container. GTM's preview / workspace
  state is invisible; the step says "publish".
- A Shopify / Wix / WordPress platform setting has no static fingerprint from outside;
  it is a spot check, and server-side forwarding stays out of reach (the task says so).
