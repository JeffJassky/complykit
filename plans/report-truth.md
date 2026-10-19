# Report truth (2026-10-19)

Three field bugs, all generic. Contract for the fix; tests listed per part are the
acceptance gate. Branch `report-truth`.

| # | Field case | Bug |
|---|---|---|
| A | telabio.com, `hsforms.net` | Unclassified tool, its `__cf_bm` cookie green everywhere: a cookie-name KB match wins over the tool's state |
| B | allen-heath.com, GA4 / Ads / Meta before a choice | "Couldn't test" although the visit ran and nothing fired: routine coverage notes count as capture gaps |
| C | samsontech.com, `affirm.com` | Classification lost on refresh (browser-driven re-render); "Necessary" silently refused (tracker guard) yet to-do says "Decided ✓"; picker asks for a verdict, not a fact |

Policy reminders: complykit decides verdicts; users supply facts (what a tool does).
Never one-off site fixes.

---

## A. A cookie is never judged better than its tool  — tier: Sonnet

Files: `src/report/consent-matrix.ts` (`buildBehaviorMatrix` storage rows),
`src/report/owner-report.ts` (cookie rows), `src/report/consent-view.ts`
(`storageReviewCards`), `src/report/research.ts`, client `ReportPage.tsx:~400`.

Contract — a storage row's `categories`:
1. Site classification of that cookie (`siteClass(m, partyId, kind, name)`) wins — an explicit fact.
2. Else, if the tool is **unclassified** (its row categories empty or contain `unknown`):
   `categories = []` (→ `review`, "?") even when `lookupStore` matches the name.
   `categorySource` names both: `"<KB label> by name; depends on what <tool> is for"`.
3. Else (tool classified): `union(tool categories, KB-name categories)` — the strictest
   of the two drives the verdict. A cookie of an advertising tool fronted by Cloudflare
   (`__cf_bm`) is off before consent like its tool.
4. A cookie whose party is a KB-known party (first-party `__cf_bm` attributed to
   `cloudflare` via `storeOwner`) is unaffected: its tool *is* Cloudflare.

Owner report: cookie rows take their categories from the matrix row only (drop the
one-way inheritance block in `buildOwnerReport`, now redundant). Unclassified
cookie of an unclassified tool: `purpose: "Depends on what <tool label> is for"`,
`classified: false`. Client: cookie rows pass `unclassified: !k.classified`.

`storageReviewCards` / `research.ts`: a name-matched store under an unknown tool is
not "known" — same rule 2.

Tests: `test/report-truth.test.ts` › "A …".

## B. Only a note that could hide activity is a capture gap — tier: Sonnet

Files: new `src/report/capture-gap.ts`, `src/report/consent-matrix.ts:85`.

