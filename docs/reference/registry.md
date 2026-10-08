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

## Location rules

Which rules apply to a place is derived from the registry, not listed by hand.

- `describeLocationRules(jurisdictions, onDate)` returns a location's model label,
  summary, must-have bullets, the laws compared (from the requirements whose
  jurisdictions reach it on that date) and notes. The report's location popover renders it.
- `regimeForCodes(codes, onDate, { unverifiedUs })` is the scanner's regime decision
  for jurisdiction codes: `opt-in`, `opt-out-signal`, `opt-out` or `unknown`.
- `US_PRIVACY_ACT_STATES` is the table of states with a privacy act: the date each act
  is in force and, where it applies, the date its signal duty starts.
- `US_STATE_PRIVACY_ACTS` holds each act's name, citation and official URLs.

Tracking requirements for the US states are `us-states.opt-out-signal` (honor a universal
opt-out signal) and `us-states.opt-out-method` (a clear and conspicuous way to opt out of
targeted advertising and sale). California's equivalents are `ccpa.regs.7025` and
`ccpa.opt-out-link`.

## Versioning

The registry version is stamped into every `run.json`, so a finding means what
the registry meant when it was produced. Requirement entries are **append-mostly**
— a changed legal interpretation is a *new* entry with a `supersedes` link, never
an in-place edit.

## v1 instruments

WCAG 2.2 (via axe + own rules), the GDPR consent / dark-pattern set, and EU AI
Act Article 50. No CCPA, no EAA-beyond-EN301549, no ADA state variants in v1 —
those become registry entries when they come.
