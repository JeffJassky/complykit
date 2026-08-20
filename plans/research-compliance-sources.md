# Research: Compliance reference registry — authoritative sources for web-app audit skills

Verified August 10, 2026. Companion docs: `research-existing-tools.md`,
`research-distribution.md`.

**Verification legend:** ✓ = URL fetched directly and content confirmed · ◇ = canonical
URL confirmed via official-site search listings/citations, but the site blocks
automated fetch (eur-lex.europa.eu, ecfr.gov, federalregister.gov, ico.org.uk, ftc.gov
all bot-block) · **UNVERIFIED** = could not confirm. Blogs/law-firm explainers are
excluded except where explicitly marked **secondary**.

---

## 1. Accessibility (ADA / global) — skill: `ada`

### Normative technical standards

| Document | URL | What it mandates | Dates | Ver. |
|---|---|---|---|---|
| WCAG 2.1 (W3C Recommendation) | https://www.w3.org/TR/WCAG21/ | Normative success criteria (A/AA/AAA) for perceivable, operable, understandable, robust web content. This is the version legally incorporated by the DOJ Title II rule and EN 301 549. | Rec. since 5 Jun 2018; latest edition 6 May 2025 | ✓ |
| WCAG 2.2 (W3C Recommendation) | https://www.w3.org/TR/WCAG22/ | Current W3C recommendation; adds 9 criteria (focus appearance, target size, accessible authentication, etc.). Backward-compatible superset — auditing to 2.2 AA satisfies 2.1 AA except removed 4.1.1 Parsing. | Rec. 5 Oct 2023; latest edition 12 Dec 2024 | ✓ |
| How to Meet WCAG (Quick Reference) | https://www.w3.org/WAI/WCAG22/quickref/ | Filterable listing of every success criterion (2.0/2.1/2.2) with sufficient/advisory techniques and failures — the per-criterion checklist an audit skill should key off. | Living document | ✓ |
| Understanding WCAG 2.2 | https://www.w3.org/WAI/WCAG22/Understanding/ | Non-normative but W3C-authored intent, definitions, and examples for each criterion; use to justify findings. | Living document | ✓ |
| ARIA Authoring Practices Guide (APG) | https://www.w3.org/WAI/ARIA/apg/ | W3C-authored patterns for accessible widgets (correct roles/states/properties, keyboard interaction) — the authority for "is this custom component built right." | Living document | ✓ |

### United States

| Document | URL | What it mandates | Dates | Ver. |
|---|---|---|---|---|
| DOJ ADA Title II Web & Mobile App Rule (final rule, 89 FR 31320) | https://www.federalregister.gov/documents/2024/04/24/2024-07758/nondiscrimination-on-the-basis-of-disability-accessibility-of-web-information-and-services-of-state · codified at 28 CFR Part 35, Subpart H: https://www.ecfr.gov/current/title-28/chapter-I/part-35 | State/local government web content and mobile apps must conform to **WCAG 2.1 Level AA**. Limited exceptions (archived content, certain third-party content, individualized password-protected docs). | Published 24 Apr 2024 | ◇ |
| DOJ Interim Final Rule — compliance-date extension (91 FR 20902) | https://www.federalregister.gov/documents/2026/04/20/2026-07663/extension-of-compliance-dates-for-nondiscrimination-on-the-basis-of-disability-accessibility-of-web | **Extends Title II compliance deadlines by one year**: entities serving pop. ≥ 50,000 → **26 Apr 2027** (was 24 Apr 2026); pop. < 50,000 and special districts → **26 Apr 2028** (was 26 Apr 2027). | IFR effective 20 Apr 2026 | ◇ |
| ADA.gov fact sheet on the Title II web rule | https://www.ada.gov/resources/2024-03-08-web-rule/ | DOJ's plain-language summary of the rule's scope, standard, and exceptions. | Mar 2024 | ◇ |
| DOJ Guidance on Web Accessibility and the ADA (Title III status) | https://www.ada.gov/resources/web-guidance/ | For private businesses open to the public (Title III), DOJ's position: websites must be accessible, but **no technical standard has been codified** — businesses have "flexibility"; WCAG cited as a reference point. Litigation in practice applies WCAG 2.1/2.2 AA as the de facto measure. | Published 18 Mar 2022; still the operative Title III guidance (no Title III rulemaking as of Aug 2026) | ✓ |
| Section 508 ICT Accessibility Standards (36 CFR Part 1194, Access Board) | https://www.access-board.gov/ict/ | Federal agencies' ICT (incl. public-facing web content) must conform to **WCAG 2.0 Level AA** (incorporated by reference at §702.10.1, applied via E205.4, E207.2, 602.3). | 2017 refresh; compliance since 18 Jan 2018 | ✓ |
| Section508.gov (GSA implementation portal) | https://www.section508.gov/ | Government-run testing guidance (ICT Testing Baseline, Trusted Tester) for meeting the 508 standards. | Living site | ◇ |

