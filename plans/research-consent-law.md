# Research: consent, pixels & tracking law — what is actually true (2026-09-30)

Companion doc: [consent-design.md](consent-design.md) (the approved plan for what
complykit builds). Probes of real storefronts that informed both are kept out of the
repo (local `reports/`, gitignored). Extends
[research-compliance-sources.md](research-compliance-sources.md) §2, which only
covered the EU side and cited GDPR where ePrivacy is the operative rule.

Compiled 2026-09-30 from five parallel research passes plus direct probes.
**Legend:** links without a tag are primary (statute, regulation, court, regulator);
**[S]** = secondary (law-firm alert, tracker, vendor blog); **†** = not re-fetched
(bot-blocked, e.g. curia.europa.eu, eur-lex). Several passes exhausted their web-search
quota and finished by fetching primary texts directly. Not legal advice — this is the
requirement registry's source material; counsel signs off on policy choices (§8).

---

## 0. The owner's model vs. what is true

| Belief | Reality |
|---|---|
| "Florida lets pixels run by default; they only have to stop if the user opts out." | **Privacy-statute side: essentially true — and more permissive than stated.** The Florida Digital Bill of Rights only reaches $1B+ revenue companies of three narrow types ([§501.702(9)](http://www.leg.state.fl.us/statutes/index.cfm?App_mode=Display_Statute&URL=0500-0599/0501/Sections/0501.702.html)); there is no general Florida opt-out duty. One exception applies to every for-profit business: selling *sensitive* data needs prior consent + a fixed notice ([§501.715](http://www.leg.state.fl.us/statutes/index.cfm?App_mode=Display_Statute&URL=0500-0599/0501/Sections/0501.715.html)). **Wiretap side: false.** Florida's Security of Communications Act requires *all parties' prior consent* to interception ([§934.03(2)(d)](http://www.leg.state.fl.us/statutes/index.cfm?App_mode=Display_Statute&URL=0900-0999/0934/Sections/0934.03.html)), and since 2025 it is reported as the second-largest venue for pixel/chat suits [S] (§2.5). Chat widgets and session replay are the targets. |
| "In California, nothing can be placed until the user consents." | **Statute side: false.** CCPA is opt-out for adults ([§1798.120](https://cppa.ca.gov/pdf/20260101_ccpa_statute.pdf)); opt-in only for known under-16s. But the opt-out must work *automatically*: a GPC signal must suppress sharing pixels on the first page load, with no popup, and since 2026-01-01 the site must display that it honored it (§1.2). **Litigation side: effectively true.** CIPA wiretap suits turn on consent obtained *before* the pixel fires (§2) — that is what pushes California toward opt-in in practice. |
| "Europe and the UK are the opposite: nothing until consent." | **EU: true, and broader than cookies** — pixels, tracking URLs, localStorage, IP-only tracking and client-side hashed emails all need prior consent (EDPB 2/2023). **UK: mostly true** — since 2026-02-05 narrow no-consent exceptions exist for first-party-style analytics and appearance, but only with a free objection mechanism; advertising is never exempt; fines now reach £17.5M / 4% (§3.3). |
| "Sitting in Florida, I can't tell whether California is handled." | **Correct, and it is the core engineering problem.** Shopify, the Google tag, Cookiebot and Meta's LDU all decide jurisdiction server-side from the visitor's IP; headers can't fake it. Only OneTrust is cleanly mockable. Evidence for a jurisdiction requires an exit IP in it (consent-design.md §2.2). |
| "Shopify says it follows California and European law — do I believe it?" | **For surfaces Shopify manages, yes; for theme code and app embeds, no — and Shopify says so itself** ("If you have manually installed third-party cookies or pixels or integrated them through apps… you may need to use a third-party cookie banner or add custom logic", [help](https://help.shopify.com/en/manual/privacy-and-security/privacy/customer-privacy-settings/privacy-settings)). Details: consent-design.md §7. |
| "Withdrawal has to actually work." | **Correct everywhere.** EU/UK: withdrawal as easy as consent, then no further reading/writing (§3.1). California: a failed opt-out is the single most-fined pattern (§1.5). A S.D. Cal. ruling (2026-08-12) held that rejecting cookies made later browsing "confidential" for §632 — a leaking banner is evidence *against* the site (§2.2). |
| "Are there retroactive concerns?" | **Yes.** CPPA can act up to 5 years back ([§1798.199.70](https://cppa.ca.gov/pdf/20260101_ccpa_statute.pdf)); California has no right to cure; Tractor Supply fixed GPC in 2024-07 and was fined in 2025-09 for the prior period. CIPA: 1-year limitations from the visit; Florida ch. 934: 2 years. Fixing now stops new exposure accruing; it does not erase visits inside those windows (§6). |
| "Lawyers have near-infinite easy targets." | **Accurate for 2023–2026:** ~4,000 CIPA suits and "tens of thousands" of demand letters by mid-2026, per SB 690's sponsor ([Assembly analysis](https://apcp.assembly.ca.gov/system/files/2026-06/sb-690-caballero-apcp-analysis.pdf)). The easiest theory (§638.51 pen register) is being closed by SB 690 and *Variety Media* (§2.3); §§631/632/632.7 and Florida remain. |

**The reframe that matters for the product:** the US has *two* regimes stacked on
the same pixel. Privacy statutes (CCPA + ~20 states) are opt-out with automatic
signals. Wiretap statutes (CIPA, Florida ch. 934, PA WESCA) are all-party-consent
and privately litigated. A site can satisfy the first and still be the ideal
defendant under the second. complykit must report both, labelled differently
(consent-design.md §2.6: *violation* vs *exposure*).

---

## 1. United States — privacy statutes (the opt-out regime)

Primary texts: [CCPA statute eff. 2026-01-01](https://cppa.ca.gov/pdf/20260101_ccpa_statute.pdf) ·
[CCPA regulations eff. 2026-01-01](https://cppa.ca.gov/regulations/pdf/ccpa_statute_eff_20260101.pdf) ·
[2025 redline](https://cppa.ca.gov/regulations/pdf/ccpa_updates_cyber_risk_admt_appr_text.pdf).

### 1.1 CCPA/CPRA

- **Model:** right to opt out of sale/sharing (§1798.120(a)). Opt-in only for consumers
  known to be under 16 — 13–15 consent themselves, under-13 need a parent;
  "willful disregard" of age counts as knowledge (§1798.120(c)). Sensitive PI gets a
  right to *limit* (§1798.121). AB 1542 (ban on selling sensitive PI) was vetoed
  2026-09-27 ([S](https://www.kelleydrye.com/viewpoints/blogs/ad-law-access/californias-2026-legislative-session-wraps-a-wave-of-privacy-and-ai-bills-reaches-the-governor-with-key-child-safety-and-ai-measures-signed-into-law)).
- **Pixels are "sharing."** Sharing = disclosure for cross-context behavioral advertising
  "whether or not for monetary or other valuable consideration"; a vendor providing it
  "is a third party and not a service provider" (§1798.140(ah), (k)). Meta, TikTok,
  Pinterest and Google Ads remarketing are sharing. Vendors without §7051 contract terms
  (often Klaviyo, session replay, chat) are not service providers, and disclosures to
  them "may be" sales (§7050(e)). Sephora: analytics given in exchange for the vendor's
  own benefit was a sale ([complaint ¶¶12–13](https://oag.ca.gov/system/files/attachments/press-docs/Complaint%20%288-23-22%20FINAL%29.pdf)).
- **Required website surface:**
  - notice at collection at or before collection — a conspicuous homepage link
    suffices; without it the business "shall not collect", and the site owner must
    cover third-party ad networks it lets collect (§7012(c)–(d), (g)(3)(A));
  - "Do Not Sell or Share My Personal Information" link in header/footer (§7013(c)),
    or a single "Your Privacy Choices" link with the opt-out icon at roughly the size
    of other header/footer icons (§7015(b));
  - privacy-policy text on how opt-out preference signals are processed (§7011(e)(3)(F));
  - at least two opt-out methods, one of which is the opt-out preference signal
    (§7026(a)(1)). **A cookie banner is "not by itself an acceptable method"**
    (§7026(a)(4)).
- **What "honoring GPC" means (§7025):** applies to the browser/device, every profile
  linked to it (incl. pseudonymous), and the consumer if known, e.g. logged in
  ((c)(1)); no extra information may be demanded ((c)(2)); the signal overrides a
  conflicting site setting — the site may then *ask* for consent through a §7004-clean
  flow ((c)(3)); a signal that later disappears is not consent ((c)(5)). Timing: as soon
  as feasible, ≤15 business days, real-time ad tech immediately, and anyone who received
  data in between must be notified (§7026(f)). "Frictionless" = no fee, no change to the
  experience, no popup or interstitial in response to the signal ((f)); only a
  frictionless business with the policy text may omit the opt-out link ((g)); posting
  the link never excuses ignoring GPC ((e)).
- **Is a Florida business covered?** Yes, if it does business in California and meets
  any one of (§1798.140(d)): revenue > **$26,625,000** ([CPI-adjusted 2025-01-01](https://www.cppa.ca.gov/regulations/cpi_adjustment.html));
  buys/sells/**shares** PI of **≥100,000** California consumers or households (pixels
  sharing browser IDs count — a small store with heavy California traffic can qualify);
  ≥50% of revenue from selling/sharing. The revenue test isn't limited to California
  revenue. The only carve-out is conduct "wholly outside of California"
  (§1798.145(a)(1)(G)).

### 1.2 Regulation changes effective 2026-01-01

(OAL approval 2025-09-22, [notice](https://cppa.ca.gov/regulations/pdf/ccpa_updates_cyber_risk_admt_noa.pdf).)

- **Display the opt-out status.** §7025(c)(6) changed "may" to "must display whether it
  has processed" the signal — the reg's own example is "Opt-Out Request Honored" plus a
  toggle. §7026(g) requires a way to confirm an opt-out was processed. *Testable.*
- **Dark patterns (§7004), new vs 2023:** a more prominent "yes" than "no" is not
  symmetrical ((a)(2)(D)); silence/failure to act is not consent ((a)(3)); closing or
  navigating away from a consent popup is not consent ((a)(3)(D)); false-urgency
  countdowns banned ((a)(3)(E)); methods "must be tested to ensure that they are
  functional" ((a)(5)). Kept: "Accept All" + "More Information/Preferences" alone is not
  symmetrical ((a)(2)(C)).
- **Risk assessments:** selling or sharing PI is a significant-risk activity (§7150(b)(1));
  existing processing needs an assessment by 2027-12-31 (§7155(b)); submission with an
  executive attestation due 2028-04-01 (§7157).
- **Cyber audits** (§§7120–7121): only above the revenue/volume tiers; first due
  2028–2030.
- Nothing later on banners or signals through 2026-09-30. The CPPA (now "CalPrivacy")
  ran a 2026-08-06 session on opt-out signals incl. "the timing and ambiguity of consent
  signals" — data that flows before the opt-out takes effect
  ([materials](https://cppa.ca.gov/meetings/materials/20260806_07_02.pdf)).

### 1.3 AB 566 — California Opt Me Out Act

Signed 2025-10-08; Civ. Code §1798.136, **operative 2027-01-01**. Browsers must ship a
consumer-configurable opt-out preference signal that is "easy for a reasonable person to
locate and configure". Websites: expect a step change in GPC traffic in 2027; tags must
read `Sec-GPC` / `navigator.globalPrivacyControl` before any ad tag fires.

### 1.4 Other state comprehensive laws (all opt-out for targeted ads/sale)

GPC column per the [CPPA's own list, 2026-08-06](https://cppa.ca.gov/meetings/materials/20260806_07_02.pdf);
thresholds per [Enzuzo tracker (S), 2026-09-23](https://www.enzuzo.com/blog/us-state-privacy-laws)
unless linked. Threshold = residents whose data is processed per year; "rev." = gross
revenue from selling personal data.

| State | Effective | Applies if | Must honor GPC | Sensitive |
|---|---|---|---|---|
| VA | 2023-01-01 | 100k, or 25k + >50% rev. | no | opt-in |
| CO | 2023-07-01 | 100k, or 25k + any sale rev. | 2024-07-01 | opt-in |
| CT | 2023-07-01 | from 2026-07-01: 35k, or any sensitive data, or any sale ([S](https://www.morganlewis.com/pubs/2026/07/us-state-consumer-privacy-law-update-notable-changes-across-existing-frameworks)) | 2025-01-01 | opt-in; sale needs consent |
| UT | 2023-12-31 | $25M rev. AND (100k, or 25k + >50%) | no | notice + opt-out |
| TX | 2024-07-01 | not an SBA small business | 2025-01-01 | opt-in |
| OR | 2024-07-01 | 100k, or 25k + ≥25% | 2026-01-01 ([OR DOJ](https://www.doj.state.or.us/media-home/news-media-releases/attorney-general-rayfield-releases-one-year-report-on-oregon-consumer-privacy-act/)) | opt-in |
| MT | 2024-10-01 | 25k, or 15k + >25% (since 2025-10-01) | 2025-01-01 | opt-in |
| IA | 2025-01-01 | 100k, or 25k + >50% | no | notice + opt-out |
| DE | 2025-01-01 | 35k, or 10k + >20%; **from 2027: 10k, or 5k + >20%** ([code](https://delcode.delaware.gov/title6/c012d/index.html)) | 2026-01-01 | opt-in |
| NE | 2025-01-01 | not an SBA small business | yes | opt-in |
| NH | 2025-01-01 | 35k, or 10k + >25% | yes | opt-in |
| NJ | 2025-01-15 | 100k, or 25k + any sale rev. | 2025-07-15 | opt-in; sale banned from 2026-06-30 [S] |
| TN | 2025-07-01 | $25M rev. AND (175k, or 25k + >50%) | no | opt-in |
| MN | 2025-07-31 | 100k, or 25k + >25% | yes | opt-in |
| MD | 2025-10-01 | 35k, or 10k + >20% | yes* | sale banned |
| IN | 2026-01-01 | 100k, or 25k + >50% ([SEA 5](https://iga.in.gov/pdf-documents/123/2023/senate/bills/SB0005/SB0005.05.ENRS.pdf)) | no | opt-in |
| KY | 2026-01-01 | 100k, or 25k + >50% ([Acts ch. 72](https://apps.legislature.ky.gov/law/acts/24RS/documents/0072.pdf)) | no | opt-in |
| RI | 2026-01-01 | 35k, or 10k + >20% ([§6-48.1-4](https://webserver.rilegislature.gov/Statutes/TITLE6/6-48.1/6-48.1-4.htm)) | no | opt-in |
| OK | 2027-01-01 | 100k, or 25k + >50% ([SB 546](https://www.oklegislature.gov/cf_pdf/2025-26%20ENR/SB/SB546%20ENR.PDF)) | no | opt-in |
| LA | 2027-01-01 | >$25M rev., or 75k, or ≥50% from sale (SB 386) [S](https://fpf.org/?p=249908) | 2027-01 | opt-in |
| AL | 2027-05-01 | >25k, or >25%; <500 employees not selling exempt ([HB 351](https://alison.legislature.state.al.us/files/pdf/SearchableInstruments/2026RS/HB351-enr.pdf)) | no† | opt-in |
| VT | 2028-01-01 | 35k, or sensitive data of 3k, or sells data of 3k (S.71) [S](https://www.hunton.com/privacy-and-cybersecurity-law-blog/vermont-becomes-23rd-state-with-comprehensive-consumer-privacy-law) | 2028-01 | opt-in; no sale without consent |

\* Maryland's drafting is ambiguous ([§14-4707](https://mgaleg.maryland.gov/mgawebsite/Laws/StatuteText?article=gcl&section=14-4707&enactments=false)); the CPPA counts it as a GPC state.
† Alabama mentions signals only in a conflict clause. Most states also make ads/sales to
known teens opt-in or banned.

**Product consequence:** because every tracked visitor counts toward thresholds, busy
sites cross 10k–35k-resident thresholds in several states. Treat "honor GPC for all US
traffic" as the default posture, not a California feature — geo-filtering GPC has drawn
public criticism ([Wyden letter, 2026-08-03, S](https://captaincompliance.com/news/senator-wyden-urges-state-privacy-enforcers-to-close-gaps-in-global-privacy-control-compliance/)).

### 1.5 Regulator enforcement — what was wrong and **how it was found**

| Action | What was wrong | How it was detected |
|---|---|---|
| **Sephora** — CA AG, 2022-08-24, $1.2M ([complaint](https://oag.ca.gov/system/files/attachments/press-docs/Complaint%20%288-23-22%20FINAL%29.pdf)) | trackers = undisclosed sale; GPC "completely ignored"; no fix after notice | June 2021 retailer sweep: investigators used "commercially available browser extensions to monitor network traffic", **GPC on vs off** (¶14) |
| **Honda** — CPPA, 2025-03-12, $632,500 ([order](https://cppa.ca.gov/regulations/pdf/20250307_hmc_order.pdf)) | OneTrust with ad cookies allowed by default; opt-out 2 clicks vs 1-click "Allow All"; ID verification for opt-outs | connected-vehicle review |
| **Todd Snyder** — CPPA, 2025-05-06, $345,178 ([CPPA](https://cppa.ca.gov/announcements/2025/20250506.html)) | CMP misconfigured ~40 days — banner vanished, opt-out impossible; photo-ID demand. "Using a consent management platform doesn't get you off the hook." | not disclosed |
| **Healthline** — CA AG, 2025-07-01, $1.55M ([complaint](https://oag.ca.gov/system/files/attachments/press-docs/People%20v.%20Healthline%20Media%20Complaint.pdf)) | opt-outs didn't work; diagnosis-implying titles sent to ad tech; banner "did not disable tracking cookies" | investigators **opted out three ways at once** (GPC + form + banner), then counted what remained: 118 ad cookies, 82 pixels on one page, a cookie-sync pixel, a universal ID in localStorage, article titles in payloads (¶¶2, 14–21) |
| **Tractor Supply** — CPPA, 2025-09-30, $1.35M ([order](https://cppa.ca.gov/pdf/20250930_tractor_supply_bd_sfo.pdf)) | "Do Not Sell" form had no effect on trackers; GPC ignored until 2024-07 | consumer complaint. **Remedy: scan sites quarterly and keep a tracker inventory**; equal-size reject button |
| **Sling TV** — CA AG, 2025-10-30, $530k ([complaint](https://oag.ca.gov/system/files/attachments/press-docs/Complaint%20For%20Injunction%2C%20Civil%20Penalties%2C%20And%20Other%20Equitable%20Relief.pdf)) | "Your Privacy Choices" led only to cookie prefs; real form behind an unlabeled caret; excess fields | Jan 2024 streaming sweep |
| **Disney** — CA AG, 2026-02-11, $2.75M ([release](https://oag.ca.gov/news/press-releases/california-wont-let-it-go-attorney-general-bonta-announces-275-million)) | opt-out stopped only Disney's own ad platform, not embedded third-party ad tech; GPC per-device only | same sweep |
| **PlayOn Sports** — CPPA, 2026-03-03, $1.1M ([CalPrivacy](https://privacy.ca.gov/2026/03/youth-sports-media-company-to-pay-1-1-million-fine-change-practices-over-privacy-violations/)) | Meta Pixel; "Agree"-only banner covering content on mobile; opt-out by phone/email only; no GPC; "no sale" claim; teens | consumer complaint |
| **Ford** — CPPA, 2026-03-05, $375,703 ([CalPrivacy](https://privacy.ca.gov/2026/03/ford-to-change-practices-pay-fine-for-adding-unnecessary-friction-to-opt-out-process/)) | email verification before processing opt-outs; remedy includes tracker audits + GPC | connected-vehicle review |
| **Multistate GPC sweep** — CA AG + CPPA + CO + CT, 2025-09-09 ([CT](https://portal.ct.gov/ag/press-releases/2025-press-releases/connecticut-california-and-colorado-announce-joint-investigative-privacy-sweep)) | businesses that "do not appear to be processing" GPC | automated/manual signal testing |
| **Connecticut** — cure-notice sweeps ([report 2025-04-17](https://portal.ct.gov/-/media/ag/press_releases/2025/updated-enforcement-report-pursuant-to-connecticut-data-privacy-act-conn-gen-stat--42515-et-seq.pdf)); TicketNetwork $85k 2025-07-08 | highlighted "AGREE" next to a "SHOW PURPOSES" link; "By continuing to browse…"; guidance: Reject All shown with Accept, same color/font/size | banner review; 2026 report: AG works with technologists to test signal detection [S] |

Also: DoorDash (2024, $375k — found via a customer's social post); Jam City (2025-11,
$1.4M, apps); GM (2026-05, $12.75M — driving data, not pixels). Oregon: 38 cure notices,
no fines, cure period ended 2026-01-01. Colorado/Texas: no public pixel fines.

**FTC §5** has no size threshold: saying "we don't sell" or "we honor GPC" while pixels
transmit is deception — GoodRx ($1.5M, 2023), BetterHelp ($7.8M, 2023), Hims & Hers
(sued 2026-07-29, pending). Florida's FDUTPA imports the FTC standard
([§501.204](http://www.leg.state.fl.us/statutes/index.cfm?App_mode=Display_Statute&URL=0500-0599/0501/Sections/0501.204.html)).
**Product consequence:** policy-vs-behavior drift (the existing `policy-drift` skill) is
a deception finding in its own right.

---

## 2. United States — wiretap litigation (the consent-pressure regime)

### 2.1 CIPA theories

- **§631(a) wiretapping** — learning the contents of a communication "in transit" or
  "sent from, or received at any place within this state" without all parties' consent.
  Sites are sued for *aiding* the vendor ([Mikulsky, 9th Cir. 2025-06-20](https://cdn.ca9.uscourts.gov/datastore/memoranda/2025/06/20/24-3564.pdf));
  a site can't eavesdrop on itself (*Thomas v. Papa John's*, 9th Cir. 2025-06-18).
  - Vendor as third party: split between *Graham v. Noom* (vendor = site's "tape
    recorder") and *Javier v. Assurance IQ* (N.D. Cal. 2023: *capable* of using the data
    for itself = third party). Unresolved on appeal.
  - **"Contents" — the payload matters, not just the hit.** Record data isn't contents
    (*Yoon v. Lululemon*); descriptive URLs and button clicks can be (*In re Meta Pixel
    Healthcare*); full URLs with article titles were (*Krzyzek v. OpenX*, N.D. Cal.
    2026-01-27); session replay capturing form contents stated a claim (*Mikulsky*).
  - "In transit": defendants win at summary judgment when vendors only processed stored
    data (*Gutierrez v. Converse*, 9th Cir. 2025-07-09, chat; *Torres v. Prudential*).
    Whether §631 reaches the internet at all is now contested (E.D. Cal. magistrate
    2026-08-03: no; *Casillas v. Six Flags* 2025-12: yes) ([S](https://www.troutmanprivacy.com/2026/09/privacy-litigation-report-takeaways-from-august-2026-decisions/)).
- **§632 confidential communications** — online communications presumptively not
  confidential; yet the only tracking jury verdict so far is §632 (*Frasco v. Flo
  Health*, 2025-08-01). **S.D. Cal. 2026-08-12:** a shopper who rejected optional cookies
  made her later searches/product views/cart activity "confidential" — rejection that
  leaks is evidence for the plaintiff ([S](https://www.troutmanprivacy.com/2026/09/privacy-litigation-report-takeaways-from-august-2026-decisions/)).
- **§632.7** — cellular/cordless communications, applies to parties too
  (*Smith v. LoanMe*, Cal. 2021); pleaded for chat and mobile visits; untouched by SB 690.
- **§638.51 pen register / trap-and-trace** — the 2023–2026 volume engine. Federal courts
  mostly let it proceed (*Greenley v. Kochava* 2023; *Shah v. Fandom* 2024: IP =
  addressing info; consent to the site ≠ consent to its trackers). State trial courts
  mostly dismiss. **First appellate signal: *Variety Media v. Superior Court*** (Cal. Ct.
  App. B350578, tentative, late Aug 2026): §638.51 reaches the internet and isn't
  displaced by CCPA, but a visitor's IP identifies the *source*, not the destination —
  IP-only complaints fail; screenshots of domain/Origin/Referer fields were insufficient
  as pleaded ([S](https://www.carpedatumlaw.com/2026/08/california-court-of-appeal-tentatively-holds-that-collecting-a-website-visitors-ip-address-alone-does-not-constitute-pen-register-activity-under-cipa/)). Final opinion expected ~late November.
- **Damages:** greater of $5,000 per violation or 3× actual; no harm required (§637.2).

### 2.2 Consent — what courts accept

- **Prior only.** Retroactive consent via policy doesn't cure (*Javier*, 9th Cir.
  2022-05-31).
- Footer policy link (browsewrap) isn't consent where tracking starts first
  (*Camplisson v. Adidas*, S.D. Cal. 2025-11-18). "By continuing to use the site you
  agree" isn't enough (*Price v. Carnival*, S.D. Cal. 2024 — a Microsoft Clarity case).
  A banner saying cookies give "the best experience" + policy link isn't implied consent
  unless it signals third-party sharing (N.D. Ill. 2026-08-07).
- **Clickwrap works:** banner + account checkbox + checkout defeated CIPA/VPPA/ECPA in
  *Lakes v. Ubisoft* (N.D. Cal. 2025-04-02). No decision found holding a correctly gated
  opt-in banner insufficient.
- **An opt-out banner never provides prior consent; a broken one keeps claims alive**
  (*Apaydin v. Move*, C.D. Cal. 2025-10-29; *De Ayora v. Inspire Brands*, N.D. Cal. 2026 —
  post-opt-out cookies).
- **Google Consent Mode "advanced" — no case law.** Pre-consent cookieless pings carry
  IP, UA, full page URL and referrer — the fields courts treat as destination data or
  contents. Treat as transmission before consent.

### 2.3 SB 690 — status: **pending Governor action (deadline 2026-09-30)**

Passed the Legislature 2026-08-28 (Assembly 66–0, Senate concurrence 39–0), presented
2026-09-04 ([leginfo](https://leginfo.legislature.ca.gov/faces/billHistoryClient.xhtml?bill_id=202520260SB690)).
The 2026-07-01 rewrite dropped the broad "commercial business purpose" exemption. Text:
new §637.2(d) — §638.51 claims "arising from conduct occurring on an internet website,
online application, or mobile application" may be brought only by the Attorney General;
applies to pending claims in actions commenced within two years before the operative
date (2027-01-01, no urgency clause) — i.e. suits filed since ~2025-01-01; final
judgments unaffected; severability clause anticipates challenges
([Assembly analysis](https://apcp.assembly.ca.gov/system/files/2026-06/sb-690-caballero-apcp-analysis.pdf);
[S](https://www.goodwinlaw.com/en/insights/publications/2026/09/alerts-technology-cldr-california-curbs-cipa-pen-register-suits)).
**Leaves §§631, 632, 632.7, CDAFA, common-law claims, and every other state untouched.**
A 2026-09-03 blog headlined "SB 690 is now law" is conditional in its body — do not cite
it. **Re-check leginfo on 2026-10-01**; if the Governor did not act, it becomes law
without signature.

### 2.4 Standing, venue, reach

- **Federal standing:** *Popa v. Microsoft* (9th Cir. 2025-08-26, published) — routine
  session replay on a pet-supply site is no concrete injury; plaintiffs need
  embarrassing/private data. *Cook v. GameStop* (3d Cir. 2025-08-07) same. Survives where
  cross-site profiles are alleged (*Harris v. iHeartMedia* 2026-01-29; *Krzyzek*).
  State courts have no Article III gate — hence LA Superior Court and Florida small claims.
- **Who can be sued in California:** *Briskin v. Shopify* (9th Cir. en banc 2025-04-21) —
  knowingly tracking devices located in California is express aiming; out-of-state
  merchants can be haled into California. A Florida brand selling nationally should assume
  jurisdiction. On remand, CIPA §631/CDAFA claims against Shopify's checkout survived
  (2026-07-30) ([S](https://www.shopifreaks.com/shopify-loses-a-second-bid-to-dismiss-a-california-class-action-alleging-its-checkout-software-quietly-harvests-shopper-data/)).
- CIPA covers communications sent from or received in California; visitors elsewhere are
  covered by their own states (below).

### 2.5 Other states

| Statute | Status |
|---|---|
| **Florida FSCA** (§934.10: greater of $1,000 or $100/day + punitive + fees; 2-year SOL from discovery) | 2021 session-replay wave failed (*Jacome v. Spirit*; *Goldstein v. Costco*). Revived after *W.W. v. Orlando Health* (M.D. Fla. 2025-03-06); **hundreds of small-claims chat suits** under the $8,000 limit with pretrial within 1–2 weeks of service ([S](https://www.fisherphillips.com/print/v2/content/44684/is-florida-the-new-hotbed-for-digital-wiretapping-lawsuits.pdf)); *Magenheim v. Nike* (S.D. Fla., filed 2025-12-16: no banner, ignored GPC, sharing after opt-out, identity resolution). **High and rising.** |
| **Pennsylvania WESCA** | Interception occurs at the user's browser (*Popa v. Harriet Carter*, 3d Cir. 2022); federal standing now defeats non-sensitive cases (*Cook*). Moderate–low. |
| **Massachusetts** | Closed by *Vita v. New England Baptist* (SJC 2024-10-24); bill S.1266 pending. |
| **Washington** | Privacy Act pixel case at the state supreme court (review granted 2026-01-08). Email-subject CEMA suits curbed by HB 2274 (eff. 2026-06-11) — relevant to Klaviyo senders. |
| **Arizona** email "spy pixels" | Dead: *Smith v. Target* (Ct. App. 2025-11-13). |
| **Illinois** | BIPA only if a client uses face scanning (virtual try-on). |

### 2.6 VPPA (pixel + video)

Circuit split on who is a "consumer"; **SCOTUS granted cert in *Salazar v. Paramount*
(No. 25-459, 2026-01-26), argument 2026-10-14** ([SCOTUSblog](https://www.scotusblog.com/cases/case-files/salazar-v-paramount-global/)).
For retailers with incidental product-demo videos: **low risk** — a company whose videos
are incidental isn't a "video tape service provider" (*Carroll v. General Mills*, C.D.
Cal. 2023; *Cantu v. Tapestry*, S.D. Cal. 2023). Rises only if a client sells or streams
video (courses, memberships, DVDs).

### 2.7 How the plaintiffs' bar operates

- **Volume:** ~600 suits early 2025 → ~4,000 eighteen months later + tens of thousands of
  letters (sponsor, Assembly analysis); 100+ class actions on the TikTok pixel in 2024
  ([S](https://www.proskauer.com/blog/now-trending-the-tiktok-dox)); many filings trace to
  four firms using repeat plaintiffs.
- **Who:** Pacific Trial Attorneys (Scott Ferrell) and Swigart Law Group send demands and
  mass-arbitration demands; a pro se serial filer (Vivek Shah) was declared vexatious in
  C.D. Cal. only (2026-07-20) after thousands of letters.
- **Targeting:** geographic clusters of businesses get letters together (one firm hit ~40
  Sacramento plumbing/HVAC companies); Florida testers file small-claims chat suits.
  Scanning is productized: webXray (formerly an open-source research crawler) now sells a
  "California Privacy Audit" — i.e. plaintiffs scan *as Californians*.
- **Evidence they attach:** HAR files and network logs; Meta Pixel Helper screenshots;
  Facebook "Off-Facebook activity" exports; screenshots of domain/Origin/Referer fields.
  Priced at $5,000 per tracker or recipient; one sample opening demand $50k
  ([vendor](https://captaincompliance.com/education/what-a-swigart-lawsuit-cipa-claim-reads-like/)).
- **Money:** demands $20k–$5B; small businesses settle "for a couple thousand dollars";
  *Mirmalek v. LA Times* class settlement $3.85M (2026-06-26). Class cert is being denied
  where consent/browser settings vary person to person (*Ingraham v. Capital One*, 2026-07)
  — a working opt-in banner helps defeat certification.

---

## 3. EU & UK

### 3.1 EU baseline — ePrivacy Art 5(3) + GDPR consent

- **Rule:** storing or reading anything on the device needs *prior* consent, except
  storage solely for transmission or strictly necessary for a service the user
  explicitly requested ([ePD 5(3)](https://eur-lex.europa.eu/eli/dir/2002/58/oj)†). Applies
  whether or not the data is personal; pre-ticked boxes invalid; disclose duration and
  third parties (*Planet49* C-673/17†). Consent to the GDPR standard (Art 4(11), 7†).
  **complykit today cites GDPR Art 7(4) for pre-consent cookies — wrong hook; the
  operative rule is ePrivacy 5(3) as nationally implemented** (consent-design.md §8).
- **Scope ([EDPB Guidelines 2/2023 v2](https://www.edpb.europa.eu/system/files/documents/2024-10/edpb_guidelines_202302_technical_scope_art_53_eprivacydirective_v2_en_0.pdf)):**
  pixels and tracking links = storage; collecting their identifiers = access; for
  JS-built pixels the script is the instruction (¶¶50–51); browser-computed data sent
  back (¶53); IP-only tracking unless the IP demonstrably isn't from the device (¶55);
  **client-side hashed email/phone** — Meta Advanced Matching, Google enhanced
  conversions, Klaviyo identify (¶¶61–63).
- **"Strictly necessary" is judged from the user's side;** mislabelling is itself a
  violation; owners must document necessity ([EDPB CBTF report 2023-01-18](https://www.edpb.europa.eu/system/files/documents/2023-01/edpb_20230118_report_cookie_banner_taskforce_en.pdf) ¶¶26–29).
  German DPAs: chat, maps, video count as "requested" only once used (DSK ¶76).
- **Legitimate interest can never justify trackers** (CBTF ¶24).
- **Analytics exemptions only in some states:** FR (CNIL: own measurement only, anonymous
  stats, no cross-site, IP last byte truncated, ≤13-month trackers / ≤25-month data,
  objection possible — "most large audience measurement offerings" don't qualify); IT
  (Garante: 4th octet masked, single site, no combining); NL ("no or minor" impact);
  **DE, ES: none**.
- **Reject as easy as accept:** reject on the same layer; not a buried link; readable
  contrast (CBTF ¶¶8, 14, 18); CNIL one-click reject if one-click accept; AEPD same layer
  same level; DSK second-layer-only reject = not freely given; Austrian court (2026-05-21,
  [S]) required equally prominent "Accept all" and "Only necessary".
- **Silence isn't consent;** closing = refusal only if the banner says so (CNIL); "X"
  keeps defaults (Garante); cookie walls generally invalid.
- **Withdrawal:** persistent icon/link (CBTF ¶¶31–35); afterwards nothing may be read or
  written — expire cookies server-side or delete non-HttpOnly client-side (CNIL
  session-replay draft ¶36).
- **Proof & timing:** consent records (CNIL suggests timestamped hashes of CMP code,
  screenshots, config logs); remember refusal ~6 months (CNIL/Garante); consent ≤24
  months (AEPD).

### 3.2 Territorial scope

GDPR Art 3(2)(a) targeting: reachability alone isn't enough; EU language, currency,
delivery or domains are. **Art 3(2)(b) monitoring needs no intent** — behavioral ads and
"online tracking through the use of cookies" are the EDPB's examples ([3/2018 v2.1](https://www.edpb.europa.eu/sites/default/files/files/file1/edpb_guidelines_3_2018_territorial_scope_after_public_consultation_en_1.pdf)).
A US store that ships to the EU and fires pixels on EU visitors is caught on both
grounds (and owes an Art 27 representative). ePrivacy is enforced nationally with no
one-stop-shop — CNIL fined US-incorporated Google LLC directly. UK: PECR has "no specific
rules" for foreign firms, but UK GDPR applies to offering/monitoring and the ICO's own
example treats behavioral-ad cookies as monitoring. A UK-established company is fully in
scope. Practical risk for small US brands: regulator sweeps target large national
sites; complaints have no size threshold; Google's EU User Consent Policy requires
consent regardless.

### 3.3 UK after the Data (Use and Access) Act 2025

- **Commenced 2026-02-05** ([S.I. 2026/82](https://www.legislation.gov.uk/uksi/2026/82/made), reg 11) — conduct before
  then falls under the old regime.
- **New reg 6** ([text](https://www.legislation.gov.uk/uksi/2003/2426/regulation/6)) covers
  anyone who "instigat[es]" storage/access (the site owner answers for third-party tags)
  and information the device "automatically emit[s]".
- **Schedule A1 exceptions** ([text](https://www.legislation.gov.uk/uksi/2003/2426/schedule/A1)):
  transmission; strictly necessary (incl. security, fraud prevention, fault detection,
  authentication, remembering choices); **statistical purposes** — sole purpose improving
  the service, shared only with helpers, clear information, "simple means of objecting,
  free of charge", not objected, passively emitted data excluded; **appearance/
  functionality** on the same terms; emergency assistance.
- **Fines:** reg 6 breach now carries the higher maximum, £17.5M or 4%
  ([PECR Sch 1 para 18](https://www.legislation.gov.uk/uksi/2003/2426/schedule/1)).
- **ICO final guidance 2026-04-29** ([consent](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies/how-do-we-manage-consent-in-practice/);
  [exceptions](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies/what-are-the-exceptions/)):
  accept-all and reject-all equally prominent; non-exempt toggles off; inaction ≠ consent;
  name third parties; no "legitimate interest" options; withdrawal = stop, tell third
  parties, treat as erasure; ~6 months before re-asking; **advertising never exempt**
  (incl. frequency capping, ad measurement, click-fraud); statistical exception needs the
  analytics provider as *processor*, excludes session recording and conversions shared
  with ad partners; external fonts can fit the appearance exception if disclosed; embeds
  set nothing on load (informed user starting an embed/chatbot can be strictly necessary).
- **ICO campaign** — three checks: ad cookies before choice; reject as easy as accept;
  ad cookies without consent. 979 of the top 1,000 sites passed by 2025-12-04 (564 only
  after ICO contact; 17 preliminary enforcement notices); 992 by 2026-04-29. Method:
  "cookie tool compliance assessment at scale" — automated ([ICO](https://ico.org.uk/about-the-ico/media-centre/news-and-blogs/2025/12/ico-action-secures-increased-cookie-compliance/)). No cookie fine yet.
- Pending: reg 6A power to exempt low-risk advertising — ICO advice 2026-05-18, nothing
  made.

### 3.4 EU enforcement and how regulators find violations

- **CNIL** (21 cookie sanctions in 2025): **Shein €150M** (2025-09-01 — ad cookies on
  arrival; banner omitted ad purposes/third parties; cookies set and read after "Refuse
  all"; withdrawal broken — found by an Aug 2023 *online inspection*,
  [CNIL](https://www.cnil.fr/en/cookies-placed-without-consent-shein-fined-150-million-euros-cnil));
  **Google €325M** (2025-09-01); **Condé Nast €750k** (2025-11-20 — cookies on arrival,
  falsely "strictly necessary", set/read after refusal); **American Express €1.5M**
  (2025-11-27 — on arrival, after refusal, read after withdrawal); an unnamed distance
  seller €500k; 23 simplified sanctions Jan–Jul 2026. Method: online checks since 2021.
- **Dutch AP:** in-house tool monitoring **10,000 sites** since 2025-04; 50 warnings
  (webshops among them) then 200+ by 2025-11; ~¾ fixed; holdouts investigated.
- **EDPB Website Auditing Tool** (2024-01-29): records cookies, local storage, network
  requests and screenshots per test scenario ([EDPB](https://www.edpb.europa.eu/documents/514_en)) —
  **the evidence model complykit should mirror.**
- **noyb:** automated scanning → 422 complaints (2021) + 226 (2022); EDPB Binding Decision
  1/2026 (2026-07-14) ordered the Belgian DPA to decide one on the merits.
- **Germany, private enforcement:** Google Fonts €100 award (LG München I 2022†) spawned
  mass letters; loss of control over data is damage (BGH VI ZR 10/24); ~2,500
  first-instance judgments against **Meta** over Business Tools (pixel/SDK), appellate
  awards €1,200–€3,000 (OLG Dresden, Naumburg, Jena 2026; BGH appeal allowed). Only Meta
  sued so far — but embedding sites are joint controllers for collection/transmission
  (*Fashion ID* C-40/17†).

### 3.5 Google Consent Mode v2, EUCP, TCF

- **Basic mode:** no Google data until interaction. **Advanced:** tags load immediately and
  send cookieless pings (timestamp, UA, referrer, consent state, random number, ad-click
  flag) ([Google](https://developers.google.com/tag-platform/security/concepts/consent-mode)) —
  script-instructed transmissions carrying the IP, within 5(3) (EDPB 2/2023 ¶¶51, 55). No
  DPA endorses advanced mode. UK: ad measurement never exempt.
- **EUCP** (EEA/UK/CH): consent where law requires and for ad personalisation; Google Ads
  requires `ad_user_data` + `ad_personalization` signals for EEA users.
- **TCF v2.3:** Disclosed Vendors mandatory since 2026-02-28 [S]; shops rarely need TCF.

### 3.6 Legislative outlook

Digital Omnibus COM(2025) 837 (2025-11-19): proposed Art 88a (exemptions incl. own
aggregated measurement; one-click refusal; 6-month no-re-ask) and 88b (honor browser
signals after 24 months). Council compromise (2026-05-21) keeps cookie rules in an amended
ePrivacy Directive; the browser-signal rule reportedly dropped (2026-06-18, [S]);
Parliament draft 2026-06-22 with 1,750+ amendments; no trilogue yet. **Nothing applies
before late 2027 at the earliest** — design for current law.

### 3.7 Session replay, chat, embeds, fonts

Session replay needs consent; mask fields and strip values before sending (CNIL draft);
UK: excluded from the statistical exception. Chat: DE — load only on launcher click; UK —
informed engagement can be strictly necessary, vendor analytics still need consent.
Video: YouTube privacy-enhanced mode only limits personalisation; Vimeo `dnt=1` blocks
session data/analytics; German practice is a two-click facade. Maps/reCAPTCHA: DE — only
on interaction; CNIL fined partly over reCAPTCHA (2023). Fonts: EU — self-host; UK —
appearance exception possible if disclosed.

---

## 4. How violations get found — the methods complykit must replicate

| Finder | Method | complykit equivalent |
|---|---|---|
| CA AG (Sephora) | browser extension watching network traffic, GPC on vs off | do-not-sell signal scenario diff (consent-design.md §2.3) |
| CA AG (Healthline) | opt out three ways at once, count remaining cookies/pixels/localStorage IDs, inspect payloads for page titles | "belt-and-braces opt-out" scenario + payload content classification |
| Sweeps (GPC multistate 2025; streaming 2024; vehicles) | signal testing across a sector | scheduled monitoring across a client portfolio |
| Consumer complaints (Tractor Supply, PlayOn) | "the opt-out didn't work" | withdrawal + opt-out flow walk |
| Connecticut | banner design review | banner symmetry rules (existing `consent.click-asymmetry`, extended) |
| CNIL / Dutch AP / ICO | automated online inspections at scale: on arrival, after refusal, after withdrawal | the EU/UK scenario matrix from an EU/UK exit |
| EDPB Website Auditing Tool | cookies + storage + requests + screenshots per scenario | evidence export per scenario (consent-design.md §3) |
| noyb | automated scans → templated complaints | same, reversed: find it first |
| Plaintiffs | fresh browser, **California IP**, DevTools/HAR, Pixel Helper screenshots, Origin/Referer screenshots, typed-form capture | "plaintiff lens" report view + HAR export |
| Remedies | Tractor Supply: **quarterly scans + tracker inventory**; Ford: tracker audits | `complykit` scheduled runs + inventory report — the regulator is ordering the product |

## 5. Risk ranking of tracker types (US litigation + EU/UK regulator view)

1. Session replay (Clarity, Hotjar, FullStory) — especially on forms/checkout, unmasked.
2. Third-party chat with no pre-chat disclosure, loaded before consent.
3. Identity-resolution / identity-graph scripts (de-anonymizing visitors to emails).
4. Meta and TikTok pixels — worst with advanced matching (hashed PII) or firing on
   search/checkout with content in the payload.
5. Other ad pixels (Pinterest, Snap, LinkedIn, Bing/UET) and Google Ads/GA4 in Consent
   Mode advanced.
6. Klaviyo onsite tracking and email open/click pixels.
7. Embedded video/maps/fonts/reCAPTCHA (EU/UK concern; low US litigation risk unless the
   client sells video).
8. Essential services (payments, fraud prevention, CDN) — usually exempt; fingerprinting
   fraud tools belong on login/checkout, not every page.

## 6. Retroactivity and limitation periods

| Regime | Lookback | Cure |
|---|---|---|
| CCPA — CPPA administrative | 5 years (§1798.199.70) | discretionary (§1798.199.45(a)); none for AG (§1798.199.90) |
| CCPA — AG civil | no express limit; tolling agreements used | none since 2023-01-01 |
| CIPA private | 1 year from the visit; delayed discovery usually rejected | — |
| Florida ch. 934 | 2 years from discovery | — |
| FDBR (AG only) | — | 45 days at AG discretion |
| DE / OR | — | cure periods ended 2025-12-31 / 2026-01-01 |
| OK / AL | — | 30 / 45-day cure rights, no sunset |
| UK PECR reg 6 | new fine levels only for conduct from 2026-02-05 | — |

Fixing doesn't end exposure: data collected while no opt-out notice was posted can't be
sold/shared without consent (§7013(h)); recipients of post-opt-out data must be notified
(§7026(f)(2)); fines stack per violation/consumer ($2,663; $7,988 intentional or
under-16s, 2025 amounts).

## 7. Volatile — recheck before relying

- **SB 690** Governor action (deadline 2026-09-30); retroactivity challenge; *Variety
  Media* final opinion (~late Nov 2026); *Drummer v. CoStar* 9th Cir. standing appeal.
- Whether §631 applies to internet communications at all; capability-vs-extension split;
  the single-ruling §632 "rejection makes it confidential" theory.
- *Salazar v. Paramount* (argued 2026-10-14); Washington Supreme Court pixel case; MA
  S.1266; Florida has no appellate pixel ruling (*Magenheim v. Nike* pending).
- CCPA CPI adjustment due 2027-01; AB 566 browser implementations + possible CPPA regs;
  federal SECURE Data Act (released 2026-04-22) could preempt state laws.
- NJ regulations adoption unconfirmed; MD/LA/AL GPC drafting unclear; LA/VT texts from
  secondary summaries.
- UK reg 6A advertising exceptions; GA4 as "processor" under the UK statistical exception.
- Digital Omnibus cookie text; CNIL session-replay recommendation (final pending); BGH on
  Meta Business Tools.
- Google Consent Mode advanced — untested in court and by DPAs; treating it as a pre-consent transmission
  in the EU is an inference from EDPB 2/2023.

## 8. Decisions that belong to counsel/the client, not to complykit

complykit reports facts and requirement mappings; it never emits "compliant". These are
policy choices a report should *surface* for a human:

1. Treat California (and all-party-consent states: FL, PA, WA…) as **opt-in for
   wiretap-risk categories** (session replay, chat, content-bearing ad pixels) even though
   the privacy statutes are opt-out? (Litigation posture, not statutory duty.)
2. Honor GPC nationally, or only in the 12+ states that require it? (Recommended:
   nationally — §1.4.)
3. Google Consent Mode basic vs advanced per region.
4. Whether RDP/LDU "restricted" vendor modes satisfy CCPA opt-out for a given vendor
   contract, or the tag must not fire at all.
5. Which vendors have §7051 service-provider terms (determines "sale/share" vs service
   provider).
