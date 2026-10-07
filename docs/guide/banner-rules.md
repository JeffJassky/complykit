# Banner design rules

The consent evaluation measures the consent banner itself, not only what the page
sends. Five rules check a banner against the dark-pattern findings of regulators and
courts. They apply to any banner: a known consent tool, an unknown one found by the
heuristic, or complykit's own tool.

Sources are in [research-consent-law.md](https://github.com/JeffJassky/complykit/blob/main/plans/research-consent-law.md)
(§ numbers below refer to it). Rules: `src/rules/consent/banner-design.ts`. The
browser readout: `src/collect/browser/evaluation/banner-design.ts`.

::: warning Not legal advice
A finding means "a person should look at this", with the measured numbers attached.
No finding means nothing was flagged on these pages, at this viewport, from this
location. It never means "compliant".
:::

## What is measured, and when

| Readout | Scenario | What it records |
|---|---|---|
| First layer | `do-nothing`, on landing, nothing clicked | Accept, reject and manage controls: bounding box, font size and weight, text color, background stack, border, element type, DOM order, whether each is visible without scrolling and not covered. Also the banner's text and links, page usability behind it (covered / inert / scroll-locked), and the page's opt-out link labels. |
| Settings layer | `do-nothing` (read from the DOM only), `partial` (opened) | Each category toggle's label and default checked/disabled state. |
| After a choice | `accept`, `reject` (any successful choice) | Whether the banner is gone, whether the page is usable, and which visible controls reopen the settings. Also any consent-tool API that could reopen them. |

How the banner is found:

- **complykit's own tool**: by its documented hooks: `#complykit-ui .ck-banner`,
  `.ck-btn[data-ck-action=accept|reject|manage]`, `.ck-settings .ck-category`,
  `.ck-choices`, `[data-complykit-open]`. The first layer is read even when autoconsent
  does not recognize the tool.
- **Any other banner**: through the same detection the scenarios use. Known
  consent-tool selectors come first (OneTrust, Cookiebot, Didomi, Usercentrics,
  CookieYes, Complianz, Osano, Shopify), then the strict heuristic. The tool is named
  by autoconsent when autoconsent detected it.

**Not tested is never a pass.** If something cannot be measured, the scan records it
as not tested in that scenario. Examples: a banner inside a cross-origin frame or a
closed shadow root, a background image behind a button (contrast unknown), banner
text that is not English (the wording checks are English), or a settings layer with
no readable toggles. A not-tested item produces no finding and does not count as a
clean result.

## Where each rule applies

Each rule applies by the **verified** location, through the `jurisdictions` of the
requirement it cites. This is the same scoping the tracking rules use.

| Rule | EU/EEA (opt-in) | UK (opt-in) | California | Other US states / elsewhere |
|---|---|---|---|---|
| `consent.equal-prominence` | GDPR Art 4(11) | UK GDPR Art 4(11) | 11 CCR §7004(a)(2) | — |
| `consent.no-pre-ticked` | GDPR Art 4(11) | UK GDPR Art 4(11) | — (defaults on are lawful under opt-out) | — |
| `consent.no-cookie-wall` | GDPR Art 4(11) | UK GDPR Art 4(11) | — | — |
| `consent.required-strings` | ePrivacy Art 5(3), GDPR Art 7(3) | PECR reg 6, UK GDPR Art 7(3) | 11 CCR §7013(c), §7015(b) | — |
| `consent.withdrawal-control` | GDPR Art 7(3) | UK GDPR Art 7(3) | — | — |

Findings use the tracking rules' fingerprint convention: site-wide locus `*`, the
jurisdiction in `locator.landmark`, the pattern in `locator.name`. There is one
finding per location per pattern.

## `consent.equal-prominence`

**Requirement.** Refusing must be as easy as accepting, on the same layer, with the
same visual weight. Sources:

- EDPB Guidelines 03/2022 on deceptive design patterns.
- EDPB Cookie Banner Taskforce report, 2023-01-18, ¶¶8, 14, 18. Its findings: no
  reject on the first layer, deceptive button colors and contrast.
- CNIL: one-click reject wherever there is one-click accept.
- ICO 2026 guidance: accept-all and reject-all equally prominent.
- 11 CCR §7004(a)(2)(C) and (D). A more prominent "yes" than "no" is not
  symmetrical, and neither is "Accept All" offered with only "More information".

See research §1.2 and §3.1.

| Pattern | When | Confidence |
|---|---|---|
| `no-reject-first-layer` | Opt-in, and accept is shown with no reject control on the first layer | violation when the banner was read by exact selectors (complykit or a known tool); needs-review from the heuristic, which may miss a reject with unusual wording |
| `accept-and-more-info-only` | California, accept plus only a "more information / preferences" control | needs-review |
| `size` | Accept area ≥ 2× reject, or accept text ≥ 1.3× larger, or accept ≥ 300 font-weight heavier | needs-review |
| `emphasis` | Accept's surface stands out from the banner background at ≥ 2.5:1, while reject has no fill or border (< 1.3:1). Typical case: a colored button next to a text link | needs-review |
| `reject-low-contrast` | Reject text contrast < 4.5:1 while accept clears it, or reject < 3:1 | needs-review |
| `reject-needs-scroll` | Accept is visible on arrival, but reject is outside the viewport or clipped inside the banner | needs-review |

Order is recorded in the evidence but is never a finding by itself. No authority
requires reject to come first. The thresholds are in `PROMINENCE` in the rule file.
4.5:1 is WCAG 1.4.3's threshold, used here as the measure of "readable" (CBTF ¶18).

## `consent.no-pre-ticked`

**Requirement.** Optional categories, and any "legitimate interest" toggle for
trackers, start switched off. Sources:

- CJEU *Planet49* (C-673/17).
- GDPR Recital 32: "pre-ticked boxes … should not … constitute consent".
- EDPB Cookie Banner Taskforce: legitimate interest cannot justify trackers (¶24).
- ICO 2026: non-exempt toggles off.

See research §3.1 and §3.3. Opt-in locations only.

A toggle counts as pre-ticked when it is checked, not disabled, and its label is not a
strictly-necessary one. The finding is a **violation** when at least one ticked
toggle is clearly an optional purpose (analytics, marketing, advertising,
personalization, …) or a legitimate-interest toggle. Otherwise it is
**needs-review**, for example when only an unlabeled vendor switch is ticked.

Some tools tick a box in the settings but store "denied" until the visitor saves.
That is still reported: the visitor sees a pre-ticked box.

## `consent.no-cookie-wall`

**Requirement.** Refusing must leave the site usable. Sources:

- EDPB Guidelines 05/2020 on consent, ¶¶39–41: making access conditional on
  consent is not freely given consent.
- EDPB Cookie Banner Taskforce.
- ICO 2026.

See research §3.1. Opt-in locations only.

"Unusable" means at least one of the following:

- the page behind the banner is `inert` or `aria-hidden`, or the banner is a modal `<dialog>`;
- ≥ 80% of a 6×6 grid of points outside the banner hit the banner or a full-viewport overlay;
- scrolling is locked on a page that is taller than the viewport.

| Pattern | When | Confidence |
|---|---|---|
| `blocked-after-reject` | After a successful reject, the page is still unusable | violation when inert or covered; needs-review for a scroll lock alone |
| `blocking-without-reject` | The banner blocks the page and its first layer has accept but no reject | needs-review |
| `wall-wording` | The banner says the visitor must accept to continue | needs-review |

A modal banner that offers an equal reject, and leaves the page usable after the
reject, is **not** reported. Blocking until a choice is made is not a cookie wall by
itself.

## `consent.required-strings`

**Requirement.** What the first layer must say, by regime. The checks are English
patterns and tolerant of wording.

**Opt-in (EU/UK).** Sources: ePrivacy Art 5(3) and PECR reg 6 require "clear and
comprehensive information". GDPR Art 7(3): the data subject "shall be informed" of
the right to withdraw "prior to giving consent".

| Pattern | Missing |
|---|---|
| `missing-storage` | That cookies or similar technologies are stored or read |
| `missing-purposes` | What they are used for (analytics, advertising, …) |
| `missing-withdrawal` | That consent can be withdrawn or changed at any time (cites Art 7(3)) |
| `missing-further-information` | No link (privacy or cookie policy) and no settings control on the first layer |

**California.** Sources: 11 CCR §7013(c) and §7015(b). The page has an opt-out link,
but its label is neither "Do Not Sell or Share My Personal Information" nor "Your
Privacy Choices" (pattern `non-statutory-opt-out-label`). A missing link is reported
by `tracking.opt-out-link`, not here.

The same duties are checked on a config's string overrides at generation time, by
`src/record/consent-strings-guard.ts` (ticket F2).

## `consent.withdrawal-control`

**Requirement.** After a choice, the visitor needs a visible way back into the
settings. Sources:

- GDPR Art 7(3): "as easy to withdraw as to give consent".
- EDPB Cookie Banner Taskforce ¶¶31–35: a persistent icon or link.

See research §3.1. Opt-in locations only.

| Pattern | When |
|---|---|
| `no-control` | After accepting or rejecting, there is no complykit Privacy choices button, no `[data-complykit-open]` element, no known consent-tool floating widget, and no link or button worded like "Cookie settings" / "Manage consent" / "Privacy choices" anywhere on the page |
| `api-only` | Same, except a consent-tool JS API could reopen the settings (e.g. `OneTrust.ToggleInfoDisplay`). Nothing on the page calls it for the visitor |

Both patterns are needs-review. When the `withdraw` scenario already found no way to
reopen the settings, `tracking.withdrawal` reports it and this rule does not repeat
it. Whether withdrawal actually *stops* the trackers is `tracking.withdrawal`'s job.

## complykit's own banner

The test suite runs every rule against the built client (`client/dist`) in three
setups. All must produce zero findings:

- the bar layout under opt-in;
- the modal layout (UK);
- the box layout under opt-out-signal (California).

The checks are in `test/banner-design.test.ts`. The test skips, and says so in its
output, when the client has not been built.
