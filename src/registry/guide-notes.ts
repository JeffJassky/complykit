// The legal guide's words (plans/legal-guide-contract.md): complykit's testing
// policy, each rule model explained once, a plain summary per law, and the
// place-specific callouts — exceptions, litigation practice, and the places
// deliberately left out of a posture, with why. Everything a place inherits
// (its model, its laws, its state act) comes from the rest of the registry;
// only what is particular to a place lives here.
//
// Sources: plans/research-consent-law.md (dated 2026-09-30, §2.5 updated
// 2026-10-08) and the requirement entries' own authority lists. Copy is for a
// site owner; it states the model and the evidence, never that a site complies.

/** Local mirror of the service's note shape (registry imports nothing internal). */
export interface GuideNoteEntry {
  kind: 'posture' | 'litigation' | 'exception' | 'pending';
  title: string;
  text: string;
  sources: Array<{ label: string; href: string }>;
}

export const GUIDE_POSTURE = {
  title: 'How complykit decides what to expect',
  principles: [
    'Two tests, and a site must pass both. First, the letter of the law where the visitor is. Second, how the law is actually enforced and litigated there — including lawsuits under laws that were not written for websites. Meeting the statute while staying exposed to a well-known lawsuit pattern is not treated as compliant.',
    'Where the two tests disagree, the stricter one sets the expectation. California’s privacy act is opt-out, but wiretap suits there target trackers that fire before the visitor agrees, so complykit expects those trackers off until the visitor accepts.',
    'Nothing is given up without a reason. A tool is expected off only where a law or a documented lawsuit pattern says so; everywhere else it may run, and the report says so.',
    'A location is what the scan measured, never what a site claims. Each law is tested from a browser whose exit address was verified to be in that place; an unverified location is compared against nothing.',
    'Absence is not a pass. A visit that could not run, or a capture that might have missed something, is reported as not checked, never as fine.',
    'Places complykit has not researched fail closed: its consent tool treats those visitors as opt-in, the strictest model, and the scanner draws no legal conclusion there.',
    'This guide is the policy the scanner runs. Every rule here is the same data the scanner uses, so the guide and the reports cannot disagree.',
  ],
} as const;

export const GUIDE_MODELS = [
  {
    id: 'opt-in',
    label: 'Opt-in',
    summary:
      'Nothing non-essential may run until the visitor says yes. A banner is required, rejecting must be as easy as accepting, and consent must be provable and as easy to withdraw as to give.',
    mustHave: [
      'No analytics, advertising or social scripts, cookies or storage before a choice — only what is strictly necessary for a service the visitor asked for.',
      'A banner where rejecting is as easy as accepting: regulators expect the reject option on the first screen, as prominent as accept, with no pre-ticked boxes.',
      'Proof of consent, and a way to withdraw it that is as easy as giving it. Withdrawal means the tools stop and what they stored is removed.',
    ],
  },
  {
    id: 'opt-out-signal',
    label: 'Opt-out, privacy signal honored',
    summary:
      'Tracking may run by default, but the visitor can opt out of the sale or sharing of their data and of targeted advertising, and the browser’s Global Privacy Control (GPC) signal must be treated as that opt-out without the visitor doing anything.',
    mustHave: [
      'Tracking may run by default; the visitor can opt out of sale, sharing and targeted advertising.',
      'The browser’s opt-out signal (GPC) is honored as an opt-out on the first page, with no popup.',
      'A clear and conspicuous way to opt out, reachable from every page, that works without an account or extra information. California prescribes the wording (see CCPA).',
      'Disclosure of the processing and the opt-out right in the privacy policy (not checked by a scan).',
    ],
  },
  {
    id: 'opt-out',
    label: 'Opt-out',
    summary:
      'Tracking may run by default and the visitor can opt out of targeted advertising and the sale of their data. The state’s law does not require honoring the browser’s opt-out signal.',
    mustHave: [
      'Tracking may run by default; the visitor can opt out of targeted advertising and sale.',
      'A clear and conspicuous way to opt out, reachable from the site, that works without an account or extra information.',
      'No legal duty to honor GPC here — complykit’s consent tool honors it anyway, because traffic thresholds make several states’ duties apply to most busy sites.',
      'Disclosure of the processing and the opt-out right in the privacy policy (not checked by a scan).',
    ],
  },
  {
    id: 'opt-out-no-act',
    label: 'No state privacy law',
    summary:
      'The state has no comprehensive privacy law in force. Federal rules (COPPA, the FTC Act) and the state’s wiretap statute may still apply; the scan compares tools with the baseline US opt-out model.',
    mustHave: [
      'No state-specific consent or opt-out duty is asserted.',
      'complykit still checks that a rejection, an opt-out or the privacy signal is respected when a site offers one: a choice that leaks is evidence in wiretap suits everywhere.',
    ],
  },
  {
    id: 'unresearched',
    label: 'Not researched',
    summary:
      'complykit has not researched the law here. The scanner shows what it observed and draws no legal conclusion; complykit’s consent tool treats these visitors as opt-in, the strictest model.',
    mustHave: ['Nothing is compared against a legal model. Treat visitors from here as opt-in until the law is researched.'],
  },
] as const;

