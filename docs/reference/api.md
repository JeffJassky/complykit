# Programmatic API

The CLI is the primary surface; the programmatic API is what it wires together,
and what CI scripts and a future SDK harness import. Writes are verbs, reads are
the noun.

```ts
import {
  defineConfig,
  evaluate,        // pure: (artifacts, rules, ctx) => RawFinding[]
  addFinding,      // validate + fingerprint into a run
  loadRun, listRuns,
  diffRuns, budgetBreaches,
  renderReport,    // 'jsonl' | 'md' | (sarif M1, html M5)
  coverage,
} from '@jeffjassky/complykit';
```

## Root export is dep-light

The root (`.`) pulls in the record format, registry, pure rules, and report
renderers — **no Playwright, no Anthropic SDK**. CI diff/report tooling imports
it without Chromium. The heavy collectors live behind subpath exports:

| Subpath | Behind | Contains |
|---|---|---|
| `@jeffjassky/complykit` | — | record, registry, rules, report, config |
| `@jeffjassky/complykit/registry` | — | the pure legal data + `verifyRegistry` |
| `@jeffjassky/complykit/collect-static` | — | file discovery, ESLint / a11y-plugin runner, inventories |
| `@jeffjassky/complykit/collect-browser` | `playwright` peer *(M2)* | Playwright collectors |
| `@jeffjassky/complykit/judge` | `@anthropic-ai/sdk` peer *(M4)* | the LLM adjudication harness |

## Rules are pure functions over artifacts

A rule is `(artifacts) => RawFinding[]` — no browser handle, no filesystem, no
network. Collectors produce artifacts; rules evaluate them. This is what makes
every rule testable from recorded fixtures with no Chromium in the suite, and it
is enforced mechanically (a rule importing a collector fails CI).

```ts
import { evaluate, ALL_RULES } from '@jeffjassky/complykit';

const raw = evaluate(artifacts, ALL_RULES, { property: 'shop', tags: ['targets-eu'] });
```

## Adding a finding

```ts
import { addFinding } from '@jeffjassky/complykit';

const finding = addFinding(rawFinding, {
  runId,
  producer: { type: 'agent', model: 'claude', rubricVersion: '2026-08-19.1' },
});
// confidence is capped by the rule; severity narrows, never raises; fingerprint is frozen.
```
