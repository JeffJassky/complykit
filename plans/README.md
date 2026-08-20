# compliance — planning directory

Compliance auditing for web apps: accessibility (ADA/WCAG), GDPR, privacy-policy /
ToS drift, and AI-content disclosure (EU AI Act Art. 50).

Status: **research + ideation.** The delivery shape is deliberately undecided — the
range runs from a public repo of SKILL.md files to an internal agency service to a
client-facing SaaS. What's settled is the layer underneath all three: the record
format. See "Why format first" below.

This package does not follow the recon→synthesize pipeline — there are no source
implementations to mine. It's greenfield, so planning starts from research.

## Research artifacts (stage 0, completed 2026-08-10)

| Doc | Question it answers |
|---|---|
| [research-existing-tools.md](research-existing-tools.md) | What already exists — skills, MCP servers, underlying scanners, commercial products, and the gap analysis |
| [research-distribution.md](research-distribution.md) | How to distribute cross-platform — SKILL.md standard adoption, registries, installers, versioning/auto-update |
| [research-compliance-sources.md](research-compliance-sources.md) | The authoritative legal/technical reference registry each skill cites — with verification status per URL |

## Findings that shape the build

1. **Format is settled.** SKILL.md (agentskills.io) is an open standard adopted by all
   three target CLIs plus ~45 other agents. No per-platform authoring needed.
2. **Install is nearly settled.** `npx skills add <owner>/<repo>` installs to 75+
   agents via symlinks. Supplement with a `.claude-plugin/` marketplace manifest
   (Claude-native versioning + background auto-update) and `gemini-extension.json`
   (Gemini-native `--auto-update`). Codex has no installer; it reads `.agents/skills/`
   which `npx skills` populates.
3. **The niche is crowded with prompt packs, empty of instruments.** Only two existing
   skill projects actually drive a browser, both accessibility-only. Verified
   greenfield: rendered-page EU AI Act Art. 50 checking (nothing exists, commercial or
   open, and the article became enforceable 2 Aug 2026), policy-vs-behavior drift
   reconciliation, and consent-flow behavioral testing (accept vs reject path
   diffing).
4. **The full-page-context constraint has proven foundations.** axe-core injects into
   the live DOM; Playwright/Puppeteer drive real Chromium; the EDPS's own Website
   Evidence Collector and The Markup's Blacklight are mature rendered-page GDPR
   evidence scanners nobody has wired to an agent yet. Never render components in
   isolation — global CSS/JS changes outcomes.
5. **Requirements are citable, with dates.** WCAG 2.2 AA is the audit bar (2.1 AA is
   what DOJ Title II and EN 301 549 legally incorporate); GDPR Arts. 13/14 give an
   itemizable 13-point privacy-notice checklist; EU AI Act Art. 50 obligations are
   specified by the Commission's 20 Jul 2026 guidelines and the 10 Jun 2026 Code of
   Practice (icon set for labeling). Several source sites bot-block — the registry
   marks which URLs need one human click of verification before ship.

---

## Why format first

Two delivery shapes were on the table: per-app foundry package (mongo models +
express routes + react UI installed into each host app, the telemetry/featureboard
pattern) versus a standalone hosted service. Neither survives contact on its own:

- **Per-app packages can't cover tier-1 subjects at all.** A Shopify store, a Webflow
  brand site, or a static marketing page has no backend to install into.
- **Compliance history is an agency asset, not an app asset.** telemetry and
  featureboard install per-app because they're features for the *host's* users.
  Compliance findings are for our engineers. Forty per-app installs means forty
  disconnected databases and no "show me every property missing a cookie banner."
- **A skill that hard-requires infrastructure is dead on arrival as an open-source
  install** — which the distribution research already committed us to.

So: **the record format is the product; the runner is an implementation detail.**
Findings and evidence land as structured files that git, a service, or a laptop can
all produce and read. Everything downstream — portfolio views, scheduling, the UI —
is additive once the format exists, and none of it has to be decided now.

## The record model

Deliberately thin. The goal is surfacing violations and evidence in a navigable way,
not a flawless taxonomy for every variant. A schema that tries to enumerate every
violation type grows rigid and unmaintainable within a release. Six shapes:

