# Legal guide — contract (2026-10-08)

A page on the complykit site that is the definitive, readable statement of how
complykit tests every place: which rule model applies, which laws, what a site
must have, which visits a scan makes, and the place-specific exceptions and
litigation practice — deduplicated and filterable. Asked for by Jeff after the
first multi-law storyfolder scan: "a reference guide for compliance in all of
these areas … the definitive policy for how we test."

## Principles

- **One source.** Everything comes from the registry the scanner already uses
  (`src/registry/`), so the guide and the reports cannot disagree. The guide's
  own words (policy, model explanations, law summaries, place notes) live in
  `src/registry/guide-notes.ts` and scenario explanations in
  `src/rules/tracking/legal-guide.ts` — both written in PR 0 and not to be
  reworded by implementers.
- **Deduplicated.** A model is explained once (`models`), the wiretap posture
  once (`wiretap`), each law once (`laws`, with its requirements and its
  notes), each scan visit once (`scenarios`). A place carries only ids plus
  what is particular to it (its label, state act, scan plan, its own notes).
- **Two filters that feed each other.** Choosing laws narrows the places to
  those the laws reach; choosing a place narrows the laws to that place's.
- **The service never imports the complykit package.** The core builds the
  guide; a generated `service/src/shared/legal-guide.json` carries it to the
  page; `test/legal-guide.test.ts` fails when the file is behind
  (`UPDATE_GUIDE=1 npx vitest run test/legal-guide.test.ts` rewrites it).

## Data shape

`service/src/shared/legal-guide.ts` (PR 0) — `LegalGuide` and its parts. The
core builder returns a structurally identical value (the test assigns it to the
service type, compile-time).

## PR 0 — contract (frontier, done)

Types, content, failing tests:

- `service/src/shared/legal-guide.ts` — types.
- `src/registry/guide-notes.ts` — `GUIDE_POSTURE`, `GUIDE_MODELS`, `GUIDE_WIRETAP`,
  `GUIDE_LAWS` (per instrument: shortName, scope, summary, risk, notes),
  `GUIDE_PLACE_NOTES` (per place code). Exported from `src/registry/index.ts`.
- `src/rules/tracking/legal-guide.ts` — `GUIDE_SCENARIOS` (what/why per visit).
- `test/legal-guide.test.ts` — the builder.
- `service/src/client/lib/legalGuide.test.ts`, `legalGuide.fixture.ts`,
  `service/src/client/components/LegalGuide.test.tsx` — the page.
- `describe.ts` `WIRETAP_MUST` now cites MD and IL too.

## PR 1 — core builder (Sonnet)

**Files:** `src/rules/tracking/legal-guide.ts` (add `buildLegalGuide`),
`src/rules/tracking/index.ts` (export `buildLegalGuide`, `GUIDE_SCENARIOS`, and
the `LegalGuide` type), `service/src/shared/legal-guide.json` (generated).

**Contract:** `buildLegalGuide(asOf: string): LegalGuide` — pure. Define the
`LegalGuide` type family locally in the core (copy of the service file's types;
`registry/` and `rules/` may not import the service).

- `version: 1`, `asOf`.
- `posture` from `GUIDE_POSTURE`; `models` from `GUIDE_MODELS` (plain arrays,
  not readonly); `wiretap` = `GUIDE_WIRETAP` + `states: [...WIRETAP_STATES].sort()`.
- `scenarios`: `ScenarioId.options` order, each from `GUIDE_SCENARIOS`.
- `laws`: one per instrument that has a requirement with `jurisdictions`, in
  the order `eprivacy, gdpr, pecr, uk-gdpr, ccpa, us-state-privacy, cipa, fsca,
  wesca, mdwa, ilea, enforcement-practice` (= `INSTRUMENTS` order filtered).
  `name` = the instrument's name; shortName/scope/summary/risk/notes from
  `GUIDE_LAWS`; `kind` = the strongest of its requirements' kinds (obligation >
  exposure > practice). `requirements`: every jurisdiction-scoped requirement of
  the instrument, in `ALL_REQUIREMENTS` order: `{ id, title, citation:
  citationLabel(r), text, kind: r.kind ?? 'obligation', since:
  r.effective.from, urls: hrefs, authority: r.authority ?? [], volatile:
  r.volatile === true }`. `placeCodes` = codes of the places whose `lawIds`
  include it, in place order.
