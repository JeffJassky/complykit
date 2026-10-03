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
| `report` | Render a run — `--format jsonl \| md \| sarif \| html`, `--run <id>`, `--out <file>`. `html` is a single self-contained file (inline evidence crops, filters) that opens from disk. Consent runs: `--format consent-html \| consent-md \| consent-json`. |
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
| `--out <file>` | HTML report path (default `<run>/consent-report.html`) |

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
