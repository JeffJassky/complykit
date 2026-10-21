# Wiretap holds in the client, and owner overrides (config schema 1.1)

Status: contract committed on branch `regime-overrides`. Implementation tasks below.

## Why

1. **The client fired trackers before consent in wiretap states.** CA/FL/PA/MD/IL
   are `opt-out-signal` / `opt-out`. The generator granted every non-necessary
   category by default under both, so analytics and ad pixels ran before any
   choice. The scanner expects them off there (report/cookie-purpose.ts,
   rules/tracking/compatibility.ts), so complykit's own client failed
   complykit's own scan for California visitors.
2. **Implementations must be configurable in any direction.** Rule (Jeff,
   2026-10-21): the scanner and reports are fixed to complykit policy; the client
   runs whatever the site owner configures, compliant or not. A site that loosens
   past policy shows mismatches in its report. It is not refused.

## The model

Two layers in the config, and nothing else decides a pre-choice default:

| Layer | Fields | Who writes it | Direction |
|---|---|---|---|
| Policy | `categories[].defaultByRegime`, `locationDefaults` | the generator | opt-in grants nothing; `locationDefaults` only holds (`false`) |
| Owner | `overrides` | the owner (service consent settings, or a hand edit) | anything |

`consentCategoryDefault(config, id, regime, location?)` in
`src/record/consent-config-guard.ts` is the one place precedence lives (it is
implemented and tested in the contract). In order:

1. `necessary` → true.
2. an unlisted category → false.
3. `overrides.defaults`: subdivision key, then country key, then the regime, then `'*'`.
4. opt-in → false.
5. `locationDefaults`, most specific key first.
6. `defaultByRegime`.

GPC is applied on top by the store and the proof, unless `overrides.honorGpc === false`.

Regime: `overriddenRegime(config, location)` (first matching key in
`overrides.regimes`, `'*'` for anything else, an unknown location included),
else the built-in `regimeFor`. A `fixed` regimeSource ignores it.

Location keys: `'US-CA'`, `'US'`, `'*'`. Upper case. `locationKeys()` produces the lookup order.

Version: `CONSENT_CONFIG_VERSION` is `'1.1'` (additive minor). A 1.0 tool ignores
the new fields and behaves as before. Neither field has a zod default, so 1.0
configs hash the same.

## Contract (done, frontier)

- `src/record/consent-config-guard.ts`: types `LocationKey`, `VisitorLocation`,
  `ConsentOverrides`; `ConsentToolConfig.locationDefaults` / `.overrides`; guard
  structural checks; `locationKeys`, `overriddenRegime`, `honorsGpc`,
  `hasOverrides`, the new `consentCategoryDefault`.
- `src/record/consent-config.ts`: `LocationKeySchema`, `ConsentOverridesSchema`,
  schema fields + refinements (locationDefaults holds only; no `necessary`;
  listed categories only; overrides strict).
- `types/index.d.ts`, `src/index.ts`, `client/src/config.ts`: exports.
- Tests: `test/consent-config.test.ts` (1.1 blocks, passing). These fail until
  implemented: `client/test/overrides.test.ts`, `test/consent-generator.test.ts`
  (1.1 block), `test/consent-tool-proof.test.ts` (1.1 block),
  `test/location-rules.test.ts` (visitorLocationFromCodes),
  `service/test/consent-settings.test.ts` (1.1 block).

## Tasks (Sonnet; one checklist review each)

### A. Client — `client/src/` [Sonnet]

Files: `location.ts`, `store.ts`, `api.ts`, `diagnostics.ts`, `ui/strings.ts`, `ui/copy.ts`, `bridges/shopify.ts`.

- `LocationDecision` gains `overridden: boolean`. `decide()` uses
  `overriddenRegime(config, location) ?? regimeFor(location)`. Unknown and pending
  use `overriddenRegime(config, undefined) ?? FALLBACK_REGIME`. `fixed` → `overridden: false`,
  overrides ignored. `diagnostics.location` gains `location?` and `overridden`.
- `StoreOptions.location?: VisitorLocation`. `ConsentState` gains `location?: VisitorLocation`
  and `gpcHonored: boolean` (= gpc && honorsGpc(config)). The defaults are
  `consentCategoryDefault(config, id, regime, location) && (!gpcHonored || necessary)`.
  `setRegime(r, location?)`: a location given replaces the stored one; omitted keeps it.
  Export `holdsBeforeChoice(config, regime, location)`: regime !== 'opt-in' and some
  listed non-necessary category's `consentCategoryDefault` is false.
- `api.ts`: pass `loc.initial.location` to `createStore`. On `ready`, call
  `setRegime(d.regime, d.location)`.