- `places`, in this order:
  1. `eu` — "European Union & EEA", group `europe`, `members` = country names
     of `EU_EEA_COUNTRIES` (Intl.DisplayNames 'en'), codes `['eu']`.
  2. `uk` — "United Kingdom", codes `['uk']`.
  3. The 50 states + DC (`US_STATE_NAMES` minus PR, GU, VI, AS, MP), sorted by
     name, code `us-xx`, codes `['us', 'us-xx']`.
  4. `other` — "Everywhere else", group `other`, model `unresearched`, label
     "Not researched", codes `['zz']` for the scan plan.
- Per place: `label` = `describeLocationRules(codes, asOf).label` (except
  `other`); `model`: `opt-in` for eu/uk; for US, `regimeForCodes` →
  `opt-out-signal`, or `opt-out` when the state's act is in force, else
  `opt-out-no-act`; `wiretap` = `isWiretapJurisdiction(codes)`; `lawIds` =
  laws (guide order) with at least one requirement where
  `requirementScopeFor(r, codes, asOf)` is defined (the `any` scope counts — so
  `enforcement-practice` reaches every place, `other` included); `stateAct` from
  `usStateAct()` with `inForce = from <= asOf` and `urls` as hrefs;
  `scenarios` = `defaultScenarios(codes, asOf)`; `notes` =
  `GUIDE_PLACE_NOTES[code] ?? []`, plus for a state act not yet in force one
  `pending` note: title "<act name> takes effect <from>", text naming the date
  (and the privacy-signal date if any) and that nothing is compared under it
  until then. Omit optional fields that are undefined (no `stateAct: undefined`
  keys — the JSON drift check compares structurally).

**Tests:** `test/legal-guide.test.ts` (all), then
`UPDATE_GUIDE=1 npx vitest run test/legal-guide.test.ts` to write the JSON;
`npm run typecheck`, `npm run boundaries` (no-orphans: export what you add),
full `npx vitest run`.

**Invariants:** no edits to `guide-notes.ts`, `GUIDE_SCENARIOS` or any test.
`rules/` imports only `record/` and `registry/`.

**Non-goals:** the page; new legal content.

## PR 2 — the page (Sonnet)

**Files:** `service/src/client/lib/legalGuide.ts` (new),
`service/src/client/components/LegalGuide.tsx` (new),
`service/src/client/lib/useHashView.ts`, `service/src/client/components/Header.tsx`,
`service/src/client/App.tsx`, `service/src/client/styles.css`,
`service/tsconfig.client.json` (`"resolveJsonModule": true`).

**Contract — `lib/legalGuide.ts`:**

```ts
export interface GuideFilter { query: string; models: GuideModelId[]; laws: string[]; wiretap: boolean; place?: string }
export const EMPTY_FILTER: GuideFilter; // { query: '', models: [], laws: [], wiretap: false }
export function isFiltered(f: GuideFilter): boolean;          // query/models/laws/wiretap; `place` is not a filter
export function filterPlaces(g: LegalGuide, f: GuideFilter): GuidePlace[];
export function visibleLaws(g: LegalGuide, f: GuideFilter): GuideLaw[];
export function guidePlaceHref(code: string): string;          // '#laws/<code>'
```

- `filterPlaces`: guide order. AND across groups; OR within a group. Laws: the
  place's `lawIds` meet `f.laws`. Models: `place.model` in `f.models`. Wiretap:
  `place.wiretap`. Query (trimmed, case-insensitive, blank = no filter): matches
  name, code, the bare state code (`ga` for `us-ga`), any member, or the label.