### EU

| Document | URL | What it mandates | Dates | Ver. |
|---|---|---|---|---|
| EN 301 549 v3.2.1 — Accessibility requirements for ICT | https://www.etsi.org/deliver/etsi_en/301500_301599/301549/03.02.01_60/en_301549v030201p.pdf | Harmonised European standard; clauses 9–11 incorporate **WCAG 2.1 AA** for web/documents/software, plus ICT-specific requirements WCAG lacks. Presumption of conformity for the Web Accessibility Directive (2016/2102) and the operative benchmark for EAA conformity. | Published Mar 2021; still the in-force harmonised version. A WCAG 2.2-based revision ("v4") is in late ETSI/CEN/CENELEC drafting, expected to publish 2026 — **not yet citable (UNVERIFIED as to number/date)** | ◇ |
| European Accessibility Act — Directive (EU) 2019/882 | https://eur-lex.europa.eu/eli/dir/2019/882/oj | Accessibility obligations on **private-sector** products/services: e-commerce, consumer banking, e-books/e-readers, electronic communications, transport ticketing/AV media interfaces, OS/hardware. Microenterprises (<10 staff, ≤€2M) exempt for services. Any company selling into the EU is covered regardless of establishment. | In force 27 Jun 2019; **applies to new products/services since 28 Jun 2025**; legacy service-contract transition until 28 Jun 2030 | ◇ |

### Machine-testable rule sets

| Document | URL | What it mandates | Dates | Ver. |
|---|---|---|---|---|
| W3C ACT Rules | https://www.w3.org/WAI/standards-guidelines/act/rules/ | W3C-approved atomic/composite conformance-testing rules mapped to WCAG 2.2 criteria and ARIA, with pass/fail examples — the canonical bridge from success criteria to automatable checks. | Living; rules individually versioned | ✓ |
| axe-core rule descriptions (Deque) | https://github.com/dequelabs/axe-core/blob/develop/doc/rule-descriptions.md · human-readable: https://dequeuniversity.com/rules/axe/ | Full catalog of axe-core automated rules with WCAG mapping, impact levels, and ACT-rule cross-references. **Secondary to WCAG/ACT** (vendor rule set), but the de facto engine most audit tooling runs. | Living, tracks axe-core releases | ✓ |

---

## 2. GDPR / privacy (EU + notable others) — skill: `gdpr`

### Primary law

