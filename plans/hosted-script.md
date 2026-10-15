# Hosted consent script + banner analytics — plan and contract

Status: plan, 2026-10-14. Branch `hosted-script` off `main`.

## Why

Today a site owner downloads an install bundle (two client files + a config) and pastes
two lines: an inline JSON config and a `<script src>` to their own copy of the core. Every
config change means re-downloading and re-uploading. We want:

1. **One line to paste**, served by us, so the config can be managed from the complykit
   host (and, later, edited there: the banner editor).
2. **Banner analytics**: how often the banner shows, what visitors choose, how long they
   take, per config version (copy, labels), per region — so we can tell owners how well
   their banner works and learn which copy works.

This reverses `plans/client-consent-design.md` §10 "No runtime fetch from us". The
precautions that make the reversal acceptable are the invariants below; they are not
optional.

## Decisions (user, 2026-10-14)

- Script served by the complykit host behind **Cloudflare** (edge cache, purge on change,
  geo headers). The Spaces CDN approach is dropped (bucket deleted).
- Analytics are **counters only**: no event log, no visitor identifier, no IP stored, no
  page URL. True unique-visitor counts are out of scope by design.
- The **zip download is removed** from the service and the static report.
- No domain yet: everything ships working on the default App Platform URL; Cloudflare is
  switched on later by env vars only (no code change).
- (Added mid-build) The install task carries a **settings form** (mode, layout, block the
  page, privacy policy link). The main setting is the **mode**: complykit as the whole
  consent manager, or as an **add-on** to the site's existing banner that follows its
  choice and deletes the cookies of whatever the visitor withdraws. The scan tells us
  which banner is there; the add-on hooks into that banner's own API (OneTrust, Cookiebot,
  Usercentrics, Didomi, TrustArc, Shopify, WordPress Consent API), or falls back to IAB
  TCF, Google Consent Mode updates, or a documented `ComplyKit.sync()` call.

## Invariants (every ticket; the Fable review checks these first)

Privacy / wiretap posture (see memory: wiretap posture, opinionated policy):

- **P1** `/s/*` and `/e` never set or read a cookie. No `Set-Cookie`, no `Vary: Cookie`.
- **P2** No visitor IP is written anywhere (logs, records, counters). In-memory rate
  limiting keyed by IP is allowed (as `/api/consent-records` does today); it is never
  persisted or logged.
- **P3** `/e` stores only counters. There is no table/collection/file of individual
  events. A request's raw body is never logged or stored.
- **P4** No page URL, path, query, referrer, title, user agent, or anything the visitor
  typed is sent by the client or stored by the server. The client never reads
  `location.href` for analytics.
- **P5** No identifier: no visitor id, no session id, no fingerprint inputs (screen,
  language, timezone, UA) in the beacon. `decide.ms` is the only measured number.
- **P6** Geography is country + subdivision code from Cloudflare headers only, and only
  when `TRUST_CF_GEO=1`. Otherwise `XX`. Never derived from the IP by us.
- **P7** The paste snippet carries `referrerpolicy="no-referrer"`.
- **P8** The beacon is sent at most once per page view (on `pagehide` /
  `visibilitychange: hidden`), with `credentials: 'omit'` on the fetch fallback.

Behavior:

- **B1** A site's script URL never changes: `${PUBLIC_ORIGIN}/s/<registrable-domain>.js`.
  Config changes and new client versions reach visitors through the same URL.
- **B2** A config change is visible on the next request that misses the browser cache
  (≤ 60 s): the host's render cache is invalidated and the CDN URL purged synchronously
  with the workspace write (purge failures are logged, never fail the write).
- **B3** If the host is down, Cloudflare serves the last copy (`stale-if-error`); the
  client site never hangs on us longer than a normal cache hit.
- **B4** The scanner treats the complykit host as the site's own consent tool: not a
  tracker, not an "existing consent tool" to remove, no `config-missing` finding.
- **B5** The self-hosted install keeps working for CLI users (the package is public);
  only the *service* always generates the hosted install.

## Add-on mode (companion)

Config fields (schema, guard and public types done in Step 0; no defaults, so existing
configs hash the same): `mode?: 'full' | 'companion'` (absent = full) and
`companion?: { cmp, map? }` (required for companion). `cmp` ∈ `onetrust cookiebot
usercentrics didomi trustarc shopify wordpress tcf consent-mode manual`.

