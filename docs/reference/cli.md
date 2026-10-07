# CLI reference

```
complykit <command> [options]
```

Run `complykit help` for the summary, or `complykit <command> --help`.

## Commands

| Command | What it does |
|---|---|
| `init` | Write a starter `complykit.config.js` + `comply.dispositions.yaml`. |
| `scan` | Collect artifacts, evaluate rules, write a run. Zero-config: `scan --url <url>`. |
| `consent` | Consent & tracking evaluation by visitor location — see [the guide](/guide/consent). Zero-config: `consent --url <url>`. |
| `consent-config` | The consent tool's config, `<head>` snippet and change list from a consent run — see [`consent-config`](#consent-config). |
| `report` | Render a run — `--format jsonl \| md \| sarif \| html`, `--run <id>`, `--out <file>`. `html` is a single self-contained file (plain-language action plans, collapsed evidence and filters) that opens from disk. Consent runs: `--format consent-html \| consent-md \| consent-json \| consent-changes`; `--workspace <file>` re-renders the saved run with the site workspace's current classifications (compatibility section, change list, checklist — nothing is rescanned; a necessary classification of a known tracker is refused as the generator refuses it), `--previous <run dir>` picks the run for "Since" (default: the newest earlier run of the site in `.comply/runs`), `--kb-dir` the knowledge-base store. `consent-html` with `--out` also writes `change-list.md` and the model `.json` beside it. |
| `verify-change` | Check one change from the guided checklist against the live page — see [`verify-change`](#verify-change). |
| `review` | Adjudicate the needs-review queue with C1 (LLM crop verdicts). `--dry` previews the queue with no API call; needs `ANTHROPIC_API_KEY` to run. |
| `diff` | Compare two runs by fingerprint. Exits non-zero on a budget breach. |
| `coverage` | Requirement coverage for a `--ruleset`. |
| `finding add` | Validate + fingerprint a finding into a run (the agent gateway). |
| `static` | Static layer only — point at a repo, get an in-PR run with no server or browser. |
| `fixtures record` | Record collector artifacts as rule test fixtures (static now; browser with M2). |
| `registry verify` | Validate the registry; list items needing a human check. |
| `runs` | List recorded runs. |
| `routes` / `review` / `auth` | Land in later milestones. |

## `scan`

```bash
complykit scan --url https://example.com     # zero-config, single public property
complykit scan                                # uses complykit.config.js
complykit scan --property shop --config ./ci.config.js
```

## `consent`

```bash
complykit consent --url https://shop.example.com                 # this machine's location
complykit consent --url https://shop.example.com --quick         # first look
complykit consent --locations de,us-ca --proxy de=socks5://127.0.0.1:1081 \
  --proxy us-ca=http://gluetun-ca:8888 --authorized               # verified remote exits
complykit consent --scenarios reject,accept,withdraw              # override the scenario sets
```

| Option | |
|---|---|
| `--locations a,b` | `local`, a country (`de`, `uk`), a US state (`us-ca`), or ids from the config |
| `--proxy id=server` | route a location through a proxy (repeatable); requires `--authorized` |
| `--scenarios a,b` | override every location's default set |
| `--quick` | shorter visits, reduced scenario set |
| `--raw-evidence` | keep cookie values, auth headers and bodies in evidence (default redacted) |
| `--no-har` | skip the HAR export |
| `--concurrency N` | scenarios in parallel per location (default 1, for timing fidelity) |
| `--runs N` | visits per scenario, 1 to 5 (default 1). Each run after the first is throttled (Slow 3G, 4x CPU) to catch trackers that only fire when the consent tool loads slowly. A tool active in any run counts as active; the report says "Active in 1 of 2 runs". A throttled run gets three times the 300 s scenario budget (`throttledBudgetFactor` in the API); one that still runs out is listed as not tested for that run, and the first run stands. See [What a scan cannot tell you](/guide/limits#n-of-n-runs). |
| `--workspace <file>` | the site's workspace JSON (the service's `GET /api/sites/<domain>/workspace`): its tool and cookie classifications apply to this run, and done tasks carry into the report. Applies to this run only; it never changes the shared knowledge base. |
| `--previous <run dir>` | the run to compare with for the report's "Since" section. Default: the newest earlier consent run of the same site in `.comply/runs`. |
| `COMPLYKIT_BROWSER_CHANNEL=chrome` (env) | drive an installed Chrome / Edge (`msedge`) through Playwright instead of its own Chromium — for machines without the Playwright browser download. The trace names the browser and version used. |
| `COMPLYKIT_BROWSER_ARGS` (env) | extra Chromium flags, space-separated before each `--` (e.g. `--host-resolver-rules=MAP shop.example.test 127.0.0.1:8080`) — for scanning a local test site; `verify-change` reads it too. |
| `--local-copy <file>` | **Test mode.** Apply a change set to the site inside the scanner's own browser only — the generated snippet first in `<head>`, the change list's tag rewrites, the tool's files served from disk at the snippet's path, simulated tag-manager consent settings — and scan that copy. Nothing is installed on the site. The record carries what was applied, the report leads with "LOCAL COPY — not the live site", and the run is listed as not tested against the live site. Spec format: [Local-copy mode](/guide/consent#local-copy-mode). |
| `--out <file>` | HTML report path (default `<run>/consent-report.html`) |

### Re-rendering a consent run

```bash
complykit report --run <id> --format consent-html --out report.html   # also writes change-list.md beside it
complykit report --run <id> --format consent-changes --out change-list.md
complykit report --run <id> --format consent-html --workspace workspace.json --out report.html   # with the current classifications
```

With `--workspace`, the saved run is read again with the site's current
classifications: the compatibility section, the change list and the matrix
purposes follow them, in seconds, without a rescan. The report records which
classifications it applied; served by the service, it offers **Update report
with my classifications** (`POST /api/jobs/:id/rerender`) once they change.
Opened from disk, it offers the classifications made in that browser as a
workspace file for this command.

`consent-changes` is the owner's change list as Markdown: tags to rewrite, GTM
tags to gate, leaks to remove and the rest, with behavior mismatches first. It is
written automatically beside the HTML report as `change-list.md`. See
[Compatibility verdicts](/guide/compatibility).

## `consent-config`

```bash
complykit consent-config .comply/runs/<run-id>                    # writes <run>/consent-config/
complykit consent-config <run-dir> --workspace workspace.json --script-src /assets/complykit/complykit-consent.js
```

Generates the consent tool's config, the `<head>` snippet, the change list and
`generator-notes.md` from a consent run. Options (`--workspace`, `--out`, `--kb-dir`,
`--script-src`, `--record-endpoint`, `--privacy-policy`, `--regime-source`, `--json`)
are listed by `complykit consent-config --help`. What to do with the output:
[Installing the consent tool](/guide/consent-tool).

## `verify-change`

```bash
complykit verify-change --task task.json --json            # one task object from consent-config --json's "tasks"
complykit verify-change --workspace workspace.json --id <task id> --site example-shop.test
```

Verifies **one** remediation task. Static checks fetch the page's served HTML (or the
published Google Tag Manager container) through a browser context, at most 20 seconds,
no scan. A browser spot check loads one page twice, refusing then accepting through the
installed tool, at most 60 seconds. A manual task is always `cannot-verify`. If the site
answers with a bot challenge (Cloudflare, Akamai, PerimeterX, DataDome, Sucuri, Imperva)
instead of its page, the result is `cannot-verify`; no checker runs on the challenge.

| Option | |
|---|---|
| `--task <file\|->` | the task JSON (a task, or its `verify` spec); `-` reads stdin |
| `--workspace <file>` `--id <task id>` | alternatively, take the task from the workspace's stored config (`config.value.tasks`) |
| `--site <domain>` | the site's registrable domain (default: from the page URL) |
| `--kb-dir <path>` | knowledge-base store whose confirmed entries apply |
| `--json` | print `{ result, message, evidence, at, check, id?, fetched?, observation? }` |

`COMPLYKIT_BROWSER_CHANNEL=chrome` uses installed Chrome; `COMPLYKIT_BROWSER_ARGS` adds
Chromium flags. Exit 0 whenever a result was produced (`pass`, `fail` or `cannot-verify`),
2 on bad input. A pass proves the served markup carries the change (for a spot check, one
page and one visit), not behavior across the site; the rescan is that proof. The full
flow: [From scan to verified install](/guide/remediation).

## `finding add`

Agents and scripts never write `findings.jsonl` directly — they pipe a raw
finding here, which validates the schema, caps confidence by the rule's declared
maximum, computes the frozen fingerprint, and stamps the producer.

```bash
complykit finding add --run <runId> --producer agent --model claude \
  --rubric-version 2026-08-19.1 --file finding.json
# or: --json '{...}', or pipe JSON on stdin
```

`--producer` is `agent` (default), `rule`, or `engine`.

## `diff` as a CI gate

```bash
complykit diff --base <baselineRunId> --head <thisRunId> --fail-on new-critical
```

Exit `1` when new findings at or above the severity floor appear; `0` otherwise.
`--fail-on` is `new-critical` (default), `new-serious`, or `none`.

JSON and consent JSON reports also include an additive `researchWorkflow` with
agent research questions and a report-specific answer schema. See
[Agent research](../guide/agent-research.md). Answers are separate work records;
they do not change scan findings or automatically update HTML progress.