Contract: `hidesActivity(note: {scope, id, reason}): boolean` — one documented list,
replaces `NOT_A_CAPTURE_GAP` and the inline id list. NOT a gap (each says nothing
about whether a tool loaded on the pages visited):
- ids `server-to-server`, `vendor-processing`, `contracts`, `consent-records`, `unvisited` (existing)
- GPC-in-workers, `banner design:`, `no visible (search|email) field` (existing)
- `page-exit sends from cross-origin frames …` (beacons from inside a frame on unload; the frame's other traffic is captured)
- `site search: …` (a journey step not taken = an unvisited page, like `unvisited`)
- choice-confirmation notes: `… clicked but the stored consent state did not change`,
  `clicked; no readable consent state …`, `the stored consent state does not reflect …`,
  `autoconsent self-test: …`, `complykit’s tool is on the page: …`,
  `banner driver (@duckduckgo/autoconsent) not installed …`,
  `banner reject failed (…) — opted out by signal and link only`
  (whether a choice took is the grid's `choice`/`choiceGap`, not capture)

Frame-scoped: `storage inside sandboxed frame <url> …` hides only the storage of that
frame's site — a gap for a row whose party `domain`/`hosts` share the frame URL's
registrable domain, nothing else (allen-heath's reject column carried one for a
Cloudflare Turnstile frame). Signature: `hidesActivity(note, party: {domain, hosts})`.

Still a gap: HAR incomplete, `unreadable frame`, throttled run did not complete, any
unrecognised note (unknown text stays conservative).

`captureGap` in `buildBehaviorMatrix` = scoping as today AND `hidesActivity(g, p)`.

Tests: `test/report-truth.test.ts` › "B …" (allen-heath shape: Vimeo frame + no search
box, wiretap state, GA4 absent → `match`, owner state `ok`).

## C. Classifications stick, and the report says what complykit did with them — tier: Sonnet (C1–C3), Sonnet (C4 UI)

### C1. Refusal is recorded, shown, and judged — core
- `src/record/tracking.ts` `siteWorkspace.classifications[]`: add `refused: z.string().optional()`.
- `refuseNecessaryTrackers`: when the refused party has a site classification
  (`ev.siteWorkspace.classifications`, kind tool, same partyId), set its `refused` to
  the `why` text. Return value unchanged.
- `buildBehaviorMatrix` tool row: when `siteClass(m, partyId)?.refused`, categories
  `['other']` (CONSENT: off until consent), `categorySource:
  "complykit: behaves like a tracker (<why>)"`. Its cookies follow rule A3.
- `OwnerToolRow` (both `src/report/owner-report.ts` and `service/src/shared/api.ts`):
  `answer?: { categories: string[]; applied: boolean; reason?: string }` — set when a
  site classification exists for the tool. Refused → `applied:false`, `reason` = why,
  `purpose: "Needs consent (behaves like a tracker)"`, `classified: true`
  (complykit has decided; no "?").

### C2. The server owns the re-render — service
- `PATCH /api/sites/:domain/workspace` with any `class:` key: after the patch, start
  (fire-and-forget, deduped by `rerenderRunning`) a re-render without `generate` of the
  newest done consent job of that domain.
- `GET /api/jobs/:id/report`: a done consent job whose owner report `generatedAt` is
  older than the newest `class:` entry `at` in the workspace is **stale**: start a
  re-render (same dedupe) and answer `updating: true`. A re-render that fails for a
  given (jobId, newest class `at`) is not retried for that stamp; the response
  carries `updateError` (string) instead.
- Client (`ReportPage.tsx` `onClassify`): PATCH, then `refresh()`; no
  `createRerenderQueue` for classifications. Keep the "(saved)" marker until a report
  with `answer` for that classKey arrives. While `updating`, poll as the page already
  does for a running job.

### C3. Decided ≠ applied — service
- `jobReport`: for a classify task whose tool row has `answer.applied === false`, add
  `refused: string` to the task (shared `RemediationTask.refused?: string`). Status
  stays decided (the owner has nothing left to answer; the hold task is the action).
- `DecisionTodo`: refused → "Answered: <answer>. complykit treats it as needing
  consent: <reason>." — not "Decided ✓ / Saved as …".

### C4. Ask what the tool does, not its category — client
`PURPOSES` becomes facts, each mapped to a KB category:

| id (stored `category`) | label | help |
|---|---|---|
| `payments` | Payments or checkout | Pay-later, card or wallet buttons (Affirm, PayPal) |
| `necessary` | Security, login or cart | The site breaks without it |
| `chat` | Chat or support | |
| `embed` | Video, maps or other embedded content | |
| `reviews` | Reviews | |
| `functional` | Another feature visitors use | Saved choices, wishlists |
| `analytics` | Measures visits | |
| `advertising` | Ads or retargeting | |

Stored shape unchanged (`{category, categoryChosen:true, source}`); the generator and
matrix already understand every id. `PURPOSE_LABEL` covers old stored values.

### C5. KB — `affirm.com`
Add a seed entry `affirm` (payments) in `src/registry/kb/entries.ts` only if its
signatures can be cited from the vendor's docs; otherwise queue it via `kb` research
(never `kb confirm`). Its tracker behaviour still decides (C1).

Tests: `test/report-truth.test.ts` › "C …" (core); service: extend
`service/test/rerender.test.ts` / `job-report.test.ts` with — PATCH class: triggers one
re-render of the newest done job; stale GET answers `updating:true` and starts one;
failed re-render not retried for the same stamp and surfaces `updateError`; refused
answer reaches the classify task as `refused`.

## Non-goals
- No change to the generator's treatment of unknown parties (config stays strictest).
- No new owner cell state; "Couldn't test" stays for genuine gaps.
- Full HTML report's in-page reclassification JS unchanged beyond A's server-side rows.