Client in companion mode (a separate bundle — the core is at ~96% of its 15 KB gz budget):
- `complykit-consent-companion.js` (new IIFE, own budget 8 KB gz) holds the source
  adapters and maps. The core, when `mode === 'companion'`, loads it async from the same
  folder as itself with `?v=<TOOL_VERSION>` (same derivation as the UI file; attribute
  `data-complykit-companion` overrides), exactly like the UI loader. The companion file
  registers on a host object the core exposes (like `ComplyKit._ui`). The service serves
  it at `/s/complykit-consent-companion.js` with the UI file's caching rules; the CLI's
  self-hosted copy step copies it too.
- **Off:** the UI file (never requested), the GTM bridge, the vendor adapters, the
  platform bridges (they would write our state into the platform — the banner owns it),
  consent records (the banner keeps its own proof). The gate is installed but there are no
  held tags to release.
- **On:** one source adapter for `companion.cmp` reads the banner's current choice at
  start and on every change, maps it through `companion.map ?? DEFAULT_MAPS[cmp]` to
  complykit category ids (ids the config doesn't have are ignored; `necessary` is always
  true), and calls `store.set(mapped)`. A grant → deny change runs the existing withdrawal
  cleanup (withdraw.ts step 4). Reload default `none` (the `data-complykit-reload`
  attribute still overrides).
- **Sweep on load:** at start, once the banner's choice is known, categories it reports
  denied are cleaned up (catches cookies left from before the add-on was installed or a
  withdrawal made on another device's banner state).
- **Banner not found:** the adapter waits for the banner's API (its documented ready
  hook/event; otherwise polls every 250 ms up to 10 s), then gives up: diagnostics say so,
  nothing is cleaned.
- **Public API:** `ComplyKit.sync(choice: Record<string, boolean>)` sets the store from the
  site's own code (the `manual` source; works with any cmp).
- **Analytics:** `load` and `decide` with `via: 'cmp'` (no `shown`, no `ms`).

Built-in maps (`client/src/companion/maps.ts`, overridable per site):

| cmp | read | change event | map |
|---|---|---|---|
| onetrust | `OnetrustActiveGroups` | `OneTrustGroupsUpdated` | C0002→analytics, C0003→functional, C0004→advertising, C0005→advertising |
| cookiebot | `Cookiebot.consent` | `CookiebotOnConsentReady` / `OnAccept` / `OnDecline` | statistics→analytics, marketing→advertising, preferences→functional |
| usercentrics | `UC_UI.getServicesBaseInfo()` / v3 `__ucCmp` | `UC_UI_CMP_EVENT`, `ucEvent` | by category slug: functional→functional, marketing→advertising+analytics |
| didomi | `Didomi.getCurrentUserStatus()` | `didomiEventListeners` `consent.changed` | purpose ids containing measure/analytics→analytics; ads/advertising/personalized→advertising |
| trustarc | `truste.cma.callApi('getConsentDecision')` | `message` from truste | level ≥2→functional, ≥3→advertising+analytics |
| shopify | `Shopify.customerPrivacy.currentVisitorConsent()` | `visitorConsentCollected` | analytics→analytics, marketing→advertising, preferences→functional |
| wordpress | `wp_has_consent(cat)` | `wp_listen_for_consent_change` | statistics→analytics, marketing→advertising, preferences→functional |
| tcf | `__tcfapi('addEventListener')` | same | purposes 7,8,9→analytics; 2,3,4→advertising |
| consent-mode | `dataLayer` `['consent','default'|'update',{…}]` | dataLayer push | analytics_storage→analytics, ad_storage→advertising |
| manual | — | `ComplyKit.sync()` | identity |

Each vendor's API shape must be checked against its current docs by the implementer (cite
the doc URL and date in the adapter's header comment, as bridges/shopify.ts does).

Detection: the generator maps the scan's existing consent tool to a `cmp`
(`consent.onetrust`→onetrust …; the platform plugin `shopify-customer-privacy`→shopify; a
WordPress consent plugin → wordpress) and returns it as `detectedCmp` (stored in the
workspace config value). The form preselects it.

## Owner settings (the install task's form)

