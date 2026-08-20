# compliance — rule registry design (2026-08-19)

Companion to [options-architecture.md](options-architecture.md). The registry is
the encoding of what we check, why it's legally required, and how each layer
detects it. It is the largest single engineering artifact in the package and the
one with the longest life — detection tech will churn; the registry compounds.

## The load-bearing split: requirements vs rules

One flat "violation registry" rots immediately, because it couples two things
that change on different clocks and for different reasons:

| | **Requirement** | **Rule** |
|---|---|---|
| What it is | A legal/normative fact: this instrument, at this citation, obliges this | An executable detector: this check, in this layer, evidences (non-)conformance with requirement(s) |
| Changes when | The law changes (rare, dated, externally versioned) | Detection tech changes (often, ours) |
| Authored by | Legal-source transcription + human verification | Engineering |
| Cardinality | — | **Many-to-many.** One requirement may have a static rule, three browser rules, and an LLM rubric; one rule (e.g. consent-diff) may evidence several requirements |

A Finding cites a **requirement** (that's its type — README's "the citation is
the type") and records which **rule** produced it. Reports group by
requirement; engineering debugs by rule.

This split is also what makes the coverage report *derived instead of
hand-written*: requirements enumerate the obligation space; rules declare what
they cover and in which layer; the delta is, mechanically, the "not
auto-checkable, needs human audit" list. For a legal deliverable that
statement is the whole report (README §access levels), and here it falls out
of the data model for free.

## Requirement encoding

Pure data. No code, no detection logic. One file per instrument, entries
validated by zod.

```ts
{
  id: "gdpr.art7.3",                    // hierarchical, citation-shaped, stable
  instrument: "gdpr",                    // → instruments table: full name, links,
                                         //   jurisdiction, official-text license
  citation: { article: 7, paragraph: 3 },// law/section/point as structured fields,
                                         //   shape varies per instrument family
  title: "Consent must be as easy to withdraw as to give",
  text: "…",                             // normative excerpt (EU/US official legal
                                         //   texts are public domain; per-instrument
                                         //   license noted on the instrument)
  authority: [                           // interpretive sources that sharpen it
    { ref: "edpb-03-2022", note: "click-asymmetry as dark pattern" },
  ],
  urls: [{ href: "…", verified: "2026-08-10", botBlocked: true }],
  effective: { from: "2018-05-25" },     // AI Act Art.50: from 2026-08-02
  version: null,                         // WCAG entries carry "2.1" | "2.2"
  appliesIf: ["processes-personal-data", "targets-eu"],  // applicability tags,
                                         //   matched against property config
  severityGuidance: "critical",          // default; rules may narrow, not raise
}
```

Design notes:

- **IDs are citation-shaped and hierarchical** (`wcag22.1.4.3`,
  `eu-ai-act.art50.1`, `en301549.9.1.4.3`) so a finding's type reads as its
  legal reference and sorts into the instrument's own structure.
- **Cross-instrument incorporation is data, not duplication.** ADA Title II
  incorporates WCAG 2.1 AA (DOJ rule); EN 301 549 incorporates WCAG. Encode as
  `incorporates: { requirement: "wcag21.*", level: "AA" }` edges on the
  instrument — one WCAG entry, many legal on-ramps. A US-jurisdiction report
  cites the same finding through the ADA edge; an EU one through EN 301 549.
- **Applicability is a predicate, not prose.** Property config declares tags
  (`targets-eu`, `has-ai-features`, `processes-personal-data`, `public-sector`);
  requirements gate on them. This keeps "why is an AI Act rule firing on a
  brochure site" from ever happening, and makes the registry safely
  over-inclusive.
- **Verification metadata is part of the entry** — the research already flags
  bot-blocked sources needing one human click per release
  (research-compliance-sources.md). `verified` dates make staleness queryable.

## Rule encoding

A rule = metadata (data) + implementation (code or rubric), linked by ID. The
metadata is uniform across layers; the implementation interface differs per
layer.

```ts
{
  id: "consent.click-asymmetry",
  requirements: ["gdpr.art7.3"],         // ≥1; the legal hook(s)
  layer: "browser",                      // static | browser | llm
  confidence: "violation",               // violation | needs-review  (axe's
                                         //   "incomplete" concept, promoted to
                                         //   a first-class field: needs-review
                                         //   routes to the LLM layer or a human)
  severity: "critical",
  evidence: ["screenshot", "dom-snippet", "interaction-log"],  // what check MUST attach
  detects: "presence",                   // presence | absence  (absence findings
                                         //   fingerprint on requirement+subject,
                                         //   per README — declared here so the
                                         //   fingerprinter branches on data)
  remediation: "…",                      // short, framework-neutral guidance
  falsePositives: "…",                   // known traps, for the disposition workflow
}
```

Per-layer implementation interfaces:

- **static** — `applies(fileCtx) → check(ast|text) → RawFinding[]`. Runs
  per-file or per-repo (inventories).
- **browser** — `check(pageCtx) → RawFinding[]` where `pageCtx` exposes the
  Playwright page, CDP session, computed-style helpers, and the consent-diff
  primitives. Rules compose collectors; they don't own browser lifecycle.
- **llm** — **the implementation is data**: a rubric (prompt template), the
  evidence kinds it consumes, and a zod output schema. A single generic
  executor (C1 batch calls, or the C2 skill harness) iterates llm-rules. This
  is the highest-leverage decision in the design: adding an LLM check —
  usually the fastest-growing category — means adding a registry entry, not
  writing harness code. It also makes LLM checks diffable, reviewable, and
  versionable like everything else.

## External engines map in, they don't get rewritten

axe-core, IBM Equal Access, Lighthouse etc. arrive with their own rule IDs and
their own WCAG tags. The registry holds **mapping tables**, not re-encodings:

```ts
{ engine: "axe-core", engineRule: "color-contrast",
  requirements: ["wcag22.1.4.3"], confidence: "violation" }
```

The normalization step (options doc, layer B) runs engine output through the
mapping into canonical findings. Unmapped engine rules fail loudly at build
time — the mapping table is exhaustive against the pinned engine version, so an
axe upgrade that adds rules breaks CI until someone maps them. That's the
feature: engine drift becomes a visible, reviewable diff instead of silent
coverage change.

## Rulesets are queries, not lists

`"wcag22aa"`, `"gdpr-consent"`, `"ai-act-50"` — the config-surface names — are
saved filters over the registry (`instrument = wcag, version ≤ 2.2, level ≤ AA`),
not hand-maintained ID lists that drift. Custom rulesets compose the same way.

## Coverage matrix — the derived payoff

Because both sides are enumerated:

```
comply coverage --ruleset wcag22aa
  50 success criteria in scope
  31 auto-checked        (static: 4, browser: 27)
  11 llm-assisted        (needs-review escalation or rubric)
   8 manual-only         ← the honest gap, printed in every report
```

`run.json` records which rules actually executed (a browser rule can't run if
the property has no reachable target; an llm rule can't without a key), so the
per-run coverage statement is *actual*, not theoretical.

## Packaging and lifecycle

- **Requirements + mappings = a pure-data module** — the model-catalog pattern:
  no host coupling, importable without Playwright or an API key. Subpath export
  (`<pkg>/registry`) first; promote to its own package only if an external
  consumer materializes.
- Registry entries live as TS data files (typed literals, zod-validated in CI)
  — reviewable in PRs, greppable, no YAML-loader indirection.
- **Versioning:** registry version is stamped into `run.json` alongside tool
  versions. Requirement entries are append-mostly; a changed legal
  interpretation is a *new* entry with a supersedes link, never an in-place
  edit — otherwise historical findings silently change meaning.
- **Release checklist hook:** `comply registry verify` lists entries whose
  `verified` date predates the last release + the bot-blocked URLs needing the
  human click. Volatile items (DOJ deadlines, EN 301 549 v4, AI Act guidance)
  carry a `volatile: true` flag to sort that list.
- **Not-a-lawyer posture, encoded:** entries carry normative text and authority
  links; findings say "evidence against requirement X," never legal
  conclusions. The report renderer enforces the vocabulary (README's accessiBe
  lesson).

## Sizing honestly

The engineering (schemas, mapping loader, coverage computation, generic llm
executor) is days. The *content* is the long pole: WCAG 2.2 A/AA is ~50
criteria (mostly arriving via axe mappings), GDPR consent/notice surface is
~20–30 requirements, Art. 50 is ~6–10 — but each entry needs transcription and
a verification pass. Sequence it as: schema + axe mapping first (instant
breadth), then the dark-pattern/consent set (already drafted in the
brain-dump), then Art. 50 (greenfield, time-boxed by the enforcement date),
then drift/data-flow rubrics.
