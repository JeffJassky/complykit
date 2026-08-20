---
name: a11y-visual-review
description: Guide a visual accessibility review of a rendered web page for the WCAG judgment criteria automated tools can't decide — image-of-text, wrong-but-present alt text, colour as the only meaning channel, visual reading order, and affordance confusion. Use after a complykit scan, when needs-review findings or manual-only coverage remain.
---

# Accessibility visual review

The deterministic and axe layers catch what is provable from the DOM and flat
pixels. This skill covers the criteria that need a human-or-model **judgment**
about what a sighted user actually perceives. Work from the run's screenshots in
`.comply/runs/<id>/evidence/` and the report's manual-only list.

## What to judge (and the criterion each maps to)

1. **Images of text** (WCAG 1.4.5) — text baked into an `<img>`. The DOM sees an
   image; only the pixels reveal the words. Flag any non-logo text rendered as an
   image.
2. **Alt text that exists but is wrong** (1.1.1) — `alt="image23.jpg"`, `alt="."`,
   or alt that describes the wrong thing. Passes every engine; only judgment
   catches the mismatch. Compare each meaningful image's alt to what it depicts.
3. **Colour as the only meaning channel** (1.4.1) — links distinguished from text
   by colour alone, required fields marked only in red, chart series separable
   only by hue. Ask: if this were greyscale, is the meaning still available?
4. **Visual reading order vs DOM order** (1.3.2 / 2.4.3) — does the tab/screen-
   reader order match the visual layout? CSS can reorder without reordering the
   DOM.
5. **Affordance confusion** (general 4.1.2 / usability) — things that look
   clickable but aren't, icon-only controls with unclear meaning, links
   indistinguishable from body text.

## How to work

- Open the full-page screenshots for each route × viewport × scheme in the run's
  evidence directory. Judge one criterion at a time across the page.
- Every finding must cite a specific criterion — no guessed requirements.
- Record each as a finding through the validated path (never edit findings.jsonl
  directly):

```bash
complykit finding add --run <runId> --producer agent --model <you> \
  --json '{"ruleId":"a11y.visual-review","requirementId":"wcag22.1.4.5","subject":{"property":"<id>","routePattern":"/pricing"},"confidence":"needs-review","message":"Pricing tiers are rendered as an image of text.","evidence":[]}'
```

- Use `confidence: "needs-review"` unless the defect is unambiguous in the
  screenshot. `unclear` cases stay in the manual slice — that is honest, not a
  failure.

## Do not

- Do not assert a page is "accessible" or "compliant" — record findings and
  evidence only.
- Do not invent a requirement id; cite the WCAG success criterion.