Stored in the site workspace as entry `consent-settings` → value
`{ mode: 'full'|'companion', cmp?: CompanionCmp, layout?: 'bar'|'box'|'modal', blockPage?: boolean, privacyPolicyUrl?: string }`.
Validated by the service (unknown keys refused; `privacyPolicyUrl` https only; `cmp`
required for companion). Saving it is a workspace write, so it invalidates the render cache
and purges the CDN URL (B2) like a config change.

The served config = stored generated config, then the settings applied (`mode`,
`companion: { cmp }`, `layout`, `blockPage`, `privacyPolicyUrl` — only the keys present),
then endpoints filled in (companion: `record` removed), then re-hashed.

In companion mode the to-do list hides `remove-existing-tool` tasks, and the install
task shows the companion steps (paste the line anywhere in `<head>`, after the banner's
script if possible; `async` is fine; keep the banner; for `manual`, the `ComplyKit.sync`
call to add to the banner's callback). Other tasks are unchanged in v1 (the leak tasks
still say what to hold; holding it is the banner's job — a note at the top of the list
says so).

## Wire formats (the contract)

### Hosted script — `GET /s/<host>.js`

- `<host>`: `^[a-z0-9.-]{1,253}$` lowercased. Mapped through `siteDomain()` to the
  registrable domain. Not registrable → `400`. Registrable but different from `<host>`
  (e.g. `www.example.com`) → `301` to `/s/<registrable>.js`.
- No workspace config for the domain → `404`, `Content-Type: text/javascript`, body
  `/* complykit: no consent config for <domain> */\n`, `Cache-Control: public, max-age=60`.
- Found → `200`, body exactly:

  ```
  /*! complykit <toolVersion> | <domain> | config <hash first 12> */
  window.ComplyKitConfig=<JSON.stringify(hostedConfig)>;
  <core bundle bytes, unchanged>
  ```

  Line 2 is exactly `window.ComplyKitConfig=` + one-line JSON + `;` + `\n`.
  `parseHostedScript(text)` (src, see T1a) relies on this.
