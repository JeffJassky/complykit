import { createRequire } from 'node:module';
import fs from 'node:fs';
import type { Page } from 'playwright';
import type { Artifact, Subject } from '../../record/index.js';

// Family A: the axe-core rules-engine pass, injected into the live DOM. In the
// rendered page this supersedes the static layer's template checks —
// accessible-name computation runs for real, ARIA refs resolve, label
// associations work across component boundaries. axe results map through the
// registry engine table; axe's `incomplete` becomes needs-review (a feature).
//
// axe-core is a regular dep (injected, not a peer). Its version is pinned to
// match the registry mapping table; test/axe-drift.test.ts guards the pairing.

const require = createRequire(import.meta.url);

let axeSourceCache: string | undefined;
function axeSource(): string {
  if (axeSourceCache === undefined) {
    axeSourceCache = fs.readFileSync(require.resolve('axe-core'), 'utf8');
  }
  return axeSourceCache;
}

interface AxeNode {
  target?: string[];
  html?: string;
  failureSummary?: string;
}
interface AxeRuleResult {
  id: string;
  impact?: string | null;
  help?: string;
  nodes: AxeNode[];
}
interface AxeRun {
  violations: AxeRuleResult[];
  incomplete: AxeRuleResult[];
  testEngine?: { name: string; version: string };
}

export async function runAxe(page: Page, subject: Subject, capturedAt: string): Promise<Artifact> {
  await page.addScriptTag({ content: axeSource() });
  const result = (await page.evaluate(async () => {
    // @ts-expect-error axe is injected into the page global at runtime.
    const r = await axe.run(document, {
      resultTypes: ['violations', 'incomplete'],
      // Element refs come back as CSS-path targets; enough to anchor evidence.
      elementRef: false,
    });
    return {
      violations: r.violations,
      incomplete: r.incomplete,
      testEngine: r.testEngine,
    };
  })) as AxeRun;

  return {
    kind: 'axe-result',
    subject,
    capturedAt,
    results: result as unknown as Record<string, unknown>,
  };
}
