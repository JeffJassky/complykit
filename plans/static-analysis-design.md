# compliance — static analysis layer design (2026-08-19)

Companion to [options-architecture.md](options-architecture.md) (layer A) and
[registry-design.md](registry-design.md). Answers: how does static analysis
actually work, what does it cover, does it handle Vue/React templates, and
where does it stop.

## Role — what static is *for*

Static analysis is not "the browser scan at lower fidelity." It has three jobs
the other layers can't do, and it does nothing else:

1. **Instant, in-PR feedback on the provable slice** — no server, no browser,
   no key; runs in seconds on every push.
2. **Inventories invisible to any browser scan** — server-side code: tracker
   SDKs, AI framework lineage, PII schema surface, third-party data egress.
3. **Leads for other layers** — needs-review findings that route to the
   browser layer or an LLM rubric for confirmation.

## Mechanism — three passes

### Pass 1: wrap the lint ecosystems (breadth for free)

Template-level a11y linting is solved; we integrate, not rebuild:

| Stack | Tool | How it parses |
|---|---|---|
| React/JSX/TSX | `eslint-plugin-jsx-a11y` (~40 rules) | JSX elements are first-class ESTree AST nodes |
| Vue SFC | `eslint-plugin-vuejs-accessibility` (~25 rules) | `vue-eslint-parser` compiles `<template>` into a template AST (elements, attributes, directives — `:alt` / `v-bind` understood) |
| Plain HTML | parse5-based checks | Static marketing sites, no framework |
| Svelte/Angular | later; same pattern (`svelte-eslint-parser`, `@angular-eslint`) | |

Execution: ESLint **programmatic Node API** with our own curated flat config —
a11y rules only, the host repo's own eslint config deliberately ignored (their
lint politics are not our audit). Framework detected from package.json deps.
Engine output runs through mapping tables (`engineRule → requirement`), the
exact pattern registry-design.md establishes for axe: exhaustive against the
pinned plugin version, CI-breaking when an upgrade adds unmapped rules.

### Pass 2: bespoke scanners — the inventories

Where static earns its keep. Mechanics: **string/regex pre-filter first**
(ripgrep-class literal scan over the repo to find candidate files), then parse
only candidates with a fast native parser (SWC or oxc, ~ms/file), walk the AST
for structured extraction. Never build a full type-checked TS program — that's
10–100× the cost for nothing these rules need.

| Inventory | Looks for | Output |
|---|---|---|
| **Trackers/SDKs** | imports/requires of known tracker packages (gtag, mixpanel, posthog, sentry, pixel snippets); `<script src>` URLs against tracker domains; `document.cookie` writes; storage of known tracker keys | Findings + the third-party sharing inventory; cross-referenced against the same tracker/cookie DB the browser layer uses |
| **AI frameworks** (EU AI Act) | imports of openai / @anthropic-ai / langchain / ollama / ai-sdk etc.; provider endpoints in string literals | Inventory findings **and the `has-ai-features` applicability tag** — derived from repo evidence, not human assertion (feeds registry `appliesIf`) |
| **PII surface** | schema/model fields matching PII name patterns (email, phone, dob, ssn, address) in mongoose/prisma/zod definitions; forms whose action posts off-origin | needs-review findings; scoping input for the C2 data-flow skill |
| **Consent-adjacent leads** | analytics script inclusion with no consent-gating construct in the same file | needs-review; browser layer's pre-consent capture confirms or clears |

### Pass 3: nothing — the deliberate stop

No cross-file semantic analysis. "Label component in parent, input in child,"
"does the delete endpoint actually erase the user's rows," "is this cookie set
only after consent" — these need reasoning over composition and data flow, not
AST pattern-matching. Building that deterministically is a type-checker-scale
project with a false-positive profile that would poison trust in the whole
layer. It's exactly what layer C2 (investigative skills) exists for, with the
pass-2 inventories as its scoping input.

## Reliability policy

**A static rule asserts `confidence: violation` only when the defect is
provable from a literal in a single file.**

- `<img>` with no alt attribute → violation.
- `alt={someVar}` / `:alt="someVar"` → *silence* (not needs-review noise); the
  browser layer sees the rendered value and judges there.
- Inferential patterns (consent gating, PII heuristics) → `needs-review`,
  routed onward.

Cost is undercounting; that's fine because layer B exists. Benefit is a
near-zero false-positive rate, which is what lets the layer gate PRs without
becoming ignored.

Component indirection (`<Button>` wrapping `<button>`): handled via
jsx-a11y-style `components` mapping in property config — the repo declares its
design-system → element mapping. Imperfect, documented, per-repo knob.

## Coverage — stated honestly

| Domain | What static covers |
|---|---|
| WCAG | ~15–20 of ~50 AA criteria *touched*, mostly partial depth: literal missing alt, invalid ARIA roles/attrs/values, missing `lang`, positive tabindex, in-file label association, media element captions presence, distracting elements, heading order (partial), anchor validity |
| Contrast, focus order, reflow, target size, rendered composition | **Zero — impossible statically.** Requires cascade + rendered tree. Layer B, by design |
| GDPR / AI Act inventories | **Only layer that can produce these** — server code is invisible to a browser scan |

The registry's per-rule `layer` field makes this split queryable —
`comply coverage` reports it, and `run.json` records what actually executed.

## Execution shape (`comply static`)

1. File discovery: repo-relative, `.gitignore`-respecting, source-extension
   globs; per-file content-hash cache → incremental in CI.
2. Pass 1 (ESLint programmatic, curated config) and pass 2 (pre-filter →
   targeted parse) run concurrently; both emit RawFindings.
3. Normalization: mapping tables → canonical findings, `producer: "static"`,
   evidence = `file:line` + snippet.
4. **Fingerprints use repo-relative path + rule + structural anchor**
   (element + attribute name), *not* line numbers — lines shift every commit;
   `file:line` lives in evidence only.

Performance target: < 30s cold on a 100k-LOC repo, < 5s warm (cache); ESLint
pass restricted to template/component files, native parsers everywhere else.

## Build-vs-wrap resolution (closes options doc §7.3)

Wrap + normalize for template a11y (pass 1); bespoke only for the inventories
(pass 2), which nothing off-the-shelf emits in our record format. Both feed the
same mapping-table discipline so engine/plugin drift is a visible CI diff.