| Document | URL | What it mandates | Dates | Ver. |
|---|---|---|---|---|
| GDPR — Regulation (EU) 2016/679, consolidated text | https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A02016R0679-20160504 (also https://eur-lex.europa.eu/eli/reg/2016/679/oj) | The full regulation. Key articles for a code/site audit: **5** (principles), **6** (lawful basis), **7** (conditions for consent), **12–22** (transparency + data-subject rights: access, rectification, erasure, portability, objection, automated decisions), **25** (data protection by design/default), **28** (processor contracts), **30** (records of processing), **32–34** (security, breach notification), **35** (DPIA), **44–49** (international transfers). | Applies since 25 May 2018 | ◇ |
| ePrivacy Directive 2002/58/EC (as amended 2009), consolidated | https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A02002L0058-20091219 | **Art. 5(3)** is the EU cookie rule: storing or accessing information on a user's device requires prior informed consent unless strictly necessary for a service the user requested. Applies alongside GDPR consent standards. | Amended version since 19 Dec 2009; still in force (ePrivacy Regulation proposal withdrawn Feb 2025) | ◇ |

### EDPB / WP29 interpretive guidance

| Document | URL | What it mandates | Dates | Ver. |
|---|---|---|---|---|
| EDPB Guidelines 05/2020 on consent | https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-052020-consent-under-regulation-2016679_en | Valid-consent tests: freely given, specific, informed, unambiguous; **cookie walls generally invalid; scrolling ≠ consent**; withdrawal must be as easy as giving. | Adopted 4 May 2020 (v1.1) | ✓ |
| EDPB Guidelines 03/2022 on deceptive design patterns | https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-032022-deceptive-design-patterns-social-media_en | Taxonomy of dark patterns (overloading, skipping, stirring, obstructing, fickle, left-in-the-dark) that violate GDPR Arts. 5, 12, 25 — the authority for consent-banner/dark-pattern findings. | v2.0 adopted 24 Feb 2023 | ✓ |
| EDPB Guidelines 2/2023 on the technical scope of Art. 5(3) ePrivacy | https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-22023-technical-scope-art-53-eprivacy-directive_en | Confirms Art. 5(3) consent covers **not just cookies**: pixels/tracking URLs, localStorage, fingerprinting, IoT reporting, IP-based tracking techniques. | v2.0 adopted 16 Oct 2024 | ✓ |
| EDPB Cookie Banner Taskforce report | https://www.edpb.europa.eu/our-work-tools/our-documents/other-guidance/report-work-undertaken-cookie-banner-taskforce_en | Cross-regulator consensus on banner design: no pre-ticked boxes; rejecting must not be materially harder than accepting; deceptive contrast/link-in-paragraph designs flagged. | Adopted 17 Jan 2023 | ◇ |
| EDPB Guidelines 4/2019 on Article 25 (data protection by design & default) | https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-42019-article-25-data-protection-design-and_en | How Art. 25 applies to defaults, minimization, and design-time choices — relevant to code-level audit findings. | v2.0 adopted 20 Oct 2020 | ◇ (fetch timed out; URL pattern matches verified EDPB pages) |
| WP29 Guidelines on DPIA (WP248 rev.01, EDPB-endorsed) | https://ec.europa.eu/newsroom/article29/items/611236 | When processing is "likely high risk" triggering a mandatory Art. 35 DPIA (nine criteria incl. systematic monitoring, large-scale sensitive data, innovative tech). | 13 Oct 2017; endorsed by EDPB 25 May 2018 | ✓ |
| EDPB Recommendations 01/2020 on supplementary transfer measures | https://www.edpb.europa.eu/our-work-tools/our-documents/recommendations/recommendations-012020-measures-supplement-transfer_en | Post-*Schrems II* methodology for Arts. 44–49 transfers: assess third-country law, add technical/contractual measures beyond SCCs. | v2.0 adopted 18 Jun 2021 | ✓ |

### National regulators

| Document | URL | What it mandates | Dates | Ver. |
|---|---|---|---|---|
| CNIL guidelines + recommendation on cookies and other trackers | https://www.cnil.fr/en/cookies-and-other-tracking-devices-cnil-publishes-new-guidelines | France's operative cookie rules: refuse must be as easy as accept (reject-on-first-layer enforced), consent proof retained, scroll/continue ≠ consent. Basis of CNIL's large ad-tech fines. | Guidelines + recommendation adopted 17 Sep / published 1 Oct 2020; enforced since Apr 2021 | ◇ (English news page verified in site listings; earlier `/en/cookies-and-other-trackers` path now 404s — do not use that path) |
| ICO Guidance on the use of storage and access technologies | https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies/ | UK PECR/UK-GDPR application to cookies, pixels, fingerprinting; reflects the Data (Use and Access) Act 2025 changes (new limited consent exemptions, e.g. certain analytics). | **Final version published 29 Apr 2026** (replaced Dec 2024 draft) | ◇ (403 to fetcher; URL + date confirmed via ICO's own news listing) |

### US state privacy (secondary scope, one level deep)

| Document | URL | What it mandates | Dates | Ver. |
|---|---|---|---|---|
| CCPA/CPRA statutory text — Cal. Civ. Code § 1798.100 et seq. (Title 1.81.5) | https://leginfo.legislature.ca.gov/faces/codes_displayText.xhtml?division=3.&part=4.&lawCode=CIV&title=1.81.5 | Notice, access, deletion, correction, opt-out of sale/sharing, sensitive-data limits, non-discrimination for CA residents. | CCPA 2020; CPRA amendments since 1 Jan 2023 | ✓ |
| CPPA regulations (incl. 2025 ADMT/risk-assessment/cyber-audit package) | https://cppa.ca.gov/regulations/ | Implementing regs: notices, opt-out preference signals (GPC), dark-pattern prohibition on consent flows; Sept 2025 package adds automated-decisionmaking, risk assessments, cybersecurity audits — **effective 1 Jan 2026**. | Mar 2023; updates effective 1 Jan 2026 | ✓ |
| Other state laws (list only — cite from each legislature if a skill needs them) | — | Virginia CDPA, Colorado CPA, Connecticut CTDPA, Utah UCPA, Texas TDPSA, Oregon OCPA, Montana MCDPA, Delaware, Iowa, Nebraska, New Hampshire, New Jersey, Tennessee, Minnesota, Maryland MODPA (notably strict data-minimization, eff. Oct 2025). | Various 2023–2026 | — |

---

## 3. Privacy-policy & ToS content requirements — skill: `policy-drift`

### What GDPR Arts. 13/14 require a privacy notice to disclose (itemized)

Source: GDPR consolidated text above (◇), Arts. 13–14; authoritative interpretation:
**WP29 Transparency Guidelines WP260 rev.01 (EDPB-endorsed)** —
https://ec.europa.eu/newsroom/article29/items/622227 (◇), adopted 11 Apr 2018.

A compliant notice must state, in clear and plain language:

1. Controller identity + contact details (and EU representative, if any)
2. DPO contact details (where one exists)
3. Purposes of processing **and the legal basis for each** (Art. 6)
4. The "legitimate interests" pursued, where Art. 6(1)(f) is the basis
5. Recipients or categories of recipients
6. International transfers + safeguard mechanism and how to obtain a copy
7. Retention period, or the criteria used to determine it
8. Each data-subject right: access, rectification, erasure, restriction, portability, objection
9. Right to withdraw consent at any time (where consent-based)
10. Right to lodge a complaint with a supervisory authority
11. Whether provision is statutory/contractual and consequences of not providing data
12. Existence of automated decision-making incl. profiling (Art. 22) + meaningful information about the logic and consequences
13. *(Art. 14 — data not collected from the subject)* additionally: categories of data and **the source**, incl. whether publicly accessible

### Statutes and guidance

| Document | URL | What it mandates | Dates | Ver. |
|---|---|---|---|---|
| CCPA notice requirements — Civ. Code § 1798.130 + CPPA regs §§ 7010–7012 | Statute: URL above (✓) · Regs: https://cppa.ca.gov/regulations/ (✓) | Privacy policy must list categories collected/sold/shared/disclosed (12-month lookback), purposes, retention criteria, consumer rights and how to exercise them, two contact methods, "Do Not Sell or Share" link, GPC honoring, last-updated date. | Regs updated eff. 1 Jan 2026 | ✓ |
| COPPA Rule — 16 CFR Part 312 | https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-312 · 2025 amendments: https://www.federalregister.gov/documents/2025/04/22/2025-05904/childrens-online-privacy-protection-rule | For child-directed services (<13): online notice content (§ 312.4(d)), direct notice to parents, verifiable parental consent — 2025 amendments add **separate consent for third-party disclosure/AI-training uses**, biometric identifiers as personal info, written security program and retention policy. | Amendments effective 23 Jun 2025; full compliance by 22 Apr 2026 | ◇ |
| Unfair Contract Terms Directive 93/13/EEC (consolidated) | https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A01993L0013-20220528 | Consumer-contract (ToS) terms must be in plain, intelligible language; non-negotiated terms causing significant imbalance are unenforceable; Annex grey-list (unilateral change clauses, one-sided termination, liability exclusions) maps directly to ToS-audit checks. | 1993; consolidated to 28 May 2022 | ◇ |
| Consumer Rights Directive 2011/83/EU (consolidated) | https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A02011L0083-20220528 | Pre-contractual information for online contracts (Art. 6): trader identity, total price, duration/renewal terms, withdrawal right + model form; button must clearly indicate "order with obligation to pay". Modernisation Directive (2019/2161) added ranking-transparency and review-authenticity duties. | Consolidated to 28 May 2022 | ◇ |
| FTC Act § 5 (15 U.S.C. § 45) + FTC ".com Disclosures" guidance | https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title15-section45&num=0&edition=prelim · https://www.ftc.gov/business-guidance/resources/com-disclosures-how-make-effective-disclosures-digital-advertising | US hook for ToS/privacy-policy honesty: deviating from stated policies is a "deceptive practice." .com Disclosures (2013): disclosures must be clear and conspicuous, unavoidable, proximate to the claim — hyperlink-buried disclosures scrutinized. For auto-renewing subscriptions, ROSCA (15 U.S.C. § 8401 et seq.) requires clear disclosure + simple cancellation (FTC's 2024 "click-to-cancel" Negative Option Rule was **vacated by the 8th Circuit, July 2025** — cite ROSCA, not the rule). | .com Disclosures Mar 2013 | ◇ (ftc.gov 403s to fetcher) |

---

## 4. AI-content disclosure / AI transparency — skill: `ai-disclosure`

### EU AI Act — the core obligation set

| Document | URL | What it mandates | Dates | Ver. |
|---|---|---|---|---|
| EU AI Act — Regulation (EU) 2024/1689, Article 50 | https://eur-lex.europa.eu/eli/reg/2024/1689/oj | **Art. 50(1)**: providers must ensure users are informed they are interacting with an AI system (chatbots), unless obvious. **Art. 50(2)**: providers of generative AI must mark synthetic audio/image/video/text outputs in a **machine-readable format** detectable as artificially generated (watermarking/metadata/provenance), effective, interoperable, robust "as far as technically feasible." **Art. 50(3)**: deployers of emotion-recognition/biometric-categorization systems must inform exposed persons. **Art. 50(4)**: deployers must **label deepfakes**, and disclose AI-generated/manipulated **text published to inform the public on matters of public interest** (carve-out where human editorial review + responsibility exists). **Art. 50(5)**: information must be clear, at first interaction/exposure. Penalties up to €15M / 3% global turnover (Art. 99(4)(g)). | Entered force 1 Aug 2024; **Art. 50 applies from 2 Aug 2026 — CONFIRMED** (Commission FAQ + guidelines). Transitional: generative systems already on the market before 2 Aug 2026 get until **2 Dec 2026** for the Art. 50(2) marking/detection obligation | ◇ (EUR-Lex fetch-blocked; date confirmed ✓ via Commission pages below) |
| Commission Guidelines on transparency obligations (Art. 50) | https://digital-strategy.ec.europa.eu/en/library/guidelines-transparency-obligations-providers-and-deployers-ai-systems | Official Commission interpretation of Art. 50 scope for providers and deployers — what counts as an in-scope system, acceptable marking techniques, deepfake/label placement. Adopted **20 July 2026**. | Adopted 20 Jul 2026; page updated 31 Jul 2026 | ✓ |
| Code of Practice on Transparency of AI-generated Content | https://digital-strategy.ec.europa.eu/en/policies/code-practice-ai-generated-content | **Voluntary** code (final version **10 June 2026**) recognized by the Commission/AI Board as an adequate compliance path for Art. 50(2) marking/detection and Art. 50(4) labeling; includes a standard **icon set for labeling AI-generated content**. ~190 signatories as of late Jul 2026. | Final 10 Jun 2026 | ✓ |
| Commission FAQ: Transparency obligations under Article 50 | https://digital-strategy.ec.europa.eu/en/faqs/transparency-obligations-under-article-50-ai-act | Plain-language Q&A on who must do what, from when. | Live 2026 | ◇ |

### US state laws

| Document | URL | What it mandates | Dates | Ver. |
|---|---|---|---|---|
| California SB 942 — AI Transparency Act (Bus. & Prof. Code § 22757 et seq.) | https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?bill_id=202320240SB942 | "Covered providers" (public gen-AI systems >1M monthly visitors/users) must: offer a **free public AI-detection tool**; offer users an optional **manifest (visible) disclosure**; embed **latent (machine-readable) provenance disclosures** in generated image/video/audio; contractually bind licensees to preserve capabilities. $5,000/violation/day civil penalty. | Enacted 19 Sep 2024, originally operative 1 Jan 2026; **AB 853 (signed 13 Oct 2025) delayed operative date to 2 Aug 2026** — now in effect. AB 853 also added large-platform provenance-display and capture-device duties (2027–2028 phase-in). AB 853 text: https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?bill_id=202520260AB853 (◇) | ✓ |
| California AB 3030 — health-care generative AI (Health & Saf. Code § 1339.75) | https://leginfo.legislature.ca.gov/faces/billNavClient.xhtml?bill_id=202320240AB3030 | Health facilities/clinics/practices using gen-AI for **patient clinical communications** must include a disclaimer that content was AI-generated plus instructions to reach a human clinician; exempt if a licensed provider reviews the message. | Effective 1 Jan 2025 | ◇ |
| Utah AI Policy Act — SB 149 (2024), Utah Code Title 13, Ch. 72 | https://le.utah.gov/~2024/bills/static/SB0149.html | Gen-AI use in consumer-protection-regulated interactions must be disclosed **on clear and unambiguous request**; **proactive, prominent disclosure** required for regulated occupations (health, legal, financial advice) — as narrowed by SB 226 (2025). Codified-chapter URL **UNVERIFIED** (le.utah.gov code viewer would not render to the fetcher). | Effective 1 May 2024; SB 226/SB 332 amendments effective 7 May 2025; sunset extended to 1 Jul 2027 | ✓ |
| Colorado — SB 24-205 (CAIA) → replaced by SB 26-189 | https://leg.colorado.gov/bills/sb24-205 · https://leg.colorado.gov/bills/sb26-189 | Original CAIA (high-risk AI, algorithmic-discrimination duty, and a consumer-facing **AI-interaction disclosure**) **never took effect**: delayed to 30 Jun 2026 (SB 25B-004), enforcement enjoined Apr 2026 (xAI litigation, DOJ intervening), then **repealed and replaced by SB 26-189** (signed 14 May 2026) — a narrower notice-based regime: deployers must notify consumers when **automated decision-making technology** influences consequential decisions (employment, housing, credit, etc.), with explanation and human-review rights; developer documentation duties. | SB 26-189 effective 12 Aug 2026; substantive obligations from **1 Jan 2027** (subject to pending litigation) | ✓ |

### China

| Document | URL | What it mandates | Dates | Ver. |
|---|---|---|---|---|
| Measures for Labeling AI-Generated Synthetic Content (人工智能生成合成内容标识办法), CAC et al. | https://www.cac.gov.cn/2025-03/14/c_1743654684782215.htm (official, Chinese) · English translation (**secondary**, unofficial): https://www.chinalawtranslate.com/en/ai-labeling/ | Dual labeling regime for all AI-generated text/image/audio/video/virtual scenes: **explicit labels** (visible/audible marks users can perceive) and **implicit labels** (file-metadata identifiers incl. provider name and content ID; watermarks encouraged). Distribution platforms must verify and re-label; removing labels prohibited. Paired mandatory national standard **GB 45438-2025** specifies the labeling method. | Issued 7 Mar 2025; **effective 1 Sep 2025** | ✓ |

### Provenance standards

| Document | URL | What it mandates | Dates | Ver. |
|---|---|---|---|---|
| C2PA Content Credentials — Technical Specification v2.4 | https://spec.c2pa.org/specifications/specifications/2.4/index.html (index: https://spec.c2pa.org/) | Open spec for cryptographically signed provenance manifests bound to media assets — the leading candidate "machine-readable marking" implementation for EU AI Act Art. 50(2) and SB 942 latent disclosures. | v2.4 current as of Aug 2026 | ✓ |
| IPTC Digital Source Type NewsCodes | https://cv.iptc.org/newscodes/digitalsourcetype/ | Controlled vocabulary for declaring how media was created — incl. `trainedAlgorithmicMedia` (AI-generated), `compositeWithTrainedAlgorithmicMedia`, `compositeSynthetic`; the value set C2PA and Google/IPTC metadata use to flag AI content. | Living CV; AI terms added 2023–2024 | ✓ |

---

## Registry-wide caveats

- **Fetch-blocked official sites (◇):** eur-lex.europa.eu, ecfr.gov,
  federalregister.gov, ico.org.uk, and ftc.gov actively block automated fetchers. All ◇
  URLs use the sites' canonical, deterministic identifier schemes (CELEX/ELI, eCFR
  title paths, FR document numbers) and were corroborated verbatim in official-site
  search listings — but a human should click each once before the skill ships.
- **UNVERIFIED items:** Utah Code Title 13 Ch. 72 code-viewer URL; the EN 301 549
  "v4"/WCAG 2.2 revision (expected 2026, not yet published or OJ-cited).
- **Volatile through 2026–2027 (recheck before each release):** DOJ Title II deadlines
  (IFR comment period closed Jun 2026 — a further change is possible), Colorado
  SB 26-189 (active constitutional litigation), EN 301 549 revision, ePrivacy
  successor activity, and the EU AI Act third-country enforcement posture.
