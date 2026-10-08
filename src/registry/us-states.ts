import type { VerifiedUrl } from './schema.js';
import { US_PRIVACY_ACT_STATES } from './regime.js';

// The US state comprehensive privacy acts, by USPS code: what the report's
// location popover names and links. Dates live in regime.ts (the table the
// client bundles); this file is registry-only. Sources: research-consent-law.md
// §1.4 and the official code sites linked per act. Section-level citations for
// the opt-out right and the clear-and-conspicuous method are collected in
// plans/location-rules-citations.md for human confirmation; here each act is
// cited by its chapter, which is stable.

export interface UsStatePrivacyAct {
  /** USPS code. */
  state: string;
  /** The act's short name. */
  name: string;
  /** Chapter-level citation. */
  citation: string;
  /** Official text where known (verified by the docs task; bot-blocked sites flagged). */
  urls: VerifiedUrl[];
  /** How the act treats sensitive data — reported, never checked by a scan. */
  sensitive: 'opt-in' | 'notice-and-opt-out' | 'sale-banned';
}

export const US_STATE_PRIVACY_ACTS: Readonly<Record<string, UsStatePrivacyAct>> = {
  CA: {
    state: 'CA',
    name: 'California Consumer Privacy Act (as amended by the CPRA)',
    citation: 'Cal. Civ. Code §1798.100 et seq.; 11 CCR §7000 et seq.',
    urls: [{ href: 'https://cppa.ca.gov/regulations/pdf/ccpa_statute_eff_20260101.pdf' }],
    sensitive: 'notice-and-opt-out',
  },
  VA: {
    state: 'VA',
    name: 'Virginia Consumer Data Protection Act',
    citation: 'Va. Code §59.1-575 et seq.',
    urls: [{ href: 'https://law.lis.virginia.gov/vacode/title59.1/chapter53/' }],
    sensitive: 'opt-in',
  },
  CO: {
    state: 'CO',
    name: 'Colorado Privacy Act',
    citation: 'Colo. Rev. Stat. §6-1-1301 et seq.',
    urls: [{ href: 'https://coag.gov/resources/colorado-privacy-act/' }],
    sensitive: 'opt-in',
  },
  CT: {
    state: 'CT',
    name: 'Connecticut Data Privacy Act',
    citation: 'Conn. Gen. Stat. §42-515 et seq.',
    urls: [{ href: 'https://www.cga.ct.gov/current/pub/chap_743jj.htm' }],
    sensitive: 'opt-in',
  },
  UT: {
    state: 'UT',
    name: 'Utah Consumer Privacy Act',
    citation: 'Utah Code §13-61-101 et seq.',
    urls: [{ href: 'https://le.utah.gov/xcode/Title13/Chapter61/13-61.html' }],
    sensitive: 'notice-and-opt-out',
  },
  TX: {
    state: 'TX',
    name: 'Texas Data Privacy and Security Act',
    citation: 'Tex. Bus. & Com. Code ch. 541',
    urls: [{ href: 'https://statutes.capitol.texas.gov/Docs/BC/htm/BC.541.htm' }],
    sensitive: 'opt-in',
  },
  OR: {
    state: 'OR',
    name: 'Oregon Consumer Privacy Act',
    citation: 'ORS 646A.570 to 646A.589',
    urls: [{ href: 'https://www.doj.state.or.us/consumer-protection/id-theft-data-breaches/privacy/' }],
    sensitive: 'opt-in',
  },
  MT: {
    state: 'MT',
    name: 'Montana Consumer Data Privacy Act',
    citation: 'Mont. Code Ann. §30-14-2801 et seq.',
    urls: [{ href: 'https://leg.mt.gov/bills/mca/title_0300/chapter_0140/part_0280/sections_index.html' }],
    sensitive: 'opt-in',
  },
  IA: {
    state: 'IA',
    name: 'Iowa Consumer Data Protection Act',
    citation: 'Iowa Code ch. 715D',
    urls: [{ href: 'https://www.legis.iowa.gov/docs/code/715D.pdf' }],
    sensitive: 'notice-and-opt-out',
  },
  DE: {
    state: 'DE',
    name: 'Delaware Personal Data Privacy Act',
    citation: '6 Del. C. ch. 12D',
    urls: [{ href: 'https://delcode.delaware.gov/title6/c012d/index.html' }],
    sensitive: 'opt-in',
  },
  NE: {
    state: 'NE',
    name: 'Nebraska Data Privacy Act',
    citation: 'Neb. Rev. Stat. §87-1101 et seq.',
    urls: [{ href: 'https://nebraskalegislature.gov/laws/statutes.php?statute=87-1101' }],
    sensitive: 'opt-in',
  },
  NH: {
    state: 'NH',
    name: 'New Hampshire Data Privacy Act',
    citation: 'N.H. Rev. Stat. Ann. ch. 507-H',
    urls: [{ href: 'https://www.gencourt.state.nh.us/rsa/html/LII/507-H/507-H-mrg.htm' }],
    sensitive: 'opt-in',
  },
  NJ: {
    state: 'NJ',
    name: 'New Jersey Data Privacy Act',
    citation: 'N.J. Stat. §56:8-166.4 et seq.',
    urls: [{ href: 'https://www.njconsumeraffairs.gov/ocr/Pages/data-privacy.aspx' }],
    sensitive: 'opt-in',
  },
  TN: {
    state: 'TN',
    name: 'Tennessee Information Protection Act',
    citation: 'Tenn. Code Ann. §47-18-3201 et seq.',
    urls: [{ href: 'https://www.tn.gov/attorneygeneral/working-for-tennessee/tennessee-information-protection-act.html' }],
    sensitive: 'opt-in',
  },
  MN: {
    state: 'MN',
    name: 'Minnesota Consumer Data Privacy Act',
    citation: 'Minn. Stat. ch. 325O',
    urls: [{ href: 'https://www.revisor.mn.gov/statutes/cite/325O' }],
    sensitive: 'opt-in',
  },
  MD: {
    state: 'MD',
    name: 'Maryland Online Data Privacy Act',
    citation: 'Md. Code, Com. Law §14-4701 et seq.',
    urls: [{ href: 'https://mgaleg.maryland.gov/mgawebsite/Laws/StatuteText?article=gcl&section=14-4707&enactments=false' }],
    sensitive: 'sale-banned',
  },
  IN: {
    state: 'IN',
    name: 'Indiana Consumer Data Protection Act',
    citation: 'Ind. Code art. 24-15',
    urls: [{ href: 'https://iga.in.gov/pdf-documents/123/2023/senate/bills/SB0005/SB0005.05.ENRS.pdf' }],
    sensitive: 'opt-in',
  },
  KY: {
    state: 'KY',
    name: 'Kentucky Consumer Data Protection Act',
    citation: 'Ky. Rev. Stat. §367.3611 et seq.',
    urls: [{ href: 'https://apps.legislature.ky.gov/law/acts/24RS/documents/0072.pdf' }],
    sensitive: 'opt-in',
  },
  RI: {
    state: 'RI',
    name: 'Rhode Island Data Transparency and Privacy Protection Act',
    citation: 'R.I. Gen. Laws ch. 6-48.1',
    urls: [{ href: 'https://webserver.rilegislature.gov/Statutes/TITLE6/6-48.1/6-48.1-4.htm' }],
    sensitive: 'opt-in',
  },
  OK: {
    state: 'OK',
    name: 'Oklahoma Consumer Data Privacy Act (SB 546)',
    citation: 'Okla. Sess. Laws 2025, SB 546',
    urls: [{ href: 'https://www.oklegislature.gov/cf_pdf/2025-26%20ENR/SB/SB546%20ENR.PDF' }],
    sensitive: 'opt-in',
  },
  LA: {
    state: 'LA',
    name: 'Louisiana Consumer Privacy Act (SB 386)',
    citation: 'La. Acts 2026, SB 386',
    urls: [{ href: 'https://legis.la.gov/' }],
    sensitive: 'opt-in',
  },
  AL: {
    state: 'AL',
    name: 'Alabama Personal Data Protection Act (HB 351)',
    citation: 'Ala. Acts 2026, HB 351',
    urls: [{ href: 'https://alison.legislature.state.al.us/files/pdf/SearchableInstruments/2026RS/HB351-enr.pdf' }],
    sensitive: 'opt-in',
  },
  VT: {
    state: 'VT',
    name: 'Vermont Data Privacy and Online Surveillance Act (S.71)',
    citation: 'Vt. Acts 2026, S.71',
    urls: [{ href: 'https://legislature.vermont.gov/' }],
    sensitive: 'opt-in',
  },
};

/** USPS code → state name, for labels ("Opt-out (Virginia)"). */
export const US_STATE_NAMES: Readonly<Record<string, string>> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska',
  NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
  ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', PR: 'Puerto Rico', GU: 'Guam',
  VI: 'U.S. Virgin Islands', AS: 'American Samoa', MP: 'Northern Mariana Islands',
};

/** The act for a state with its dates, or undefined when the state has none. */
export function usStateAct(region: string): (UsStatePrivacyAct & { from: string; gpcFrom?: string }) | undefined {
  const st = region.trim().toUpperCase().replace(/^US[-_]/, '');
  const dates = US_PRIVACY_ACT_STATES.find((s) => s.state === st);
  const act = US_STATE_PRIVACY_ACTS[st];
  if (!dates || !act) return undefined;
  return { ...act, from: dates.from, ...(dates.gpcFrom ? { gpcFrom: dates.gpcFrom } : {}) };
}
