# Host on DigitalOcean, scan on Fly

Status: plan, 2026-10-14. Decisions by Jeff (2026-10-14): the host runs on
DigitalOcean App Platform (Amplify 11 account); **every scan runs on Fly**
(California becomes an ordinary worker in `lax`); files go to Spaces, records
to MongoDB. The host has no location and no browser, so it can run anywhere.

## Why

The service today is one Fly Machine that sleeps after 15 idle minutes and
keeps everything on one 10 GB volume (`/data`: 3.2 GB, ~2,000 files). The
host should be always on, and nothing should live on a single disk.

App Platform has no volumes and a 2 GiB local disk, so the host can't hold
scans. It doesn't need to: under this plan it never runs a browser and never
holds a scan's files.

## Shape

```
 browser ──HTTPS──▶ HOST (App Platform, nyc)          Mongo `complykit` db
                    UI, API, orchestration  ───────▶  (amplify11 cluster, nyc3)
                    no Chromium, small image
                        │  Fly Machines API (start/stop)
                        │  HTTPS + secret → workers (public, per-Machine routing)
                        ▼
             FLY WORKERS (complykit-workers): fra lhr lax dfw ord
             collect, merge, accessibility, verify-change
                        │  upload finished, redacted files
                        ▼
                    SPACES bucket (nyc3, private)  ◀── host streams reports/zips out
```

## What runs where

| Work | Today | After | Browser? |
|---|---|---|---|
| Consent collection, per law | CA on primary, rest on workers | all on workers (CA → `lax`) | yes |
| Merge of a multi-law scan (rules + report) | primary | a worker (the merge worker, below) | no, but heavy (109 MB HTML) |
| Single-location consent scan (no laws, legacy) | primary | worker in `ord` (US, no state law), same as the `us` law | yes |
| Accessibility check | primary | worker | yes |
| `verify-change` (Verify button) | primary | worker in `ord` | yes (lazy) |
| Re-render after a classification, consent-config (to-do list) | primary | host, one at a time, in scratch (measured on the largest scan: 5 s, 920 MB peak, ~140 MB written) | no |
| `complykit kb …` (knowledge base) | primary | host (small files, no browser) | no |
| UI, API, workspaces, records, report/zip serving | primary | host | no |

Rule: anything that runs Chromium, or touches raw (unredacted) collections,
runs on a worker. The host re-renders from the stored, redacted evaluation:
it downloads the run's evaluation files to scratch, runs the CLI, uploads the
changed reports, and deletes the scratch.

## Storage

### Spaces (bucket `complykit-data`, nyc3, private, versioning off)

```
jobs/<jobId>/consent/.comply/runs/<runId>/…   the finished, redacted run (reports, evidence, HARs, owner-report.json)
jobs/<jobId>/accessibility/…                  the accessibility report
kb/…                                          mirror of the knowledge-base directory
```

Same paths as today under `DATA_DIR/jobs`, so report URLs, the zip layout and
`rerender`'s path logic keep their shape. Objects are written only by workers
(runs) and the host (kb). **Raw collections never go to Spaces**: they carry
unredacted request bodies and cookie values and are deleted after the merge,
as today.

### Mongo (database `complykit` in the existing `amplify11` cluster)

| Collection | Holds | Was |
|---|---|---|
| `jobs` | one doc per job (JobDetail, incl. log) | `jobs/<id>/job.json` |
| `workspaces` | one doc per domain (SiteWorkspace) + `rev` for optimistic writes | `sites/<domain>/workspace.json` |
| `consentRecords` | one doc per record, indexed `{domain, at}` | `sites/<domain>/consent-records.jsonl` |

