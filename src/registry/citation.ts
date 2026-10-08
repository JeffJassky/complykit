import type { Requirement } from './schema.js';
import { INSTRUMENTS } from './instruments.js';

// One short, human label per requirement citation ("ePrivacy Directive Art. 5(3)",
// "11 CCR §7025(b)–(c)", "Cal. Penal Code §631(a)"). Lives in the registry so the
// report and the location popover (describe.ts) print the same string.

const SHORT_INSTRUMENT: Record<string, string> = {
  eprivacy: 'ePrivacy Directive',
  gdpr: 'GDPR',
  'uk-gdpr': 'UK GDPR',
  pecr: 'PECR',
  ccpa: 'CCPA regs',
  'us-state-privacy': 'State privacy laws',
  cipa: 'CIPA',
  fsca: 'Fla. ch. 934',
  wesca: 'PA WESCA',
  'enforcement-practice': 'Regulator orders',
};

export function citationLabel(req: Requirement): string {
  const id = String(req.instrument);
  const inst = SHORT_INSTRUMENT[id] ?? INSTRUMENTS.find((i) => String(i.id) === id)?.name ?? id;
  const c = req.citation;
  switch (c.kind) {
    case 'article':
      return `${inst} Art. ${c.article}${c.paragraph ? `(${c.paragraph})` : ''}${c.point ? `(${c.point})` : ''}`;
    case 'sc':
      return `WCAG ${c.principle}.${c.guideline}.${c.sc}`;
    case 'clause':
      return `${inst} ${c.clause}`;
    case 'section':
      return `${c.title} CCR §${c.section}`;
    case 'statute':
      return `${c.code} ${c.section}`;
  }
}
