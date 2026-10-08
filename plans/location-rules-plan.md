# Location rules — plan and work breakdown

Decided 2026-10-08. Branch `location-rules` off `main`.

## Why

The scanner already applies a different rule set per verified location (EU/UK opt-in;
California opt-out with the privacy signal; the other signal states; the wiretap states).
A check of 14 locations on 2026-10-08 found these gaps:

1. Outside California, the only encoded state duty is honoring GPC. Every comprehensive
   state act also gives a right to opt out of targeted advertising / sale and requires a
   clear and conspicuous way to do it. Virginia, Utah, Iowa, Tennessee, Indiana, Kentucky
   and Rhode Island (acts in force, no GPC duty) got **no** checks at all.
2. Countries outside EU/UK/US come back `unknown`: nothing is compared, and the report
   does not say so. The client treats them as opt-in. Both are right; the report must say
   which happened.
3. A US visit whose state could not be verified is `opt-out` in the scanner and
   `opt-out-signal` in the client. Also intentional (the scanner never asserts a state law
   it could not verify; the client fails closed) — and also unexplained in the report.
4. The report's state check (`optOutSignalStates()`) ignores each state's start date.
   Harmless today (every listed date has passed); wrong the day a future-dated state is
   added.
5. `test/compatibility.test.ts` labels `us-tx` "opt-out"; Texas is opt-out-signal.
6. The report never states which location was detected and which model of rules it
   compared against. The user asked for that, with a hover popover that explains the
   model and cites the law.

Out of reach for a browser scan, so a non-goal: the states' opt-in duties for
*sensitive* data (health, precise location, children). Those belong to the privacy-policy
and judge layer.

## Design

**One source of truth for "which rules apply here".** `src/registry/describe.ts` →
`describeLocationRules(codes, onDate, opts)` derives, from the registry alone:

- the **regime** (`opt-in` | `opt-out-signal` | `opt-out` | `unknown`) via the shared
  `regimeForCodes()` in `regime.ts` (same table the client bundles);
- a **label**, a **summary**, the **must-have** bullets (the user's EU-vs-California table,
  written for a site owner), and
- the **laws**: every requirement whose `jurisdictions` reach these codes on this date,
  with its citation, title, URLs and start date — the same `requirementScopeFor()` the
  rules use, so the popover cannot list a law the rules do not apply;
- for US states, the **state act** (name, citation, URL, in-force date, GPC date) from
  `src/registry/us-states.ts`;
- **notes** for the two documented divergences (unverified US state; unresearched country).

The report model stores it per location (`locations[].rules`), so JSON, Markdown and HTML
all render the same facts. The HTML gets a hover/click disclosure next to each location.

**New requirement** `us-states.opt-out-method` (right to opt out of targeted
advertising / sale + clear-and-conspicuous method), scoped to every comprehensive-act
state except California with each act's in-force date. The existing `tracking.opt-out-link`
rule fires under it for those states (no icon check — that is CCPA-specific).

**Dates everywhere.** `regimeForCodes`, the matrix regime, `optOutSignalStates` and the
compatibility expectations all take the scan date.

Vocabulary: the report says "rules", "model", "compared against"; never "compliant"
(`assertReportVocabulary`).

## Execution model

| Role | Who | Where |
|---|---|---|
| Contract + tests | Fable | commit 1 on `location-rules` |
| Implementation | Sonnet, one agent per PR, worktree-isolated | PRs A–D, branches `lr-<letter>` |
| Per-PR gate | Sonnet reviewer, one pass, checklist below | each PR |
| Area review | Fable, three passes | integrated `location-rules` |

Worktrees live under `packages/` (foundry ignores `packages/*/`):
`git worktree add ../ck-wt-<letter> -b lr-<letter> location-rules`, then
`ln -s ../complykit/node_modules node_modules`. Tests: `COMPLYKIT_BROWSER_CHANNEL=chrome
npx vitest run <files>`. Typecheck: `npx tsc --noEmit`. Boundaries: `npm run boundaries`.

Sonnet may not change the contract (registry data, types, tests). If it looks wrong, stop
and report. Deleting or weakening a test is forbidden; adding tests is encouraged.

## Contract (Fable, commit 1)

