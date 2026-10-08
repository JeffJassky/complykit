# Multi-region scans — implementation contract

Companion to `plans/multi-region-scans.md` (the why). This file is the what: interfaces
and behaviors the PRs must meet. Tests written by the frontier tier pin them; an
implementer does not change a contract test to make it pass — if a test looks wrong,
stop and report.

Branch base: `multi-region`. One worktree per PR. Never `git stash`. Run before
reporting done: `npx tsc --noEmit`, `npx vitest run <your tests>`, `npm run boundaries`,
`npm run build && node scripts/check-exports.mjs` (when public exports change).

---

## PR 1 — split the consent scan into collect and merge

### Why
A worker in Frankfurt collects the German location; the primary in Los Angeles runs the
rules over every location at once, with its knowledge base, and writes the one report.

### 1a. `timelineArtifact` moves to the record layer

`src/collect/browser/evaluation/index.ts` has a private `timelineArtifact(tl, property,
instanceUrl, capturedAt)`. Move it, unchanged, to `src/record/tracking.ts` and export it
from `src/record/index.ts`. `evaluation/index.ts` imports it from there. (Record may
import only zod and record — the function uses only record types, so this is allowed.)

### 1b. `src/consent-collection.ts` (new; no playwright import, static or dynamic)

```ts
import type { ConsentEvaluationCollection } from './collect/browser/evaluation/index.js'; // type-only

export const COLLECTION_FILE = 'collection.json';
export const COLLECTION_KIND = 'complykit-consent-collection';
export const COLLECTION_SCHEMA_VERSION = 1;

/** What a collect-only run leaves in its run dir, for a merge. Contains RAW timelines
 *  (unredacted request bodies, cookie values): the rules need them. It is transient:
 *  never copied into a merged run dir, deleted by whoever gathered it. */
export interface ConsentCollectionHandoff {
  kind: typeof COLLECTION_KIND;
  schemaVersion: typeof COLLECTION_SCHEMA_VERSION;
  packageVersion: string;
  property: string;
  targetUrl: string;
  runId: string;
  collection: Omit<ConsentEvaluationCollection, 'artifacts'>;
}

export function writeCollectionHandoff(runDir: string, handoff: ConsentCollectionHandoff): string; // returns the file path
export function readCollectionHandoff(runDir: string): ConsentCollectionHandoff;
export function mergeCollections(handoffs: readonly ConsentCollectionHandoff[]): ConsentEvaluationCollection;
export function mergeEvidence(sourceRunDirs: readonly string[], destRunDir: string): { copied: number; skipped: number };
```

`readCollectionHandoff` throws an `Error` whose message contains:
- `no collection.json` when the file is missing;
- `not a complykit consent collection` when `kind` differs or the JSON is not an object;
- `schema version` when `schemaVersion` is not `COLLECTION_SCHEMA_VERSION`.

`mergeCollections` (pure). Throws an `Error` whose message contains:
- `nothing to merge` for an empty list;
- `version skew` when `packageVersion`s differ (name both versions);
- `different sites` when `collection.site.registrableDomain`s differ;
- `different properties` when `property` differs;
- `collected twice` when a location id appears in more than one handoff (name the id).

Otherwise it returns:
- `locations`, `timelines`: concatenated in input order;
- `notTested`: concatenated; items with the same `(scope, id, location ?? '')` kept once
  (first wins);
- `containers`: one per `id`, first wins;
- `site`: the first handoff's; `autoconsentVersion`: the first defined;
- `startedAt`: the earliest; `finishedAt`: the latest (ISO strings compare lexically);
- `artifacts`: `timelineArtifact(tl, property, site.url, finishedAt)` for each merged
  timeline, in order.

`mergeEvidence` copies every file under each source's `evidence/` into
`destRunDir/evidence/`, keeping relative paths. A file that already exists in the
destination is not overwritten (first source wins — same rule as containers) and counts
as `skipped`. Nothing outside `evidence/` is copied; in particular never
`collection.json`. Sources are not modified. A source with no `evidence/` is fine.

### 1c. `src/pipeline.ts`

Split `runConsentScan` without changing its behavior:

```ts
/** Browser half: verify locations, run scenarios, write evidence. No rules, no KB. */
export async function collectConsentScan(opts: ConsentScanOptions): Promise<ConsentEvaluationCollection>;
/** Analysis half: rules + evaluation + matrix, from any collection (one run's, or merged). */
export function analyzeConsentScan(collection: ConsentEvaluationCollection, opts: ConsentScanOptions): ConsentScanResult;
// runConsentScan(opts) === analyzeConsentScan(await collectConsentScan(opts), opts)
```

`onPartial` keeps working in `runConsentScan` (live analysis needs the KB) and is
ignored by `collectConsentScan` (no analysis there). Export both from `src/index.ts` and
declare them in `types/index.d.ts` (+ `types/test-d.ts` usage); same for the
`consent-collection.ts` exports.

### 1d. CLI: `complykit consent --collect-only` and `--merge`

`--collect-only`:
- runs `collectConsentScan` with the usual options (`--locations`, `--proxy`,
  `--quick`, `--runs`, `--scenarios`, `--concurrency`, `--no-har`, `--raw-evidence`,
  `--events`);
- writes the evidence (the collector already does) and `collection.json` into
  `runDir(runId, cwd)`;
- writes NO `run.json`, `findings.jsonl`, `tracking.json`, report, change list or owner
  report, and does not touch the KB store (no research-queue update);
- events: the usual `start` / `location` / `scenario-*`, then
  `{ type: 'collected', runId, runDir, locations: string[] }` (no `done`);
- prints `run <id>: collected <n> location(s) · <runDir>` and exits 0.

`--merge <dir>[,<dir>…]` (each a run dir that holds a `collection.json`):
- no browser;
- requires `--url`; every handoff's `collection.site.registrableDomain` must equal the
  registrable domain of `--url`, else exit 2 naming the dir;
- refuses (exit 2, message names the flag) together with `--collect-only`,
  `--locations`, `--proxy`, `--scenarios`, `--quick`, `--runs`, `--concurrency`,
  `--local-copy`;
- a read/merge error exits 2 with the error message;
- otherwise: new run id; `mergeEvidence(dirs, newRunDir)`;
  `analyzeConsentScan(merged, …)` with the same KB/workspace/property/tags the normal path
  uses; then exactly the normal tail (`run.json`, findings, `tracking.json`, report,
  change list, final owner report whose `locations` come from the merged locations'
  verifications, research queue unless `--no-kb-queue`, `done` event, printed summary);
- leaves the input dirs untouched (the caller deletes them);
- `--failed <locationId>=<reason>` (repeatable, only with `--merge`): a location whose
  collection never arrived. Each adds `{ scope: 'location', id, location: id, reason }`
  to the merged `notTested` before analysis. Malformed value (no `=`) → exit 2; `--failed` without `--merge` → exit 2. At least one dir
  is required (exit 2, `--merge needs at least one run dir`).

Help text documents both flags.

### Tests (frontier-written; do not edit)
- `test/consent-collection.test.ts` — pure: handoff IO errors, merge rules, evidence
  merge.
- `test/consent-merge-browser.test.ts` — browser (skips without one): two single-location
  collections merged ≡ one two-location scan; CLI `--merge` writes a normal run with
  both locations and no `collection.json`; CLI flag refusals.

---

## PR 2 — law catalog (service/shared)

`service/src/shared/laws.ts`:

```ts
export type LawId = 'eu' | 'uk' | 'ca' | 'tx' | 'us';
export interface Law {
  id: LawId;
  /** complykit location id passed to --locations. */
  locationId: 'de' | 'uk' | 'us-ca' | 'us-tx' | 'us-il';
  flyRegion: 'fra' | 'lhr' | 'lax' | 'dfw' | 'ord';
  /** Runs on the primary itself (its region is lax). */
  local?: true;
  /** Checkbox label: "EU law", "UK law", "California law", "Texas law", "US, no state privacy law". */
  label: string;
  /** Model line under the label, from describeLocationRules(): "Opt-in (EU/EEA)" … */
  model: string;
  /** Law names for the form: "GDPR, ePrivacy" etc. */
  laws: string;
}
export const LAWS: readonly Law[];
export const DEFAULT_LAWS: readonly LawId[]; // all five
export function isLawId(v: unknown): v is LawId;
```

`model` is computed with `describeLocationRules(jurisdictionsOf(locationId), today)`
from the package's registry subpath — or, if the service cannot import it, hard-coded
with a test that compares it against `describeLocationRules` output. Test:
`service/test/laws.test.ts` (implementer writes): five laws, unique ids/regions, exactly
one `local` (`ca`/`lax`), models match the registry.

