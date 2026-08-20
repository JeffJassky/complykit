# compliance — package structure (2026-08-19)

How the package is carved so boundaries stay hard as it grows. Four candidate
structures considered; recommendation at the end with the enforcement
mechanics.

## The boundary-defining observation first

Everything designed so far implies one split that matters more than any
folder scheme: **collection is I/O; evaluation is pure.**

- *Collectors* touch the world — filesystem, ESLint, Playwright, CDP, the
  Anthropic API. They produce **artifacts**: file inventories, DOMSnapshots,
  cookie jars, request logs, screenshots, crop verdicts.
- *Rules* are pure functions `(artifacts, registry) → RawFinding[]`. No
  browser handle, no fs, no network. Which means: **every rule is testable
  from fixtures** — record artifacts once, evaluate forever, no Chromium in
  the rule test suite.

Any structure that lets a rule reach into a live page has already lost the
boundary war — the rule becomes untestable without a browser and the layers
bleed. So the structure question is really: how do we arrange folders so this
split (and a few dependency directions) is mechanically enforced?

## Option 1 — layer-first

`static/ browser/ vision/ core/`. Mirrors the architecture docs.

- For: matches how we think and how the docs are written; heavy deps isolate
  naturally (Playwright in browser/, SDK in vision/).
- Against: rules and collectors cohabit per layer, so nothing stops a browser
  rule from grabbing the page object; cross-layer rule families (contrast
  spans browser + vision) get split arbitrarily; "core" becomes the junk
  drawer every layer-first design grows.

## Option 2 — domain-first

`a11y/ gdpr/ ai-act/`. Mirrors the legal instruments.

- For: matches how findings are reported and sold.
- Against: worst engineering boundaries available — every domain needs every
  layer, so Playwright/ESLint/SDK deps smear across all three folders; shared
  browser machinery (settle, profiles, snapshot) has no home; adding an
  instrument duplicates plumbing. Domains are a *registry* dimension
  (instrument field), not a code dimension. Rejected outright.

## Option 3 — rule-centric

Every rule family is a folder co-locating its static + browser + llm
detection: `rules/contrast/{static,browser,llm}.ts`.

- For: a rule's full story in one place; adding a rule touches one folder.
- Against: only works if rules are pure — at which point the co-location is
  of *evaluators*, and collectors still need their own home; done naively it
  couples every rule folder to every heavy dep, destroying the
  import-without-Chromium property the CI report tooling needs.

## Option 4 — pipeline-stage (data-flow) — **recommended, with option 3's
co-location for evaluators**

Folders are stages; the record format is the only thing that crosses a stage
boundary. Rules are pure and grouped by family *inside* the evaluation stage.

```
src/
  registry/            PURE DATA. requirements/<instrument>.ts, mappings/
                       (axe, jsx-a11y, vue-a11y…), rulesets.ts, verify.ts
  record/              THE HUB. zod schemas: Finding, Evidence, Run,
                       Disposition, Artifact types; fingerprint.ts; run-store
                       (read/write .comply/runs). Imports nothing but zod.
  collect/
    static/            file discovery, cache, eslint runner, pre-filter+parse
                       primitives (oxc/swc), emits StaticArtifacts
    browser/           session, profiles (measurement/evidence), settle,
                       scroll-through, DOMSnapshot, CDP capture, consent
                       driver, interaction probes, screenshot/crop capture —
                       emits BrowserArtifacts. ONLY place Playwright exists.
  rules/               PURE. one file per rule: metadata + evaluator
    a11y-structure/    (artifacts) → RawFinding[]
    contrast/
    keyboard/
    consent/           dark-pattern metrics, cookie classification
    inventories/       trackers, ai-frameworks, pii-surface
    art50/
    index.ts           explicit registration; CI check: every rule file
                       exported + mapped to a requirement (traps.md pattern)
  judge/               C1 harness: pHash dedupe, verdict cache, tiler, SoM
                       overlay, batch client, llm-rule executor. ONLY place
                       the Anthropic SDK exists. Emits VerdictArtifacts —
                       which rules/ evaluate like any other artifact.
  report/              renderers (jsonl/csv/sarif/md/static-html), coverage
                       matrix, diff, dispositions
  cli/                 command wiring ONLY — parse args, sequence stages,
                       print progress. No logic worth testing.
skills/                C2 SKILL.md folders (data, shipped, not imported)
```

Note what fell out: **vision is not a layer folder.** The LLM is a collector
(judge/ produces verdict artifacts) and the decisions about those verdicts are
rules like any other. That keeps "Claude said X" inside the same pure,
fixture-testable evaluation path as "axe said X."

## Dependency law (the actual boundaries)

```
registry  → (nothing)
record    → zod
rules     → record, registry            ← pure; the heart
collect/* → record  (+ its own heavy dep)
judge     → record, registry, SDK
report    → record, registry
cli       → everything
```

Nothing imports cli. Nothing imports across collect/static ↔ collect/browser.
rules import NO collector — artifacts arrive as values.

Enforced mechanically, not by convention:

1. **dependency-cruiser** (or eslint import rules) in CI encoding the table
   above — a PR that adds `import { chromium }` inside rules/ fails to merge.
2. **Subpath exports as the public boundary**: `.` (record+registry+report,
   dep-light — CI diff/report tooling imports this without Chromium),
   `./collect-static`, `./collect-browser` (Playwright peer), `./judge` (SDK
   peer), `./cli` (bin). Internal files outside `exports` are unimportable —
   the boundary is package-enforced for consumers.
3. **Fixture-only rule tests**: rule test harness accepts artifacts from
   `test/fixtures/` recorded by a `comply fixtures record` dev command.
   A rule needing anything else can't be written.
4. **Registration completeness check** (traps.md §test-d blind spot pattern):
   mechanical test that every file under rules/ is registered in index.ts and
   every registered rule maps to ≥1 requirement.

## Why one package, not a workspace

Telemetry split core/client/cli on *trust boundaries* (browser vs server).
Here every stage runs in the same trust context (our runner), and the
dep-weight problem is solved by subpath exports + peer deps without version
skew between N packages. Revisit only if an external consumer wants
`registry` standalone — it's pre-carved for extraction (imports nothing).

## Growth test

- New WCAG criterion: registry entry + rule file (+ fixture). Two folders.
- New engine (IBM Equal Access): mapping table + collector call. No rule
  changes.
- New instrument (CCPA): registry data + maybe new rule family folder.
- Swap SDK for Agent SDK harness (v2): judge/ internals only.
- New renderer: report/ only.

Each change lands in one or two folders with the blast radius visible from
the diff paths alone — which is the definition of well-boundaried.
