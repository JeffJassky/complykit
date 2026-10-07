---
name: Release checklist
about: Gate for the first (and every) npm publish. The lead ticks it; an agent never publishes.
title: "Release vX.Y.Z"
labels: release
---

<!--
Nothing here is auto-ticked. Each box is ticked by the lead after looking at the
evidence. The publish itself is manual (interactive login + 2FA OTP) and happens
only after the last box. See foundry standards/publishing.md.
-->

Release: `@jeffjassky/complykit` vX.Y.Z / `@jeffjassky/complykit-consent` vX.Y.Z

## Build and budgets (client/)
- [ ] `npm --prefix client run size` passes: core `complykit-consent.js` <= 15 KB gzipped, UI `complykit-consent-ui.js` <= 12 KB gzipped. Sizes pasted below.
- [ ] CI green on main for **client (chromium)**, **client (firefox)** and **client (webkit)** (the job matrix) and the `client-checks` job.
- [ ] Root CI `test` job green (check-tracked, typecheck, boundaries, build, check-exports, tests, CJS entry).
- [ ] `npm run docs:build` passes and the docs deploy workflow is green.

## Versions and notes
- [ ] CHANGELOG.md: `[Unreleased]` moved under the new version with a date; no client names, hostnames or ids.
- [ ] Version bumped in **both** `package.json` and `client/package.json`; the two are intentionally equal or the difference is explained here.
- [ ] Peer ranges unchanged, or widened only (a narrowing is a major; traps #10).

## Contract and docs freshness
- [ ] `npm run schema:consent` produces no diff: `schema/consent-tool-config.schema.json` is fresh.
- [ ] `npm run docs:config-schema` produces no diff: config-schema docs are fresh.
- [ ] Banner copy (docs/guide/banner-copy.md and the per-regime strings) reviewed by the agency; reviewer and date recorded below.

## Proof (D10)
- [ ] A real install was verified by **rescan**: consent tool installed on an approved sample site (or its `--local-copy` loop), rescan reports it controlled (held in every denied visit, ran when granted, journey parity). Run directory and result noted below (no site names in this public issue).
- [ ] Withdrawal verified: revoking consent stops the tools it should (F3).

## Package contents
- [ ] `npm pack --dry-run` reviewed for the root package: `dist`, `schema`, `types/*`, `skills`, `README.md`, `LICENSE`, `package.json` only.
- [ ] `npm pack --dry-run` reviewed in `client/`: `dist` plus package.json only.
- [ ] `node scripts/check-pack.mjs` passes for the root, and for `client/` once it is no longer private. Run with the out-of-repo deny-list present (`$COMPLYKIT_DENYLIST` or `~/.complykit/denylist`); with none it checks paths only.
- [ ] No client material: no `reports/`, `.comply/`, `plans/` field notes, test fixtures, captured HTML, client hostnames or container/pixel ids in either tarball.
- [ ] Client package flipped for release (see the list at the bottom).

## Publish decision
- [ ] Explicit human **go** recorded in this issue (a comment from the owner saying "go", with the exact version and package names).
- [ ] Publish done manually by the owner (`npm publish --access public --otp=...`). Agents never publish.
- [ ] After publish: smoke-test the **published** artifact from a fresh directory (`npm install`, import every export, run the CLI), then set up trusted publishing / provenance.

## Evidence
```
core gz:
UI gz:
CI run URLs:
Copy reviewer / date:
D10 rescan run dir + result:
```

## What must change in `client/package.json` at release
`client/` is `"private": true` and its `prepublishOnly` refuses while that is so. At release:

1. Remove `"private": true`.
2. Confirm `name` (`@jeffjassky/complykit-consent`); scoped names need `publishConfig`.
3. Add `"publishConfig": { "access": "public" }`.
4. Keep `"files": ["dist"]` (add `README.md`/`LICENSE` copies in client/ if they should ship; today the tarball has neither).
5. Add an `exports` map (today only `main`/`module`): the ESM core, the UI file, and `./package.json`; add `types` if a `.d.ts` is built.
6. Re-run `npm pack --dry-run` and `node ../scripts/check-pack.mjs .`.