| Shape | Carries |
|---|---|
| **Property** | The audited thing. Configured with any subset of four access levels (below). |
| **Run** | Timestamp, tool + ruleset versions, git SHA, scope, and which access levels were actually exercised. |
| **Finding** | Stable fingerprint, subject ref, requirement ref, severity — plus an unconstrained `details` blob. |
| **Evidence** | A `kind` discriminator (screenshot region, DOM snippet, network request, cookie record, file:line) over an opaque payload. |
| **Disposition** | open / fixed / accepted-risk / false-positive / wont-fix, with who, when, why. |
| **Requirement** | The citation registry from `research-compliance-sources.md`, as data. |

Three design notes that do the real work:

**The citation is the type.** Don't invent a violation taxonomy — WCAG success
criteria and GDPR article references already are one, they're externally maintained
by regulators, and they're versioned. A finding's "type" is the requirement it
cites. This is what keeps the schema from growing a new enum per violation class.

**Finding identity is the hard problem.** If a fingerprint derives from DOM selector
plus URL, a CSS refactor makes every finding "new" and the history is worthless. Too
coarse and two real violations collapse into one. Probable answer: rule ID +
normalized *route pattern* (`/product/:id`, not `/product/1234`) + a structural
locator that survives restyling (role + accessible name + ordinal within landmark,
not a raw CSS path), with a fuzzy-match fallback that proposes "probably the same as
finding X" for confirmation.

**Absence findings need their own path.** "Missing cookie banner" is a violation with
no DOM location to fingerprint — most scanners only find things that exist and are
wrong. Absence findings key on requirement + subject instead.

## Access levels

Four levels, configured per property; a run exercises every level the property has
configured. These are **capability flags on a Run**, not different products — same
skills, same format, and the report states its own coverage:

| Level | Runner needs | Notes |
|---|---|---|
| 1. Public | Nothing | Unauthenticated surface. Any runner, server or laptop. |
| 2. Authed | App credentials | Logged-in flows, account pages, checkout. |
| 3. Code repo | GitHub access | Static analysis, route discovery, third-party inventory. |
| 4. Code + infra | Deployment/config access | Headers, CSP, cookie flags, data residency. |

A compliance report that doesn't state its own coverage is misleading — "12 public
routes, 8 authed routes, codebase scanned" versus "public routes only" are different
claims about the same site. For a legal deliverable that distinction is the whole
report.

**Decided: no database or `.env` access.** Runs read the repo and drive the deployed
site; they do not connect to production data stores.

## Route discovery: parse *and* crawl

Router parsing and link-following aren't alternatives — they're complementary.
**Routers give the shape; crawling gives the instances.** A parsed route table yields
`/product/:id` but no real ID to visit; a sitemap or link crawl supplies live
instances to sample. Both feed one artifact.

Rather than writing a parser per framework (Vue Router, React Router, Next.js
file-based, Nuxt, Astro, SvelteKit, plus server-rendered), have the agent read the
repo and *emit* a route manifest — exactly the LLM-shaped task, and it degrades
gracefully to crawling when no repo is configured. Cache the manifest as part of the
property config so it's human-reviewable and not re-derived every run.

## Deployment options (open)

The record format is runner-agnostic, so this can stay open. Three shapes, and one
question decides between them.

**The deciding question: does Playwright/headless Chromium run in a Managed Agents
cloud sandbox?** Unverified. The premise of the whole product is rendered-page
screenshots, and Chromium is a heavier dependency than the documented sandbox use
cases. This is a one-day spike that determines the deployment shape.

| Option | Who hosts the loop | Who hosts the browser | Trade |
|---|---|---|---|
| **A. Managed Agents, cloud sandbox** | Anthropic | Anthropic | Least infrastructure to build — if Playwright runs there |
| **B. Managed Agents, self-hosted sandbox** (`config: {type: "self_hosted"}`) | Anthropic | Us | Playwright works by construction; loses vault env-var credentials |
| **C. Claude Agent SDK on our own server** | Us | Us | Most control; we rebuild scheduling and session persistence |

Agent SDK and Managed Agents are not competing harnesses — they're different splits
of *who hosts*. Agent SDK is harness-only; Managed Agents is harness plus deployment.
The self-hosted sandbox is the seam between them.

