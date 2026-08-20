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
| `report` | Render a run — `--format jsonl \| md`, `--run <id>`, `--out <file>`. |
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
