# The record format

The record format is the product. Six shapes, deliberately thin — the goal is
surfacing violations and evidence navigably, not a flawless taxonomy for every
variant.

| Shape | Carries |
|---|---|
| **Property** | The audited thing, with any subset of four access levels. |
| **Run** | Timestamp, tool + ruleset versions, git SHA, and which access levels were actually exercised. |
| **Finding** | Stable fingerprint, subject ref, requirement ref, severity, plus an unconstrained `details` blob. |
| **Evidence** | A `kind` discriminator (screenshot region, DOM snippet, network request, cookie, file:line, verdict) over an opaque payload. |
| **Disposition** | open / fixed / accepted-risk / false-positive / wont-fix, with who, when, why. |
| **Requirement** | The citation registry, as data. |

## The citation is the type

A finding's "type" is the requirement it cites — WCAG success criteria and GDPR
article references are already an externally-maintained, versioned taxonomy. This
is what keeps the schema from growing a new enum per violation class.

## Finding identity is a frozen fingerprint

A finding's fingerprint derives from its **stable** parts only, so a CSS refactor
does not make every finding "new":

- **presence** findings: rule id + property + route pattern (or file path) +
  a structural locator (role, accessible name, landmark, ordinal within landmark).
- **absence** findings ("missing cookie banner" has no DOM node): requirement id
  + property + route pattern.

Deliberately **excluded** from the hash: instance URLs, line numbers, CSS paths,
viewport, and colour scheme. A contrast failure in dark mode is the *same*
finding as in light — the variants land in evidence, not identity.

The algorithm is **v1-frozen**. A change ships as a new version tag plus a
migration that re-keys `comply.dispositions.yaml`, so historical findings never
silently change meaning.

## No producer inflates its own authority

Every finding — from axe, from a rule, from an agent — is normalized through one
gatekeeper. Confidence is **capped** by the rule's declared maximum, and severity
**narrows** the requirement's default and never raises it. Agents never write
`findings.jsonl` directly; they go through `complykit finding add`, which
validates the schema, computes the fingerprint, and stamps the producer. Reports
can always separate "axe said" from "Claude said".
