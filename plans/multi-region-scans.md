# Multi-region scans on Fly (plan)

Status: planned, 2026-10-08, reviewed. Nothing built. Architecture: **regional workers**
(B). The earlier "central scanner + proxy exits" draft (A) is kept at the end with the
reasons it lost.

## Goal

The new-scan form shows one checkbox per **law model**, not per place. A user checks
one, some or all. One consent scan visits the site from one location per checked law,
each from a Machine that is physically in that place, and produces one combined report
with each location measured against its own rules.

One location per law. No two places under the same law; no laws without a Fly region.

## The law checkboxes

| Checkbox (draft label) | Location id | Fly region | Runs on |
|---|---|---|---|
| EU law — opt-in (GDPR, ePrivacy) | `de` | `fra` | worker |
| UK law — opt-in (UK GDPR, PECR) | `uk` | `lhr` | worker |
| California law — opt-out, privacy signal (CCPA, CIPA) | `us-ca` | `lax` | the service itself (today's scan) |
| Texas law — opt-out, privacy signal (TDPSA) | `us-tx` | `dfw` | worker |
| ~~Virginia law — opt-out, no signal duty (VCDPA)~~ | `us-va` | `iad` | **dropped: Ashburn exits geolocate to DC (spike)** |
| US baseline — no comprehensive state privacy law (Illinois) | `us-il` | `ord` | worker |

- Texas is separate from California because the scanner compares different rules there:
  California gets the CCPA regulations (link wording, the icon, signal handling with no
  popup) plus CIPA wiretap exposure; Texas gets the general state-act requirements and
  stands in for the other signal states.
- The model text in each label comes from `describeLocationRules()`, so the form, the
  report's location line and its popover always agree. The law names in parentheses
  are form copy.
- All boxes start checked; the form remembers the last selection (localStorage); a scan
  with nothing checked can't be submitted.
- An **"I am authorized to scan this site"** checkbox is required for every new scan
  and recorded on the job (`authorized: { at, from: ip }`). It is not tied to regions:
  a worker scan is a plain local scan from that Machine, exactly like today's `lax` scan,
  so the CLI's `--proxy`/`--authorized` gate never triggers. The checkbox is our record
  of the user's claim, nothing more.

## Spike results (2026-10-08)

One-off Machines (`shared-cpu-2x`, 2 GB, the production image, app `complykit-workers`)
ran `consent --url https://storyfolder.com/ --locations <id> --quick` with no proxy.

| Region | Location | Verdict | Exit seen | Report model | Scan time |
|---|---|---|---|---|---|
| `fra` | `de` | verified | DE | Opt-in (EU/EEA) | 78 s |
| `lhr` | `uk` | verified | GB | Opt-in (UK) | 78 s |
| `dfw` | `us-tx` | verified | US-TX | Opt-out, privacy signal honored (Texas) | 88 s |
| `ord` | `us-il` | verified | US-IL | Opt-out (Illinois, no state privacy law in force) | 87 s |
| `iad` | `us-va` | **mismatch** (twice, two Machines) | US-DC | Not verified — no rules compared | 17 s |

- The architecture works unchanged. Scans ran cleanly from each region with the
  normal CLI and no code changes, and the report picked the right model.
- **Virginia can't be covered from Fly.** Ashburn exits geolocate to Washington DC in
  one source. No other Fly US region sits in a state with an act but no signal duty
  (`ewr` = NJ, which has a signal duty). The "opt-out, no signal duty" model is dropped
  from the checkboxes, per the rule that laws without a Fly region aren't covered.
- **Cold start is the first-run image pull.** A new Machine took 29–73 s to boot; a
  stopped Machine restarts from its cached rootfs, so pre-created workers start much
  faster.
- **Sources saw different exit IPs** (IPv4 vs IPv6 per source). Verification still
  passed. The note in the log ("exit may rotate") is cosmetic for dual-stack; leave as is.
- **Production bug found in passing.** Fly's init is PID 1, so tini prints "Tini is not
  running as PID 1 … zombie reaping won't work". The `complykit` app logs show it too.
  The Dockerfile's comment says tini is there to reap orphaned Chromium processes, and it
  isn't doing that on Fly. Fix: `ENV TINI_SUBREAPER=1` in the runtime stage (or
  `tini -s`). This applies to the service today, not just workers.

