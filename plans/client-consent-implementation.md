# complykit — client consent tool: implementation plan

Written 2026-10-06 from [client-consent-design.md](client-consent-design.md). Every row is a
GitHub issue on JeffJassky/complykit (filed the same day; the epic lists them). Issue numbers
are in the epic, not here, so this file does not go stale.

## Model assignment

| Model | Used for | Rule |
|---|---|---|
| Sonnet | mechanical, well-specified work: tables, docs, CSS, plumbing an option, UI over an existing API | the spec in the ticket is complete; no judgment calls |
| Opus | complex work needing judgment: parsers, state machines, integrations across subsystems, research | design decisions inside a fixed scope |
| Fable | the most critical and most complex: the claims the product makes (verdict, gate, config contract, GTM parser, the proof step) | a wrong result here is a false pass in a litigated area |

Counts: sonnet 15 · opus 20 · fable 6 · total 41.

## Phases

### A. Scanner: implementation checks (M14)

| Key | Ticket | Model | Depends on |
|---|---|---|---|
| A1 | Scanner: static markup inspection of every visited page | opus | — |
| A2 | Scanner: Google Tag Manager container parser | fable | — |
| A3 | Scanner: in-page consent-API call recorder | opus | — |
| A4 | Scanner: detect the installed consent tool and its default state on a fresh profile | sonnet | — |
| A5 | Scanner: platform fingerprint (Shopify, Wix, Squarespace, WordPress + consent plugin) | sonnet | — |
| A6 | Scanner: one implementation class per party (the seven ways) | opus | A1, A2, A5 |
| A7 | Scanner: throttled second run per scenario and 'N of N runs' in the record | sonnet | — |
| A8 | KB: control facts per vendor (consent API, restricted mode, install-snippet leaks) | opus | — |

### B. Compatibility verdict and report (M15)

| Key | Ticket | Model | Depends on |
|---|---|---|---|
| B4 | Scanner: default journey performs a site search | sonnet | — |
| B1 | Compatibility verdict per tool (gateable / tag-manager / platform / uncontrollable / unknown) | fable | A6, A3, A8, A4 |
| B2 | Report: compatibility section, owner change list, 'outside your consent tool's reach' line | opus | B1 |
| B3 | Report: every pass carries pages / time / location / login state / run count | sonnet | A7 |
| B5 | Docs: compatibility verdicts and what a scan cannot tell you | sonnet | B2 |

### C. Site workspace on the service

| Key | Ticket | Model | Depends on |
|---|---|---|---|
| C1 | Service: per-site workspace store and API | opus | — |
| C2 | Report workbench reads and writes the site workspace when served by the service | opus | C1 |
| C3 | Rescans apply the site workspace and report what changed since the last run | opus | C1 |
| C4 | Service client: per-site page (runs, workspace summary, latest config) | sonnet | C1 |
| C5 | Exported report embeds a dated workspace snapshot and a link back | sonnet | C2 |

### D. Client package core (M16)

| Key | Ticket | Model | Depends on |
|---|---|---|---|
| D1 | Client package scaffold: build, size budget, fixture test harness | sonnet | — |
| D2 | Config schema shared by scanner and client (versioned) | fable | — |
| D3 | Client: consent state store and consent record | opus | D2 |
| D4 | Client: script gate | fable | D2 |
| D5 | Client: vendor consent-API adapters | opus | D2, A8 |
| D6 | Client: Google Tag Manager bridge | opus | D2 |
| D7 | Client: location source, regime decision, GPC | opus | D2 |
| D8 | Generator: scan → config + snippet + change list | opus | D2, B1, C1, B2 |
| D9 | Client: unstyled banner and settings layer (functional, accessible) | opus | D3 |
| D10 | Scanner: detect complykit's tool, drive it by selectors, compare deployed config with reality | fable | D2, D8, B1 |
| D11 | Prove the loop on one GTM-heavy sample site | fable | D4, D5, D6, D7, D8, D9, D10 |

### E. Platform bridges (M17)

| Key | Ticket | Model | Depends on |
|---|---|---|---|
| E1 | Client: Shopify bridge | opus | D7, D3 |
| E2 | Client: WordPress Consent API bridge | sonnet | D3 |
| E3 | Client: Wix consent policy bridge | sonnet | D3 |
| E4 | Close the loop on one Shopify and one WordPress sample site | opus | E1, E2, D11 |

### F. Banner UI and self-check (M18)

| Key | Ticket | Model | Depends on |
|---|---|---|---|
| F1 | Client: theme tokens and the three layouts | sonnet | D9 |
| F2 | Client: string table with per-regime defaults and required-string guardrails | opus | D9, D7 |
| F3 | Client: withdrawal flow | opus | D3, D4, D5 |
| F4 | Service: optional consent-record endpoint | sonnet | C1 |
| F5 | Client: self-check — accessibility, dark-pattern rules, Firefox and WebKit | opus | F1, F2, F3, F6 |
| F6 | Scanner: rules for consent-banner design (equal prominence, no pre-ticked boxes, no cookie wall, required strings) | opus | B1 |

### G. Docs and release gate

| Key | Ticket | Model | Depends on |
|---|---|---|---|
| G1 | Docs: client install guide, platform recipes, config reference | sonnet | D11, E4 |
| G2 | Release gate: package publish checklist (pause point) | sonnet | F5, G1 |

## Parallelism: waves

A wave starts when every ticket it depends on is done. Tickets inside a wave run in parallel.

**Wave 1** — A1 (opus), A2 (fable), A3 (opus), A4 (sonnet), A5 (sonnet), A7 (sonnet), A8 (opus), B4 (sonnet), C1 (opus), D1 (sonnet), D2 (fable)

**Wave 2** — A6 (opus), B3 (sonnet), C2 (opus), C3 (opus), C4 (sonnet), D3 (opus), D4 (fable), D5 (opus), D6 (opus), D7 (opus), F4 (sonnet)

**Wave 3** — B1 (fable), C5 (sonnet), D9 (opus), E1 (opus), E2 (sonnet), E3 (sonnet), F3 (opus)

**Wave 4** — B2 (opus), F1 (sonnet), F2 (opus), F6 (opus)

**Wave 5** — B5 (sonnet), D8 (opus), F5 (opus)

**Wave 6** — D10 (fable)

**Wave 7** — D11 (fable)

**Wave 8** — E4 (opus)

**Wave 9** — G1 (sonnet)

**Wave 10** — G2 (sonnet)

## Critical path

D2 (config schema) → D4/D5/D6/D7 → D8 (generator, also needs B1) → D10 (proof scanner) → D11 (prove the loop) → E4 → G1 → G2.
B1 (verdict) sits on A6 (which sits on A1, A2, A5), A3, A4 and A8. Starting A1, A2, A3, A4, A5, A8 and D2 on day one shortens everything.

## Pause points (human)

- Before D11 and E4 run against any site: owner's go-ahead (standing rule — never a live site without it).
- Before G2: the first npm publish is a separate human decision.
- Any Fable ticket's output is reviewed by a person before dependent tickets start.

## Ticket format

Each issue carries: goal, scope, done-when, dependencies (issue links), the model and why.
Labels: `epic`, `model: sonnet|opus|fable`, `phase: A–G`.
