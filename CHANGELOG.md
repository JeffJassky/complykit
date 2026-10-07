# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

A **peer range widening** is a minor. A peer range *narrowing* is a major — it
breaks installs for people who were relying on the claim, and the claim is only
real if CI runs the matrix. See standards/traps.md #10.

## [Unreleased]

### Added: client consent tool and consent-compatibility epic
- `client/` (`@jeffjassky/complykit-consent`, private, not published): a
  zero-dependency consent tool that asks and remembers, holds scripts back,
  tells loaded scripts the state, and supports withdrawal. Split build: a
  blocking core (<= 15 KB gzipped) and a lazy UI (<= 12 KB gzipped); size
  budgets enforced in CI. Gate by `type="text/plain"` + `data-category`,
  vendor adapters, Google Tag Manager consent bridge, location-based regimes
  (opt-in / opt-out-signal / opt-out), per-regime banner strings with a
  validator, themes and layouts, consent-record endpoint on the service.
  Tested in Chromium, Firefox and WebKit.
- Config contract: a JSON config element, `schema/consent-tool-config.schema.json`
  (shipped in the package), generated docs, and `complykit consent-config <run-dir>`
  which writes a config, snippet and change list from a scan.
- Scanner: markup analysis (gateable / leak / hint / held), GTM container
  parsing and consent-setting rewrite for local copies, consent-API recording,
  consent-tool and platform detection, implementation class, repeated runs
  (`--runs N`), site-search journey step.
- Consent compatibility verdict and change list per tracker (gateable,
  tag manager, platform, uncontrollable, unknown; fails closed), scope and
  blind-spot lines, consent-tool proof section (controlled only when held in
  every denied visit, run when granted, and journey parity).
- `complykit consent --local-copy <spec.json>` proves an install loop against a
  route-intercepted copy of a page without touching the live site.
- Service: shared per-site workspace (config, snippet, change list, notes),
  Sites page, snapshot export, rescans that apply the workspace and show what
  changed since the last scan.
- Guides: platform bridges for Shopify, WordPress and Wix; GTM setup; location;
  banner copy and banner design rules; consent records; limits.
- Release gate: `.github/ISSUE_TEMPLATE/release-checklist.md` and
  `scripts/check-pack.mjs` (pack-contents guard wired into `prepublishOnly`;
  the client package refuses to publish while private).

### Added
- Initial extraction.
- `complykit consent` — consent & tracking evaluation by visitor location
  (plans/consent-design.md M6–M8): context-level capture (frames, workers,
  service workers, page-exit beacons, initiator + insertion chains, HttpOnly
  cookies, per-frame storage, websockets, first-party CNAMEs); a 12-scenario
  runner with autoconsent banner driving and stored-state confirmation;
  two-source location verification through each location's proxy; redacted HAR
  + timeline evidence; party identification (seed knowledge base + behavior),
  vendor consent decoding, marker detection; location rules for ePrivacy
  Art. 5(3), PECR reg. 6, GDPR/UK GDPR Art. 7(3) withdrawal, CCPA opt-out signal
  / display / link, state opt-out-signal laws, wiretap exposure (CIPA, Fla.
  ch. 934, WESCA) and unrecognized trackers; the consent report (summary grid,
  findings, inventory, research queue, not tested).
- Registry: requirements gain `jurisdictions` and `kind`
  (obligation / exposure / practice); `statute` citation kind; registry 0.2.0.

### Changed
- `consent.pre-consent-tracker` cites ePrivacy Art. 5(3) (was GDPR Art. 7(4)).
- Root `prepublishOnly` now also runs `check-pack`.
- `consent --events`: repeat runs (`--runs N`) emit their own `scenario-start` /
  `scenario-done` with `run: 2..N` (a skipped repeat still emits its
  `scenario-done`), and `location` carries `runs`, so a UI can plan
  scenarios x runs steps. Events without these fields mean one run.
- Service: consent scans are a single pass by default (was two runs). A scan opts
  into the slowed repeat with `slowRepeat` (submit form and full rescans;
  `CONSENT_RUNS` sets its runs, default 2; quick is always one pass). The job time
  limit scales with runs: 45 min x (1 + 3 x (runs - 1)). The progress bar counts
  the repeats and the scan details name the upcoming visits.