/** complykit's wiretap posture, explained once (the states come from registry/wiretap.ts). */
export const GUIDE_WIRETAP = {
  summary:
    'In these states, all-party-consent wiretap laws are used to sue websites whose trackers send what a visitor does to a third party before the visitor agrees. The privacy statute may be opt-out, but prior consent is the defence in court — so complykit expects the targeted tools off until the visitor accepts.',
  holds:
    'Advertising pixels, session recording, chat and identity-resolution tools stay off until the visitor accepts. Courts accept only consent given before the tracking starts; a footer policy link or “by using this site you agree” is not consent, and an opt-out banner never provides it.',
} as const;

const RESEARCH = 'https://github.com/JeffJassky/complykit/blob/main/plans/research-consent-law.md';
const src = (label: string, href: string) => ({ label, href });

/** Per instrument: chip label, plain summary, litigation risk (exposure laws), and notes that apply wherever it reaches. */
export const GUIDE_LAWS: Readonly<Record<string, { shortName: string; scope: string; summary: string; risk?: 'high' | 'moderate' | 'moderate-low' | 'low'; notes: GuideNoteEntry[] }>> = {
  eprivacy: {
    shortName: 'ePrivacy Directive',
    scope: 'EU & EEA',
    summary:
      'The EU’s cookie law. Storing anything on a visitor’s device, or reading anything from it, needs prior consent unless strictly necessary for a service the visitor asked for. Regulators read “anything” broadly: pixels, link tracking, local storage and IP-based tracking all count.',
    notes: [],
  },
  gdpr: {
    shortName: 'GDPR',
    scope: 'EU & EEA',
    summary:
      'EU data protection law. Where consent is the basis, it must be freely given, specific, informed and unambiguous, provable, and as easy to withdraw as to give; the privacy notice must name who receives the data.',
    notes: [],
  },
  pecr: {
    shortName: 'PECR',
    scope: 'United Kingdom',
    summary:
      'The UK’s cookie law, rewritten by the Data (Use and Access) Act 2025. Storage and access need prior consent, with narrow exceptions: strictly necessary, appearance and functionality, and first-party statistics with a simple, free way to object.',
    notes: [],
  },
  'uk-gdpr': {
    shortName: 'UK GDPR',
    scope: 'United Kingdom',
    summary: 'UK data protection law, retained from the GDPR: the same consent standard, including withdrawal as easy as giving consent.',
    notes: [],
  },
  ccpa: {
    shortName: 'CCPA / CPRA',
    scope: 'California',
    summary:
      'California’s privacy act and its regulations. Opt-out, not opt-in: a business that sells or shares data must offer a prescribed opt-out link, honor the browser’s GPC signal as an opt-out, and since 2026 show the visitor that the signal was honored.',
    notes: [],
  },
  'us-state-privacy': {
    shortName: 'State privacy acts',
    scope: 'US states with a comprehensive privacy act',
    summary:
      'The comprehensive privacy acts of the other US states. All opt-out: the visitor can opt out of targeted advertising and sale, the site must say how, and in some states the browser’s GPC signal must be honored as that opt-out.',
    notes: [
      {
        kind: 'posture',
        title: 'Thresholds are assumed met',
        text:
          'Each act applies only above a traffic or revenue threshold (often 35,000–100,000 residents a year), which no browser can observe. Every tracked visitor counts toward it, so busy sites cross thresholds in several states. complykit applies every act as if it covers the site, and its consent tool honors GPC for all US traffic.',
        sources: [src('Research §1.4', RESEARCH)],
      },
    ],
  },
  cipa: {
    shortName: 'CIPA',
    scope: 'California',
    risk: 'high',
    summary:
      'California’s Invasion of Privacy Act, a 1967 wiretap law now the main engine of website tracking suits. Plaintiffs claim a site helps a vendor read visitors’ communications without everyone’s prior consent. $5,000 per violation, no harm required.',
    notes: [
      {
        kind: 'litigation',
        title: 'Only prior consent counts',
        text:
          'Consent obtained after tracking starts does not cure it (Javier v. Assurance IQ, 9th Cir. 2022). A footer policy link is not consent where tracking starts first, an opt-out banner never provides prior consent, and a rejection that still leaks is evidence for the plaintiff — one court treated a shopper’s activity after she rejected cookies as confidential.',
        sources: [src('Research §2.1–2.2', RESEARCH)],
      },
      {
        kind: 'litigation',
        title: 'Out-of-state sites can be sued in California',
        text:
          'Knowingly tracking devices located in California is enough for California courts to hear the case (Briskin v. Shopify, 9th Cir. en banc 2025). Where the business is based does not matter.',
        sources: [src('Research §2.4', RESEARCH)],
      },
      {
        kind: 'pending',
        title: 'SB 690 would end private pen-register suits, not wiretap suits',
        text:
          'SB 690 passed the Legislature on 2026-08-28 and went to the Governor (deadline 2026-09-30). If it is law, only the Attorney General can bring §638.51 pen-register claims about websites from 2027-01-01. It leaves §631, §632, §632.7 and every other state untouched, so it does not change complykit’s posture.',
        sources: [src('SB 690 bill history', 'https://leginfo.legislature.ca.gov/faces/billHistoryClient.xhtml?bill_id=202520260SB690')],
      },
    ],
  },
  fsca: {
    shortName: 'Florida FSCA',
    scope: 'Florida',
    risk: 'high',
    summary:
      'Florida’s Security of Communications Act requires every party’s prior consent to intercept a communication. The greater of $1,000 or $100 a day, plus punitive damages and fees.',
    notes: [
      {
        kind: 'litigation',
        title: 'High and rising: small-claims chat suits',
        text:
          'After a 2021 wave failed, suits revived in 2025 (W.W. v. Orlando Health). Hundreds of small-claims suits over chat widgets are filed under the $8,000 limit, with pretrial hearings within one to two weeks of service.',
        sources: [src('Research §2.5', RESEARCH)],
      },
    ],
  },
  wesca: {
    shortName: 'Pennsylvania WESCA',
    scope: 'Pennsylvania',
    risk: 'moderate-low',
    summary:
      'Pennsylvania’s wiretap act. Courts treat the interception as happening in the visitor’s browser in Pennsylvania (Popa v. Harriet Carter, 3d Cir. 2022), so out-of-state sites are reachable.',
    notes: [
      {
        kind: 'litigation',
        title: 'Federal standing now stops most non-sensitive cases',
        text: 'Routine tracking on a non-sensitive site is not a concrete injury in federal court (Cook v. GameStop, 3d Cir. 2025). Health, finance and other sensitive sites remain exposed.',
        sources: [src('Research §2.4–2.5', RESEARCH)],
      },
    ],
  },
  mdwa: {
    shortName: 'Maryland Wiretap Act',
    scope: 'Maryland',
    risk: 'moderate-low',
    summary:
      'Maryland requires every party’s prior consent to intercept a communication. At least $100 a day or $1,000, plus punitive damages and fees.',
    notes: [
      {
        kind: 'litigation',
        title: 'Page addresses and cookies are not “contents”; form input is',
        text:
          'A Maryland appeals court held URLs, IP addresses, cookie values and login events are not the contents of a communication (Doe II v. MedStar, 2026, unreported). What a visitor types — form input, searches, chat text — sent to a third party remains the exposure.',
        sources: [src('Research §2.5', RESEARCH)],
      },
    ],
  },
  ilea: {
    shortName: 'Illinois Eavesdropping Act',
    scope: 'Illinois',
    risk: 'moderate',
    summary:
      'Illinois prohibits intercepting a private electronic communication without every party’s consent, and makes whoever the eavesdropper works for liable too. Actual and punitive damages; no statutory damages or fee shifting.',
    notes: [
      {
        kind: 'litigation',
        title: 'The site is liable for its pixel vendor',
        text:
          'Federal courts in Illinois let pixel claims proceed against the site owner as the vendor’s principal (Kurowski v. Rush, 2023; Dawson v. University of Phoenix, 2026).',
        sources: [src('Kurowski v. Rush', 'https://www.govinfo.gov/content/pkg/USCOURTS-ilnd-1_22-cv-05380/pdf/USCOURTS-ilnd-1_22-cv-05380-1.pdf'), src('Dawson v. University of Phoenix', 'https://cases.justia.com/federal/district-courts/illinois/ilndce/1:2025cv03497/475832/52/0.pdf')],
      },
    ],
  },
  'enforcement-practice': {
    shortName: 'Regulator practice',
    scope: 'Everywhere',
    summary:
      'Not a statute: what regulators order companies to do after enforcement. California’s orders require periodic scans and an inventory of every third party that receives visitor data — a party nobody can identify cannot be disclosed, contracted or gated.',
    notes: [],
  },
};