## What already exists (verified in code, 2026-10-08)

- `complykit consent --locations a,b` runs several locations in one run and writes one
  `TrackingEvaluation` (`locations[]`). The report, the matrix and the per-location
  rules popover are already multi-location.
- `locationPreset(id)` (`src/rules/tracking/plan.ts`) accepts any `us-xx` and any
  country code, so `de`, `uk`, `us-tx`, `us-va`, `us-il` need no new definitions.
- Location verification (`src/collect/browser/evaluation/location.ts`): two geo
  lookups from inside the browser before a location runs; anything not `verified`
  gets no findings. A worker in the wrong place can't produce a wrong report.
- A run dir is self-contained and re-analyzable: `tracking.json`, `findings.jsonl`,
  `run.json`, `evidence/tracking/<location>/<scenario>/…` and one timeline file per
  scenario (`scenarios[].evidence.timeline`, relative path). `complykit report
  --format consent-html` already rebuilds a report from a saved run, and
  `src/cli/commands/report.ts` already rehydrates timelines from those files. The
  analysis step is a pure function over the collection:
  `analyzeConsentCollection(collection, opts, kb)` in `src/pipeline.ts`.
- Progress: the CLI writes `events.ndjson` (`location`, `scenario-start`,
  `scenario-done`, each carrying `location`); the service tails it
  (`service/src/server/runner.ts`). Events already carry the location id.
- The service image **is** the scanner image (Playwright base, CLI in `dist/`), with
  self-stop after idle (`IDLE_SHUTDOWN_MINUTES`, `lifecycle.ts`).
- A typical run dir is ~28 MB.
- Fly egress check from the `lax` Machine: ipwho.is places `89.187.184.231` in Los
  Angeles, CA; ipinfo reports `America/Los_Angeles`. Fly egress IPs belong to the host
  in that region.

## Fly facts the plan relies on (checked against docs.fly.io, 2026-10-08)

- Machines API: `POST /v1/apps/{app}/machines` with `region` and `config.image`
  creates a Machine in a region; `POST …/machines/{id}/start` and `…/stop` start and
  stop it. A stopped Machine starts clean (reset to its image), which is fine because
  the worker ships its run dir before it stops.
- Cost: a stopped Machine costs rootfs only, $0.15/GB/month (a ~3 GB image ≈ $0.45/mo
  per region). Running: shared-cpu-2x 2 GB ≈ $0.019/h, performance-2x 4 GB ≈ $0.09/h
  (iad prices). A 15-minute worker scan is well under a cent on shared CPU, ~2¢ on
  performance.
- Private network: apps in the same org reach each other over 6PN by default;
  `<machine_id>.vm.<app>.internal` is the stable name for one Machine. Only started
  Machines resolve.
- Deploys: a deploy updates every Machine in the group, and stopped Machines in an
  auto-scaled service stay stopped. Our workers are not auto-scaled, so a deploy may
  start them; the idle self-stop (set to 3 min for workers) handles that.

## Architecture: regional workers

```
 UI ─▶ service (lax, primary; volume: jobs, KB)
         │ job { url, laws: [eu, uk, ca, tx, va, us] }
         ├─ ca ─▶ local  `consent --collect-only --locations us-ca`        (as today)
         ├─ eu ─▶ start worker(fra) ─▶ POST /internal/collect { url, location: de, … }
         ├─ uk ─▶ start worker(lhr) ─▶ …
         ├─ tx ─▶ start worker(dfw) ─▶ …
         ├─ va ─▶ start worker(iad) ─▶ …
         └─ us ─▶ start worker(ord) ─▶ …
             │   each worker: scan from its own exit, stream events, serve run.tar
             ▼
         gather run dirs ─▶ `consent --from-runs <dirs>`  (merge + rules with the KB
                           + report + research queue, on the primary)  ─▶ stop workers
```