The workspace file lock becomes `findOneAndUpdate` with `rev` matching (retry
on conflict); the merge rule (latest `at` per key) is unchanged and stays in
`workspace.ts`. Size limits stay as they are (1 MB config is well under
Mongo's 16 MB).

### Host local disk

Scratch only: a small LRU cache of hot small files (`owner-report.json`,
`consent-report.json`), capped at 500 MB, plus temp files. Losing it loses
nothing.

## Host ↔ worker

Workers today listen only on Fly's private network. The host is outside it, so:

- Worker Machines get a public HTTPS service on `complykit-workers.fly.dev`;
  the host addresses one Machine with Fly's `fly-force-instance-id` header.
  Every `/internal/*` call still needs `x-complykit-worker-secret` (already
  enforced). Workers also keep listening on the private network for each
  other.
- The host keeps polling events and live reports as now (small); it no longer
  downloads `run.tar`.

### The merge worker

After the law workers collect, the host picks one of them (the first that
succeeded) as the merge worker and calls a new `POST /internal/merge` with:
the other workers' private `run.tar` URLs, the job URL, failed laws, the site
workspace JSON, and the previous run's Spaces prefix. The merge worker pulls
the collections over Fly's private network, fetches the previous run's
`tracking.json` from Spaces, runs `consent --merge`, uploads the finished run
to `jobs/<id>/consent/…`, deletes the raw collections, and streams events like
a collection does. Law workers are released after the merge.

Verify runs on a worker: `POST /internal/verify` with the task; the worker
answers with the CLI's JSON outcome.

## Serving

- `/reports/<jobId>/…`: streamed from Spaces. The report HTML gets the
  workspace config injected as today, as a stream transform after `<head>`.
- Zip download: objects listed and streamed from Spaces into the archive.
- Report page JSON: `owner-report.json` read through the LRU cache (ETag check
  against Spaces), so a 2-second poll doesn't refetch 9 MB.
- SSE (`/api/stream`): unchanged, with a heartbeat comment every 25 s so
  App Platform's edge doesn't close idle streams.

## Images and deploy

- **Worker image** (Fly registry): today's Dockerfile, unchanged browsers.
  Built and pushed with `fly deploy -a complykit-workers --build-only --push`
  (or `fly deploy --image-label`); its ref goes in the host's `WORKER_IMAGE`.
- **Host image** (DO): new `Dockerfile.host` on `node:<lts>-slim`: service +
  complykit CLI dist (for `kb`), no Playwright browsers. Target < 400 MB.
- **App Platform app** `complykit` in Amplify 11: one service, instance
  `apps-s-1vcpu-2gb` (re-renders peak ~1 GB), region nyc (next to
  Mongo and Spaces), built from the public GitHub repo's `Dockerfile.host`,
  health check `/api/health`. `IDLE_SHUTDOWN_MINUTES=0`.
- `scripts/deploy-do.sh`: push worker image → update `WORKER_IMAGE` →
  `doctl apps create-deployment`. Worker image first, so a new host never
  calls an old worker protocol.

### Config / secrets

| Where | Name | Who sets it |
|---|---|---|
| DO app | `MONGO_URL`, `SPACES_KEY`, `SPACES_SECRET`, `SPACES_BUCKET`, `SPACES_ENDPOINT` | Claude creates DB user + bucket-scoped Spaces key, puts them in the app spec as encrypted secrets |
| DO app | `FLY_API_TOKEN`, `WORKER_SECRET`, `WORKER_IMAGE` | Claude (from the current `complykit` Fly app's secrets) |
| Fly `complykit-workers` | `SPACES_KEY`, `SPACES_SECRET`, `SPACES_BUCKET`, `SPACES_ENDPOINT` (app secrets, reach API-created Machines) | Claude (`fly secrets set`) |
| Mongo cluster | trusted source = the App Platform app | Claude |

## Migration and cutover

1. Build and test everything with `DATA_BACKEND=fs` (today) and
   `DATA_BACKEND=cloud` (Spaces + Mongo, tests against MinIO + mongodb-memory-server).
2. Stand up the DO app on the cloud backend; deploy the new worker image.
3. One-shot `scripts/migrate-to-cloud.ts`, run on the Fly primary over
   `fly ssh`: upload `jobs/*` (minus `job.json`, `gather/`, `live/`) to Spaces;
   insert `job.json`s, workspaces and consent records into Mongo; mirror `kb/`.
   Idempotent (skips objects already there with the same size).
4. Verify on the DO URL: every job's report, history, a zip, a classification
   re-render, one new multi-law scan.
5. Stop the Fly primary (`complykit` app, keep the volume 30 days as a
   backup), keep `complykit-workers`.

## Work breakdown

Per the execution tiers: I write the storage interfaces (contract) and their
tests first; implementation per step after.

1. `Blobs` interface (`get`, `head`, `put`, `list`, `delete`, `stream`) with
   `fs` and `spaces` (S3 SDK) implementations; `Records` interface for jobs,
   workspaces, consent records with `fs` and `mongo` implementations. Tests run
   against both.
2. Host: `JobStore`, `WorkspaceStore`, `ConsentRecordStore` on `Records`;
   report serving, zip, `job-report`, `history` on `Blobs`.
3. Worker: public service, Spaces upload, `/internal/merge`,
   `/internal/accessibility`, `/internal/verify`.
   Host: re-render and consent-config through scratch + Blobs.
4. Runner: every scan through the fleet; California in `lax`; merge on a worker.
5. Host image, app spec, deploy script.
6. Migration script; cutover.

## Open

Settled 2026-10-14: default `*.ondigitalocean.app` URL; Claude sets all
secrets (DO app spec and `fly secrets set` on complykit-workers); Verify pays
the worker cold start (~20–60 s); classification re-renders stay on the host.
