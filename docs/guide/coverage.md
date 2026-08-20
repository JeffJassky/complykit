# Coverage & honesty

A compliance report that doesn't state its own coverage is misleading. "12 public
routes, 8 authed routes, codebase scanned" and "public routes only" are different
claims about the same site. For a legal deliverable, that distinction is the whole
report.

## Access levels

Four levels, configured per property; a run exercises every level configured and
records which it actually reached.

| Level | Runner needs | Notes |
|---|---|---|
| Public | Nothing | Unauthenticated surface. |
| Authed | App credentials | Logged-in flows, account pages, checkout. |
| Code repo | Repo access | Static analysis, route discovery, third-party inventory. |
| Code + infra | Deploy/config access | Headers, CSP, cookie flags. |

Decided: **no database or `.env` access** — runs read the repo and drive the
deployed site; they never connect to production data stores.

## The coverage matrix is derived, not hand-written

Requirements enumerate the obligation space; rules declare what they cover and in
which layer; the delta is, mechanically, the "needs human audit" list:

```
complykit coverage --ruleset wcag22aa
  50 requirements in scope
  31 auto-checked   (static / browser rules)
  11 llm-assisted   (rubric or needs-review escalation)
   8 manual-only    <- the honest gap, printed in every report
```

`run.json` records which rules **actually executed** — a browser rule can't run
without a reachable target, an LLM rule can't run without a key — so per-run
coverage is *actual*, not theoretical.

## Coverage gaps are explicit

When a page can't be reached — a cross-origin iframe, a closed shadow root, a
timeout, a bot block, a missing key — the run records a typed `CoverageGap`
rather than silently narrowing the claim.
