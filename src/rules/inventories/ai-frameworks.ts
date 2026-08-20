import { makeInventoryRule } from './inventory-rule.js';

// An AI framework in the codebase is a lead for EU AI Act Art. 50: if the site
// surfaces AI output or interaction, transparency obligations attach. The static
// layer can only see the dependency; the browser + LLM layers confirm whether a
// disclosure is actually present. needs-review by construction.
export const inventoryAiFrameworks = makeInventoryRule({
  id: 'inventory.ai-framework',
  category: 'ai-framework',
  requirement: 'eu-ai-act.art50.1',
  remediation:
    'If this AI system interacts with users or generates content shown to them, ensure a clear AI-interaction disclosure and, for generated media, machine-readable marking (Art. 50).',
  falsePositives:
    'Purely internal AI tooling (build scripts, tests) with no user-facing output does not trigger Art. 50 — dispose as not-applicable.',
  message: (name) => `AI framework "${name}" is used — verify EU AI Act Art. 50 disclosure obligations apply and are met.`,
});