- **Workers** are the same image, in a second app `complykit-workers`, one Machine per
  region, created once and left **stopped**. `WORKER=1` makes the server bind its 6PN
  address only (`fly-local-6pn`), expose `/internal/*` only, require a shared secret
  header, and self-stop after 3 idle minutes. No volume, no KB, no UI.
- **The primary** keeps everything it has today. New: a fleet manager (Machines API,
  token in `FLY_API_TOKEN`), fan-out, event multiplexing, gathering, merge.
- **Collection and analysis split.** Workers only collect (browser work). The primary
  runs the rules with its KB, writes findings, the report, the research queue, the
  owner report — one place, one KB, one version of the rules. This is also why workers
  need no volume.
- **Failure model** is the existing one: a worker that won't start, times out or ships
  nothing makes its location `not tested` with a reason; the other locations proceed.
  A job with every location failed is a failed job.
- **Wall time** ≈ the slowest location (locations really run in parallel, on separate
  CPUs). No change to scenario concurrency within a location (stays 1 for timing).

What this fixes compared with the proxy draft:

- No proxy hop: full timing fidelity, HTTP/3 intact, DNS and CNAME lookups from the
  region, CDN edges chosen as a real visitor's would be.
- No CPU/RAM contention on the primary (the `lax` Machine is sized for two Chromiums;
  six locations in parallel through proxies would not fit).
- No `--authorized` gate dependency; no SOCKS auth plumbing; no exit app.

## Risks and how the plan handles them

- **Geo lookups on shared datacenter IPs.** ipinfo.io is called without a token (the
  response says `missingauth`); its free quota is per IP, and Fly egress IPs are shared
  by other tenants. An exhausted quota makes a location `unknown` → no findings. Fix in
  the first PR: `IPINFO_TOKEN` env passed as `?token=` (free tier, 50k/month), and
  consider a third source with a 2-of-3 rule. This risk exists today in `lax`; regions
  multiply it.
- **Odd geolocation of a region's IP.** `89.187.184.231` is a Datacamp (CDN77) range;
  geo databases sometimes mislabel such ranges. `ewr` is Secaucus and often maps to New
  York. Task 7 (verify each region) runs the real lookups per region before any region
  enters the catalog. Only regions where both sources agree at state level are offered.
- **Bot walls.** Six simultaneous crawls of one site from six datacenter IPs can look
  like an attack to a WAF. Stagger worker starts by a few seconds; the report already
  marks a challenged location. Watch for it in the spike; if common, serialize US
  locations.
- **Deploy starts stopped workers.** Covered by the 3-minute idle self-stop. Deploy both
  apps from the same image ref in one script so versions can't skew
  (`fly deploy -a complykit-workers --image <ref>`).
- **A worker's clean reset on start.** The run dir lives on the worker's ephemeral disk
  and is fetched before stop; a crash mid-scan loses that location only.
- **Rescan and rerender.** Rerender runs `complykit report` on the saved (merged) run:
  unchanged. Rescan repeats the latest job's options: it must carry `laws` and
  `authorized`.

## Decisions

1. Authorization: one checkbox on every new scan, recorded on the job (owner, 2026-10-08).
2. Laws offered: the six above. Texas kept; drop it if one signal state is enough.
3. States/countries without a Fly region: not covered (owner, 2026-10-08).
4. Worker size: start with `shared-cpu-2x` 2 GB (one Chromium). If the spike shows
   timing noise from shared CPU, move to `performance-1x` 2 GB.

## Work breakdown

Execution tiers as before: a frontier model writes the contract and tests; Sonnet
implements; worktree agents never `git stash`.

