# Spike results

The build plan folds spikes into their milestones and requires the result be
written here before building on it.

---

## M2 — Pixel-band contrast thresholds — RESOLVED

**Question:** for a non-flat effective background (image/gradient/overlap),
where axe punts to `incomplete` and the cascade can't prove a ratio, can we
recover a deterministic verdict from the screenshot before escalating to C1?

**Result (implemented, `collect/browser/pixel-band.ts`):** yes, for the clear
cases. We sample a bounded grid (≤40×40) of pixels in the element's screenshot
region, drop pixels within 0.02 luminance of the text colour (likely the
glyphs), and take the luminance extremes as the background band. The **worst-
case** contrast over that band (text vs the closest-luminance background pixel)
is the measured floor.

Thresholds:
- `minRatio >= required` → **pass** (even the worst background pixel clears it) —
  dropped, never a finding.
- `maxRatio < required` → **fail** → a `violation` (measured).
- otherwise the band straddles the threshold → **ambiguous** → `needs-review`,
  routed to C1 (M4).

`required` is the WCAG value (4.5:1, or 3:1 for large text from computed
`font-size`/`font-weight`). This is conservative by construction: worst-case
sampling never over-claims a pass, and it shrinks the C1 queue to only the
genuinely ambiguous band. On `maxedmarketing.ai` the pixel-band path contributed
to the 31 contrast findings with zero run-to-run drift.

## M2 — DOMSnapshot closed-shadow pierce — IMPLEMENTED, verification pending

**Question:** closed shadow roots are invisible to the Playwright/JS API. Does
CDP `DOMSnapshot.captureSnapshot` pierce them (debugger-level access, like
DevTools), recovering style/structure coverage?

**Result (implemented, `collect/browser/snapshot.ts`):** the CDP path is wired.
We count closed shadow hosts via the JS API (`element.shadowRoot === null` on a
custom element), capture the CDP snapshot with `computedStyles`, and compare the
snapshot's document count to the JS-visible frame count as the pierce signal.
Where closed shadow is present and NOT pierced, an explicit
`closed-shadow-root` coverage gap is recorded (never a silent skip). Coordinate-
based interaction works regardless of shadow boundaries.

**Verification status:** the maxed homepage and the local fixtures have **no
closed shadow roots**, so the pierce itself was not exercised on a real page in
M2. The gap-recording fallback IS exercised. Follow-up (M3, when a subject with a
closed-shadow web component appears, or via a dedicated fixture): confirm the CDP
snapshot returns the shadow subtree's nodes/styles and flip the gap to recovered
coverage. Until then the conservative behaviour (record the gap) is what ships —
which is correct, not optimistic.

## M3 — CMP selector coverage — RESOLVED

**Question:** can we locate the consent banner and its accept/reject controls
across the CMP vendors real EU sites use, well enough to drive the three-way
capture and measure click/prominence asymmetry?

**Result (implemented, `collect/browser/consent.ts`):** two-tier detection.
1. **Known-vendor selector table** (`CMP_VENDORS`): OneTrust, Cookiebot, Didomi,
   Usercentrics, TrustArc, Osano/CookieConsent, Complianz, Quantcast — banner +
   accept + reject (+ manage) selectors. Direct reject → 1 click; reject only via
   a "manage" step → 2 clicks (buried); no reject → `null`.
2. **Heuristic fallback**: text-matched buttons (`/accept|allow all|agree/i`,
   `/reject|decline|deny|necessary only/i`, `/manage|settings|preferences/i`)
   within the page's controls, tagged so we can click them.

Verified on `maxedmarketing.ai`: its CMP is NOT a known vendor, and the heuristic
tier detected it correctly — accept (1 click) + reject (2 clicks, behind manage),
button prominence metrics captured. The click-asymmetry rule fired. The known-
vendor table shortcuts the common cases; the heuristic catches the long tail.

Follow-up (non-blocking): expand the vendor table as new CMPs appear in field
runs; the heuristic ensures nothing is silently missed in the meantime.