- Headers on 200: `Content-Type: text/javascript; charset=utf-8`,
  `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: cross-origin`,
  `Access-Control-Allow-Origin: *`, strong `ETag` = `"sha256 of body, first 32 hex"`,
  conditional `If-None-Match` → `304`.
  `Cache-Control`:
  - CDN configured (`CF_ZONE_ID` + `CF_API_TOKEN`): `public, max-age=60, s-maxage=3600, stale-while-revalidate=60, stale-if-error=604800`
  - otherwise: `public, max-age=60` (App Platform's own edge must never hold it longer).
- Mounted **before** basic auth. Never sets a cookie (P1).

`hostedConfig(stored, publicOrigin)` = the stored workspace config with
`record = { endpoint: `${publicOrigin}/api/consent-records` }` and
`analytics = { endpoint: `${publicOrigin}/e` }`, re-hashed with the service's hash
function (identical to `hashConsentToolConfig`). Deterministic: same input, same bytes.

### UI file — `GET /s/complykit-consent-ui.js`

Serves the client UI bundle. With `?v=<current toolVersion>`:
`Cache-Control: public, max-age=31536000, immutable`. Any other or no `v`:
`public, max-age=60`. Same other headers as above. (`complykit-consent-ui` has no TLD,
so it can never collide with a site.)

The core derives the UI URL from its own `src` as today, and now appends
`?v=<TOOL_VERSION>` when it derives it (not when `data-complykit-ui` is set). This keeps
the core and UI of one release together across a deploy.

### Paste snippet (service-generated)

```html
<script src="https://<PUBLIC_ORIGIN host>/s/example.com.js" referrerpolicy="no-referrer"></script>
```

First in `<head>`, blocking (no `async`/`defer`/`type=module`). Part 2 of the snippet
(tag rewrites / change list) is unchanged.

### Config schema addition (package)

`ConsentToolConfigSchema` gains `analytics: z.object({ endpoint: z.string().min(1) }).optional()`.
The published JSON schema is regenerated. No default (absent = no beacon).

### Event beacon — `POST /e`

Client → host, `text/plain` body (CORS-simple, no preflight), ≤ 4096 bytes:

```jsonc
{
  "v": 1,
  "h": "<64 hex: the running config's hash>",
  "tv": "<tool version>",
  "r": "opt-in" | "opt-out-signal" | "opt-out",
  "ev": [
    { "t": "load", "d": 0 | 1, "gpc": 0 | 1 },        // d: a stored choice existed at load
    { "t": "shown" },                                   // banner became visible
    { "t": "open", "via": "banner" | "choices" | "api" },// settings layer opened
    { "t": "decide", "a": "accept" | "reject" | "custom",
      "via": "banner" | "settings" | "cmp", "ms": 1234, // ms since "shown"; omitted if no banner shown this page (always for cmp)
      "cats": { "analytics": true, "marketing": false } } // only when a = custom
  ]
}
```

Server rules:

- Always answers `204` (also on anything dropped) except `413` over 4096 bytes and `429`
  rate-limited. CORS: echo a valid site `Origin` like `/api/consent-records`. `OPTIONS` →
  204.
- The `Origin`'s registrable domain must equal the domain of a **served config snapshot**
  with hash `h`; otherwise the whole body is dropped. (Prevents counter pollution for
  sites and hashes we never served.)
- Unknown keys are ignored; an event that fails validation is dropped alone. At most 20
  events; at most one `load`, one `shown` per body. `ms` is clamped to `[0, 86_400_000]`
  and bucketed; the raw number is never stored. `cats` keys must be category ids in that
  snapshot's config.
- Mounted before basic auth. Rate limits: 120/min per IP (in memory), 20 000/min per site.

### Counters

One document per `(domain, day UTC "YYYY-MM-DD", hash)`; `n` is a flat map of counts:

| key | from |
|---|---|
| `load`, `load:decided`, `load:gpc` | `load` (`d`=1 → also `load:decided`) |
| `shown` | `shown` |
| `open:<via>` | `open` |
| `decide:<a>:<via>` | `decide` |
| `ttd:<a>:<bucket>` | `decide` with `ms`; buckets `lt2s 2-5s 5-10s 10-30s 30-60s 1-5m gt5m` |
| `cat:<id>:on` / `cat:<id>:off` | `decide` with `a=custom` |
| `geo:<CC>[-<RR>]:load` / `:shown` / `:decide:<a>` | same events, geo per P6 |

`regime` is counted as `regime:<r>` once per body that has a `load`.

Mongo field names: keys contain `:`, `-`, letters, digits only (no `.` / `$`).

### Config snapshots

`(hash) → { hash, domain, config, firstServed }`, written the first time the host renders
a hash. Read by the stats API so a stats row can show the copy and labels it measured.
Kept forever (not personal data).

### Stats API (behind auth)

- `GET /api/sites/:domain/stats?days=30` (1–366) →
  `{ domain, from, to, configs: [{ hash, firstServed, totals: Record<string, number>, days: [{ day, n }] }] }`,
  newest `firstServed` first.
- `GET /api/sites/:domain/configs/:hash` → the snapshot, or 404.

## Environment (service)

| var | meaning | default |
|---|---|---|
| `PUBLIC_ORIGIN` | origin visitors' browsers reach the host at | `http://localhost:<port>` |
| `CF_ZONE_ID`, `CF_API_TOKEN` | Cloudflare purge (token: Zone → Cache Purge) | unset = no CDN |
| `TRUST_CF_GEO` | read `cf-ipcountry` / `cf-region-code` | off |

App Platform now: `PUBLIC_ORIGIN=https://complykit-6v9s6.ondigitalocean.app`. When the
domain exists: point a proxied Cloudflare hostname at the app, enable the "Add visitor
location headers" managed transform, set the four vars, deploy, and add the hostname to
the KB entry (T1b). The default App Platform host stays in the KB entry.

---

## Work breakdown

Tiers: **F** = frontier (Opus, this session). **S** = Sonnet agent in its own worktree.
**R** = one Fable review at the end. Every S prompt includes: never `git stash` (WIP
commits instead); symlink `node_modules` and `service/node_modules` into the worktree;
contract tests are not edited to pass — stop and report if one looks wrong; before done:
`npx tsc --noEmit`, the ticket's tests, `npm run boundaries`, plus the service/client
equivalents for those packages.

### Step 0 — contract tests (F)

On `hosted-script`, one commit: this plan, the shared types below, and failing tests for
every ticket (listed per ticket under **Tests**). Shared pieces written here so parallel
tickets agree:

- `src/record/consent-config.ts`: the `analytics` field (+ regenerated JSON schema).
- `src/record/remediation.ts`: install verify spec gains `mode: z.enum(['self','hosted']).default('self')`;
  `configHash` and `elementId` become optional (required when `mode` is `self` — refine);
  consent-default spec gains optional `scriptSrc`.
- `src/hosted-script.ts` (new, pure): `HOSTED_CONFIG_PREFIX = 'window.ComplyKitConfig='`,
  `hostedScriptPath(domain): string` (`/s/<domain>.js`), `parseHostedScript(text): unknown | undefined`
  (reads line 2 only).
- `COMPLYKIT_PARTY_ID = 'consent.complykit'` exported from the registry.
- `service/src/shared/api.ts`: `ConsentStatsResponse`, `ConfigSnapshot`; `installZipUrl` removed.
- `client/src/ui/host.ts`: `UiHost.report(e: UiAnalyticsEvent): void` and the event type.

### Interfaces pinned by the Step 0 tests (read these before coding)

Package (`src/`): `hostedScriptUrl` option and result field and `detectedCmp` on the
generator; `RemediationSource.hostedScriptUrl`; `RemediationTask.companionSteps`;
install spec `mode` (+ optional `configHash`/`elementId`); consent-default `scriptSrc`;
`StaticVerifyInput.hostedScript: HostedScriptFetch`; `verifyInstall(html, expected,
opts, hostedScript?)`; `verifyConsentDefault(html, spec, hostedScript?)`;
`ComplykitToolSnapshot.configSource`; config `analytics`, `mode`, `companion`
(+ guard, public types, `COMPANION_CMPS`); `COMPLYKIT_PARTY_ID`, `COMPLYKIT_HOSTS`;
`src/record/hosted-script.ts`.

Client: `UiHost.report(UiAnalyticsEvent)` (stubbed); `ComplyKit.sync(choice)`;
`ComplyKit.diagnostics.companion = { cmp, state: 'waiting' | 'ready' | 'not-found' }`.
Beacon `decide.cats` lists the non-necessary categories only.

Service:
- `ServiceConfig`: `publicOrigin` (from `PUBLIC_ORIGIN`, trailing `/` trimmed; default
  `http://localhost:<port>`), `cdn?: { zoneId, token }` (both env vars or neither),
  `trustCfGeo: boolean`, `statsFlushMs` (default 30 000).
- `AppDeps.purger?: CdnPurger` (default: `cloudflarePurger` when `cdn`, else `noopPurger`).
- `Service.stats: { flush(): Promise<void> }`.
- `config-hash.ts`: `configHash(config)`. `cdn.ts`: `CdnPurger`, `cloudflarePurger({ zoneId,
  token, fetch?, log? })`, `noopPurger`. `hosted-script.ts`: `hostedConfig(stored,
  publicOrigin, settings?)`. `consent-settings.ts`: `CONSENT_SETTINGS_KEY`,
  `normalizeConsentSettings(raw)` (WorkspaceError 400). `consent-stats.ts`: `bucketMs(ms)`.
- Routes: `GET/PUT /api/sites/:domain/consent-settings` (behind auth).
- `storedTasks(ws)` drops `remove-existing-tool` when the settings say companion.
- `onConfigChange(domain)` also fires when the `consent-settings` entry changes.
- Storage: `ConfigSnapshotRecords` (T3) and `ConsentStatsRecords` (T4) on `Storage`, fs +
  mongo. fs stats file: `DATA_DIR/stats/<domain>/<day>.json` holding the day's documents
  `{ domain, day, hash, n }` (array or keyed by hash).

Known baseline noise: `service` `tsc` reports one pre-existing error in
`src/report/html.ts` (Buffer types); ignore it. Contract tests of other tickets fail
until those tickets land; only your ticket's tests must pass.

### Wave 1 (parallel)

#### T1a — generator, remediation, Verify, static report (S)

**Files:** `src/consent-generator.ts`, `src/remediation.ts`, `src/rules/remediation/verify.ts`,
`src/remediation-verify.ts`, `src/cli/commands/consent-config.ts`,
`src/report/consent-remediation.ts`, `test/fixtures/remediation-e2e-site.ts`,
`scripts/remediation-demo.ts`, the tests listed.

**Contract:**
- Generator option `hostedScriptUrl?: string`; CLI `consent-config --hosted <url>`. When
  set: snippet Part 1 is the one-line paste snippet above; no client files copied; the
  `script-path` note is replaced by a `hosted` note; `--record-endpoint` still honored.
- Install task, hosted: steps = paste the one line first in `<head>`; keep it blocking;
  remove any earlier complykit lines (inline `#complykit-config` and a self-hosted
  `complykit-consent.js`); publish; press Verify. No "upload files", no "don't use a
  third-party CDN" step, no zip in `stepVariants.service`. Verify spec
  `{ check:'install', method:'static', page, mode:'hosted', scriptSrc }`. Consent-default
  spec carries `scriptSrc` in hosted mode.
- `verifyInstall` hosted mode passes iff: one `<script>` whose resolved `src` has the same
  origin + path as `scriptSrc` (query/hash ignored); it is blocking; no tag script
  (`isTagScript`) precedes it; no `#complykit-config` element and no other
  `complykit-consent.js` on the page (else fail: "two copies"); and fetching `scriptSrc`
  answers 200 with a body `parseHostedScript` can read. Missing `referrerpolicy` passes
  with a detail line saying to add it.
- `verifyConsentDefault` hosted mode: the core is the `scriptSrc` script; the config is
  read from the fetched script via `parseHostedScript`.
- Self mode unchanged (B5).
- Static report: zip link and `siteApi()+'/install.zip'` removed.
- `detectedCmp?: CompanionCmp` on the generator result (see "Add-on mode", Detection).
- Install task (hosted) also carries `companionSteps` (the add-on steps).
- Verify hosted: when the fetched config has `mode: 'companion'`, the tag need not be
  first or blocking (present, one copy, and serving is enough).

**Tests (written in Step 0):** `test/hosted-script.test.ts` (parse/path), additions to
`test/consent-generator.test.ts`, `test/remediation-tasks.test.ts`,
`test/remediation-verify*.test.ts` (hosted pass; each hosted failure; self unchanged),
`test/consent-remediation-report.test.ts` (no zip), `test/remediation-e2e.test.ts`.

**Non-goals:** service code; scanner party logic.

#### T1b — scanner recognizes the hosted tool (S)

**Files:** `src/registry/kb/entries.ts`, `src/consent-generator.ts` (only the
existing-consent-tool branch — coordinate: T1a owns the rest of the file; this ticket's
change is one condition), `src/remediation.ts` (`removeExistingToolTasks` guard only),
`src/collect/browser/evaluation/complykit.ts`, `src/record/` ComplykitToolSnapshot,
`src/rules/tracking/consent-tool-proof.ts`, tests listed.

**Contract:**
- KB seed `consent.complykit` (vendor ComplyKit, owner ComplyKit, category `consent`,
  hosts `['complykit-6v9s6.ondigitalocean.app']`).
- `COMPLYKIT_PARTY_ID` never produces an `existing-consent-tool` note or a
  `remove-existing-tool` task.
- Requests to that host before consent (the script, `/e`, `/api/consent-records`) produce
  no pre-consent tracking finding (as for any `consent` party — prove with a test).
- `readComplykit` falls back to `window.ComplyKitConfig` when there is no config element:
  snapshot gets `configSource: 'element' | 'global'` and `configJson` from
  `JSON.stringify` of the global (same 64 KB limit). `consent-tool-proof` emits
  `config-missing` only when neither exists.

**Tests:** KB entry test; generator/remediation tests with a `consent.complykit` party;
`test/consent-tool-proof*.test.ts` global-config case; analyze test for pre-consent
requests to the host.

**Non-goals:** making the host list configurable at runtime.

#### T2 — client: beacon + UI version pinning (S)

**Files:** `client/src/events.ts` (new), `client/src/index.ts` (wire with `whenStore`),
`client/src/ui-loader.ts` (`?v=`; `report` on `uiHost`), `client/src/ui/index.ts`
(call `report` on banner show, settings open, and each decision with its `via`),
`client/src/ui/host.ts` (from Step 0), `client/test/*`.

**Contract:**
- Active only when `config.analytics?.endpoint` is set. Otherwise no listeners, no
  requests.
- Queues `load` at store start (`d` = a stored choice existed; `gpc` from state).
  `shown` when the banner becomes visible (once per page). `open` on settings open.
  `decide` on each UI decision: `a` from the action (`save` → `custom`, or `accept`/`reject`
  when the saved categories equal all-on / all-off), `via`, `ms` since `shown` when a
  banner was shown this page, `cats` for custom.
- Flush on `pagehide` and `visibilitychange` → hidden: one `sendBeacon(endpoint, text)`
  per flush with events not yet sent; fetch fallback `keepalive`, `credentials:'omit'`,
  `mode:'cors'`. Nothing sent when there are no new events. No timers.
- Body is exactly the wire format; never includes anything in P4/P5.
- `uiUrl()` appends `?v=${TOOL_VERSION}` only when derived from `ownScript.src`.
- Core still within the 15 KB gz budget (`npm run build && node scripts/check-size.mjs`).

**Tests:** `client/test/events.test.ts` (each event, flush once, nothing without
endpoint, body keys allow-list, no URL/UA in body), `client/test/ui-loader.test.ts` (`?v=`).

**Non-goals:** retries, local storage of unsent events.

#### T3 — service: hosted script, purge, paste UI, zip removal (S)

**Files:** `service/src/server/config-hash.ts` (new), `hosted-script.ts` (new: renderer +
route), `cdn.ts` (new: purger), `config.ts` (`publicOrigin`, `cdn`, `trustCfGeo`),
`workspace.ts` (`onConfigChange` hook), `app.ts` (mount `/s/*` before auth; wire hook;
remove zip route; use `publicOrigin` for consent-config and `ChecklistMaker`),
`consent-config.ts` (always `--hosted <publicOrigin>/s/<domain>.js` and
`--record-endpoint <publicOrigin>/api/consent-records`), `rerender.ts`, delete
`install-zip.ts`, `job-report.ts` (no `installZipUrl`), `storage/*` (config snapshots:
`ConfigSnapshotRecords { put(s): Promise<void>; get(hash): Promise<ConfigSnapshot|undefined> }`,
fs + mongo), client UI (`Sites.tsx`, `ReportPage.tsx`, `lib/checklist.ts`, `lib/sites.ts`:
zip button → the one-line snippet with a Copy button), `.do/app.yaml` (`PUBLIC_ORIGIN`),
tests.

**Contract:**
- Everything in "Hosted script", "UI file", `hostedConfig`.
- `configHash(config)` equals the package's `hashConsentToolConfig` (parity test on a
  CLI-generated fixture).
