import type { Requirement } from '../schema.js';
import { asRequirementId, asInstrumentId } from '../ids.js';

// Consent & tracking by visitor location (plans/consent-design.md §8; legal
// detail and every citation in plans/research-consent-law.md). These entries
// carry `jurisdictions` — matched against the VERIFIED location of the browser
// that produced the evidence — and `kind`:
//
//   obligation — a statute/regulation duty; findings may be violations.
//   exposure   — a wiretap-litigation theory (CIPA, Fla. ch. 934, WESCA). Evidence
//                for counsel, never presented as a violation; rules cap these at
//                needs-review.
//   practice   — a regulator-ordered practice (the tracker inventory), not a law.
//
// `appliesIf` keeps the classic `scan` path honest: there, without a measured
// location, a property's hand-set tag stands in for "visitors from here exist".
// The consent evaluation gates on `jurisdictions` instead and ignores appliesIf.
//
// Text fields: EU and UK texts are official (EU reuse / OGL). US entries are
// close paraphrases with the operative words quoted — read the source.

const EPRIVACY = asInstrumentId('eprivacy');
const PECR = asInstrumentId('pecr');
const UK_GDPR = asInstrumentId('uk-gdpr');
const CCPA = asInstrumentId('ccpa');
const US_STATES = asInstrumentId('us-state-privacy');
const CIPA = asInstrumentId('cipa');
const FSCA = asInstrumentId('fsca');
const WESCA = asInstrumentId('wesca');
const PRACTICE = asInstrumentId('enforcement-practice');

