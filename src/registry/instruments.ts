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
];