- Render cache: in memory per domain, keyed by (stored config `at`, bundle hash,
  publicOrigin); a snapshot is `put` the first time a hash is rendered.
- `WorkspaceStore` option `onConfigChange(domain)`: called once after a write that
  replaced `config` (not on stale). The app's handler drops the render cache entry and
  calls `purger.purgeUrls([`${publicOrigin}/s/${domain}.js`])` without awaiting the
  request's response on it; errors logged.
- `cloudflarePurger({ zoneId, token, fetch })`: `POST https://api.cloudflare.com/client/v4/zones/<zone>/purge_cache`
  with `{ files }` (≤ 30 per call) or `{ purge_everything: true }`, `Authorization: Bearer`;
  one retry; never throws. `noopPurger` when unset.
- Boot: `sha256(core bundle + UI bundle + publicOrigin)` compared with blob
  `meta/hosted-bundle.sha256`; different → `purgeAll()` then write the blob.
- Zip: route, module, API field, buttons, links, tests all gone.

**Tests:** `service/test/hosted-script.test.ts` (200 body format and headers per CDN
on/off, 301, 400, 404, 304, no Set-Cookie, before-auth, UI file `?v=` caching),
`config-hash.test.ts` (parity), `cdn.test.ts` (request shape, batching, retry, no throw),
`workspace.test.ts` (hook once, not on stale), `consent-config.test.ts` (CLI args),
UI tests (copy snippet, no zip).