export const TRACKING_REQUIREMENTS: Requirement[] = [
  // --- EU ---------------------------------------------------------------------
  {
    id: asRequirementId('eprivacy.art5.3'),
    instrument: EPRIVACY,
    citation: { kind: 'article', article: 5, paragraph: 3 },
    title: 'Consent before storing or reading information on the device',
    text:
      'Member States shall ensure that the storing of information, or the gaining of access to information already stored, in the terminal equipment of a subscriber or user is only allowed on condition that the subscriber or user concerned has given his or her consent, having been provided with clear and comprehensive information … This shall not prevent any technical storage or access … as strictly necessary in order for the provider of an information society service explicitly requested by the subscriber or user to provide the service.',
    authority: [
      { ref: 'edpb-02-2023', note: 'technical scope: tracking pixels, URL/link tracking, local storage, IP-only tracking and hashed identifiers are all "gaining access"' },
      { ref: 'edpb-cookie-banner-taskforce-2023', note: 'no reject on first layer, pre-ticked boxes, deceptive design' },
    ],
    urls: [
      { href: 'https://eur-lex.europa.eu/eli/dir/2002/58/oj', botBlocked: true },
      { href: 'https://www.edpb.europa.eu/system/files/documents/2024-10/edpb_guidelines_202302_technical_scope_art_53_eprivacydirective_v2_en_0.pdf' },
    ],
    // Directive 2009/136/EC (the consent wording) — transposition deadline.
    effective: { from: '2011-05-25' },
    appliesIf: ['targets-eu'],
    jurisdictions: [{ code: 'eu' }],
    kind: 'obligation',
    severity: 'serious',
  },
  {
    id: asRequirementId('gdpr.art13.recipients'),
    instrument: asInstrumentId('gdpr'),
    citation: { kind: 'article', article: 13, paragraph: 1, point: 'e' },
    title: 'Name the recipients of personal data',
    text: 'The controller shall … provide the data subject with … the recipients or categories of recipients of the personal data, if any.',
    urls: [{ href: 'https://eur-lex.europa.eu/eli/reg/2016/679/oj', botBlocked: true }],
    effective: { from: '2018-05-25' },
    appliesIf: ['processes-personal-data', 'targets-eu'],
    jurisdictions: [{ code: 'eu' }],
    kind: 'obligation',
    severity: 'moderate',
  },

  // --- UK ---------------------------------------------------------------------
  {
    id: asRequirementId('pecr.reg6'),
    instrument: PECR,
    citation: { kind: 'statute', code: 'Privacy and Electronic Communications (EC Directive) Regulations 2003', section: 'reg. 6' },
    title: 'Consent before storage or access (UK)',
    text:
      'A person must not store information, or gain access to information stored, in the terminal equipment of a subscriber or user, or instigate another person to do so, unless the subscriber or user is provided with clear and comprehensive information about the purposes and has given consent — subject to the Schedule A1 exceptions (strictly necessary; statistical purposes with a simple, free means of objecting; appearance/functionality).',
    authority: [
      { ref: 'duaa-2025', note: 'Data (Use and Access) Act 2025 rewrite; commenced 2026-02-05 (S.I. 2026/82); fines up to £17.5M or 4%' },
      { ref: 'ico-storage-access-guidance-2026', note: 'advertising is never exempt; the statistical exception needs a processor and excludes session recording' },
    ],
    urls: [
      { href: 'https://www.legislation.gov.uk/uksi/2003/2426/regulation/6' },
      { href: 'https://www.legislation.gov.uk/uksi/2003/2426/schedule/A1' },
      { href: 'https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies/what-are-the-exceptions/' },
    ],
    effective: { from: '2003-12-11' },
    appliesIf: ['targets-uk'],
    jurisdictions: [{ code: 'uk' }],
    kind: 'obligation',
    severity: 'serious',
  },
  {
    id: asRequirementId('uk-gdpr.art7.3'),
    instrument: UK_GDPR,
    citation: { kind: 'article', article: 7, paragraph: 3 },
    title: 'Withdrawal of consent (UK)',
    text: 'The data subject shall have the right to withdraw his or her consent at any time … It shall be as easy to withdraw as to give consent.',
    authority: [{ ref: 'ico-storage-access-guidance-2026', note: 'withdrawal means stop, tell third parties, treat as erasure' }],
    urls: [{ href: 'https://www.legislation.gov.uk/eur/2016/679/article/7' }],
    effective: { from: '2021-01-01' },
    appliesIf: ['targets-uk'],
    jurisdictions: [{ code: 'uk' }],
    kind: 'obligation',
    severity: 'serious',
  },

  // --- California (CCPA statute + regulations, tit. 11 CCR) ---------------------
  {
    id: asRequirementId('ccpa.regs.7025'),
    instrument: CCPA,
    citation: { kind: 'section', title: 11, section: '7025(b)–(c)' },
    title: 'Honor opt-out preference signals (Global Privacy Control)',
    text:
      'A business that sells or shares personal information shall process an opt-out preference signal as a valid request to opt out of sale/sharing for that browser or device and any consumer profile associated with it, without requiring more information, and shall not respond to the signal with a popup or interstitial. Paraphrase — see 11 CCR §7025 and Civ. Code §1798.135.',
    authority: [
      { ref: 'ca-ag-sephora-2022', note: 'GPC "completely ignored"; investigators compared GPC on vs off' },
      { ref: 'cppa-tractor-supply-2025', note: 'GPC ignored; remedy: quarterly scans and a tracker inventory' },
      { ref: 'ca-ag-healthline-2025', note: 'opted out three ways at once, then counted remaining trackers' },
    ],
    urls: [
      { href: 'https://cppa.ca.gov/regulations/pdf/ccpa_updates_cyber_risk_admt_appr_text.pdf' },
      { href: 'https://cppa.ca.gov/regulations/pdf/ccpa_statute_eff_20260101.pdf' },
    ],
    effective: { from: '2023-03-29' },
    appliesIf: ['ccpa-covered'],
    jurisdictions: [{ code: 'us-ca', from: '2023-03-29' }],
    kind: 'obligation',
    severity: 'serious',
  },
  {
    id: asRequirementId('ccpa.regs.7025c6'),
    instrument: CCPA,
    citation: { kind: 'section', title: 11, section: '7025(c)(6)' },
    title: 'Display that the opt-out signal was processed',
    text:
      'The business must display whether or not it has processed the consumer’s opt-out preference signal — the regulation’s example is “Opt-Out Request Honored” — and §7026(g) requires a way to confirm an opt-out was processed. Paraphrase; mandatory from 2026-01-01.',
    urls: [{ href: 'https://cppa.ca.gov/regulations/pdf/ccpa_updates_cyber_risk_admt_appr_text.pdf' }],
    effective: { from: '2026-01-01' },
    appliesIf: ['ccpa-covered'],
    jurisdictions: [{ code: 'us-ca', from: '2026-01-01' }],
    kind: 'obligation',
    severity: 'moderate',
  },
  {
    id: asRequirementId('ccpa.opt-out-link'),
    instrument: CCPA,
    citation: { kind: 'section', title: 11, section: '7013, 7015, 7026' },
    title: 'Opt-out link, icon, and methods',
    text:
      'A business that sells or shares personal information must offer a “Do Not Sell or Share My Personal Information” link in the header or footer, or a single “Your Privacy Choices” link accompanied by the opt-out icon (§7015(b)); offer at least two opt-out methods, one being the opt-out preference signal (§7026(a)(1)); a cookie banner is not by itself an acceptable method (§7026(a)(4)); and must not add friction such as requiring unnecessary information (§7026(c)). Paraphrase.',
    authority: [
      { ref: 'cppa-ford-2026', note: 'email verification before processing opt-outs was unlawful friction' },
      { ref: 'cppa-playon-2026', note: 'opt-out by phone/email only; no GPC' },
    ],
    urls: [{ href: 'https://cppa.ca.gov/regulations/pdf/ccpa_updates_cyber_risk_admt_appr_text.pdf' }],
    effective: { from: '2023-03-29' },
    appliesIf: ['ccpa-covered'],
    jurisdictions: [{ code: 'us-ca' }],
    kind: 'obligation',
    severity: 'moderate',
  },

  // --- Other US states: universal opt-out mechanisms ----------------------------
  {
    id: asRequirementId('us-states.opt-out-signal'),
    instrument: US_STATES,
    citation: { kind: 'statute', code: 'State comprehensive privacy acts', section: 'universal opt-out mechanism provisions (e.g. Colo. Rev. Stat. §6-1-1306(1)(a)(IV))' },
    title: 'Honor universal opt-out signals (state laws)',
    text:
      'Controllers covered by these state laws must treat a recognized universal opt-out mechanism (GPC) as an opt-out of targeted advertising and sale. Dates per the CPPA’s 2026-08-06 list; thresholds differ by state and are not observable from a browser. Paraphrase — see research-consent-law.md §1.4.',
    urls: [{ href: 'https://cppa.ca.gov/meetings/materials/20260806_07_02.pdf' }],
    effective: { from: '2024-07-01' },
    appliesIf: ['us-state-privacy-covered'],
    jurisdictions: [
      { code: 'us-co', from: '2024-07-01' },
      { code: 'us-ct', from: '2025-01-01' },
      { code: 'us-tx', from: '2025-01-01' },
      { code: 'us-mt', from: '2025-01-01' },
      { code: 'us-ne', from: '2025-01-01' },
      { code: 'us-nh', from: '2025-01-01' },
      { code: 'us-nj', from: '2025-07-15' },
      { code: 'us-mn', from: '2025-07-31' },
      { code: 'us-md', from: '2025-10-01' },
      { code: 'us-or', from: '2026-01-01' },
      { code: 'us-de', from: '2026-01-01' },
    ],
    kind: 'obligation',
    severity: 'serious',
    // Maryland drafting ambiguous; NJ regs pending; new states phase in 2027.
    volatile: true,
  },

  // --- Wiretap exposure (litigation theories, not obligations) ------------------
  {
    id: asRequirementId('cipa.631'),
    instrument: CIPA,
    citation: { kind: 'statute', code: 'Cal. Penal Code', section: '§631(a)' },
    title: 'Wiretap theory: contents to a third party without prior consent (CA)',
    text:
      'Plaintiffs allege a site aids a vendor in learning the contents of a communication (descriptive URLs, searches, form input, chat, session replay) in transit without the consent of all parties. Consent must come before the transmission. $5,000 per violation (§637.2). Exposure, not an obligation — see research-consent-law.md §2.1–2.2.',
    authority: [
      { ref: 'javier-v-assurance-2022', note: 'retroactive consent does not cure' },
      { ref: 'mikulsky-2025', note: 'session replay capturing form contents stated a claim' },
    ],
    urls: [{ href: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=PEN&sectionNum=631' }],
    effective: { from: '1967-01-01' },
    jurisdictions: [{ code: 'us-ca' }],
    kind: 'exposure',
    severity: 'serious',
  },
  {
    id: asRequirementId('cipa.638.51'),
    instrument: CIPA,
    citation: { kind: 'statute', code: 'Cal. Penal Code', section: '§638.51' },
    title: 'Pen-register theory: addressing data to a tracker (CA)',
    text:
      'Plaintiffs allege a third-party tracker that records dialing, routing, addressing or signaling information (IP, device identifiers, page addresses) is an unauthorized pen register / trap-and-trace device. Exposure — volatile: SB 690 (pending Governor action as of 2026-09-30) would end private website suits from 2027-01-01, and Variety Media (Cal. Ct. App., tentative) holds IP-only complaints fail.',
    urls: [{ href: 'https://leginfo.legislature.ca.gov/faces/billHistoryClient.xhtml?bill_id=202520260SB690' }],
    effective: { from: '2015-01-01' },
    jurisdictions: [{ code: 'us-ca' }],
    kind: 'exposure',
    severity: 'moderate',
    volatile: true,
  },
  {
    id: asRequirementId('fsca.934.03'),
    instrument: FSCA,
    citation: { kind: 'statute', code: 'Fla. Stat.', section: '§934.03' },
    title: 'Wiretap theory: interception without all-party consent (FL)',
    text:
      'Florida’s Security of Communications Act requires all-party prior consent to intercept the contents of a communication; §934.10 gives the greater of $1,000 or $100/day, punitive damages and fees, 2-year limitation. Chat and session-replay suits are rising, including in small claims. Exposure — see research-consent-law.md §2.5.',
    urls: [{ href: 'http://www.leg.state.fl.us/statutes/index.cfm?App_mode=Display_Statute&URL=0900-0999/0934/Sections/0934.03.html' }],
    effective: { from: '1969-01-01' },
    jurisdictions: [{ code: 'us-fl' }],
    kind: 'exposure',
    severity: 'serious',
  },
  {
    id: asRequirementId('wesca.5703'),
    instrument: WESCA,
    citation: { kind: 'statute', code: '18 Pa. C.S.', section: '§5703' },
    title: 'Wiretap theory: interception at the visitor’s browser (PA)',
    text:
      'Pennsylvania’s Wiretapping and Electronic Surveillance Control Act; interception is treated as occurring at the visitor’s browser (Popa v. Harriet Carter, 3d Cir. 2022). Federal standing now defeats non-sensitive cases. Exposure — moderate to low.',
    urls: [{ href: 'https://www.legis.state.pa.us/cfdocs/legis/LI/consCheck.cfm?txtType=HTM&ttl=18&div=0&chpt=57&sctn=3&subsctn=0' }],
    effective: { from: '1978-10-04' },
    jurisdictions: [{ code: 'us-pa' }],
    kind: 'exposure',
    severity: 'moderate',
  },

  // --- Practice -----------------------------------------------------------------
  {
    id: asRequirementId('practice.tracker-inventory'),
    instrument: PRACTICE,
    citation: { kind: 'statute', code: 'Regulator orders', section: 'tracker inventory and periodic scans' },
    title: 'Know every third party that receives visitor data',
    text:
      'Enforcement orders (CPPA v. Tractor Supply, 2025; CA AG v. Healthline, 2025) require periodic scans and an inventory of every tracker on the site. A party nobody can identify cannot be disclosed, contracted, or gated. Practice, not a statute.',
    urls: [{ href: 'https://cppa.ca.gov/pdf/20250930_tractor_supply_bd_sfo.pdf' }],
    effective: { from: '2025-09-30' },
    jurisdictions: [{ code: 'any' }],
    kind: 'practice',
    severity: 'moderate',
  },
];
