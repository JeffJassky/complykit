import type { Requirement } from '../schema.js';
import { asRequirementId, asInstrumentId } from '../ids.js';

// GDPR consent + notice surface. Seed set; the dark-pattern/consent family
// expands at M3. Official text is EU public domain. Authority refs point at
// EDPB guidance that sharpens the obligation (e.g. dark-pattern guidelines).

const GDPR = asInstrumentId('gdpr');
const GDPR_EFFECTIVE = '2018-05-25';

export const GDPR_REQUIREMENTS: Requirement[] = [
  {
    id: asRequirementId('gdpr.art7.3'),
    instrument: GDPR,
    citation: { kind: 'article', article: 7, paragraph: 3 },
    title: 'Withdrawal of consent',
    text: 'The data subject shall have the right to withdraw consent at any time. It shall be as easy to withdraw as to give consent.',
    authority: [{ ref: 'edpb-03-2022', note: 'click-asymmetry treated as a dark pattern' }],
    urls: [{ href: 'https://eur-lex.europa.eu/eli/reg/2016/679/oj', botBlocked: true }],
    effective: { from: GDPR_EFFECTIVE },
    appliesIf: ['processes-personal-data', 'targets-eu'],
    severity: 'critical',
  },
  {
    id: asRequirementId('gdpr.art7.4'),
    instrument: GDPR,
    citation: { kind: 'article', article: 7, paragraph: 4 },
    title: 'Freely given consent',
    text: 'When assessing whether consent is freely given, account shall be taken of whether performance of a service is conditional on consent to processing that is not necessary for that service.',
    authority: [{ ref: 'edpb-05-2020', note: 'consent must be a genuine choice; no forced/bundled consent' }],
    urls: [{ href: 'https://eur-lex.europa.eu/eli/reg/2016/679/oj', botBlocked: true }],
    effective: { from: GDPR_EFFECTIVE },
    appliesIf: ['processes-personal-data', 'targets-eu'],
    severity: 'serious',
  },
  {
    id: asRequirementId('gdpr.art13'),
    instrument: GDPR,
    citation: { kind: 'article', article: 13 },
    title: 'Information to be provided where personal data are collected',
    text: 'Where personal data are collected from the data subject, the controller shall, at the time the data are obtained, provide the identity of the controller, the purposes and legal basis of processing, recipients, retention period, and the data subject rights.',
    urls: [{ href: 'https://eur-lex.europa.eu/eli/reg/2016/679/oj', botBlocked: true }],
    effective: { from: GDPR_EFFECTIVE },
    appliesIf: ['processes-personal-data', 'targets-eu'],
    severity: 'serious',
  },
];