**Non-goals:** `/e`, stats.

### Wave 2 (after T3 merges)

#### T4 — service: `/e`, counters, stats (S)

**Files:** `service/src/server/consent-stats.ts` (new: validation, bucketing, aggregator),
`storage/types.ts` + fs + mongo (`ConsentStatsRecords { add(incs): Promise<void>; read(domain, fromDay, toDay) }`),
`app.ts` (mount `/e` before auth; stats routes; flush on shutdown), client
`Sites.tsx` (a "Banner stats" panel: per config version — loads, shown, accept/reject/custom
%, ttd median bucket, top 5 regions), tests.

**Contract:** "Event beacon", "Counters", "Stats API". Aggregator holds increments in
memory and flushes every 30 s and on shutdown; Mongo writes are `$inc` upserts; fs writes
merge into `DATA_DIR/stats/<domain>/<day>.json`.

**Tests:** `service/test/consent-stats.test.ts` (every validation rule; bucketing; geo
with/without `TRUST_CF_GEO`; unknown hash dropped; origin mismatch dropped; 413; 429;
never stores raw body or IP — assert stored docs contain only the counter keys),
storage tests on both backends, stats API test, Sites panel test.

**Non-goals:** charts, export, retention policy.

#### T5 — docs + design reversal (S)

**Files:** `docs/guide/consent-tool.md` (hosted install first; self-host section for CLI
users; CSP `script-src` note), `docs/guide/config.md`, `platform-shopify.md`,
`platform-wordpress.md`, `gtm-setup.md` (still never via GTM), `remediation.md`, a new
`docs/guide/analytics.md` (what the beacon sends, what is stored, what is never collected
— written so an owner can quote it in a privacy policy), `plans/client-consent-design.md`
§10 (reversal + the invariants), `plans/remediation-flow.md`, `plans/simple-report.md`.