- `ui/strings.ts`: `LangDefaults.held?: Table` with `banner.body` and
  `settings.body`. `t()` order: config byRegime[r] → config base → DEFAULT held (when
  `holdsBeforeChoice` for the store's state) → DEFAULT byRegime[r] → base. The copy
  must say some purposes stay off until the visitor accepts and the rest are on
  unless they opt out. Run `test/consent-strings.test.ts` and the banner tests; keep reject as prominent as accept.
- `ui/copy.ts`: the GPC note shows only when `gpcHonored`.
- `bridges/shopify.ts:264` strips grants under opt-in before a choice. Change it
  to use the store's effective grants, so an owner's opt-in override reaches Shopify.
  The adapters' `not-gated` note (adapters/index.ts:222) is diagnostic only; leave it.
- Size budget: `npm run size` must pass.
- Tests: `client/test/overrides.test.ts` passes. The whole client suite (`npm run check`) stays green.

Invariants: no policy decision in client code beyond calling the shared
functions. Opt-in with no overrides still grants nothing. A stored choice is
never changed by a regime or location move.

### B. Scanner + generator + docs — `src/` [Sonnet]

- `src/registry/regime.ts`: `visitorLocationFromCodes(codes)` →
  `['us','us-ca']` → `{US, CA}`; `['us']` → `{US}`; `['eu','eu-de']` → `{DE}`;
  `['uk']` → `{GB}`; `['br']` → `{BR}`; `['eu']` alone or `[]` → undefined. Export via the
  registry index and `src/index.ts` + `types/registry.d.ts` / `index.d.ts`, whichever publishes the registry.
- `src/consent-generator.ts`: `GenerateConsentConfigOptions.overrides?: ConsentOverrides`,
  passed through into the config. When any are present (`hasOverrides`, or a
  note), add a `policy-overridden` **flag** note: what they change, plus the owner's note.
  `locationDefaults`: for every `WIRETAP_STATES` code (`'us-ca'` → `'US-CA'`), hold
  each config category that is non-necessary and either (a) `analytics` or
  `advertising`, or (b) has a vendor whose KB/inventory categories intersect
  `WIRETAP_CATEGORIES`. Omit a state row only if it would be empty. Add an info note
  listing the holds. `test/consent-generator.test.ts` (1.1 block) passes.
- `src/rules/tracking/consent-tool-proof.ts`: `expectedGrantedFor(..., gpcSeen, location?)`.
  The default branch passes `location`. The `gpc` scenario returns the
  defaults when `!honorsGpc(config)`. Callers pass
  `visitorLocationFromCodes(l.verification.jurisdictions)`. New finding
  `policy-overridden` when `hasOverrides(deployed config)`: the message names each
  override in plain words (regimes moved, defaults granted or held, GPC ignored)
  plus the owner's note; `details: { overrides }`. Add the code wherever finding
  codes are enumerated (report renderers, vocabulary checks, docs).
  `test/consent-tool-proof.test.ts` (1.1 block) passes.
- Docs: `docs/guide/location.md` (overrides.regimes, wiretap holds),
  `docs/guide/config.md` (both fields, the precedence list above, "the report still
  judges by complykit policy"). Regenerate `schema/` (UPDATE_SCHEMA=1) if needed.
  Add a CHANGELOG entry.
- The full root suite (`npm test`, typecheck, `npm run build`) stays green. Existing
  generator snapshots change: `version` becomes `'1.1'` and `locationDefaults` is added. Update them
  deliberately and check that nothing else moved.

### C. Service — `service/src/` [Sonnet]

- `shared/api.ts`: `ConsentSettings.overrides?` (mirror of `ConsentOverrides`).
- `server/consent-settings.ts`: allow-list `overrides`. Validate structurally,
  mirroring the package (strict keys `regimes|defaults|honorGpc|note`; location key
  `/^(\*|[A-Z]{2}(-[A-Z0-9]{1,3})?)$/`; regime values; defaults keys location or
  regime; values boolean; no `necessary`; category ids `/^[a-z][a-z0-9-]*$/` (match
  the package's CategoryId); note 1–500 chars). `applyConsentSettings` sets
  `out.overrides`, dropping category entries the config does not list and rows
  left empty.
- UI (ConsentSettingsForm): no editor in this change. Don't wipe an `overrides`
  key the form does not edit: the form's PUT must carry it through (check
  `client/lib/consentSettings.ts`).
- `service/test/consent-settings.test.ts` (1.1 block) passes. Run the full service suite.

## Non-goals

- No change to the scanner's policy (compatibility.ts, cookie-purpose.ts): it
  already holds wiretap categories.
- No Canada or UK-statistics policy change (research first; see the 2026-10-21 thread).
- No regime value beyond the three; no strings `byRegime` key for the held variant.
- No owner-facing overrides editor in the service UI.
- Consent records unchanged: `configHash` identifies the config, overrides included.

## Review

At the end: Fable area reviews of (1) the client store/location/gate path and (2) the
proof + generator. Not one per task.
