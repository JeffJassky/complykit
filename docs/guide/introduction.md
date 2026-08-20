# Introduction

complykit audits web properties for accessibility (WCAG 2.2 / ADA / EN 301 549),
GDPR consent behaviour and dark patterns, and EU AI Act Article 50 transparency
— and reports **findings, evidence, and coverage**. It never asserts that a site
is "compliant": that is a legal conclusion, and a report that overclaims it is
worse than no report (accessiBe took a finalized \$1M FTC order for exactly that).

## What it is

- A **CLI** you run manually or in CI, plus the programmatic API the CLI wires
  together.
- A **file-based record format** — runs, findings, and evidence land as
  structured files that git, a laptop, or a scheduled agent can all produce and
  read. The format is the product; the runner is an implementation detail.
- A **registry** of legal requirements (the citation *is* the finding's type)
  and the rules that detect (non-)conformance, in three layers: static, browser,
  and LLM-assisted.

## What it is not

- **No hosted service, daemon, or web UI** — a toolkit and CI, plus a
  self-contained static HTML report.
- **No "compliant" verdicts or legal advice.**
- **No auto-remediation or overlay injection** — reports propose fixes, never
  patch sites.
- **No CAPTCHA / bot-defense evasion** — a blocked page is a recorded coverage
  gap, not something to defeat.

## The shape of a run

```
.comply/
  runs/<run-id>/
    run.json         tool + ruleset versions, git SHA, access levels, coverage
    findings.jsonl   one finding per line, append-only
    evidence/        screenshots, cookie jars, network logs — content-addressed
  routes.json        cached route manifest — tracked, human-reviewed
comply.dispositions.yaml
```

Read on: [Quickstart](/guide/quickstart) · [The record format](/guide/record-format).