Files: `src/registry/regime.ts`, `src/registry/us-states.ts` (new),
`src/registry/describe.ts` (new), `src/registry/citation.ts` (new; `citationLabel` moves
here from `report/consent-model.ts`, which re-exports it), `src/registry/requirements/tracking.ts`,
`src/registry/instruments.ts`, `src/registry/index.ts`, `src/index.ts`, `types/registry.d.ts`,
`types/index.d.ts`, `types/test-d.ts`, `src/report/consent-model.ts` (model field only),
`test/regime.test.ts`, `test/location-rules.test.ts` (new), `test/opt-out-link-rule.test.ts`
(new), `test/location-rules-report.test.ts` (new), `test/location-rules-browser.test.ts`
(new), `test/compatibility.test.ts` (label fix only).

Adds:
- `US_PRIVACY_ACT_STATES` (state, act in force `from`, optional `gpcFrom`);
  `US_OPT_OUT_SIGNAL_STATES` now derived from it. `isUsPrivacyActState(region, onDate)`.
- `RegimeVerdict = ConsentRegime | 'unknown'`; `regimeForCodes(codes, onDate?, { unverifiedUs })`.
- `US_STATE_PRIVACY_ACTS`, `US_STATE_NAMES` (registry-only; not bundled into the client).
- `describeLocationRules()` and the `LocationRules` type. `LocationRules.laws` is derived
  from `ALL_REQUIREMENTS` — no hand list.
- Requirement `us-states.opt-out-method`.
- `ConsentReportModel.locations[].rules: LocationRules`.

Red until implemented (named per PR below).

## PR A — Dates and the shared regime (Sonnet)

- **Files**: `src/report/consent-matrix.ts`, `src/rules/tracking/compatibility.ts`,
  `src/rules/tracking/plan.ts`, `src/report/cookie-purpose.ts` (only if a signature forces
  it), `src/consent-generator.ts` (only if a call site breaks).