/** Callouts particular to one place (by guide place code). */
export const GUIDE_PLACE_NOTES: Readonly<Record<string, GuideNoteEntry[]>> = {
  eu: [
    {
      kind: 'posture',
      title: 'Google Consent Mode “advanced” needs a decision',
      text:
        'With Consent Mode “advanced”, Google tags send cookieless pings before consent. Whether that is allowed without consent is contested: the pings carry the IP address, browser details and the full page address, which EU guidance treats as gaining access. complykit reports them as needing your decision rather than as a pass or a violation.',
      sources: [src('EDPB Guidelines 2/2023', 'https://www.edpb.europa.eu/system/files/documents/2024-10/edpb_guidelines_202302_technical_scope_art_53_eprivacydirective_v2_en_0.pdf')],
    },
  ],
  uk: [
    {
      kind: 'exception',
      title: 'Statistics exception (since 2026-02-05)',
      text:
        'The Data (Use and Access) Act 2025 lets first-party statistics run without consent if the visitor gets a simple, free way to object and the data goes only to a processor acting for the site. Advertising is never exempt, and session recording is not “statistics”. Fines now reach £17.5M or 4% of turnover.',
      sources: [src('ICO: storage and access exceptions', 'https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies/what-are-the-exceptions/')],
    },
    {
      kind: 'posture',
      title: 'Google Consent Mode “advanced” needs a decision',
      text: 'As in the EU, cookieless pings before consent are reported as needing your decision.',
      sources: [],
    },
  ],
  'us-md': [
    {
      kind: 'exception',
      title: 'Sale of sensitive data is banned outright',
      text: 'Maryland’s privacy act bans selling sensitive data rather than requiring consent for it. Its wording on the privacy signal is ambiguous; California’s regulator counts Maryland as a GPC state, and so does complykit.',
      sources: [src('Md. Com. Law §14-4707', 'https://mgaleg.maryland.gov/mgawebsite/Laws/StatuteText?article=gcl&section=14-4707&enactments=false')],
    },
  ],
  'us-il': [
    {
      kind: 'exception',
      title: 'Face scanning is a separate, stricter law',
      text: 'Illinois’s Biometric Information Privacy Act applies if a site scans faces (virtual try-on, ID checks). It is not part of a tracking scan.',
      sources: [src('Research §2.5', RESEARCH)],
    },
  ],
  'us-wa': [
    {
      kind: 'posture',
      title: 'Not in the wiretap posture: closed for pixels',
      text:
        'Washington’s privacy act requires all-party consent, but its Supreme Court held that searches and clicks producing an automated response from a corporate site are not a communication between people (Baker v. Seattle Children’s Hospital, 2026-10-08). Chat with a human agent was left open, so live chat carries some risk.',
      sources: [src('Baker v. Seattle Children’s Hospital', 'https://www.courts.wa.gov/opinions/pdf/1045905.pdf')],
    },
  ],
  'us-ma': [
    {
      kind: 'posture',
      title: 'Not in the wiretap posture: closed by the state’s highest court',
      text: 'Massachusetts’s Supreme Judicial Court held its wiretap act does not reach website tracking (Vita v. New England Baptist, 2024-10-24). A bill to change that (S.1266) is pending.',
      sources: [src('Research §2.5', RESEARCH)],
    },
  ],
  'us-mt': [
    {
      kind: 'posture',
      title: 'Not in the wiretap posture: no private lawsuits',
      text: 'Montana’s eavesdropping law is criminal only, with no private right to sue, and no website suits were found.',
      sources: [src('Research §2.5', RESEARCH)],
    },
  ],
  'us-az': [
    {
      kind: 'posture',
      title: 'Email tracking-pixel suits ended',
      text: 'Suits over “spy pixels” in marketing email failed on appeal (Smith v. Target, Ariz. Ct. App. 2025-11-13). Arizona has no comprehensive privacy act.',
      sources: [src('Research §2.5', RESEARCH)],
    },
  ],
  other: [
    {
      kind: 'posture',
      title: 'Fail closed',
      text: 'Visitors from places complykit has not researched are treated as opt-in by its consent tool. Add a place to this guide before drawing conclusions about it.',
      sources: [],
    },
  ],
};