**Non-goals:** marketing copy.

#### T6 — client: add-on mode (S, wave 2, after T2)

**Files:** `client/src/companion/` (new: `index.ts` mode switch, `maps.ts`, one file per
source), `client/src/index.ts` (skip UI/GTM/adapters/bridges/records in companion; add
`sync`), `client/src/withdraw.ts` (reload default per mode), `client/src/events.ts`
(`via:'cmp'`), fixture fakes per vendor in `client/test/fixtures/`, tests.

**Contract:** "Add-on mode" above. **Tests (Step 0):** `client/test/companion.test.ts` —
per source: a fake banner sets state → store follows; a revoke deletes the vendor cookie;
sweep on load; nothing of the UI is requested; no record posted; banner absent → gives up
with diagnostics; `ComplyKit.sync`. **Non-goals:** writing our choice back into the banner.

#### T7 — service: owner settings form + add-on in the to-do list (S, wave 2, after T3)

**Files:** `service/src/server/hosted-script.ts` (apply settings), a settings validator,
`workspace` entry handling, `job-report.ts` / checklist (hide remove-existing-tool in
companion), `service/src/client/` install task card (the form: Mode first; when full:
layout, block page, privacy link; when add-on: banner select preselected from
`detectedCmp`, plus per-cmp instructions — `manual` shows the `ComplyKit.sync` snippet),
`shared/api.ts`, tests. Also T1a's generator `detectedCmp` (T1a owns the generator; T7
only stores/reads it).

