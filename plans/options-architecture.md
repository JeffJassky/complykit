# compliance — architecture decisions (2026-08-19)

Follow-up to [README.md](README.md) (2026-08-10 research). Feature scope is
settled and not in question here: all three layers ship — deterministic repo
analysis, browser-based computed-style/behavioral analysis, and screenshot/LLM
analysis — with the server-config, route-discovery, and output-format surface
already described. This doc works through the *architectural* axes: how the
thing is operated, where it installs, and how the agentic layer is triggered.

Record format, access levels, fingerprint rules, and the "never say compliant"
constraint carry forward from README.md unchanged.

---

## Axis 1 — Interaction model

**Decision: CLI subcommands + config file + artifacts directory. No GUI.**

A full GUI (trigger scans, watch progress, browse findings live) was considered
and rejected as overkill for a toolkit run manually and in CI. What replaces
each GUI job:

| GUI job | Replacement |
|---|---|
| Trigger scans | `npx comply scan` (and CI workflows) |
| Watch progress | Terminal stream — route × viewport × check as it runs |
| Browse full report | **Self-contained static HTML file** per run, Lighthouse-style: violation list, filters, inline screenshots, evidence links. `comply report --open` |
| Machine consumption | JSONL (canonical), CSV, SARIF renderers over the same run |

Escape hatch, explicitly deferred: because findings are files, a local
`report --serve` viewer over `.comply/runs/` is a cheap later add if the static
file ever proves insufficient. Not v1.

## Axis 2 — Install home

**Decision: one package, two homes — devDependency *and* central audits repo.**

Two property classes exist and neither home covers both:

| Property class | Home | Why |
|---|---|---|
| Apps whose repo we own | **devDependency** in that repo | `comply.config.ts` co-located with code; route manifest tracked in-repo; CI gate in that repo's own pipeline; tool version pinned with the app |
| Repo-less properties (client marketing sites, Shopify, Webflow) | One central **audits repo** with many property configs | Nothing to install into; also the only place cross-property queries live ("every property missing a cookie banner") — compliance history is an agency asset (README §"Why format first") |

Same CLI, same config schema, same run layout in both homes. This costs nothing
because config and findings are already just files.

Dependency weight: `playwright` as **peerDependency** (host apps frequently
have it; the audits repo installs it once); browsers via
`npx playwright install` on first run with a clear error, not a postinstall.

## Axis 3 — Triggering the agentic layer

The load-bearing observation: **the agentic layer is two different shapes**, and
they want different harnesses.

### C1 — batch multimodal checks (no agent harness)

Screenshot-region review, text-over-image contrast judgment, focus-indicator
visibility, policy-text vs scan-evidence drift. These are *map operations*:
prompt + image/text + JSON schema out. No file exploration, no tool loop.

**Built directly into the CLI as plain Anthropic API calls with structured
outputs.** `comply review` reads `ANTHROPIC_API_KEY` from env, batches the
run's evidence, writes findings. Cheap, schedulable, CI-safe, and the output
schema is enforced at the API level. No SDK harness, no skills needed.

### C2 — investigative analysis (agent required)

Repo GDPR data-flow (mishandled personal data, erasure capability, third-party
sharing inventory), EU AI Act code-side lineage and Art. 50 obligations. These
need codebase exploration — a real agent loop.

| Trigger option | Trade | Verdict |
|---|---|---|
| **Skills run in interactive Claude Code** (`/comply-gdpr-audit` inside the target repo) | Zero harness code to write or maintain; skills ship in the package's `skills/` dir, installable via `npx skills add` / plugin manifest per the distribution research; subscription auth is fine because a human is at the keyboard | **v1** |
| Shell out to `claude -p` from `comply review --deep` | Minimal code and reuses the machine's existing auth + the same skill files, but the contract with a headless CLI is fragile, and subscription auth is explicitly not for non-interactive workloads (constraint in README) | skip |
| **Claude Agent SDK embedded in the CLI** | Programmatic control, structured progress, findings-writing exposed as a typed tool, API-key/WIF auth — the only option that's legal *and* robust for scheduled/CI runs; cost is that we own harness code | **v2**, when scheduling matters |

Skills remain the source of truth in both phases — the v2 SDK harness loads the
same instruction files the interactive skills use.

### The contract that keeps the format honest

**Agents never write `findings.jsonl` directly.** All agentic findings go
through `comply finding add` (CLI subcommand in v1 skills; a typed SDK tool in
v2), which validates the schema, computes the fingerprint, attaches evidence
refs, and stamps `producer: "agent"`. The deterministic core stays the sole
gatekeeper of the record format, and reports can always separate "axe said"
from "Claude said."

---

## Net shape

```
package  (installed as devDep, or as the dep of the central audits repo)
├─ cli         init / routes / static / scan / review / report / diff / finding add
├─ layer A     repo scanners — pure code, no key
├─ layer B     playwright collectors: axe inject, computed-style contrast,
│              keyboard probes, tap targets, CDP cookies+network pre/post-consent,
│              consent-flow diff, dark-pattern metrics, screenshots,
│              viewports × color schemes
├─ layer C1    plain API multimodal calls inside `review` (ANTHROPIC_API_KEY)
├─ layer C2    skills/ — interactive Claude Code v1; Agent SDK harness v2
└─ core        record format (zod), fingerprints, route manifest,
               renderers (jsonl/csv/sarif/md/static-html), diff, dispositions
```

On-disk per run:

```
.comply/
  runs/<iso-ts>/
    run.json          # tool+ruleset versions, git SHA, access levels exercised, coverage
    findings.jsonl
    evidence/         # screenshots, cookie jars, network logs, style dumps
  routes.json         # cached route manifest — tracked, human-reviewed
comply.dispositions.yaml
```

CI: layers A+B gate merges (SARIF annotations, `comply diff` vs baseline,
fail on *new* criticals per `budget.failOn` — not absolute zero). C1 runs on a
schedule with an API key. C2 is manual in v1, scheduled via the SDK harness
in v2. Layer C never gates a merge.

---

## Open questions for /build-plan

1. **Name.** npm scope + repo slug + Pages base check per template/README.md.
2. **Package split.** Single package with subpath exports vs telemetry-style
   workspace. Real pressure: CI report/diff tooling shouldn't drag Chromium —
   lean `core` + `cli` split, collectors behind the playwright peer.
3. **Static layer build-vs-wrap.** Aggregate existing linters (jsx-a11y,
   vue-a11y) into the record format vs bespoke AST checks. Lean wrap +
   normalize; bespoke only for inventories (AI frameworks, trackers) nothing
   else emits.
4. **Route sampling.** Instances per route pattern per run — config default
   (e.g. 3) + per-pattern override.
5. **WEC/Blacklight wrap-vs-reimplement.** WEC is EUPL (subprocess fine,
   linking risky); Blacklight custom license. Lean own CDP collectors (consent
   diffing needs them anyway); validate against WEC output on the same pages.
6. **Auth capture.** Playwright storageState via an interactive
   `comply auth <property>` flow; CI credential injection env-var convention.
