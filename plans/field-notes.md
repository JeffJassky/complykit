# Field notes — running complykit on real subjects

Per the build brief: after M1 and again after M3, run the tool against the maxed
repo (`~/Projects/Amplify11/MaxMarketing`) and record findings + rough runtimes.
Fix the tool's ergonomics before proceeding if they fight.

---

## M1 — static layer, maxed (2026-08-19)

**Command** (source repo untouched — run written to a scratch dir):

```
complykit static --repo ~/Projects/Amplify11/MaxMarketing --property maxed --cwd <scratch>
```

**Runtime:** 2.45s real (4.51s user) cold, 708 source files scanned. Well under
the <30s cold target in static-analysis-design.md.

**Result:** 302 findings.

| Producer | Count |
|---|---|
| engine (eslint vue-a11y) | 297 |
| rule (inventories) | 5 |

| Confidence | Count |
|---|---|
| needs-review | 297 |
| violation | 5 |

By requirement:

| Requirement | Count |
|---|---|
| wcag22.4.1.2 (Name Role Value) | 198 |
| wcag22.2.1.1 (Keyboard) | 80 |
| wcag22.3.2.2 (On Input) | 16 |
| gdpr.art13 (info to be provided) | 4 |
| wcag22.1.3.1 (Info & Relationships) | 2 |
| wcag22.1.1.1 (Non-text Content) | 1 |
| eu-ai-act.art50.1 (AI interaction disclosure) | 1 |

Top rules: vue-a11y `label-has-for` (118), `form-control-has-label` (78),
`no-static-element-interactions` (38), `click-events-have-key-events` (37),
`no-onchange` (16); `inventory.pii-surface` (4); `inventory.ai-framework` (1).

`has-ai-features` was **derived** from an `@anthropic-ai/*` import (not asserted),
so the Art. 50 lead fired correctly. The tracker inventory found **zero** —
maxed uses first-party telemetry, no third-party tracker packages — which is the
honest result, not a miss.

**Coverage (wcag22aa):** 16 requirements in scope, 13 auto-checked, 3 manual-only
(1.4.11 non-text contrast, 2.4.7 focus visible, 2.5.8 target size — all
rendered-page criteria that are the browser layer's job in M2, printed honestly
as the gap).

### Ergonomics — did the tool fight me?

No fixes needed. Observations carried forward:

- **`--cwd` separation works well.** Pointing `--repo` at the subject and `--cwd`
  at a scratch dir kept the source repo clean (verified: no `.comply` written to
  maxed, `git status` shows only pre-existing untracked files). This is the right
  pattern for the central audits repo.
- **Volume is real but navigable.** 198 findings against 4.1.2 is a lot; the
  per-(file,rule) ordinal anchor keeps them distinct rather than collapsing, and
  a report/`diff` groups by requirement. A future `--severity`/`--confidence`
  filter on `report` would help triage — noted, not blocking.
- **needs-review dominates (297/302),** exactly as the reliability policy intends:
  the static layer undercounts hard violations and routes the inferential bulk to
  the browser/LLM layers. Not noise to silence — leads to confirm.

## M2 — browser passive, maxedmarketing.ai (2026-08-19)

The static field subject (maxed) has no locally-served public site, so the
browser layer was field-tested against the **live** property the user owns,
`https://maxedmarketing.ai` (authorized — it is their own product).

**Command:** browser passive pass, homepage, desktop × light.

**Runtime:** 4.4s for the homepage (settle + scroll + screenshot + axe +
contrast + DOMSnapshot). Well under the 20s per-page budget.

**Result:** 36 findings from 4 artifacts, 0 coverage gaps.

| Requirement | Count |
|---|---|
| wcag22.1.4.3 (Contrast) | 31 |
| wcag22.4.1.2 (Name Role Value) | 5 |

The contrast findings came from the flat-colour path and the pixel-band
escalation; the name/role/value findings from axe. No cross-origin iframe or
closed-shadow gap on the homepage.

**Flake (DoD gate — <2% across 5 repeat runs):** 5 runs produced **identical**
finding sets (36 each), avg Jaccard 100.0%, **drift 0.00%**. The settle protocol
+ animation freeze + measurement-profile ad-blocking hold the page steady. DoD
met.

### Ergonomics

- The dynamic-import of the browser layer means `complykit static` never pays for
  Playwright, and a missing-peer error is a clear install message, not a
  module-resolution crash — verified by running the static tests with the browser
  layer present but unused.
- Determinism came for free once the freeze CSS + `networkidle` settle were in;
  no per-site tuning was needed for a real marketing site.
- The local source repo was untouched (the live URL was scanned; runs written to
  a scratch dir).

## M3 — probes + GDPR evidence, maxed

_Pending M3 (after human review)._
