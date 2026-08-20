# compliance — vision analysis layer design (C1) (2026-08-19)

Companion to [browser-analysis-design.md](browser-analysis-design.md). How the
screenshot/LLM pass actually works, and why it is *not* "screenshot the whole
page, send it with the rulebook, parse JSON."

## Why the naive approach fails

Full-page screenshot + all-rules prompt + structured JSON has four independent
failure modes:

1. **Resolution.** Vision APIs downscale to ~1.15MP (longest edge ~1568px). A
   1280×8000 full-page capture arrives illegible — and the model doesn't
   refuse, it **hallucinates plausible findings** off blurry pixels. Silent
   quality collapse, the worst failure shape for a compliance tool.
2. **Localization.** LLMs are unreliable at emitting pixel coordinates or
   selectors. "The button in the hero area" is not a fingerprintable finding.
   Any design where the model *locates* violations breaks the record format.
3. **Rule-dump reliability.** Twenty rules × one giant image = misses and
   inconsistency. Vision models do well answering one narrow question about a
   small image; recall degrades sharply as scope widens.
4. **Cost.** Image tokens ≈ (w×h)/750. Whole-page tiling on every page × every
   run × every viewport is the expensive path — and most of those pixels never
   changed since the last run.

## The architecture: LLM judges, never locates

Coordinates, selectors, and fingerprints always come from the DOM side
(deterministic layer). The model only ever renders a **verdict about a region
it is handed**. Two modes:

### Mode 1 — targeted adjudication (bulk of volume)

Input: the deterministic layer's `needs-review` queue — axe incompletes,
ambiguous pixel-contrast bands, focus-indicator diffs, cross-origin iframe
regions, chat-widget captures. Each item already carries an element crop
(bbox + context padding) and a fingerprint.

Per item: **one small image + one rule's rubric + strict output schema.**

- Crop ~300×150px ≈ 60 tokens; even with rubric + response, a micro-task is
  a few hundred tokens.
- Output schema per registry llm-rule: `verdict` enum
  (`violation | pass | unclear`), `requirementId` constrained to the rule
  under test, short reason. **No free-form violation invention** — an
  unprompted discovery in a crop is emitted as a `lead`, not a finding, and
  queued for its own adjudication.
- Fully batchable (Batch API — 50% off, latency irrelevant for audits) and
  parallelizable.

Video/animated backgrounds: the deterministic layer detects
`<video autoplay>` / animation presence and captures the crop at 2–3
timestamps; the model judges the worst frame. Known-unknowns stay in mode 1
even when the pixels move.

### Mode 2 — visual sweep (discovery, bounded volume)

**This is the broad-visual-analysis channel** — full-viewport content, open
discovery questions. The tiling and marks constrain the *delivery format*
(legibility + localization), never the scope of the question. It exists
because a whole class of issues fires no deterministic lead at all — the
deterministic layer isn't just sometimes unsure, it is sometimes *blind*:

- image-of-text (1.4.5) — the DOM sees `<img>`; only pixels reveal text
- alt text that exists but is wrong (`alt="image23.jpg"` passes every engine;
  only vision judges alt-vs-content mismatch)
- color as the only meaning channel (1.4.1), visual reading order vs DOM
  order, affordance confusion (looks clickable/isn't; links
  indistinguishable from text), icon-only controls with unclear meaning,
  clipping and overlap the rect heuristics miss, flashing content, general
  layout brokenness.

- **Viewport tiles, never squashed pages**: slice the full-page capture into
  ~1280×1100 tiles with ~15% overlap. Every tile stays under the resolution
  limit → text legible. ~1.9k tokens/tile.
- **Set-of-Marks grounding**: from the DOMSnapshot, overlay numbered badges on
  visible elements (or pass a compact sidecar map: mark № → role, text, bbox,
  fingerprint). The model cites mark numbers; we resolve numbers → fingerprints.
  Localization problem gone.
- Rules grouped into **two themed passes** (perception pass, affordance/order
  pass), not one rule-dump — a tile is judged at most twice.

**The two modes form a funnel.** Sweep output is *leads* (mark № resolved to
a fingerprint), and every lead is confirmed by a mode-1 crop adjudication
before it becomes a finding. Discovery is allowed to be noisy because
confirmation is cheap — a precision gate, not a capability limit. Sweep is
the smaller-volume channel on economics alone (tiles ≈ 30× the tokens of
crops, output needs confirmation anyway, pHash/cache skips unchanged pages);
config dials its breadth: every page for legal-deliverable runs,
changed-pages-only for scheduled runs.

## The economics: dedupe + cache make C1 proportional to churn

The two highest-leverage mechanisms, both trivial given the existing design:

1. **Instance dedupe before judging.** Headers, footers, nav, repeated cards
   appear on every page. Perceptual-hash the crop (pHash), group identical
   regions → **one judgment, applied to every instance**, one finding per
   fingerprint anyway. Cuts mode-1 volume by an order of magnitude on
   template-driven sites.
2. **Verdict cache across runs.** Cache key = crop content hash + rule id +
   rubric version + model id. Unchanged region → reuse verdict, zero tokens.
   Scheduled re-runs cost proportional to **UI churn, not site size**. Cache
   lives in `.comply/cache/`, safe to commit or blow away.

Supporting knobs:

- **Model tiering**: cheap fast model for mode-1 micro-adjudications; stronger
  model for mode-2 tiles and for mode-1 items the cheap model marked
  `unclear`. Escalation ladder, config-controlled.
- **Variant discipline**: send dark-scheme/mobile variants only for
  scheme-sensitive rules (contrast, focus visibility); structure-sensitive
  rules judge one variant.
- **Optional second opinion**: high-severity `violation` verdicts can require
  a second independent call to agree (config: `review.confirmCritical`).
  Default off for cost; on for legal-deliverable runs.

## Honesty rules

- Every C1 finding: `producer: "agent"`, model id + rubric version recorded,
  the judged crop stored as evidence — a human can always see exactly what
  the model saw.
- `unclear` verdicts surface in the report as unresolved needs-review, never
  dropped: they are the residue that defines the manual-audit slice.
- Full-page screenshots are still captured (evidence substrate + report
  visuals); they just never go to the model whole.

## Flow summary

```
scan (layer B)
  ├─ needs-review queue + element crops ──► Mode 1: pHash dedupe → cache check
  │                                          → micro-adjudications (batch)
  ├─ full-page captures ──► tiler + SoM overlay ──► Mode 2: two themed passes
  │                                          (also pHash/cache-gated per tile)
  └─ all screenshots → evidence/

verdicts ──► comply finding add (schema, fingerprint, producer:"agent")
leads    ──► adjudication queue (next batch)
unclear  ──► report: manual-review slice
```
