# Divergences from the design docs

Where the build departed from a design doc, or resolved a conflict between two
of them. The build plan wins over design docs by rule (task brief); each entry
records the call and why. **None may be left unresolved at `/audit`** (done.md).

---

## 1. Requirement default-severity field name — RESOLVED

- **Conflict:** `types-sketch.md` names the field `severity: Severity` on
  `Requirement`; `registry-design.md`'s prose example names it
  `severityGuidance: "critical"`.
- **Call:** `severity`. types-sketch is the types doc, and `record/normalize`
  consumes it directly as the requirement default severity that a rule may
  narrow. One name, one consumer.
- **Where:** `src/registry/schema.ts` (`Requirement.severity`).

## 2. Branded ids declared in two modules — RESOLVED (not a drift)

- **Design:** types-sketch lists identity primitives (`RequirementId`, …) once,
  under a shared "Identity primitives" heading.
- **Constraint:** the dependency law (package-structure.md, and the task's hard
  constraints) forbids `registry/` from importing anything internal — it is
  pre-carved for standalone extraction.
- **Call:** the branded ids are declared in both `record/ids.ts` and
  `registry/ids.ts`. This is safe, not drift: zod's `BRAND` symbol is a single
  symbol per zod install, so `.brand<'RequirementId'>()` in both modules infers
  the *same* structural type, and the compiler treats them as one. A registry
  `RequirementId` is assignable to the `RequirementId` a `Finding` cites.

## 4. Type-contract drift mechanism: assertion, not import-direction — RESOLVED

- **House rule (traps #21):** hand-written `types/` stay honest because `src/`
  imports its public types FROM `types/`, so src can't grow a shape the
  declarations don't describe.
- **Conflict:** complykit is zod-first (types-sketch.md) — record shapes are zod
  schemas and their types are `z.infer`red. src imports its shapes from zod, not
  from `types/`, so the import-direction mechanism cannot apply.
- **Call:** keep the published contract hand-written in `types/`, and restore the
  drift guarantee with a compile-time assertion in `src/record/contract.ts`:
  `AssertEqual<z.infer<typeof Finding>, Public.Finding>` for every load-bearing
  record/config/registry type. A schema that grows a field fails `tsc` in src
  against the published type — the same failure the import-direction rule gives,
  by a different lever. `types/test-d.ts` still exercises the surface from
  outside as a host sees it, and `scripts/check-exports.mjs` (traps #9) diffs the
  built bundle's value exports against the `.d.ts` — no blind spot.

## 3. RuleMeta lives in rules/, not registry/ — RESOLVED

- **Design:** types-sketch groups `RuleMeta`/`Rule` under a "Registry: Rule"
  heading, implying registry ownership.
- **Constraint:** `RuleMeta.evidence` is `EvidenceKind[]` and `Rule.evaluate`
  returns `RawFinding[]` / consumes `ArtifactKind`s — all defined in `record/`,
  which `registry/` may not import.
- **Call:** registry holds only the pure legal data (requirements, instruments,
  engine mappings, rulesets, verify). The executable `RuleMeta`/`Rule`/`LlmRule`
  interfaces live in `rules/`, which may import both record and registry. This
  matches the dependency law's intent — "registry imports nothing" — over the
  doc's heading grouping.

## 5. Contrast measurement: pixel-band histogram → glyph-mask A/B diff — RESOLVED

- **Design:** `browser-analysis-design.md` describes WCAG 1.4.3 contrast as a
  histogram over a "largest contiguous luminance run" background guess
  (`pixel-band.ts`), reconciled against axe's cascade-inferred colours by
  `contrast-reconcile.ts`.
- **Conflict:** field re-scan of maxedmarketing.ai (2026-09-16, HEAD 7d0f9af)
  produced verdicts a person can refute by eye (a 17.42:1 pill reported as a
  1–1.61:1 violation, an 18.38:1 subtitle never measured at all — see
  `plans/glyph-contrast-plan.md` §1). Root cause: the histogram approach
  infers background by statistics, not by isolating the glyph pixels
  themselves, so bold anti-aliasing and a CTA's dark surround can outvote the
  actual background.
- **Call:** `plans/glyph-contrast-plan.md` (approved 2026-09-16, branch
  `glyph-contrast`) replaces the histogram guess with a glyph-mask A/B pixel
  diff: screenshot the subject, make only its glyphs transparent, screenshot
  again, and treat every pixel where the two frames differ as an exact glyph
  mask with the true background behind it (§2, §4.1 `measureGlyphs`). Per the
  plan's authority note, this document wins over `browser-analysis-design.md`
  wherever the two disagree on contrast measurement.
- **Also:** axe's own `color-contrast` findings are no longer a second,
  independently-reported source of truth. `engines.ts` now settles every axe
  `color-contrast` node against the glyph-mask measurement of the same
  element (`resolveAxeTargets`/`measureRefs`): any node with a measured match
  is dropped and `contrast.text` is the single reporter for that element;
  only unmatched axe nodes (nothing measured there) still report as axe found
  them. This removes the old dual-reporter path where axe's cascade-based
  ratio and the pixel-band ratio for the same text could disagree with no way
  to tell which was right.
- **Bug fixed along the way:** axe's shadow-DOM target shape (a target array
  like `[["host", "p"]]` for `host >>> p`) failed the results schema in
  `engines.ts`/`axe.ts` and silently dropped **every** axe finding on any page
  with open shadow DOM — not just the shadow-rooted ones. Confirmed on the
  ground-truth corpus: before the fix, `plans/contrast-truth-baseline.md`'s
  first run scored TP 2 / FN 15 on a page with one shadow-DOM case; after the
  fix (still on the old pixel-band scanner), TP 12 / FN 5. Regression test:
  `test/axe-shadow-target.test.ts` (fixture
  `test/fixtures/pages/axe-shadow-target.html`).
- **Verified:** `node scripts/score-contrast-truth.mjs` on the finished
  scanner — FP 0, FN 0, unresolved 0, ratio errors 0 over all non-`limitation`
  corpus cases (`plans/contrast-truth-after.md`), versus FP 1, FN 5 on the
  pre-change baseline (`plans/contrast-truth-baseline.md`).
