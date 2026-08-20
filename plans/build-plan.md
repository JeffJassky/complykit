# complykit — build plan (stage 3, 2026-08-19)

**Approved 2026-08-19.** Name: **complykit** (`@jeffjassky/complykit`, repo
slug `complykit`). §11 blocking items all confirmed: static-HTML UI
divergence, v1 instrument cut, `failOn: "new-critical"` default.

Greenfield package (no recon/synthesis — the oauth-host precedent). Sources:
the six design docs in this directory, distilled here per
`process/3-build-plan.md`. Design detail lives in the docs; this is the
sequenced, reviewable contract for the build.

| Settled in | Doc |
|---|---|
| Record model, access levels, coverage honesty | [README.md](README.md) |
| CLI shape, install homes, agent triggering | [options-architecture.md](options-architecture.md) |
| Requirements/rules registry | [registry-design.md](registry-design.md) |
| Static layer | [static-analysis-design.md](static-analysis-design.md) |
| Browser layer + pitfall mitigations | [browser-analysis-design.md](browser-analysis-design.md) |
| Vision layer (C1) | [vision-analysis-design.md](vision-analysis-design.md) |
| Folder layout + dependency law | [package-structure.md](package-structure.md) |
| Core types | [types-sketch.md](types-sketch.md) |

---

## 1. Name — user's call

Checked 2026-08-19 (404 = free):

| Candidate | npm | Notes |
|---|---|---|
| **complykit** | free | says what it is; "kit" matches the toolkit framing |
| **comply-kit** | free | hyphenated variant |
| **compliance-audit** | free | literal, long |
| `comply`, `compy`, `attest`, `verdict`, `lawful`, `auditkit` | taken | |

Publish scoped either way (`@jeffjassky/<name>`, house convention); the
unscoped check protects the repo slug / Pages base / prose name. Config file
follows the name (`<name>.config.ts`); this plan writes `comply.config.ts` as
a placeholder.

## 2. Public API — one screen

Primary surface is the CLI; the programmatic API is what the CLI wires
together, and it's what CI scripts and the v2 SDK harness import.

```
CLI   init | routes | static | scan | review | report | diff | coverage |
      auth <property> | finding add | fixtures record | registry verify

Programmatic (writes are verbs, reads are the noun):
  defineConfig(cfg): Config
  discoverRoutes(property): RouteManifest
  collectStatic(property): Artifact[]
  collectBrowser(property, opts): Artifact[]        // needs playwright peer
  evaluate(artifacts, registry, ctx): Finding[]     // pure
  judge(run, opts): Artifact[]                      // needs anthropic peer
  addFinding(run, raw): Finding                     // validate + fingerprint
  loadRun(id) / listRuns(property): Run / Run[]
  diffRuns(base, head): RunDiff
  renderReport(run, format): string | Buffer
  coverage(ruleset, run?): CoverageMatrix
```

One thing per name; nothing else exported from the root.

## 3. Config surface

Greenfield rule: every key cites the design doc that proves the need — and
the first three real consumers are our own properties (maxed, mailery,
featureboard), which is the paper test before any external use.

```ts
export default defineConfig({
  properties: [{
    id: string,
    targets: {                       // options-arch: URL or command+port
      public?:  { url },
      local?:   { command, port, readyPath? },
      staging?: { url },             // browser-design mitigation 11 (bot defense)
    },
    auth?: { kind: "storage-state", path } | { kind: "form", script },  // options-arch axis 2
    repo?: string,                   // enables layer A + manifest emit
    tags?: ApplicabilityTag[],       // registry-design appliesIf; has-ai-features auto-derived
    routes: {
      sitemap?: boolean, crawl?: { maxPages, sameOrigin },
      manifest?: path,               // agent-emitted, cached, human-reviewed
      include?: [], exclude?: [],
      sample?: number,               // instances per pattern, default 3 (browser-design)
    },
    viewports?: preset[] , colorSchemes?: ("light"|"dark")[],
    rulesets: string[],              // queries over registry, not ID lists
    components?: Record<string,string>, // static-design: design-system → element map
    policies?: { privacy?: path, terms?: path },  // C1 drift input
  }],
  review?: {
    models?: { adjudicate?: string, sweep?: string },  // vision-design tiering
    confirmCritical?: boolean,       // default false
    sweep?: "all" | "changed" | "off",
  },
  budget?: { failOn: "new-critical" | "new-serious" | "none" },  // CI gate
})
```

