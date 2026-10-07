import type { Requirement } from '../schema.js';
import { asRequirementId, asInstrumentId } from '../ids.js';

// Consent-banner design (ticket F6). The legal hooks for the banner rules in
// rules/consent/banner-design.ts — equal prominence, no pre-ticked boxes, no
// cookie wall. Detail and every citation: plans/research-consent-law.md §1.2
// (CCPA §7004), §3.1 (EU: Planet49, EDPB Cookie Banner Taskforce, CNIL), §3.3
// (UK: ICO 2026 guidance). Scoped by `jurisdictions` like the tracking entries:
// findings only come from a VERIFIED visitor location.
//
// Withdrawal (Art 7(3)), required wording (ePrivacy 5(3) / PECR reg 6) and the
// California opt-out link reuse the existing entries (gdpr.ts, tracking.ts).

export const BANNER_REQUIREMENTS: Requirement[] = [
  {
    id: asRequirementId('gdpr.art4.11'),
    instrument: asInstrumentId('gdpr'),
    citation: { kind: 'article', article: 4, paragraph: 11 },
    title: 'Valid consent: freely given, specific, informed, unambiguous',
    text:
      '‘consent’ of the data subject means any freely given, specific, informed and unambiguous indication of the data subject’s wishes by which he or she, by a statement or by a clear affirmative action, signifies agreement to the processing of personal data relating to him or her. (Recital 32: silence, pre-ticked boxes or inactivity should not therefore constitute consent.) Applies to cookie consent through ePrivacy Art 2(f).',
    authority: [
      { ref: 'cjeu-planet49-c-673-17', note: 'a pre-ticked checkbox is not valid consent to cookies' },
      { ref: 'edpb-05-2020', note: 'consent guidelines: cookie walls are not freely given consent (¶¶39–41)' },
      { ref: 'edpb-03-2022', note: 'deceptive design patterns: a visually dominant accept steers the choice' },
      { ref: 'edpb-cookie-banner-taskforce-2023', note: 'no reject on the first layer, deceptive button colors/contrast, pre-ticked boxes, legitimate interest for trackers' },
      { ref: 'cnil-cookies-2020', note: 'refusing must be as easy as accepting; one-click reject where there is one-click accept' },
    ],
    urls: [
      { href: 'https://eur-lex.europa.eu/eli/reg/2016/679/oj', botBlocked: true },
      { href: 'https://www.edpb.europa.eu/system/files/documents/2023-01/edpb_20230118_report_cookie_banner_taskforce_en.pdf' },
    ],
    effective: { from: '2018-05-25' },
    appliesIf: ['targets-eu'],
    jurisdictions: [{ code: 'eu' }],
    kind: 'obligation',
    severity: 'serious',
  },
  {
    id: asRequirementId('uk-gdpr.art4.11'),
    instrument: asInstrumentId('uk-gdpr'),
    citation: { kind: 'article', article: 4, paragraph: 11 },
    title: 'Valid consent (UK): freely given, specific, informed, unambiguous',
    text:
      '‘consent’ of the data subject means any freely given, specific, informed and unambiguous indication of the data subject’s wishes by which he or she, by a statement or by a clear affirmative action, signifies agreement to the processing of personal data relating to him or her. PECR reg 6 consent takes this meaning.',
    authority: [
      { ref: 'ico-storage-access-guidance-2026', note: 'accept-all and reject-all equally prominent; non-exempt toggles off by default; no cookie walls for general access' },
    ],
    urls: [
      { href: 'https://www.legislation.gov.uk/eur/2016/679/article/4' },
      { href: 'https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies/how-do-we-manage-consent-in-practice/' },
    ],
    effective: { from: '2021-01-01' },
    appliesIf: ['targets-uk'],
    jurisdictions: [{ code: 'uk' }],
    kind: 'obligation',
    severity: 'serious',
  },
  {
    id: asRequirementId('ccpa.regs.7004'),
    instrument: asInstrumentId('ccpa'),
    citation: { kind: 'section', title: 11, section: '7004(a)(2)' },
    title: 'Symmetry in choice (no dark patterns)',
    text:
      'Methods for submitting CCPA requests and obtaining consent must offer symmetry in choice: the path to a more privacy-protective option must not be longer or more difficult than the less protective one. Since 2026-01-01, a choice that makes the “yes” button more prominent (larger, brighter) than the “no” button is not symmetrical ((a)(2)(D)); “Accept All” with only “More Information” is not symmetrical ((a)(2)(C)). An agreement obtained through dark patterns is not consent (§7004(c)). Paraphrase — see 11 CCR §7004.',
    authority: [
      { ref: 'ct-ag-cure-notices-2025', note: 'Reject All shown with Accept, same color, font and size' },
      { ref: 'cppa-honda-2025', note: 'asymmetric cookie banner as a dark pattern' },
    ],
    urls: [{ href: 'https://cppa.ca.gov/regulations/pdf/ccpa_updates_cyber_risk_admt_appr_text.pdf' }],
    effective: { from: '2023-03-29' },
    appliesIf: ['ccpa-covered'],
    jurisdictions: [{ code: 'us-ca' }],
    kind: 'obligation',
    severity: 'serious',
  },
];