- `visibleLaws`: a known `f.place` → that place's laws in its `lawIds` order;
  else `f.laws` non-empty → those laws in guide order; else filtered → laws
  reaching any place `filterPlaces` returns, guide order; else all laws.
- Routes: `View` gains `'laws'`; `Route` gains `place?: string`. `#laws` →
  `{ view: 'laws' }`; `#laws/<code>` → `{ view: 'laws', place }` with the code
  stripped to `[a-z-]` (lower-cased).

**Contract — `components/LegalGuide.tsx`:**

- `LegalGuideView({ guide, filter, onFilter })` — controlled and pure (the
  tests render it statically). `LegalGuidePage({ place })` — default export for
  App: loads `../../shared/legal-guide.json`, holds the filter state, takes
  `place` from the route; choosing a place is a link to `#laws/<code>`.
- Page order:
  1. `<h1>Legal guide</h1>`, a one-line lede, "As of {asOf}".
  2. **Policy** — `posture.title` and the principles as an ordered list.
  3. **Rule models** — one card per model (label, summary, must-have list),
     then one wiretap card ("Wiretap posture": summary, holds, the states by
     name, linking each to its place).
  4. **Explorer** — filters: search (`<label for="guide-search">Find a
     place</label>` + `<input id="guide-search" type="search">`); model chips;
     a "Wiretap posture" chip; law chips grouped "Duties" (obligation),
     "Lawsuit exposure" (exposure), "Regulator practice" (practice). Every chip
     is a `<button type="button" aria-pressed>`. "Showing N of M places" and,
     when `isFiltered`, a "Clear filters" button.
     - Place list (grouped Europe / United States / Elsewhere): each row an
       `<a href="#laws/<code>">` with the name, the model label as a badge, a
       "Wiretap" badge when `wiretap`, "Act from <date>" when an act is pending,
       and `aria-current="true"` on the chosen place. Empty: "No place matches
       these filters" + "Clear filters".
     - Chosen place panel: name, `label`, its model's summary and must-haves,
       the wiretap `holds` callout when `wiretap`, its state act (name,
       citation, in force / from, GPC from, sensitive-data rule), its scan
       visits by label (each linking to `#scan-visits`), its notes as callouts.
  5. **Laws** — `visibleLaws`, one card each: shortName (h3), full name, kind
     badge ("Duty" / "Lawsuit exposure" / "Regulator practice"), risk badge for
     exposure ("High risk", "Moderate risk", "Moderate–low risk", "Low risk"),
     scope, summary, "Reaches N places", each requirement (title, citation,
     since, text in `<details>`, links, "Recheck: volatile" when volatile,
     authority notes), and the law's notes as callouts.
  6. **How we test** (`id="scan-visits"`) — every scenario: label, what, why.
- A note callout: `<aside class="guide-note note-<kind>">` with a kind label —
  posture "complykit’s decision", litigation "In court", exception
  "Exception", pending "Pending" — the title, text, and source links.
- Every law and model summary appears exactly once in the page.
- Layout: explorer is two columns on wide screens (list | panel), one column at
  phone width with no horizontal scroll; follow the existing tokens and
  component classes in `styles.css` (badges, cards, chips). Links that leave
  the site open in a new tab with `rel="noreferrer"`.
- Header: a "Laws" link (`href="#laws"`, icon `globe`) after "Sites".

**Tests:** `service/src/client/lib/legalGuide.test.ts`,
`service/src/client/components/LegalGuide.test.tsx`; the service's
`npm run typecheck` and `npx vitest run`.

**Invariants:** no edits to tests, the fixture or `legal-guide.ts` types. If
`service/src/shared/legal-guide.json` does not exist in your worktree, write
the fixture to it as a placeholder (PR 1 replaces it at integration).

**Non-goals:** editing legal content; a server API (the JSON is bundled).

## Integration (frontier)

Merge PR 1 and PR 2, regenerate the JSON, build, check the page in a browser
(desktop and phone width), deploy.