**Tests (Step 0):** `service/test/consent-settings.test.ts` — validation; served config
reflects settings and re-hashes; companion drops `record`; save purges; remove tasks
hidden in companion. UI test for the form.

### Integration (F)

Merge T1a, T1b, T2, T3, then T4, T6, T7, then T5 into `hosted-script`. Full suites (root, client,
service), builds, size check, boundaries. Local smoke: service on fs backend, a fixture
page with the pasted snippet; open it in the browser pane, accept, reload, check
`/api/sites/<d>/stats` counts and that a scan of the fixture shows no complykit
tracker finding and Verify passes.

### Review (R)

One Fable agent on the integrated branch, in this order: privacy invariants P1–P8 (read
`/e`, the aggregator, the client beacon, the script route); cache/purge correctness (B1–B3:
stale configs, version skew, 301/404 caching); Verify hosted mode (false passes);
scanner B4. Findings fixed by S agents, re-checked by tests; then report to the user.

### Deploy (needs the user's go-ahead)

Set `PUBLIC_ORIGIN` on the app, `scripts/deploy-do.sh`. Existing stored configs keep
working: the next generate/rerender produces the hosted snippet; the served config is
derived at request time, so no migration.

## Open (later, not this plan)

- Domain + Cloudflare switch-on (env only).
- Banner editor on the host (will reuse `config-hash.ts` and snapshots).
- Owner-facing analytics page beyond the Sites panel.
