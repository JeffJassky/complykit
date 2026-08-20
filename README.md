# @jeffjassky/complykit

Compliance-audit toolkit for web properties: **ADA / WCAG 2.2** accessibility,
**GDPR** consent behaviour and dark patterns, and **EU AI Act Article 50**
transparency. It reports **findings, evidence, and coverage** — and never asserts
that a site is "compliant".

> Docs: <https://jeffjassky.github.io/complykit/>

## Install

```bash
npm install --save-dev @jeffjassky/complykit
```

`playwright` (browser layer) and `@anthropic-ai/sdk` (LLM review) are **optional
peers** — install them only for those layers. Without them, the static layer,
reports, and diffs still work; the skipped layers are recorded as coverage gaps.

## Zero-config scan

```bash
npx complykit scan --url https://example.com
npx complykit report --format md
```

No config file needed for a one-off public scan. For a tracked property:

```bash
npx complykit init      # complykit.config.js + comply.dispositions.yaml
npx complykit scan
npx complykit diff --base <runId> --head <runId> --fail-on new-critical   # CI gate
```

## What it produces

Runs, findings, and evidence land as files under `.comply/runs/` — one
`findings.jsonl` line per finding, content-addressed evidence, a `run.json`
stating which access levels and rules actually executed. The record format is the
product; git, a laptop, or a scheduled agent can all produce and read it.

- **The citation is the finding's type** — a WCAG success criterion, a GDPR
  article, an AI Act paragraph. No invented violation taxonomy.
- **Findings have a frozen fingerprint** that survives CSS refactors and collapses
  variants (dark/light, viewports) onto one line.
- **No producer inflates its own authority** — axe, a rule, or an agent, every
  finding is normalized through one gatekeeper that caps confidence and narrows
  (never raises) severity.

## Layers

| Layer | Behind | Status |
|---|---|---|
| record + registry + rules + report | — | ✅ |
| static (ESLint / a11y plugins, inventories) | — | ✅ |
| browser passive (Playwright: axe, contrast flat + pixel-band, screenshots, DOMSnapshot) | `playwright` | ✅ |
| browser probes + GDPR consent evidence | `playwright` | M3 |
| LLM review (crop adjudication, tiled sweep) | `@anthropic-ai/sdk` | M4–M5 |

## Not in scope

No hosted service or web UI. No "compliant" verdicts or legal advice. No
auto-remediation or overlay injection. No CAPTCHA / bot-defense evasion — a
blocked page is a recorded coverage gap. See the docs for the full non-goals.

## License

MIT © Jeff Jassky
