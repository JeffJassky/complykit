# Registry reference

The registry encodes **what** we check, **why** it is legally required, and
**how** each layer detects it. It is the package's longest-lived artifact:
detection tech churns, the registry compounds.

## Requirements vs rules

| | Requirement | Rule |
|---|---|---|
| Is | A legal fact: this instrument, at this citation, obliges this. | An executable detector: this check, in this layer, evidences (non-)conformance. |
| Changes when | The law changes (rare, dated, externally versioned). | Detection tech changes (often, ours). |
| Cardinality | — | Many-to-many. One requirement may have a static rule, three browser rules, and an LLM rubric. |

A finding cites a **requirement** (its type) and records which **rule** produced
it. Reports group by requirement; engineering debugs by rule.

## Instruments

`wcag`, `en-301-549`, `ada`, `gdpr`, `eu-ai-act`. Cross-instrument incorporation
is **data, not duplication**: EN 301 549 and ADA Title II incorporate WCAG via
`incorporates` edges, so one WCAG entry serves many legal on-ramps.

## Engines map in, they are not rewritten

axe-core, IBM Equal Access, and friends arrive with their own rule IDs. The
registry holds **mapping tables**, not re-encodings. The table is exhaustive
against the pinned engine version — an upgrade that adds rules **breaks CI** until
someone maps them. Engine drift becomes a reviewable diff, not silent coverage
change.

```bash
complykit registry verify        # validates entries + mapping exhaustiveness
```

## Rulesets are queries

`wcag22aa`, `gdpr-consent`, `ai-act-50` are saved filters over the registry, not
hand-maintained ID lists. Custom rulesets compose the same way.

## Versioning

The registry version is stamped into every `run.json`, so a finding means what
the registry meant when it was produced. Requirement entries are **append-mostly**
— a changed legal interpretation is a *new* entry with a `supersedes` link, never
an in-place edit.

## v1 instruments

WCAG 2.2 (via axe + own rules), the GDPR consent / dark-pattern set, and EU AI
Act Article 50. No CCPA, no EAA-beyond-EN301549, no ADA state variants in v1 —
those become registry entries when they come.
