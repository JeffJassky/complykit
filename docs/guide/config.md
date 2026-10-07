# Consent tool config

The consent tool is configured from a scan. The generator writes one JSON object,
the owner pastes it inline in the snippet, the tool reads it at load, and the next
scan reads it back from the page and compares it with the workspace. This page is
the contract between those three.

Nothing here is fetched at runtime. The script is self-hosted and the config is in
the page; a request to us before consent would be exactly the kind of thing the scan
polices.

```html
<script type="application/json" id="complykit-config">
{ "version": "1.0", "generatedFrom": { … }, "hash": "…", … }
</script>
<script src="/v1/complykit-consent.js"></script>
```

Both go first in `<head>`, above Google Tag Manager and every tag they control, and the
script loads without `async` or `defer`: it must run before anything it gates or holds.

The element id is `CONSENT_CONFIG_ELEMENT_ID` (`complykit-config`): the tool, the
generator and the rescan all look for that one element.

The full field list, generated from the JSON Schema, is in the [Config
reference](/reference/config-schema); the install steps are in [Installing the
consent tool](./consent-tool.md).

## Generating it

```sh
complykit consent-config .comply/runs/<run-id> [--workspace workspace.json] [--out dir]
```

From a consent run (its `tracking.json`) and, optionally, the site workspace, the
generator writes `complykit-config.json`, `snippet.html` (the inline config, the
`<script src>`, then each tag to rewrite, as before/after markup), the
[change list](./consent.md) and `generator-notes.md` (what it refused, what to
check before deploying). The service does the same for a finished consent job —
`POST /api/jobs/:id/consent-config` — with the site's current workspace, and stores
the result as the workspace's latest config.