- **Contract**: `regimeForCodes`, `describeLocationRules`, `US_PRIVACY_ACT_STATES`.
- **Scope**: `consent-matrix.ts regimeFor(jurisdictions, onDate)` and
  `compatibility.ts regimeOf(jurisdictions, onDate)` delegate to `regimeForCodes` (policy
  `unverifiedUs: 'baseline'`); their `label` comes from `describeLocationRules(...).label`.
  `plan.ts optOutSignalStates(onDate = today)` selects the two signal requirements **by id**
  (`ccpa.regs.7025`, `us-states.opt-out-signal`) — not by instrument, since
  `us-states.opt-out-method` now shares the instrument — and filters by the per-scope
  `from` date (this is why `test/regime.test.ts` "exactly the shared table" and "agrees
  with the report matrix" are red in the contract commit);
  `defaultScenarios(jurisdictions, onDate?)` / `quickScenarios` likewise. The matrix column
  `locationLabel` is `${l.label} · ${rules.label}`, computed from `l.jurisdictions` and the
  model's `startedAt` date (not from `l.rules`, so older fixtures still build).
- **Tests to make green**: `test/regime.test.ts` (all), `test/location-rules.test.ts`
  → "matrix and compatibility agree with the shared regime" cases, existing
  `test/consent-matrix.test.ts`, `test/compatibility.test.ts`, `test/consent-analysis.test.ts`.
- **Invariants**: registry imports nothing internal; rules import no collector; the client
  bundle (`client/`) builds and its size budget passes (`cd client && npm run check`).
- **Non-goals**: no new rules, no report HTML, no change to `regimeFor(location)` semantics.

## PR B — Opt-out method in the other states (Sonnet)

- **Files**: `src/rules/tracking/rules.ts` (the `optOutLink` rule only), `src/report/human.ts`
  (copy only if a test demands it), `docs/guide/consent.md` (one paragraph).
- **Contract**: requirement `us-states.opt-out-method`; `requirementScopeFor`.
- **Scope**: `optOutLink.requirements` gains `us-states.opt-out-method`; scope resolution
  `ca ?? st` exactly like `optOutSignal`; `requirementId` follows the scope; for the state
  scope emit `missing-link`, `requires-personal-info`, `too-many-steps` but never
  `missing-icon`; messages for the state scope must not cite 11 CCR and must name the state
  act (`US_STATE_PRIVACY_ACTS[state].name`). `missing-link` still requires an advertising /
  sale-share party at that location. Dedup key stays `${pattern}|${scope}`.
- **Tests to make green**: `test/opt-out-link-rule.test.ts` (all), existing
  `test/consent-pipeline.test.ts` if the browser is available.
- **Invariants**: a California visit produces CCPA findings only (no double-firing); an
  unverified location produces nothing; a state whose act starts after the scan date
  produces nothing.
- **Non-goals**: no new scenario, no walker changes in `collect/browser`, no change to the
  CCPA messages.

## PR C — Report: detected location, model, popover (Sonnet)

- **Files**: `src/report/consent-html.ts`, `src/report/consent-md.ts`, new
  `src/report/consent-location-rules.ts` (renderer + CSS + JS).
- **Contract**: `ConsentReportModel.locations[].rules` (`LocationRules`).
- **Scope**: a section `<section id="locations-rules">` after the scope block and before the
  matrix, heading "Where we tested and which rules applied". One `<article class="ck-loc"
  data-location="{id}">` per location: label, verified / observed place, then
  `<span class="ck-loc-rules"><button type="button" class="ck-rules-btn"
  aria-expanded="false" aria-controls="rules-pop-{id}">{rules.label}</button>
  <div class="ck-rules-pop" id="rules-pop-{id}" data-open="false">…</div></span>`.
  The popover holds `<p class="ck-rules-summary">`, `<ul class="ck-rules-must">`,
  `<ol class="ck-rules-laws">` (one `<li>` per law: `<a href>` citation — title, "since
  {date}"; no `<a>` when there is no URL), `<p class="ck-rules-state">` for the state act,
  `<p class="ck-rules-note">` per note. Visible on `:hover` / `:focus-within` of
  `.ck-loc-rules` or `data-open="true"`; click toggles `data-open` and `aria-expanded`;
  Escape and an outside click close; `@media print` shows every popover inline.
  Every string through `esc()`, every href through `safeHref()`. Markdown: under
  `## Locations`, each location gets `  - Rules: {label} — {summary}`, one `  - Law:
  {citation} — {title} ({url})` per law, one `  - Note: …` per note.
- **Tests to make green**: `test/location-rules-report.test.ts`,
  `test/location-rules-browser.test.ts` (needs `COMPLYKIT_BROWSER_CHANNEL=chrome`),
  existing `test/consent-report.test.ts`, `test/report-browser.test.ts`.
- **Invariants**: `assertReportVocabulary` passes; the page has no horizontal scroll at
  390 px; no `pageerror`.
- **Non-goals**: no change to the matrix, no change to the model, no new JSON fields.

## PR D — Docs, changelog, citation verification (Sonnet)

- **Files**: `docs/guide/location.md`, `docs/guide/consent.md`, `docs/reference/registry.md`,
  `CHANGELOG.md`, new `plans/location-rules-citations.md`, `src/registry/us-states.ts`
  (**only** the `verified` / `botBlocked` fields of URLs — nothing else).
- **Scope**: location.md gets "What the scanner compares against, per location" (a table
  generated by running `describeLocationRules` for DE, GB, US-CA, US-TX, US-VA, US-FL, US-NY,
  US (no state), BR) and a "Where the scanner and the consent tool differ, and why" section
  (the two divergences). Changelog entry under Unreleased. Then fetch every URL in
  `us-states.ts` and `requirements/tracking.ts` for `us-states.*`; record `verified: <date>`
  or `botBlocked: true`; write `plans/location-rules-citations.md` listing, per state, the
  section that grants the opt-out right and the one that requires the clear-and-conspicuous
  method, with the quote and URL, or "could not confirm". Do **not** edit citations in the
  registry — the list is for human confirmation.
- **Tests to make green**: `npm run docs:build`; `test/location-rules.test.ts` keeps passing.
- **Non-goals**: no code changes beyond URL verification fields.

## Per-PR reviewer checklist (Sonnet, one pass)

1. Files touched ⊆ the task's file list. Anything else: name it.
2. No test deleted, skipped, or loosened (diff `test/`).
3. No edit to registry data, types, or `describe.ts` (contract).
4. Every new string in a renderer passes through `esc()`; every href through `safeHref()`.
5. `npx tsc --noEmit`, `npm run boundaries`, the task's named tests: paste the output.
6. Docs touched where the task says so.
Verdict: merge / fix list. No design re-derivation.

## Area reviews (Fable, on the integrated branch)

1. **Legal data and copy**: `us-states.ts`, `requirements/tracking.ts`, `describe.ts`
   copy, the popover text — what a site owner reads must be true and must not over-claim.
2. **Rule scoping and dates**: no double-firing CA/state, nothing on unverified locations,
   future-dated states inert, matrix/compat/plan agree with `regimeForCodes`.
3. **Popover safety and a11y**: escaping, `safeHref`, keyboard, print, narrow screens.

## Non-goals (whole epic)

- Sensitive-data opt-in duties; children's data; VPPA.
- Research or encoding of non-EU/UK/US countries (queued as a research note, not built).
- Changing the client's regime decisions.
- Publishing.