**Degenerate case:** a static brochure site with no repo, no auth, no key:
`comply scan --url https://example.com` must work with zero config file —
public target, sitemap+crawl routes, default viewports, wcag22aa ruleset.
Every generalization above is absent-by-default; if the zero-config path pays
for any of them, cut the feature, not the path.

## 4. Adapters (both directions)

Small set; the audited property is the "host".

| Adapter | Inbound (package asks) | Outbound (package notifies) | Default |
|---|---|---|---|
| `auth` | "give me an authenticated storage state for property X" | "state was rejected/expired mid-run" (so host flow can re-capture) | none → authed routes become a coverage gap, run continues |
| `classify` | "classify cookie/tracker `_xyz`" | "unknown key encountered" (feeds DB updates) | bundled Open-Cookie-DB snapshot |
| `components` | "what element does `<AppButton>` render?" | "unmapped component seen in a11y-relevant position" (needs-review lead) | empty map |
| `track` | — | run lifecycle + finding counts (telemetry events) | **no-op** |

## 5. Package split

**One package.** Every stage runs in one trust context (our runner) — no
trust boundary to split on (contrast: telemetry's client ships to browsers).
Dep weight handled by subpath exports + peers
(package-structure.md): root export is dep-light (record/registry/report);
`./collect-browser` behind the `playwright` peer; `./judge` behind
`@anthropic-ai/sdk`; `./cli` is the bin. `registry/` imports nothing —
pre-carved for extraction if ever needed.

## 6. Cross-package deps

- `playwright` — **peer, optional**: absent → `scan` errors with install
  instructions; `static`/`report`/`diff` fully functional.
- `@anthropic-ai/sdk` — **peer, optional**: absent (or no key) → `review`
  skipped, `needs-review` findings surface as the manual slice, run records
  `no-key` gap. Nothing else degrades.
- `@jeffjassky/telemetry` — **optional peer via `track` adapter, no-op
  default** (house rule). Wires run/finding events if the host wants them.
- ESLint + a11y plugins — regular deps of `./collect-static` (pinned; mapping
  tables are exhaustive against the pinned versions, upgrades break CI by
  design).

## 7. Data layer (expensive to reverse — settled now)

No database. Files are the data layer; these shapes are the migration-costly
decisions:

- `findings.jsonl` — one Finding per line (types-sketch schema), append-only
  per run. JSONL so `diff`/`report` stream and partial runs stay readable.
- Run dir: `.comply/runs/<iso-ts>/` with `run.json`, `findings.jsonl`,
  `evidence/` (content-addressed filenames: `<sha256-16>.<ext>` — dedupes
  repeated crops, makes evidence refs stable).
- **Fingerprint algorithm is v1-frozen**: sha256 over the canonical tuple in
  types-sketch (presence: rule + property + routePattern|file + structural
  locator; absence: requirement + subject). Any future change ships with a
  migration that re-keys `comply.dispositions.yaml`.
- Verdict cache: `.comply/cache/verdicts/<cropHash>-<ruleId>-<rubricVersion>-<model>.json`.
- `comply.dispositions.yaml` + `.comply/routes.json` are tracked; runs and
  cache are gitignored.
- Every artifact/finding carries `schemaVersion`; renderers refuse newer
  majors instead of guessing.

## 8. UI shape

**None of the three standard shapes** — this is not a host-mounted feature
package. Deliverable UI is the static HTML report (single self-contained
file, inline CSS/JS, no fetches — it must open from disk and attach to an
email). Divergence from house default noted per working-style; the React
rule governs host-embedded UI, which doesn't exist here.

## 9. Non-goals

- **No hosted service, daemon, or web UI** — toolkit + CI only (axis 1).
- **No "compliant" verdicts or legal advice** — findings + evidence + coverage,
  renderer-enforced vocabulary (accessiBe lesson).
- **No production DB / `.env` access** on audited properties (08-10 decision).
- **No auto-remediation or overlay injection** — reports propose fixes,
  never patch sites.
- **No CAPTCHA/bot-defense evasion**; blocked = coverage gap. Scanning only
  properties we're authorized on.
- **No cross-file semantic static analysis** — that's C2's job (static-design
  pass 3).
- **No reimplementing accessible-name computation** or rules engines axe
  already owns.
- **No per-instance findings** — fingerprints collapse variants by design.
- **No CMS/platform plugins** (Shopify apps etc.) — those properties are
  scanned as URLs.
- **v1 instruments: WCAG 2.2 (via axe + own rules), GDPR consent/dark-pattern
  set, AI Act Art. 50.** No CCPA, no EAA-beyond-EN301549, no ADA state
  variants in v1 — registry entries only, when they come.

## 10. Size estimate

| Area | ~lines |
|---|---|
| record/ (schemas, fingerprint, run-store) | 700 |
| registry/ (schema, verify, mappings loaders) | 500 |
| registry data (requirements + mappings, TS literals) | 1,500 |
| collect/static | 900 |
| collect/browser | 2,600 |
| rules/ (v1 families) | 1,600 |
| judge/ | 1,100 |
| report/ (HTML renderer is the big one) | 1,800 |
| cli/ | 500 |
| skills/ (4 × SKILL.md) | prose |
| **Total** | **~11k + tests** |

Replaces nothing internal (greenfield), so the "smaller than what it
replaces" check maps to: smaller than wiring WEC + pa11y-ci + a custom GDPR
crawler + hand-run prompts per property, which it is per property after ~3
properties.

Traps §15–19 (high-volume ingest): **N/A** — no public ingest path; the only
write surface is the local CLI.

---

## Build order (milestones — each independently shippable)

1. **M0 — record + registry core.** Schemas, fingerprint, run-store, registry
   verify, fixtures harness, `finding add`. *DoD: a hand-written finding
   round-trips through jsonl → report → diff.*
2. **M1 — static layer + reporting.** collect/static, inventories, eslint
   mapping tables, jsonl/sarif/md renderers, `diff` + budget gate. *DoD:
   usable in CI on maxed, real findings.*
3. **M2 — browser passive.** Session/profiles/settle/scroll, DOMSnapshot,
   axe inject + mapping, contrast (flat + pixel-band), screenshots, tiered
   matrix. *DoD: `scan` on maxed public routes; flake <2% across 5 repeat runs.*
4. **M3 — probes + GDPR evidence.** Keyboard walk, states, consent three-way
   capture, dark-pattern rules, cookie classification. *DoD: full evidence
   pass on one property with a CMP.*
5. **M4 — judge (C1).** Crops, pHash dedupe, verdict cache, batch
   adjudication; needs-review queue drains. *DoD: adjudication cost on 2nd
   run of unchanged site ≈ 0 tokens.*
6. **M5 — sweep + skills + HTML report.** Tiler+SoM sweep, 4 SKILL.md files
   (a11y-visual-review, ai-act-50, gdpr-data-flow, policy-drift), static HTML
   renderer, `coverage`. *DoD: `/audit`-clean per standards/done.md.*

Spikes folded into milestones: DOMSnapshot closed-shadow pierce (M2),
pixel-band thresholds (M2), CMP selector coverage (M3).

## Open items for review (blocking)

1. **Name** — pick from §1 (or reject all).
2. Confirm §8 UI divergence (static HTML file, no React SPA).
3. Confirm v1 instrument cut in §9.
4. `budget.failOn` default (`new-critical` proposed).

After approval: `/scaffold <name>`, sources.yaml → `planned`, plans move into
the package repo per house convention.
