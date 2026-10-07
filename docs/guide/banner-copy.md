# Banner copy

::: warning Pending agency review
These are the consent tool's default words. They were drafted against the research
notes, not reviewed by counsel or the agency yet. Until they are, treat them as a
draft: they are not legal advice, and they do not decide anything that belongs to
counsel (research §8).
:::

The tool picks its words by **regime**: the visitor's location decides the regime
([Visitor location and regime](./location)), and each regime has its own default
table. A config can override any string, per language and per regime
([config: `strings`](./config#strings)). The schema refuses overrides that drop a
required string or use a known dark pattern (the guardrail table is on the same page).

Sources are in [research-consent-law.md](https://github.com/JeffJassky/complykit/blob/main/plans/research-consent-law.md)
(§ numbers below refer to it). The defaults live in `client/src/ui/strings.ts`.

## What changes by regime

| | opt-in (EU/EEA, UK, unknown) | opt-out-signal (CA, CO, CT, …) | opt-out (other US states) |
|---|---|---|---|
| Banner title | Cookies on this site | Your Privacy Choices | Your Privacy Choices |
| Buttons (same element, same class, this order) | Reject all · Accept all · Manage choices | Do Not Sell or Share My Personal Information · Accept all · Manage choices | Reject all · Accept all · Manage choices |
| Settings layer title | Privacy settings | Your Privacy Choices | Your Privacy Choices |
| Settings refusal | Reject all | Do Not Sell or Share My Personal Information | Reject all |
| Persistent control | Privacy choices | [opt-out icon] Your Privacy Choices | Your Privacy Choices |
| After a refusal (announced) | — (withdrawal: "Your consent has been withdrawn.") | Opt-out request honored. | Opt-out request honored. |
| GPC notice | none (nothing optional runs anyway) | shown in banner and settings | shown in banner and settings |
| Privacy policy link | after the buttons, banner and settings, when `privacyPolicyUrl` is set | same | same |

## Default copy

`{purposes}` is filled from the config's own non-necessary categories ("analytics
and advertising"), so a site with no advertising tools never mentions advertising.

### opt-in

| Key | Text |
|---|---|
| `banner.title` | Cookies on this site |
| `banner.body` | We would like to use optional cookies and similar technologies for {purposes}. Some are set by the third parties listed under "Manage choices". They stay off unless you accept. Necessary cookies keep the site working and are always on. You can change your choice at any time from "Privacy choices". |
| `banner.accept` / `banner.reject` / `banner.manage` | Accept all / Reject all / Manage choices |
| `settings.title` | Privacy settings |
| `settings.body` | Choose which optional categories to allow. Each stays off until you switch it on. Necessary technologies are always on because the site cannot work without them. |
| `settings.acceptAll` / `rejectAll` / `save` / `close` | Accept all / Reject all / Save choices / Close |
| `withdraw.confirm` | Your consent has been withdrawn. |
| `withdraw.note` + `withdraw.recall` | You can withdraw your consent here at any time. Withdrawing stops further collection; data already sent cannot be recalled. |
| `privacyChoices.link` | Privacy choices |
| `privacyPolicy.link` | Privacy policy |

### opt-out-signal (overrides of the above)

| Key | Text |
|---|---|
| `banner.title`, `settings.title`, `privacyChoices.link` | Your Privacy Choices |
| `banner.body` | We and third parties use cookies and similar technologies for {purposes}. Under California and other US state privacy laws, some of this can be a "sale" or "sharing" of your personal information. You can opt out now, or at any time from "Your Privacy Choices". |
| `banner.reject`, `settings.rejectAll`, `optOut.link` | Do Not Sell or Share My Personal Information |
| `settings.body` | Optional categories are on unless you opt out. Switch off any you do not want, or opt out of all of them. A Global Privacy Control signal from your browser is honored as an opt-out. Necessary technologies stay on because the site cannot work without them. |
| `withdraw.confirm`, `optOut.confirmed` | Opt-out request honored. |
| `withdraw.note` | You can opt out at any time. |
| `gpc.honored` | Your browser sent a Global Privacy Control signal. We have treated it as your request to opt out of the sale and sharing of your personal information. |
| `optOut.iconAlt` | California Consumer Privacy Act (CCPA) Opt-Out Icon |

### opt-out (overrides of opt-in)

| Key | Text |
|---|---|
| `banner.title`, `settings.title`, `privacyChoices.link` | Your Privacy Choices |
| `banner.body` | We and third parties use cookies and similar technologies for {purposes}. Depending on where you live, you may have the right to opt out of targeted advertising and the sale of your personal information. You can opt out now, or at any time from "Your Privacy Choices". |
| `settings.body` | Optional categories are on unless you opt out. Switch off any you do not want, or reject all of them. A Global Privacy Control signal from your browser is honored as an opt-out. Necessary technologies stay on because the site cannot work without them. |
| `withdraw.confirm` | Opt-out request honored. |
| `withdraw.note` | You can opt out at any time. |

## Why it is worded this way

| Choice | Reason | Source |
|---|---|---|
| Purpose first, no "We value your privacy" | Consent has to be specific and informed: say what is used, for what. The purposes come from the scan, so they are accurate for the site. | EDPB Cookie Banner Taskforce; ICO 2026 guidance (§3.1, §3.3) |
| "Reject all" next to "Accept all", same element, reject first | Refusing has to be as easy as accepting, on the same layer; "Accept all" plus a "Preferences" link is not symmetrical. | EDPB CBTF ¶¶8, 14, 18; CNIL; AEPD; ICO; CCPA Regs §7004(a)(2)(C)–(D) (§1.2, §3.1) |
| "They stay off unless you accept" / "Each stays off until you switch it on" | Silence is not consent and pre-ticked boxes are invalid; the copy states that the toggles start off. | Planet49 C-673/17; CCPA Regs §7004(a)(3) (§1.2, §3.1) |
| No "By continuing to browse…", no close button | Navigating on or closing is not consent. | CCPA Regs §7004(a)(3)(D); Connecticut AG; CNIL (§1.2, §1.5, §3.1) |
| "You can change your choice at any time from Privacy choices" + a persistent control | Withdrawal must be as easy as consent, from a persistent link. | EDPB CBTF ¶¶31–35 (§3.1) |
| "data already sent cannot be recalled" | Withdrawal stops future collection only; implying otherwise would be a false claim. | design §6; FTC §5 deception (§1.5) |
| "Your Privacy Choices" with the opt-out icon | The alternative opt-out link permitted in place of the statutory label, with the CPPA icon at about the size of other icons. | CCPA Regs §7013(c), §7015(b) (§1.1) |
| "Do Not Sell or Share My Personal Information" on the opt-out | The statutory wording. The settings layer behind "Your Privacy Choices" carries it so the link does not lead "only to cookie prefs". | CCPA §1798.135(a)(1); Sling TV (CA AG, 2025) (§1.5) |
| "Opt-out request honored." after an opt-out; GPC notice | The business must display whether it processed the opt-out / the signal; the regulation's own example is "Opt-Out Request Honored". | CCPA Regs §7025(c)(6), §7026(g) (§1.2) |
| GPC honored outside California too | Several states require it, and geo-filtering GPC draws criticism; the tool honors it in every US regime. | §1.4 product consequence; design §6 |
| No "we do not sell" claim | Saying it while pixels transmit is deception. | FTC §5 — GoodRx, BetterHelp (§1.5) |
| No "legitimate interest" option | Legitimate interest can never justify trackers. | EDPB CBTF ¶24; ICO 2026 (§3.1, §3.3) |

## The opt-out icon

The icon is the California Attorney General's official design
([download page](https://oag.ca.gov/privacy/ccpa/icons-download), `privacyoptions.svg`,
30 × 14), reproduced unmodified as inline SVG (same path data and colors, `#0066FF` /
white). The Attorney General publishes it for businesses to use; the page states no
license terms, only usage notes, which the tool follows:

- it does not replace the opt-out link text — it sits next to "Your Privacy Choices";
- online it should be "approximately the same size as any other icons" on the page
  (it renders at 30 × 14; restyle via `.ck-icon` if the site's icons differ);
- recommended alt text "California Consumer Privacy Act (CCPA) Opt-Out Icon"
  (string key `optOut.iconAlt`).

It is shown only under opt-out-signal.

## Open for review

- Whether the opt-out-signal banner should show at all for a visitor whose browser
  sends GPC (§7025(f): no pop-up *in response to* the signal). Today the banner shows
  whenever no choice is stored, with the GPC notice in it.
- Whether "Reject all" under opt-out (non-signal states) should instead read "Opt out
  of targeted advertising and sale".
- Sensitive personal information ("Limit the Use of My Sensitive Personal
  Information", §1798.121) is not covered by these defaults.
- A second language: the mechanism is a second table (`strings.<lang>`, and a
  built-in `DEFAULTS.<lang>`); the guardrails report non-English overrides of legally
  loaded keys as unverified until someone who reads the language reviews them.
