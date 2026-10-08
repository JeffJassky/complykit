import type { Instrument } from './schema.js';
import { asInstrumentId } from './ids.js';

// The legal instruments. Cross-instrument incorporation is data, not
// duplication (registry-design.md): EN 301 549 incorporates WCAG, so one WCAG
// entry serves many legal on-ramps via `incorporates` edges.

export const INSTRUMENTS: Instrument[] = [
  {
    id: asInstrumentId('wcag'),
    name: 'Web Content Accessibility Guidelines',
    jurisdiction: ['international'],
    textLicense: 'W3C Document License (normative text reproducible with attribution)',
  },
  {
    id: asInstrumentId('en-301-549'),
    name: 'EN 301 549 — Accessibility requirements for ICT products and services',
    jurisdiction: ['eu'],
    textLicense: 'ETSI/CEN — reproduction per standard terms',
    incorporates: [
      { instrument: asInstrumentId('wcag'), filter: { version: '2.1', maxLevel: 'AA' } },
    ],
  },
  {
    id: asInstrumentId('ada'),
    name: 'Americans with Disabilities Act (Title II web rule)',
    jurisdiction: ['us'],
    textLicense: 'US public domain',
    incorporates: [
      { instrument: asInstrumentId('wcag'), filter: { version: '2.1', maxLevel: 'AA' } },
    ],
  },
  {
    id: asInstrumentId('gdpr'),
    name: 'General Data Protection Regulation (EU 2016/679)',
    jurisdiction: ['eu'],
    textLicense: 'EU public domain (official text)',
  },
  {
    id: asInstrumentId('eu-ai-act'),
    name: 'EU Artificial Intelligence Act (EU 2024/1689)',
    jurisdiction: ['eu'],
    textLicense: 'EU public domain (official text)',
  },
  // Consent & tracking by visitor location (requirements/tracking.ts).
  {
    id: asInstrumentId('eprivacy'),
    name: 'ePrivacy Directive (2002/58/EC, as amended by 2009/136/EC)',
    jurisdiction: ['eu'],
    textLicense: 'EU public domain (official text)',
  },
  {
    id: asInstrumentId('pecr'),
    name: 'Privacy and Electronic Communications Regulations 2003 (as amended by the Data (Use and Access) Act 2025)',
    jurisdiction: ['uk'],
    textLicense: 'Open Government Licence v3.0',
  },
  {
    id: asInstrumentId('uk-gdpr'),
    name: 'UK General Data Protection Regulation',
    jurisdiction: ['uk'],
    textLicense: 'Open Government Licence v3.0',
  },
  {
    id: asInstrumentId('ccpa'),
    name: 'California Consumer Privacy Act (Civ. Code §1798.100 et seq.) and regulations (11 CCR §7000 et seq.)',
    jurisdiction: ['us-ca'],
    textLicense: 'US state government text — paraphrased; quote sparingly',
  },
  {
    id: asInstrumentId('us-state-privacy'),
    name: 'US state comprehensive privacy laws (opt-out rights, universal opt-out mechanisms)',
    jurisdiction: ['us'],
    textLicense: 'US state government texts — paraphrased',
  },
  {
    id: asInstrumentId('cipa'),
    name: 'California Invasion of Privacy Act (Penal Code §630 et seq.) — litigation exposure',
    jurisdiction: ['us-ca'],
    textLicense: 'US state government text — paraphrased',
  },
  {
    id: asInstrumentId('fsca'),
    name: 'Florida Security of Communications Act (Fla. Stat. ch. 934) — litigation exposure',
    jurisdiction: ['us-fl'],
    textLicense: 'US state government text — paraphrased',
  },
  {
    id: asInstrumentId('wesca'),
    name: 'Pennsylvania Wiretapping and Electronic Surveillance Control Act — litigation exposure',
    jurisdiction: ['us-pa'],
    textLicense: 'US state government text — paraphrased',
  },
  {
    id: asInstrumentId('enforcement-practice'),
    name: 'Regulator-ordered practices (not statutes)',
    jurisdiction: ['any'],
    textLicense: 'summaries of public orders',
  },
];
