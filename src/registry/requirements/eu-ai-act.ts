import type { Requirement } from '../schema.js';
import { asRequirementId, asInstrumentId } from '../ids.js';

// EU AI Act Article 50 — transparency obligations for providers and deployers.
// Enforceable from 2 Aug 2026 (README). Obligations sharpened by the
// Commission's guidelines and the Code of Practice (labelling icon set). This
// is verified-greenfield: no existing tool checks Art. 50 against a rendered
// page. `volatile: true` — guidance is still settling; recheck each release.

const AIACT = asInstrumentId('eu-ai-act');
const AIACT_EFFECTIVE = '2026-08-02';

export const EU_AI_ACT_REQUIREMENTS: Requirement[] = [
  {
    id: asRequirementId('eu-ai-act.art50.1'),
    instrument: AIACT,
    citation: { kind: 'article', article: 50, paragraph: 1 },
    title: 'Disclosure of interaction with an AI system',
    text: 'Providers shall ensure that AI systems intended to interact directly with natural persons are designed so that the persons concerned are informed that they are interacting with an AI system, unless obvious from the circumstances.',
    authority: [{ ref: 'ec-guidelines-2026-07-20', note: 'Art. 50 transparency guidelines' }],
    urls: [{ href: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj', botBlocked: true }],
    effective: { from: AIACT_EFFECTIVE },
    appliesIf: ['has-ai-features'],
    severity: 'serious',
    volatile: true,
  },
  {
    id: asRequirementId('eu-ai-act.art50.2'),
    instrument: AIACT,
    citation: { kind: 'article', article: 50, paragraph: 2 },
    title: 'Marking of AI-generated content',
    text: 'Providers of AI systems generating synthetic audio, image, video or text content shall ensure the outputs are marked in a machine-readable format and detectable as artificially generated or manipulated.',
    authority: [{ ref: 'ec-code-of-practice-2026-06-10', note: 'labelling / marking icon set' }],
    urls: [{ href: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj', botBlocked: true }],
    effective: { from: AIACT_EFFECTIVE },
    appliesIf: ['has-ai-features'],
    severity: 'serious',
    volatile: true,
  },
];
