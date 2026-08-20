// Adjudication rubrics for the mode-1 (targeted) C1 pass, keyed by requirement.
// Each is one narrow question about a small crop with a strict verdict schema —
// never a rule-dump (vision-analysis-design). rubricVersion is part of the cache
// key, so tightening a prompt invalidates only that rubric's cached verdicts.

export interface AdjudicationRubric {
  requirementId: string;
  ruleId: string; // the llm rule id stamped on resulting findings
  rubricVersion: string;
  prompt: string;
}

export const ADJUDICATION_RUBRICS: Record<string, AdjudicationRubric> = {
  'wcag22.1.4.3': {
    requirementId: 'wcag22.1.4.3',
    ruleId: 'contrast.text-adjudicated',
    rubricVersion: '2026-08-19.1',
    prompt: [
      'You are auditing one small crop of a web page for WCAG 1.4.3 text contrast.',
      'The background here is not a flat colour (image/gradient/overlap), so a ratio',
      'could not be computed deterministically. Judge only what you can see in THIS crop.',
      'Answer "violation" if the text is hard to read against its background (clearly',
      'below the 4.5:1 / 3:1 threshold), "pass" if it reads clearly, "unclear" if you',
      'cannot tell. Do not report anything other than the text contrast in this crop.',
    ].join(' '),
  },
};

export function rubricFor(requirementId: string): AdjudicationRubric | undefined {
  return ADJUDICATION_RUBRICS[requirementId];
}