| # | Piece | Notes |
|---|---|---|
| 0 | ~~Spike~~ done, see "Spike results" | `fly machine run <current image> -a complykit-workers --region fra --rm -- node dist/cli.js consent --url <test site> --locations de --cwd /tmp/x`; confirm `location de: verified`, opt-in model in the report, and whether the site challenged the visit. Repeat for `lhr`, `dfw`, `iad`, `ord`. This is also task 7's first pass. |
| 1 | CLI split | `consent --collect-only`: writes the run dir (timelines, evidence, `collection.json` = locations, notTested, containers, site, autoconsentVersion, startedAt/finishedAt) and no findings/report. `consent --from-runs d1,d2,…`: loads collections, merges (locations concat; notTested concat; site must match; evidence paths already namespaced by location id), runs `analyzeConsentCollection` with the KB, writes everything a normal run writes. Contract test: two single-location collect-only runs merged ≡ one two-location run (same findings, same matrix). |
| 2 | Law catalog | `service/src/shared/laws.ts`: `{ id, locationId, flyRegion, local?: true, label }[]`; labels built from `describeLocationRules()`; the server rejects unknown ids. |
| 3 | Worker mode | `WORKER=1`: bind 6PN only, routes `POST /internal/collect`, `GET /internal/jobs/:id/events` (ndjson stream), `GET /internal/jobs/:id/run.tar`, `POST /internal/jobs/:id/cancel`; `WORKER_SECRET` header; idle 3 min. Reuses the runner's child spawn and `NdjsonTail`. Tests with supertest, no Fly. |
| 4 | Fleet manager (primary) | `ensureWorker(region) → { machineId, host }` (start if stopped; create if missing), `stopWorker(id)`; Machines API with `FLY_API_TOKEN`; wait for `/internal/health` over 6PN; a fake for tests. Per-region failure → not-tested item. |
| 5 | Runner fan-out | Job gains `laws: string[]` and `authorized`. Local law runs as today with `--collect-only`; others via workers. Multiplex worker event streams into the job's `events.ndjson` (existing tail works unchanged). Gather `run.tar`s into `<job>/consent/.comply/runs/<id>/`, then `consent --from-runs`. `finally`: stop workers. Jobs without `laws` (old API callers) stay today's zero-config scan. |
| 6 | UI | Law checkboxes (all on, remembered), authorization checkbox (required), per-location progress rows. Rescan carries `laws` + `authorized`. |
| 7 | Verify each region | Script: start each worker, run the verification lookups, record verdicts; the catalog lists only regions that verify at state level. Rerun whenever a region looks off. |
| 8 | Deploy + docs | `complykit-workers` app (no volume, no http_service, secrets `WORKER=1`, `WORKER_SECRET`, `IDLE_SHUTDOWN_MINUTES=3`); `scripts/deploy.sh` deploys both apps from one image ref; `fly.toml` comment update; `docs/guide/location.md` section on scanning from several places; CHANGELOG. |
| 10 | Tini subreaper | `ENV TINI_SUBREAPER=1` in the Dockerfile runtime stage; ship independently, it fixes the current service. |
| 9 | ipinfo token | `IPINFO_TOKEN` in both apps; lookup URL gains `?token=`. Small, do it with task 1. |

Order: 0 → 1 → (2, 3, 4 in parallel) → 5 → 6 → 7 → 8. Task 9 rides with 1.

## Appendix: the proxy draft (A) and why it lost

A kept one scanner in `lax` and added a tiny SOCKS5 "exit" Machine per region; each
location's browser in `lax` was routed through its exit. It reused `--proxy` with no
pipeline change. It lost because:

- the browser stays in Los Angeles: every connection pays a `lax`↔region round trip
  (~150 ms each way to Frankfurt), QUIC is lost through SOCKS, and CNAME lookups run
  from `lax` — all of which make the scan less like a real visitor, which is the point;
- all locations share the primary's CPU and 4 GB, so they either run one after another
  (six locations ≈ six times today's wall time) or contend, which contaminates timing;
- it drags in the residential-proxy authorization gate, SOCKS auth, and a second app
  anyway;
- the regional workers reuse more than it seemed: the image, the self-stop, the saved
  run format, the report-from-run path and the location-tagged events all exist.
