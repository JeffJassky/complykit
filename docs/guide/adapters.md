# Adapters

An adapter is the seam between complykit and something it does not own. The
audited property is the "host". Each adapter has **two directions**: inbound
(complykit asks the host a question) and outbound (the host is notified of a
lifecycle event). Documenting only one direction is what makes the other look
arbitrary.

The set is deliberately small. Every adapter is absent-by-default — omitting one
degrades gracefully to a recorded coverage gap, never a crash.

## `auth`

Provides an authenticated session so the run can reach level-2 (authed) surface.

- **Inbound** — "give me an authenticated storage state for property X." A
  Playwright `storage-state` file, or a `form` login script complykit drives once.
- **Outbound** — "the state was rejected or expired mid-run", so the host's
  capture flow can re-authenticate rather than silently producing empty authed
  coverage.
- **Default** — none. Authed routes become a coverage gap; the run continues on
  the public surface.

## `classify`

Names cookies and trackers for the GDPR layer.

- **Inbound** — "classify cookie/tracker `_xyz`" — is it strictly necessary,
  analytics, advertising?
- **Outbound** — "an unknown key was encountered", which feeds database updates
  so the classification set improves over time.
- **Default** — a bundled Open-Cookie-DB snapshot.

## `components`

Maps a design system's components to the elements they render, for the static
layer.

- **Inbound** — "what element does `<AppButton>` render?" so a static a11y check
  reasons about the real DOM, not the wrapper.
- **Outbound** — "an unmapped component was seen in an accessibility-relevant
  position" — surfaced as a needs-review lead rather than a silent miss.
- **Default** — an empty map; unmapped components become needs-review leads.

## `track`

Optional telemetry, the house cross-package convention.

- **Inbound** — none.
- **Outbound** — run lifecycle and finding counts, emitted as telemetry events if
  the host wires them.
- **Default** — a **no-op**. Installing complykit never drags in an analytics
  engine.
