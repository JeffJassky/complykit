# Quickstart

## Install

```bash
npm install --save-dev @jeffjassky/complykit
```

Playwright (browser layer) and `@anthropic-ai/sdk` (LLM review) are **optional
peers** — install them only when you need those layers:

```bash
npm install --save-dev playwright @anthropic-ai/sdk
```

Without Playwright, `scan`'s browser collection is skipped and recorded as a
coverage gap; the static layer, reports, and diffs still work. Without an
Anthropic key, LLM review is skipped and `needs-review` findings surface as the
manual slice.

## Zero-config scan

No config file is required for a one-off public scan:

```bash
npx complykit scan --url https://example.com
```

That builds a synthetic single-property config (public target, sitemap + crawl
route discovery, default viewports, the `wcag22aa` ruleset) and writes a run
under `.comply/runs/`.

## With a config file

```bash
npx complykit init          # writes complykit.config.js + comply.dispositions.yaml
npx complykit scan
```

## Report, diff, gate

```bash
npx complykit report --format md          # human summary of the latest run
npx complykit diff --base <runId> --head <runId> --fail-on new-critical
npx complykit coverage --ruleset wcag22aa
```

`diff` exits non-zero when new findings trip the budget — wire it into CI to
fail a merge on **new** criticals, not on absolute zero.

## Verify the registry

```bash
npx complykit registry verify
```

Lists any requirement whose source needs a human verification click, and any
`volatile` entry to recheck this release.