### Why Managed Agents is worth the spike

Our three configured property inputs map 1:1 onto primitives that already exist, and
they solve secret handling better than we would build it:

- **Public deployment** → session with `networking: unrestricted` (required — we hit
  arbitrary customer domains)
- **App auth** → vault `environment_variable` credential. The sandbox sees an opaque
  placeholder; the real secret is substituted **at egress**, scoped to
  `allowed_hosts`. Agent-written code cannot read it — which matters when the agent
  ingests untrusted web content all day.
- **GitHub repo** → `github_repository` session resource. The `authorization_token`
  never enters the container; git operations route through an Anthropic-side proxy
  that injects it after the request leaves.
- **Scheduling** → scheduled deployments: cron + timezone, one session per firing,
  per-firing run records with typed errors, pause/unpause, plus a manual trigger for
  testing.
- **Evidence out** → agent writes to `/mnt/session/outputs/`; we pull via the Files
  API scoped to the session.

Caveats: env-var substitution covers **headers and body only, never the URL path**
(path-secret webhooks can't be vaulted); `unrestricted` networking weakens the
`allowed_hosts` scoping those credentials otherwise get; and self-hosted sandboxes
don't support env-var credentials at all (egress is ours, so there's nowhere to
substitute) — app auth there falls back to a host-side custom tool.

## Constraints carried forward

**Server auth must be an API key or Workload Identity Federation — not a Claude Code
subscription.** Anthropic's guidance is explicit that interactive OAuth login is for
development on your own machine; non-interactive workloads (CI, servers, containers)
use WIF. Two practical failure modes on top of the licensing question: refresh tokens
hard-expire and don't slide with use, so a server credential dies periodically with
no warning; and a set `ANTHROPIC_API_KEY` silently shadows any profile, so the two
auth paths fight each other. For a client-facing SaaS this is a terms question, not a
preference.

**Skills must be self-contained folders.** Claude's plugin cache forbids `../` reach
and `npx skills` symlinks per-skill, so shared logic lives on npm, not in a sibling
directory.

**Every finding cites a specific criterion or article** from the reference registry —
no guessed requirements. Volatile sources (DOJ deadlines, Colorado litigation, EN
301 549 v4) get rechecked each release.

**The report says "findings and evidence," never "compliant."** accessiBe took a
finalized $1M FTC order for exactly that overclaim. Coverage-stating reports are the
difference between a useful artifact and a misleading one.

## Design docs (stage 1–2, completed 2026-08-19)

The delivery-shape question above was settled 2026-08-19: CLI toolkit + config
file + machine-readable artifacts, no server/UI; skills for the investigative
LLM layer. The Managed-Agents spike is deferred — the CLI is what a cloud
agent would invoke later.

| Doc | Settles |
|---|---|
| [options-architecture.md](options-architecture.md) | Interaction model, install homes (devDep + audits repo), agent triggering (C1 API calls / C2 skills → SDK v2) |
| [registry-design.md](registry-design.md) | Requirements vs rules split, citations-as-types, engine mappings, coverage matrix |
| [static-analysis-design.md](static-analysis-design.md) | Layer A: lint-ecosystem wrapping, inventories, single-file-provable reliability policy |
| [browser-analysis-design.md](browser-analysis-design.md) | Layer B: check families, computed-style mechanics, pitfalls + mitigation decisions |
| [vision-analysis-design.md](vision-analysis-design.md) | Layer C1: crop adjudication + tiled SoM sweep funnel, dedupe/cache economics |
| [package-structure.md](package-structure.md) | Folder layout, dependency law, pure-rules boundary enforcement |
| [types-sketch.md](types-sketch.md) | Core TS shapes: Requirement, Rule, Finding, Evidence, Run |
| [build-plan.md](build-plan.md) | **Stage 3 output — the build contract.** Awaiting review |

## Next steps

1. Review [build-plan.md](build-plan.md) — blocking items: name, UI divergence
   confirmation, v1 instrument cut, budget default.
2. `/scaffold <name>` after approval; sources.yaml → `planned`.
3. Human-verify the ◇-flagged URLs in research-compliance-sources.md (bot-blocked
   sites: eur-lex, ecfr.gov, federalregister.gov, ico.org.uk, ftc.gov).
