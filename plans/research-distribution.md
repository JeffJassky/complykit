# Research: Cross-platform distribution for AI-agent compliance skills

Verified August 2026 by web research. Companion docs: `research-existing-tools.md`,
`research-compliance-sources.md`.

---

## 1. The Agent Skills standard

**Status:** Agent Skills is now a genuine cross-vendor open standard. Originally
developed by Anthropic and released as an open spec, it lives at
[agentskills.io](https://agentskills.io) with the spec text and reference tooling at
[github.com/agentskills/agentskills](https://github.com/agentskills/agentskills), open
to ecosystem contributions (Discord + GitHub governance). Secondary sources date the
open-standard release to December 18, 2025
([paperclipped.de](https://www.paperclipped.de/en/blog/agent-skills-open-standard-interoperability/)
— UNVERIFIED exact date). Separately, the Linux Foundation formed the Agentic AI
Foundation on Dec 9, 2025 with MCP, goose, and AGENTS.md as anchor projects
([linuxfoundation.org press release](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation));
whether the Agent Skills spec itself is under AAIF governance is UNVERIFIED — the spec
site only says "open standard, open to contributions."

**Structure** (from the [specification](https://agentskills.io/specification)):

```
skill-name/
├── SKILL.md          # Required: YAML frontmatter + markdown instructions
├── scripts/          # Optional: executable code (Python/Bash/JS, agent-dependent)
├── references/       # Optional: docs loaded on demand
├── assets/           # Optional: templates, data files
```

Frontmatter fields:

| Field | Required | Notes |
|---|---|---|
| `name` | Yes | ≤64 chars, lowercase alnum + hyphens, must match directory name |
| `description` | Yes | ≤1024 chars; what it does + when to use it |
| `license` | No | Short license name or bundled file reference |
| `compatibility` | No | ≤500 chars; environment requirements (packages, network) |
| `metadata` | No | Arbitrary string→string map — this is where version goes by convention |
| `allowed-tools` | No | Space-separated pre-approved tools. **Experimental**, support varies |

Progressive disclosure is normative: ~100 tokens of metadata at startup, full body
(<5k tokens recommended, SKILL.md under 500 lines) on activation, bundled files only as
needed. Validate with `skills-ref validate ./my-skill`.

**Adoption** (verified from the client list rendered on
[agentskills.io](https://agentskills.io) itself, each with its own docs URL):

| Agent | Adopted? | Source |
|---|---|---|
| Claude Code / Claude | Yes (originator) | [code.claude.com/docs/en/skills](https://code.claude.com/docs/en/skills) |
| ChatGPT & Codex (CLI + IDE + web) | **Yes** | [developers.openai.com/codex/skills](https://developers.openai.com/codex/skills) |
| Gemini CLI | **Yes** | [geminicli.com/docs/cli/skills](https://geminicli.com/docs/cli/skills/), [repo docs](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/skills.md) |
| Cursor | Yes | [cursor.com/docs/context/skills](https://cursor.com/docs/context/skills) |
| OpenCode | Yes | [opencode.ai/docs/skills](https://opencode.ai/docs/skills/) |
| Amp (Sourcegraph) | Yes | [ampcode.com/manual#agent-skills](https://ampcode.com/manual#agent-skills) |
| Goose (Block) | Yes | [goose docs](https://block.github.io/goose/docs/guides/context-engineering/using-skills/) |
| GitHub Copilot / VS Code | Yes | [docs.github.com](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills), [code.visualstudio.com](https://code.visualstudio.com/docs/copilot/customization/agent-skills) |
| Also | JetBrains Junie, Roo Code, Kiro, Factory, Trae (ByteDance), Mistral Vibe, Letta, OpenHands, Databricks, Snowflake Cortex Code, Spring AI, Tabnine, Qodo, Laravel Boost, ~45 total | agentskills.io client carousel |

Bottom line: **all three target CLIs (Claude Code, Codex CLI, Gemini CLI) natively read
SKILL.md** — the format question is settled; only install path and packaging differ.

---

## 2. Registries and installers

### skills.sh / `npx skills` (Vercel)

- CLI: [github.com/vercel-labs/skills](https://github.com/vercel-labs/skills);
  catalog/leaderboard: [skills.sh](https://www.skills.sh); docs:
  [skills.sh/docs/cli](https://www.skills.sh/docs/cli); Vercel guide:
  [vercel.com/kb/guide/agent-skills…](https://vercel.com/kb/guide/agent-skills-creating-installing-and-sharing-reusable-agent-context).
- Commands (from README):

  ```bash
  npx skills add owner/repo                      # interactive: pick skills + agents
  npx skills add owner/repo --skill '*' -a claude-code -a codex -y   # non-interactive
  npx skills add owner/repo -g                   # global (~/) instead of project
  npx skills add <source> --list                 # list without installing
  npx skills find <query>                        # search the ecosystem
  npx skills list                                # like npm ls
  npx skills update [skills...]                  # update installed skills
  npx skills remove <skill> -a cursor
  npx skills init my-skill                       # scaffold SKILL.md
  npx skills use owner/repo@skill | claude       # ephemeral, no install
  ```

- **Multi-agent mapping:** maintains a table of 75+ agents → directories (Claude Code
  `.claude/skills/` / `~/.claude/skills/`; Cursor & Cline `.agents/skills/`; OpenCode
  global `~/.config/opencode/skills/`; Codex, Copilot, Windsurf, Gemini, etc.). Default
  mechanism is a **symlink from each agent's dir to one canonical copy** ("single source
  of truth, easy updates"); `--copy` for filesystems without symlinks. It also
  understands Claude's `.claude-plugin/marketplace.json`/`plugin.json` for discovery.
- **Versioning/updates:** no version pinning; `npx skills update` re-pulls from git
  (plus `npx skills check` per the Vercel KB). The KB recommends `metadata` as "a good
  place for your semver." A `skills-lock.json` lockfile is referenced in ecosystem
  write-ups but is not in the current CLI docs — UNVERIFIED.
- **Reach:** listing on skills.sh is automatic once people install from your public
  GitHub repo (leaderboard is install-count driven). Catalog-size claims (90k–600k
  skills, GA June 5 2026) come only from secondary blogs
  ([agensi.io](https://www.agensi.io/learn/ai-agent-marketplace-landscape-2026)) —
  UNVERIFIED numbers.

### Claude Code plugin marketplaces

- Docs: [code.claude.com/docs/en/plugin-marketplaces](https://code.claude.com/docs/en/plugin-marketplaces).
  A repo with `.claude-plugin/marketplace.json` is a marketplace; users run:

  ```
  /plugin marketplace add your-org/compliance-skills
  /plugin install compliance-audits@your-marketplace
  ```

- Plugin sources: relative path, `github` (with `ref`/`sha` pinning), git `url`,
  `git-subdir` (sparse clone for monorepos), `npm` (with semver ranges + private
  registries), and `archive` (zip + `sha256`). Plugins bundle skills, agents, hooks,
  MCP/LSP servers. Teams can auto-prompt install via `extraKnownMarketplaces` in
  `.claude/settings.json`.
- **Versioning is first-class**: resolution order is `plugin.json version` →
  marketplace-entry `version` → git commit SHA → archive sha256; background
  **auto-update** exists, plus manual `/plugin update` and `/plugin marketplace update`;
  release channels via two marketplaces pointing at different refs; dependency
  constraints via `{plugin-name}--v{version}` git tags.
- Anthropic's own [anthropics/skills](https://github.com/anthropics/skills) repo is the
  canonical example: skills + spec + `.claude-plugin/` marketplace in one repo,
  installed via `/plugin marketplace add anthropics/skills`.

### Others

- **Smithery** ([smithery.ai](https://smithery.ai)) remains MCP-server-centric, not a
  SKILL.md registry — wrong tool for this
  ([agensi.io comparison](https://www.agensi.io/learn/complete-list-ai-agent-skill-directories-2026),
  secondary source).
- **Codex `$skill-installer`**: OpenAI ships a built-in installer skill that downloads
  curated skills ([developers.openai.com/codex/skills](https://developers.openai.com/codex/skills));
  no evidence third parties can register in that curated set — UNVERIFIED.
- Aggregators skills-hub.ai / agensi.io scrape public GitHub repos; you get listed
  passively.

**Comparison:** skills.sh has the widest cross-agent reach and the best one-command DX;
Claude plugin marketplaces have the best versioning/auto-update but are Claude-only;
Gemini extensions are Gemini-only. They are not mutually exclusive — one repo can serve
all three.

---

## 3. Per-platform native mechanisms

| | Claude Code | Codex CLI | Gemini CLI |
|---|---|---|---|
| Native SKILL.md | Yes | Yes | Yes |
| Project dir | `.claude/skills/` (walks parent dirs to repo root; nested dirs load contextually) | `.agents/skills/` (cwd, parents, repo root) | `.gemini/skills/` **or `.agents/skills/` alias** |
| User dir | `~/.claude/skills/` | `~/.agents/skills/` | `~/.gemini/skills/` **or `~/.agents/skills/` alias** |
| Install command | `/plugin marketplace add` + `/plugin install` (or file copy / symlink — symlinked skill dirs are officially supported) | none for arbitrary repos (`$skill-installer` for curated; otherwise copy files or use `npx skills`) | `gemini skills install <git-url> [--path <subdir>] [--scope user\|workspace] [--consent]`; also `gemini extensions install <repo> [--auto-update]` |
| Invocation | `/skill-name` or model-invoked | `$skill-name` or model-invoked; disable via `[[skills.config]]` in `~/.codex/config.toml` | model calls `activate_skill` with user consent prompt |
| Extras | Rich extra frontmatter (`allowed-tools`, `model`, `context: fork`, `hooks`, `paths`, `disable-model-invocation`); `${CLAUDE_SKILL_DIR}` var | optional `agents/openai.yaml` metadata; admin scope `/etc/codex/skills`; AGENTS.md still the repo-instructions standard | extensions (`gemini-extension.json`) bundle skills + TOML custom commands + MCP servers + GEMINI.md context |

Sources: [Claude Code skills doc](https://code.claude.com/docs/en/skills),
[Codex skills doc](https://developers.openai.com/codex/skills) (redirects to
learn.chatgpt.com/docs/build-skills),
[Gemini CLI skills doc](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/skills.md),
[Gemini extensions reference](https://geminicli.com/docs/extensions/reference/). Codex's
old `~/.codex/prompts/` custom-prompts dir is superseded by skills — UNVERIFIED whether
it still functions.

**Lowest common denominator:** a repo-committed **`.agents/skills/`** directory is read
natively by Codex and Gemini CLI (and Cursor, Cline, opencode). **Claude Code is the
holdout** — its official docs list only `.claude/skills/` variants (no `.agents/`
alias; third-party blog claims to the contrary are not supported by the official doc).
So the practical LCD is: canonical skills in the repo + a symlink or thin
`.claude/skills/` mapping — which is exactly what `npx skills add` automates.

---

## 4. Versioning & auto-update patterns

What exists today:

- **Spec level:** no first-class `version` field. Convention (shown in the
  [spec's own example](https://agentskills.io/specification) and endorsed by
  [Vercel's guide](https://vercel.com/kb/guide/agent-skills-creating-installing-and-sharing-reusable-agent-context))
  is `metadata: { version: "1.0" }`.
- **Claude plugins:** the most mature system — explicit `version` pinning in
  `plugin.json`/marketplace entry (bump-per-release semantics: users don't update until
  the string changes), git `ref`/`sha` pinning, sha256 archive pinning, **background
  auto-update**, `/plugin update`, release channels, and `{plugin}--v{semver}` git-tag
  dependency ranges ([plugin-marketplaces doc](https://code.claude.com/docs/en/plugin-marketplaces)).
- **Gemini extensions:** `version` in `gemini-extension.json`; installs are copies;
  `gemini extensions update <name>|--all`, plus opt-in `--auto-update` at install time
  ([extensions reference](https://geminicli.com/docs/extensions/reference/)).
  `gemini skills install` has no documented update command.
- **npx skills:** `npx skills update` / `npx skills check`; symlink model means
  updating the canonical copy updates every agent at once. No pinning.
- **Codex:** no update mechanism documented at all.

**Skill-self-update:** no established pattern found of a skill checking its own
upstream repo for updates and prompting the user — nothing in the spec, and none of the
four platforms document it (UNVERIFIED that no one does it, but it is not a standard).
Best-practice design if we want it:

1. Put semver in `metadata.version` in every SKILL.md and tag releases (`v1.2.0`) on
   GitHub.
2. Ship `scripts/check-update.mjs` that compares the local version against
   `https://api.github.com/repos/<org>/<repo>/releases/latest` (or a raw `VERSION`
   file, no rate-limit auth needed), caches the result for 24h, and prints a one-line
   "vX available — run: npx skills update" notice.
3. In each SKILL.md body, make step 0: "Run
   `node ${CLAUDE_SKILL_DIR}/scripts/check-update.mjs` (best-effort; continue on
   failure) and surface any update notice to the user." (`${CLAUDE_SKILL_DIR}` is
   Claude-specific; use a relative-path fallback for Codex/Gemini.) Prompt, never
   force — agents shouldn't self-modify installed files.
4. For heavy logic, skip the problem entirely: keep logic in an npm package invoked
   with `npx -y @org/tool@latest`, so every run is current (see below).

---

## 5. Recommendation

**Setup: one GitHub repo that is simultaneously (a) an Agent Skills package for
`npx skills`, (b) a Claude Code plugin marketplace, and (c) a Gemini CLI extension —
with all Node/Playwright logic in a published npm package that skills call via `npx`.**

The key constraint driving this: skills must be **self-contained folders**. Claude Code
copies plugins into a cache and forbids `../shared-utils` references
([plugin-marketplaces doc](https://code.claude.com/docs/en/plugin-marketplaces)), and
`npx skills` symlinks/copies individual skill folders. Shared Playwright helpers
therefore cannot live as a sibling directory the skills reach into — publish them to
npm and keep the skills thin.

```
compliance-skills/                        # github.com/your-org/compliance-skills
├── skills/
│   ├── accessibility-audit/
│   │   ├── SKILL.md                      # metadata.version, compatibility: "Requires Node 20+, npx"
│   │   ├── scripts/check-update.mjs
│   │   └── references/wcag-checklist.md
│   ├── gdpr-audit/SKILL.md …
│   ├── privacy-policy-drift/SKILL.md …
│   └── eu-ai-act-check/SKILL.md …
├── packages/
│   └── compliance-audit/                 # → npm: @your-org/compliance-audit
│       └── src/  (Playwright crawler, axe-core runner, policy differ, report formatter)
├── .claude-plugin/
│   ├── marketplace.json                  # name: your-org-compliance; plugin source "./" with skills: ["./skills/…"]
│   └── plugin.json                       # name, description, version: "1.0.0" (bump every release)
├── gemini-extension.json                 # name, version — makes repo installable as a Gemini extension
├── VERSION                               # single-line semver, read by check-update scripts
└── README.md                             # install matrix below
```

Each SKILL.md body says e.g.: "Run
`npx -y @your-org/compliance-audit a11y <url> --format json`" — so the heavyweight,
fast-moving Playwright code is versioned on npm and always fetchable, while the
SKILL.md layer (instructions, interpretation guidance, report templates) changes
rarely.

**Install commands to put in the README:**

```bash
# Any agent (Claude Code, Codex, Gemini CLI, Cursor, +70 more) — one command:
npx skills add your-org/compliance-skills            # interactive agent picker
npx skills add your-org/compliance-skills --skill '*' -a claude-code -a codex -y
# (exact agent id strings for Gemini in the -a flag: check `npx skills add --list` — UNVERIFIED)

# Claude Code native (gets versioning + auto-update):
/plugin marketplace add your-org/compliance-skills
/plugin install compliance@your-org-compliance

# Gemini CLI native:
gemini extensions install https://github.com/your-org/compliance-skills --auto-update
#   or per-skill: gemini skills install https://github.com/your-org/compliance-skills.git --path skills/gdpr-audit

# Codex CLI: no native git installer — npx skills add places skills in .agents/skills/,
# which Codex reads automatically; invoke with $gdpr-audit etc.

# Update:
npx skills update        # cross-agent
/plugin update …         # Claude (also auto-updates in background)
gemini extensions update --all
```

**Why this wins:** one repo, one canonical `skills/` tree; `npx skills add` gives the
one-command cross-CLI install and skills.sh discoverability for free; the
`.claude-plugin/` manifest adds Claude-native install with real version pinning and
background auto-update at the cost of two small JSON files; `gemini-extension.json`
adds Gemini-native install with `--auto-update`; and the npm helper package gives the
only reliable auto-update channel that works identically on all three platforms.
