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