## PR 3 — worker mode (service)

Same image, `WORKER=1`:
- binds `fly-local-6pn` (or `WORKER_BIND`, default `::` in tests) on `PORT`; serves only
  `/internal/*`; every request needs header `x-complykit-worker-secret` equal to
  `WORKER_SECRET` (constant-time compare) else 401; `WORKER_SECRET` unset → refuse to
  start.
- `GET /internal/health` → `{ ok: true, version }`.
- `POST /internal/collect` `{ jobId, url, locationId, quick, runs, slowRepeat? }` →
  202; spawns `complykit consent --collect-only --url … --locations <locationId> --cwd
  <tmp>/<jobId> --events <tmp>/<jobId>/events.ndjson [--quick] [--runs N]`; one job at a
  time (409 when busy).
- `GET /internal/jobs/:jobId/events?from=<n>` → ndjson lines from line `n` (for polling);
  `GET /internal/jobs/:jobId` → `{ state: 'running'|'collected'|'failed', error? }`.
- `GET /internal/jobs/:jobId/run.tar` → tar of the collect-only run dir (incl.
  `collection.json`) once `collected`; 409 before.
- `POST /internal/jobs/:jobId/cancel` → kills the process group.
- `DELETE /internal/jobs/:jobId` → removes the tmp dir.
- idle self-stop after `IDLE_SHUTDOWN_MINUTES` (3 on workers) using the existing rule.
Tests (implementer writes, supertest, a fake CLI script): auth, busy, lifecycle, tar.

## PR 4 — fleet manager (primary)

`service/src/server/fleet.ts`:

```ts
export interface WorkerHandle { region: string; machineId: string; baseUrl: string }
export interface Fleet {
  /** Start (or create) the region's worker and wait for /internal/health. Throws with a message on failure/timeout (90 s). */
  acquire(region: string): Promise<WorkerHandle>;
  /** Stop it (best effort, never throws). */
  release(h: WorkerHandle): Promise<void>;
}
export function flyFleet(cfg: { app: string; token: string; image: string; secret: string; fetch?: typeof fetch }): Fleet;
export function fakeFleet(map: Record<string, string>): Fleet; // region → baseUrl, for tests
```

Machines API (`https://api.machines.dev/v1/apps/{app}/machines`): find the Machine whose
`region` matches and `config.metadata.complykit_role === 'worker'`; if stopped, `POST
…/{id}/start`; if none, create with `{ region, config: { image, env: { WORKER: '1',
WORKER_SECRET, IDLE_SHUTDOWN_MINUTES: '3' }, guest: { cpu_kind: 'shared', cpus: 2,
memory_mb: 2048 }, restart: { policy: 'no' }, metadata: { complykit_role: 'worker' } } }`.
If its image differs from `image`, update it first (`POST …/{id}` with the new config).
`baseUrl = http://[<private_ip>]:8080` — prefer `<id>.vm.<app>.internal` when DNS
resolves. Tests mock `fetch`.

## PR 5 — runner fan-out (primary)

- `JobDetail`/`NewJobRequest` gain `laws?: LawId[]` and `authorized?: { at: string }`;
  server validates (`isLawId`, non-empty, `authorized` required when `laws` given).
- A consent job with `laws`: for each law in parallel — local law: spawn
  `consent --collect-only --locations us-ca`; others: `fleet.acquire(region)` →
  `POST /internal/collect` → poll events (append each line to the job's
  `events.ndjson`, so the existing tail and progress UI work) → `run.tar` → extract to
  `<job>/consent/gather/<law>/` → `DELETE` → `release`.
- A law that fails (acquire/collect/transfer/timeout 30 min) → job log line, and
  `--failed <locationId>=worker in <region> failed: <message>` on the merge (PR 1).
- When ≥1 gathered: `consent --merge <dirs> --url …` (+ the usual `--previous`,
  `--events`, workspace args); then `rm -rf gather/` (raw collections).
- All failed → job failed. `finally`: release every acquired worker.
- Jobs without `laws` behave exactly as today.

## PR 6 — UI

New-scan form: five law checkboxes (label, model line, law names), all checked by
default, last selection remembered in localStorage (try/catch); "I am authorized to scan
this site" required; submit disabled when none checked or not authorized. Progress
shows one row per location (events already carry `location`). Rescan carries `laws`
and asks for authorization again.
