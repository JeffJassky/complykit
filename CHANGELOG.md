# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

A **peer range widening** is a minor. A peer range *narrowing* is a major — it
breaks installs for people who were relying on the claim, and the claim is only
real if CI runs the matrix. See standards/traps.md #10.

## [Unreleased]

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