How it decides, in short: categories are only those of the tools seen; a tool's
category is the one its rewritten tag gets in the change list (the strictest of its
purposes; `advertising` when it is not classified yet); **a tool the knowledge base
classifies as tracking is never put in `necessary`**, whatever the workspace says;
`control` follows the compatibility verdict (see the table under
[`vendors[]`](#vendors)); `gtm` lists the GTM containers seen and the tags the change
list names; the platform bridge follows the platform fingerprint; on Shopify the
location comes from the platform, elsewhere from `<meta name="complykit-region">`.
The output is parsed against this schema, and its hash verified, before anything is
written. `--script-src`, `--record-endpoint`, `--privacy-policy` and
`--regime-source` override the defaults; the default script path,
`/complykit/v1/complykit-consent.js`, is a placeholder for wherever the two files are
self-hosted.

An editor schema is shipped at `schema/consent-tool-config.schema.json`
(`$schema: "https://jeffjassky.github.io/complykit/schema/consent-tool-config.schema.json"`).
It is generated from the zod schema in `src/record/consent-config.ts` and a test
fails when it is behind.

## Versioning and migration

`version` is the **config schema** version, `"<major>.<minor>"`, separate from the
package version. The rules:

| Config vs. the tool | Tool (in the page) | Rescan |
|---|---|---|
| same major, same or **newer minor** | runs; unknown fields ignored (minors are additive and optional) | parses |
| same major, **older minor** | runs | parses and flags: *deployed config is behind the workspace* |
| **newer major** | **refuses**: does nothing | parser refuses; the header is still read and reported |
| **older major** | **refuses**: no migration exists yet | parser refuses; header read; flagged as behind |

The script is served **per major** (`/v1/complykit-consent.js`): a 1.x config keeps a
1.x tool until the owner re-installs from a new scan, so the "newer major" row only
happens when a config is pasted without its script.

Refusing means the tool does nothing — so gated scripts stay inert, which is the
fail-closed outcome. (A GTM container with no Consent Mode defaults would still run;
the bridge sets denied defaults from a static line in the snippet, before it reads
the config, for that reason.)

`parseConsentToolConfig(raw)` is the full check (zod, invariants, hash). The client
ships only `guardConsentToolConfig(raw)`: version policy plus "are the load-bearing
fields there and of the right kind", with no dependencies. A major migration, when
one exists, runs inside `parseConsentToolConfig` before the schema.

The rescan never depends on parsing to say what is deployed:
`readConsentConfigHeader(raw)` returns `version`, `hash` and `generatedFrom` (strings
only, nothing validated) from whatever is in the element, so a refused config is still
reported by run id, site and version.

## The hash

`hash` is the sha-256 (hex) of the **canonical JSON** of the parsed config with the
`hash` field removed: object keys sorted recursively, arrays in their order,
`undefined` members omitted, no whitespace. The generator stamps it over the *parsed*
form (defaults filled) and writes that form, so the deployed config is exactly what was
hashed. `withConsentConfigHash(input)` parses and stamps it;
`parseConsentToolConfig` reports `hashMatches`, checked over the config **as deployed**
(not re-parsed), so a config from an older or newer minor is not mistaken for an edit. A hand edit after generation shows
up on the rescan as "deployed config was edited since it was generated".

## Fields

Every field below is in the parsed form. In the written form, `vendors`, `gate`,
`platform`, `theme`, `strings`, `consent` and `layout` may be omitted (defaults: `[]`,
`[]`, `"none"`, `{}`, `{}`, `{ "lifetimeDays": 365 }`, `"bar"`); `gtm`, `record` and
`privacyPolicyUrl` are optional and stay optional.

### `version`, `generatedFrom`, `hash`

```json
"version": "1.0",
"generatedFrom": { "runId": "2026-10-06T00-00-00-000Z", "at": "2026-10-06T00:00:00.000Z", "site": "example-shop.test", "complykit": "0.0.0", "kb": "2026-10-02" },
"hash": "3b1f…"
```

`generatedFrom.runId` is the scan run the config came from and `site` the registrable
domain it ran against (the rescan compares it with the page it is on). The consent
record the tool posts carries `hash` so proof and config line up.

### `regimeSource` — where the location comes from

The browser does not know where it is. The location comes from the server, the CDN
or the platform — **never from a client-side call to a third-party geo service**.
The tool turns it into a **regime** with `regimeFor()`, the same function the
scanner uses:

| Regime | Meaning |
|---|---|
| `opt-in` | prior consent required (EU/EEA, UK). Nothing but `necessary` runs until granted. |
| `opt-out-signal` | may run until the visitor opts out, and a Global Privacy Control signal **must** be honored as that opt-out (US states with an opt-out-signal law, e.g. California). |
| `opt-out` | may run until the visitor opts out; no opt-out-signal law. The tool still honors GPC (design §6). |

This is the scanner's vocabulary (`regimeFor` in the consent report); its `unknown`
is the tool's fallback. Unknown location ⇒ `opt-in`. That fallback is not
configurable.

```json
"regimeSource": { "kind": "header", "header": "cf-ipcountry", "endpoint": "/.well-known/complykit-region" }
"regimeSource": { "kind": "meta", "name": "complykit-region" }
"regimeSource": { "kind": "platform" }
"regimeSource": { "kind": "fixed", "regime": "opt-in" }
```

- `header`: a **same-origin** endpoint whose body is the CDN/server header's value,
  `"DE"` or `"US-CA"` (ISO 3166-1 alpha-2, optional 3166-2 suffix).
- `meta`: `<meta name="complykit-region" content="US-CA">` written by the server
  (`complykit-region` is the default name).
- `platform`: the platform bridge reports it (needs `platform` ≠ `none`).
- `fixed`: one regime for everyone. `opt-in` everywhere is the safe choice for a site
  with no location source.

Recipes per host (Cloudflare, Vercel, Netlify, Fly, Shopify) and the full regime table:
[Visitor location and regime](./location.md).

### `categories[]`

```json
{ "id": "analytics", "label": "Analytics", "description": "How the site is used.",
  "defaultByRegime": { "opt-in": false, "opt-out-signal": true, "opt-out": true } }
```

Only the categories the scan found are listed — a site with no advertising tools
shows no advertising toggle. `id` is a lower-case slug used in `data-category`, in
the state store and in the consent record.

**`necessary` is special, and the rules are in the schema, not the reader:**

- it must be present; it is granted in every regime and never toggled;
- no other category may default to granted under `opt-in` — the schema refuses it, the
  client guard refuses a config that says otherwise, and `consentCategoryDefault`
  returns `false` under `opt-in` regardless (defense in depth against a hand edit);
- a category that is **not listed is denied** in every regime until a visitor grants
  it — which they cannot, because it has no toggle. `consentCategoryDefault(config,
  id, regime)` encodes this: `necessary` → `true`, unknown → `false`, otherwise the
  configured default. The store, the gate, the GTM bridge and the adapters all go
  through it. An unknown `data-category` on a gated script therefore never loads.

### `vendors[]`

One row per tool the scan saw, keyed by its knowledge-base entry id:

```json
{ "id": "meta.pixel", "label": "Meta Pixel", "category": "advertising",
  "control": "api", "adapter": "meta",
  "stores": [{ "name": "^_fb[cp]$", "kind": "cookie" }] }
```

`control` is how the tool reaches it (design §2):

| `control` | Meaning | Needs |
|---|---|---|
| `gate` | the load is gated (`type="text/plain" data-category`) — the universal control | — |
| `api` | gated **and** told through its consent API | `adapter` (ids below) |
| `platform` | only the platform's consent API reaches it | `platform` ≠ `none` |
| `none` | the tool cannot control it (markup leak, CNAME cookies, server-side); listed so the record and the rescan know it is outside reach | — |

`adapter` names the vendor's consent API (read only when `control` is `api`). The
calls are exactly the knowledge base's control facts (`src/registry/kb/control.ts`):

| `adapter` | KB entries | Hold (at start) | Grant | Revoke |
|---|---|---|---|---|
| `google-consent-mode` | `google.analytics`, `google.ads.ccm`, `google.ads.doubleclick` | `gtag('consent','default', {…denied})` | `gtag('consent','update', {…granted})` | `gtag('consent','update', {…denied})` |
| `meta` | `meta.pixel` | `fbq('consent','revoke')` | `fbq('consent','grant')` | `fbq('consent','revoke')` |
| `tiktok` | `tiktok.pixel` | `ttq.holdConsent()` | `ttq.grantConsent()` | `ttq.revokeConsent()` |
| `microsoft-uet` | `microsoft.uet` | `uetq.push('consent','default', {ad_storage:'denied'})` | `…'update', {ad_storage:'granted'}` | `…'update', {ad_storage:'denied'}` |
| `microsoft-clarity` | `microsoft.clarity` | — (revoke when denied) | `clarity('consentv2', {ad_Storage, analytics_Storage: 'granted'})` | `… 'denied'` |
| `pinterest` | `pinterest.tag` | — (revoke when denied) | `pintrk('setconsent', true)` | `pintrk('setconsent', false)` |
| `none` | any | nothing | nothing | nothing |

Adapters are **additive**: the gate is the control, and an adapter never releases a
gated script. In an opt-in regime an `api` vendor with no gate rule or GTM tag is
reported (`ComplyKit.diagnostics.adapters.notes`, kind `not-gated`). Each vendor is
told once per change (idempotent); a vendor in two categories is granted only when
both are. A vendor global that is not defined yet is polled for (every 100 ms, for
10 s after each change) and the owed calls run in order when it appears; the tool
never defines `fbq`, `ttq`, `clarity` or `pintrk` itself (Meta's base code skips
loading when `fbq` exists). `uetq` and the data layer are created, as their docs
say to. With a `gtm` section, Consent Mode is set by the GTM bridge from
`gtm.consentMode` and the Google adapter only checks every Google vendor's signals
are mapped there; without one, the adapter derives the signals from the vendors
(`analytics_storage` for Analytics, `ad_storage` / `ad_user_data` /
`ad_personalization` for Ads) and pushes one default per page. The schema refuses an
unknown `adapter`; the tool treats one as `none`.

`stores` are the cookie / storage keys the vendor sets (regex sources, from the KB),
used by the withdrawal flow to delete what the page can reach. Withdrawal stops
future sends; it recalls nothing — the copy never implies otherwise (string key
`withdraw.recall`, default "Withdrawing stops further collection; data already sent
cannot be recalled.").

On withdrawal (`ComplyKit.withdraw()`, or Reject all after a grant) the tool, in
order: records the deny-all choice, lets the GTM bridge push its Consent Mode update,
has the vendor adapters revoke, deletes the matching cookies and
`localStorage` / `sessionStorage` keys of the revoked categories, then reloads the
page; the gate holds every gated script from that load on. A partial change that turns
a category off gets the same revoke and cleanup but no reload by default. Set
`data-complykit-reload` on the tool's `<script>` tag to `revoke` (reload after any
change that turns a category off) or `none` (never reload). Cleanup reaches only
first-party cookies the page can read: HttpOnly cookies, third-party cookies,
partitioned cookies and data a vendor keeps elsewhere cannot be removed from the page.
Each matching cookie is expired host-only and on every parent domain (down to two
labels), on `Path=/` and on each prefix of the current path.

### `gate[]`

What the gate owns, and what the rescan verifies is actually gated in the markup:

```json
{ "category": "analytics", "src": "^https://widget\\.example-vendor\\.test/", "vendor": "example.widget" }
{ "category": "advertising", "selector": "script[data-ck-inline=\"meta\"]", "vendor": "meta.pixel" }
```

`src` is a regex source matched against `data-src`/`src`; `selector` is for inline
scripts. One of the two is required. `category` must be listed; `vendor`, if set,
must be listed.

### `gtm`

```json
"gtm": {
  "containers": ["GTM-XXXX01"],
  "dataLayer": "dataLayer",
  "consentMode": { "analytics_storage": "analytics", "ad_storage": "advertising",
                   "ad_user_data": "advertising", "ad_personalization": "advertising",
                   "security_storage": "necessary" },
  "tags": [{ "name": "GA4 - config", "category": "analytics", "vendor": "google.analytics" }]
}
```

`consentMode` maps each Consent Mode signal to the category that grants it. **An
unmapped signal stays denied.** `tags` are the container tags that must carry a
consent requirement — the owner's change list, and what the rescan checks against
the parsed container.

### `platform`

`"none" | "shopify" | "wix" | "squarespace" | "wordpress"`. Names the platform
bridge to load. Required by `control: "platform"` and `regimeSource: platform`.

### `theme` and `layout`

Theming is tokens, not an engine. `font` is always `inherit`.

```json
"theme": { "bg": "#fff", "fg": "#111", "accent": "#2563eb", "border": "#ddd", "radius": "6px" },
"layout": "bar"
```

Each key sets a CSS custom property: `--ck-bg`, `--ck-fg`, `--ck-accent`,
`--ck-border`, `--ck-radius`. `layout` is `bar` (bottom bar, the default), `box`
(corner box) or `modal` (centered). The per-category settings layer is the same in
all three.

Guardrails are **not** config: the rescan checks that reject and accept have equal
weight and contrast, no box is pre-ticked, the required strings are present and
there is no cookie wall. A theme that fails is a finding like any other.

### `strings`

```json
"strings": {
  "en": {
    "banner.title": "Your privacy choices",
    "banner.reject": "Reject all",
    "byRegime": { "opt-out-signal": { "optOut.link": "Do Not Sell or Share My Personal Information" } }
  }
}
```

Language tag → string table. Per-regime **defaults live in the tool**; the config
carries overrides, by key and (under `byRegime[regime]`) per regime. A second
language is a second table, chosen by `navigator.language`. Tables are **strict**: an
unknown key or an empty string is refused at generation time — a typo would otherwise
fall back silently and an empty string would blank a required control. Keys
(`CONSENT_STRING_KEYS`):

`banner.title` `banner.body` `banner.accept` `banner.reject` `banner.manage`
`settings.title` `settings.body` `settings.acceptAll` `settings.rejectAll`
`settings.save` `settings.close` `withdraw.link` `withdraw.confirm` `withdraw.note`
`withdraw.recall` `privacyChoices.link` `optOut.link` `optOut.confirmed`
`optOut.iconAlt` `gpc.honored` `privacyPolicy.link`

The default words for each regime, and why they are worded that way, are in
[Banner copy](./banner-copy). `{purposes}` in any string is replaced by the
config's non-necessary category labels ("analytics and advertising").

**Guardrails (refused at generation time).** Besides shape, the schema runs
`validateConsentStrings` (`src/record/consent-strings-guard.ts`) and refuses a config
whose overrides would make the visitor read something the law or the dark-pattern
findings rule out. A base-table override is checked in every regime it is not itself
overridden in.

| Rule | Refused when an override… |
|---|---|
| `blank` | is whitespace only (any key, `withdraw.recall` included) |
| `opt-in-reject` | under opt-in, `banner.reject` / `settings.rejectAll` does not say reject (Reject, Decline, Refuse, Only necessary, …) |
| `reject-as-settings` | a reject label reads as a settings link ("Settings", "More options", "Preferences") |
| `opt-out-signal-wording` | under opt-out-signal, `settings.rejectAll` or `optOut.link` drops "Do Not Sell or Share My Personal Information" |
| `privacy-choices-wording` | under opt-out-signal, `privacyChoices.link` is neither "Your (California) Privacy Choices" nor the statutory label |
| `ambiguous-accept` | under opt-in, accept is only an acknowledgement ("OK", "Got it", "Continue", "Close") |
| `implied-consent` | says browsing on is consent ("By continuing to browse…") |
| `pre-ticked` | under opt-in, says optional categories are on by default |
| `legitimate-interest`, `false-urgency`, `confirmshaming`, `cookie-wall` | uses those patterns |

Warnings (not refused; for the report and the owner): `filler` ("We value your
privacy"), `no-sale-claim` ("we do not sell" — deceptive if pixels transmit),
`ambiguous-accept` outside opt-in, and `unverified-language`: a table in a language
other than English that overrides a legally loaded key cannot be checked
automatically and needs review by someone who reads it. The client does not re-run
the checks; it trusts the generator (the hash says whether the config was edited).

### `consent` and `privacyPolicyUrl`

```json
"consent": { "lifetimeDays": 180, "cookieDomain": ".example-shop.test" },
"privacyPolicyUrl": "https://example-shop.test/privacy"
```

`consent.lifetimeDays` is how long a choice is remembered before the visitor is asked
again: default 365, at most 395 (13 months). `cookieDomain` shares the choice across
subdomains; default is the current host. `privacyPolicyUrl` (https only) is linked
from the banner and the settings layer, after the buttons (label: `privacyPolicy.link`).

### `record`

```json
"record": { "endpoint": "/consent-record" }
```

Optional. Where the tool POSTs the consent record (categories, timestamp, tool
version, config `hash`) for proof. A same-origin path, or an absolute URL if the
owner routes it to the complykit service's optional endpoint. Without it, the record
stays in the browser.

## Programmatic use

```ts
import {
  withConsentConfigHash,     // generator: parse, fill defaults, stamp hash
  parseConsentToolConfig,    // scanner / service: full validation + version policy + hash check
  guardConsentToolConfig,    // client: dependency-free structural check
  readConsentConfigHeader,   // rescan: version/hash/generatedFrom without parsing
  consentCategoryDefault,    // every consumer: the fail-closed default
  CONSENT_CONFIG_ELEMENT_ID, // 'complykit-config'
  consentToolConfigJsonSchema,
  type ConsentToolConfig,
} from '@jeffjassky/complykit';
```

The client package imports the guard and the types from
`src/record/consent-config-guard.ts`, a module with no imports, so zod never enters
its bundle. `npm run schema:consent` regenerates the editor schema from a build;
`UPDATE_SCHEMA=1 npx vitest run test/consent-config.test.ts` does it without one.
