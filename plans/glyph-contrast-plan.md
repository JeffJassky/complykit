# Glyph-mask contrast measurement — implementation plan

Status: approved for implementation 2026-09-16. Branch `glyph-contrast`.
Authority: this document governs the contrast (WCAG 1.4.3) measurement rewrite.
Where it conflicts with `browser-analysis-design.md` on contrast, this wins; the
divergence is recorded in `DIVERGENCES.md` by Wave 4.

---

## 1. Why

Field re-scan of maxedmarketing.ai on 2026-09-16 (HEAD 7d0f9af) produced wrong
contrast verdicts that a person can refute by looking at the screenshot:

| Element | Reported | Truth (prototype, 2 at-rest shots) |
|---|---|---|
| "START THE 10-DAY TRIAL" (black on lime pill) | violation 1–1.61:1 | pass 17.42 (#000 on #c3fd34) |
| FAQ question (navy on white) | violation 1.35:1 | pass 14.70 |
| Hero h2 (black on white, blue child span) | violation "3–21:1 (needs 3:1)" | pass 21.00 |
| Hero subtitle | needs-review (never measured) | pass 18.38 |
| Blue CTA (control, real failure) | 2.80 | fail 2.80 |
| nofeargear `.text-mist-400` (control) | 2.26 | fail 2.26 |

Root causes in the current code:

1. **Wrong instant.** `index.ts` measures each band as soon as it settles. JS-driven
   reveals (not CSS — CSS animation is already frozen by `session.ts FREEZE_CSS`)
   leave text unpainted at that instant; nothing checks that the text colour is
   actually present in the pixels read.
2. **Background is guessed.** `pixel-band.ts` takes the "largest contiguous
   luminance run" of a histogram as background. Large bold text's anti-aliasing
   populates the valley bins and merges ink into "background"; a CTA's dark
   surround outvotes the pill.
3. **Coverage hole.** `axe-contrast-measure.ts` only measures axe targets that
   happen to be on screen in its single viewport shot; the rest stay
   needs-review.
4. **Evidence dropped.** `contrast-reconcile.ts` passes only a verdict back to
   `engines.ts`, which then shows axe's cascade-inferred colours and no sampled
   pixels.
5. Symmetric risk: the same bugs can produce false PASSES. Not yet quantified.

## 2. The method (what "correct" means)

WCAG 1.4.3 compares the text colour with the background the text is actually on.
We measure exactly that, deterministically, per text subject:

1. Bring the subject on screen and wait until it is **at rest** (no running
   animation touching it or an ancestor; effective opacity and rect unchanged
   across two polls).
2. Screenshot **A** (normal).
3. Make **only that subject's glyphs** transparent (pinning every other
   currentColor-derived paint: borders, outlines, fills, shadows, descendants'
   colours). Screenshot **B**.
4. Restore. Screenshot **A2**. If A2 ≠ A inside the subject's rects, the page moved
   → retry later.
5. Pixels where A ≠ B inside the subject's text rects are **the glyphs** (exact
   mask, anti-aliasing included). B at those pixels is **the exact background
   behind each glyph pixel**.
6. Text colour = CSS colour composited with its alpha × effective opacity over each
   background pixel — **if** the rendered ink in A matches that prediction.
   If it doesn't (a translucent overlay, a filter, a blend mode changes what the
   reader sees), use the rendered ink from A instead (`fgSource: 'rendered'`).
7. Per-glyph-pixel ratio → histogram. **Verdict ratio = the 1st percentile**
   (at least the 5th-worst pixel), floored to 2 decimals. Fail iff verdict ratio
   < required (4.5, or 3 for large text). Min/median/max are reported too.
8. Evidence: a PNG crop of A around the subject, plus a same-size RGBA overlay
   marking every glyph pixel (magenta = below required, cyan = passing), plus
   swatches (text colour, background at the worst pixel, background at the best
   pixel) with ratios.

Batching: in a normal band all eligible on-screen subjects are hidden together
(one A/B/A2 triple per band). Subjects whose text rects overlap another subject's
are measured individually (hiding both would remove the other text from B).

Outcomes per subject: `measured` (pass|fail) or `unmeasured` with a reason.
**Unmeasured is never a pass**: it is emitted as a `contrast-unmeasured` coverage
gap. axe `color-contrast` nodes are settled by measurement: if any measurement
exists for that element (or its text-owning descendants) the axe node is dropped
and `contrast.text` is the single reporter; otherwise it stays needs-review and is
counted as unmatched.

## 3. Non-goals (documented limitations)

- SVG `<text>`, canvas text, text baked into images/video: not measured. SVG text
  elements are counted into the `contrast-unmeasured` gap note.
- Cross-origin iframes / closed shadow roots: existing gaps, unchanged.
- Hover/focus/active states and dark scheme matrix: unchanged (existing matrix).
- Device scale factor stays 1. (A 2× capture would reduce anti-aliasing share;
  deferred.)
- `text-shadow` legibility credit: B keeps the computed text-shadow; whatever
  Chromium paints is what is measured. Corpus case C26 records the behaviour and
  is not scored.

## 4. Contracts (all waves code against these — do not rename fields)

### 4.1 `src/collect/browser/glyph-math.ts` (pure; imports only `pngjs`)

```ts
export interface Rgb { r: number; g: number; b: number }
export interface Rect { x: number; y: number; width: number; height: number }

export function relLuminance(c: Rgb): number;            // WCAG 2.x sRGB (0.03928 knee)
export function contrastRatio(a: Rgb, b: Rgb): number;    // (L1+0.05)/(L2+0.05), unrounded
export function composite(fg: Rgb, alpha: number, bg: Rgb): Rgb; // fg*α + bg*(1-α), unrounded
/** rgb()/rgba(), comma or space syntax, optional "/ a"; percentages for alpha. null if unparseable. */
export function parseCssColor(s: string): { rgb: Rgb; alpha: number } | null;
export function rgbString(c: Rgb): string;                // "rgb(r, g, b)" with Math.round
export function floor2(n: number): number;                // Math.floor(n * 100) / 100

/** 2001 bins: index = clamp(floor((ratio - 1) * 100), 0, 2000). Bin value = 1 + index/100. */
export class RatioHistogram {
  readonly counts: Uint32Array;
  total: number;
  add(ratio: number, n?: number): void;
  merge(other: RatioHistogram): void;
  /** Bin value of the pixel at 0-based ascending rank `rank` (clamped to [0,total-1]). NaN if empty. */
  valueAtRank(rank: number): number;
  min(): number; max(): number; median(): number;
}

export const TRIM_FRACTION = 0.01;
export const MIN_RANK = 4; // the verdict is never worse than the 5th-worst pixel

export interface Verdict {
  verdict: 'pass' | 'fail';
  ratio: number;        // valueAtRank(min(total-1, max(MIN_RANK, floor(TRIM_FRACTION * total))))
  min: number; median: number; max: number;
  glyphPixels: number;  // hist.total
  failingPixels: number; // pixels in bins with value < required
}
export function decideVerdict(hist: RatioHistogram, required: number): Verdict; // fail iff ratio < required

export const DIFF_FLOOR = 6;       // |ΔR|+|ΔG|+|ΔB| at or below this = no change
export const MASK_FRACTION = 0.25; // glyph pixel: d >= max(DIFF_FLOOR, MASK_FRACTION*maxDiff)
export const CORE_FRACTION = 0.6;  // core pixel: d >= max(DIFF_FLOOR, CORE_FRACTION*maxDiff)
export const INK_TOLERANCE = 36;   // |pred−A| channel sum for an ink match
export const INK_MIN_MATCHES = 3;

export interface GlyphInput {
  a: PNG; b: PNG;          // same dimensions, viewport screenshots
  rects: Rect[];           // viewport-space areas to consider; clipped to the image; overlaps counted once
  fg: { rgb: Rgb; alpha: number } | null; // null => painted by its own background (gradient text)
  opacity: number;         // product of opacity of the owner and all ancestors
  required: number;
}
export interface GlyphResult {
  status: 'measured' | 'no-diff';   // no-diff: maxDiff <= DIFF_FLOOR
  maxDiff: number;
  hist: RatioHistogram;
  fgSource: 'css' | 'rendered';
  worst: { fg: Rgb; bg: Rgb; ratio: number } | null; // the single lowest-ratio glyph pixel
  best:  { fg: Rgb; bg: Rgb; ratio: number } | null;
  /** Bounding rect (integer viewport px) of `rects` ∩ image; mask is row-major over it. */
  maskRect: Rect;
  /** 0 = not glyph, 1 = glyph passing, 2 = glyph failing (ratio < required). */
  mask: Uint8Array;
}
export function measureGlyphs(input: GlyphInput): GlyphResult;
```

`measureGlyphs` algorithm (normative):
1. For every integer pixel inside any rect: `d = |Ar−Br|+|Ag−Bg|+|Ab−Bb|`; `maxDiff = max d`.
2. `maxDiff <= DIFF_FLOOR` → `status 'no-diff'`, empty hist, empty mask (all 0), worst/best null, fgSource `'css'`.
3. glyph = `d >= max(DIFF_FLOOR, MASK_FRACTION*maxDiff)`; core = `d >= max(DIFF_FLOOR, CORE_FRACTION*maxDiff)`.
4. If `fg !== null`: `ea = fg.alpha * opacity`. For each core pixel `pred = composite(fg.rgb, ea, B)`;
   match if `|pred−A|` channel sum `<= INK_TOLERANCE`. If matches `>= min(INK_MIN_MATCHES, coreCount)`
   → `fgSource 'css'`: every **glyph** pixel contributes `contrastRatio(composite(fg.rgb, ea, B), B)`.
5. Otherwise (no match, or `fg === null`) → `fgSource 'rendered'`: every **core** pixel contributes
   `contrastRatio(A, B)`; non-core glyph pixels are mask value 0 in this mode.
6. Mask value 2 when that pixel's ratio < required, else 1. Track worst/best pixel.

```ts
/** RGBA PNG of maskRect size: 2 → rgba(255,0,200,235), 1 → rgba(0,229,255,150), 0 → transparent. */
export function renderOverlay(result: GlyphResult): Buffer;
/** Plain RGB(A) PNG crop of `png` over `rect` (clipped to the image). */
export function cropPng(png: PNG, rect: Rect): Buffer;
/** True when A and A2 differ (d > DIFF_FLOOR) at any pixel inside rects. */
export function regionChanged(a: PNG, a2: PNG, rects: Rect[]): boolean;
```

### 4.2 `src/collect/browser/glyph-init.ts` — page-side, `export const GLYPH_INIT = (): void => {...}`

Installed via `context.addInitScript` **after** `GEOMETRY_INIT`. Self-contained
(serialized into the page; no imports, no closures over module scope). It must
lazily read `window.__ck` at call time (GEOMETRY_INIT may install after it in some
tests) and attach `window.__ck.glyph = { enumerate, hide, restore, settled,
resolveAxeTargets, describe, scrollSubjectTo }`.

```ts
type SubjectKind = 'text' | 'before' | 'after' | 'placeholder' | 'value';
interface PageTextSubject {
  key: string;              // `${ref}:${kind}`
  ref: number;              // __ck.register(owner)
  kind: SubjectKind;
  cssPath: string;          // same generator as contrast.ts cssPath()
  textSample: string;       // trimmed, whitespace-collapsed, <= 80 chars + '…'
  color: string;            // computed color of the owner (or of the pseudo / ::placeholder)
  opacity: number;          // product of computed opacity over owner and all ancestors (crossing shadow hosts)
  fontSizePx: number; bold: boolean; large: boolean; required: number; // large: >=24px, or >=18.66px and weight>=700
  paintedByBackground: boolean; // background-clip:text (or -webkit-) or -webkit-text-fill-color alpha 0
  rects: Rect[];            // VIEWPORT rects: text → Range client rects of the owner's DIRECT non-whitespace text nodes;
                            // before/after/placeholder/value → owner's content box (border-box minus borders+padding)
  painted: Rect | null;     // __ck.paintedBox(owner); null = not visible
  box: Rect;                // __ck.contentBox(owner) — capture space
}
enumerate(opts: { viewportOnly?: boolean; refs?: number[] }): { subjects: PageTextSubject[]; truncated: boolean; svgTextCount: number };
```

Enumeration rules: walk text nodes from `document.body`, descending into **open**
shadow roots; owner = parent element; one `text` subject per owner. Skip when the
text is whitespace-only; owner fails `checkVisibility({opacityProperty,
visibilityProperty, contentVisibilityAuto})`; owner rect < 1px; color alpha 0 and
not paintedByBackground; `painted === null`. Pseudo subjects: `::before`/`::after`
whose computed `content` is not `none`/`normal`, whose unquoted string has a
non-whitespace character outside U+E000–U+F8FF (icon fonts are 1.4.11, not 1.4.3).
Placeholder: `input`/`textarea` with non-empty `placeholder` and empty value.
Value: `textarea` / `input` of type text|email|search|tel|url|number|submit|button|reset
with non-empty value, and `select` (selected option text). Cap 5000 → `truncated`.
`viewportOnly`: keep subjects with at least one rect intersecting the viewport.
`refs`: only those owners. `svgTextCount`: visible SVG `<text>` elements.

```ts
hide(keys: string[]): void;   // throws nothing; unknown keys ignored
restore(): void;              // reverts EVERY change made by hide(), exactly, in reverse order; idempotent
```
`hide` phase 1 reads every computed value it will need; phase 2 writes. For each key:
- `text` / `value`: owner inline `color: transparent !important` and
  `-webkit-text-fill-color: transparent !important`; if `paintedByBackground` also
  `background-image: none !important`. Pin on the owner (inline, !important, to the
  phase-1 computed value): `border-{top,right,bottom,left}-color`, `outline-color`,
  `text-decoration-color`, `text-emphasis-color`, `column-rule-color`, `fill`,
  `stroke`, `box-shadow`, `text-shadow`, `-webkit-text-stroke-color`. Pin `color`
  and `-webkit-text-fill-color` on every descendant element (light DOM) that is not
  itself the owner of a key being hidden in this same call.
- `before` / `after` / `placeholder`: add a token to the owner's `data-ck-g`
  attribute and a rule in a `<style data-ck-glyph>` appended to
  `owner.getRootNode()` (document → `document.head`; ShadowRoot → the root itself):
  `[data-ck-g~="<token>"]::before{color:transparent!important;-webkit-text-fill-color:transparent!important}`
  (resp. `::after`, `::placeholder`).
- Journal every inline property's previous value and priority (`getPropertyValue`,
  `getPropertyPriority`), every attribute's previous value, and every style
  element added. `restore` replays the journal backwards (remove property when it
  was empty before).

```ts
settled(keys: string[]): { running: number; moved: number };
```
`running` = animations from `document.getAnimations()` with playState `running` or
`pending`, finite iterations, whose `effect.target` is an owner or an ancestor of
an owner (for shadow content walk up through hosts). `moved` = owners whose
effective opacity or rounded `getBoundingClientRect()` differs from the value
stored by the previous `settled` call for that ref (first call: 0). Stores the
new values.

```ts
resolveAxeTargets(targets: string[][]): Array<{ ref: number | null; measureRefs: number[] }>;
```
Target `[a, b, c]` = shadow path: `document.querySelector(a)`, then
`.shadowRoot.querySelector(b)`, … `ref` = `__ck.register(el)`. `measureRefs` = refs
of `el` and of every descendant element (light DOM + open shadow) that owns a
subject in the most recent `enumerate` result set (keep a page-side `Set<Element>`
of all owners ever enumerated). Invalid selector → `{ ref: null, measureRefs: [] }`.

```ts
describe(refs: number[]): Array<{ ref: number; sourceFile: string | null; scopeId: string | null;
  fgVars: string[]; bgVars: string[]; bgImageVars: string[]; flat: boolean; bgColor: string | null; cascadeRatio: number | null }>;
```
Port `vueFile`, `vueScopeId`, `cssVarNames`, `normColor`, `matchVars`,
`effectiveBg` from `contrast.ts collectInPage`, and the gradient-owner var logic
from `attributeGradientVars` (use the element by ref, never by cssPath).

```ts
scrollSubjectTo(ref: number, viewportY: number): Rect | null;
```
`owner.scrollIntoView({ block: 'start', inline: 'nearest' })` then scroll the
nearest scrolling ancestor (or window) back by `viewportY` so the owner's top lands
at `viewportY`. Returns the owner's viewport rect afterwards, or null if gone.

### 4.3 `src/collect/browser/glyph-measure.ts` (Playwright orchestration)

```ts
export interface MeasuredSubject {
  key: string; ref: number; kind: 'text' | 'before' | 'after' | 'placeholder' | 'value';
  cssPath: string; textSample: string;
  sourceFile: string | null; scopeId: string | null;
  fgVars?: string[]; bgVars?: string[]; bgImageVars?: string[];
  textColor: string; fontSizePx: number; bold: boolean; large: boolean; required: number;
  paintedByBackground?: boolean;
  flat: boolean; bgColor: string | null; cascadeRatio: number | null; // cascade diagnostics only
  box: { x: number; y: number; width: number; height: number };      // capture space, re-read at rest
  status: 'measured' | 'unmeasured';
  unmeasuredReason?: 'never-stable' | 'occluded' | 'cap' | 'error';
  measuredAt?: 'band' | 'rest';
  verdict?: 'pass' | 'fail';
  ratio?: number; minRatio?: number; medianRatio?: number; maxRatio?: number; // floor2
  glyphPixels?: number; failingPixels?: number;
  fgSource?: 'css' | 'rendered';
  fgColor?: string;       // rgbString of worst.fg
  worstBgColor?: string;  // rgbString of worst.bg
  bestBgColor?: string;   // rgbString of best.bg
  // Evidence, written ONLY when verdict === 'fail' (putEvidence, content-addressed):
  cropPath?: string;      // PNG crop of A over maskRect inflated by 12px (clipped)
  overlayPath?: string;   // renderOverlay placed at the same inflated rect (same width/height as crop)
  cropWidth?: number; cropHeight?: number;
}

export interface GlyphRunState {
  done: Map<string, MeasuredSubject>;  // by key
  pending: Map<string, PageTextSubject>; // seen but not measured yet
}

export async function measureBand(page: Page, state: GlyphRunState, ctx: MeasureContext): Promise<void>;
export async function measureRemaining(page: Page, state: GlyphRunState, ctx: MeasureContext): Promise<void>;
export interface MeasureContext {
  runId: RunId; cwd?: string;
  obstructions: { topInset: number; bottomInset: number };
  budgetMs?: number;      // rest pass budget per cell, default 120_000
  maxRestSubjects?: number; // default 400
  trace?: (line: string) => void;
}
```

`measureBand` (called with the page parked; the caller does NOT pass a PNG):
1. `enumerate({ viewportOnly: true })`. Add every subject not in `done` to `pending`.
2. Eligible = pending subjects whose every rect lies fully within
   `[0, vw] × [topInset, vh − bottomInset]`.
3. Remove from eligible (leave pending) any subject whose rects (inflated 1px)
   intersect another eligible or on-screen subject's rects.
4. Poll `settled(eligibleKeys)` every 100ms until `running === 0 && moved === 0` on two
   consecutive polls, cap 2000ms. On cap: eligible stay pending (rest pass).
5. `A = shot; hide(eligibleKeys); B = shot; restore(); A2 = shot` (viewport
   `page.screenshot({ type: 'png', timeout: 8000 })`, decoded with pngjs). Always
   `restore()` in a finally.
6. Per eligible subject: `regionChanged(A, A2, rects)` → stays pending. Else
   `measureGlyphs`. `no-diff`: if CSS fg alpha > 0 and the ratio of fg (composited)
   against the median B pixel in its rects is < 1.1 → measured `fail` (invisible
   text; hist = that ratio × rect pixel count). Otherwise stays pending.
   `measured` → `MeasuredSubject` (status measured, measuredAt 'band'), moved to `done`.

`measureRemaining` (after the walk, page at rest):
1. `enumerate({})` for the whole page; add unseen keys to `pending`.
2. While pending non-empty, within `budgetMs` and `maxRestSubjects` iterations:
   take the pending subject with the smallest `box.y`; `scrollSubjectTo(ref, topInset + 8)`;
   run `measureBand` (it measures everything eligible at that position, not just the target).
   If the target is still pending: **single-subject mode** — settle cap 5000ms;
   A/hide([key])/B/restore/A2, up to 3 attempts while `regionChanged`; subjects taller
   than the clear window are measured in slices (rects clipped to the clear window,
   scroll by the window height between slices, histograms merged, evidence from the
   slice holding the worst pixel). Result → `done` (measuredAt 'rest'), or
   unmeasured `never-stable` (still changing), `occluded` (no-diff and not the
   invisible-text case), `error` (exception).
3. Anything left when the budget ends → unmeasured `cap`.
4. Finally `describe()` for all done refs (vars, source, cascade) and re-read
   `box` at rest via `__ck.boxOf(ref)`.

### 4.4 Artifacts (Wave 3 writes, Wave 2E reads)

- `style-probe` artifact, `check: 'contrast'`: `results = MeasuredSubject[]` (all
  subjects of the cell, measured and unmeasured). `screenshotPath` unchanged.
- `axe-result` artifact: every node of rule `color-contrast` (violations and
  incomplete) gains `measureRefs: number[]` (from `resolveAxeTargets`, resolved at
  rest after the walk). Missing/empty = unresolved.
- `CoverageGap.reason` gains `'contrast-unmeasured'`; one gap per cell per
  `unmeasuredReason` with `note: "<n> text element(s): <reason>"`; plus, when
  `svgTextCount > 0`, one with `note: "<n> SVG text element(s) not measured"`.

### 4.5 Findings

- `contrast.text` reports **every** `status 'measured' && verdict 'fail'` subject
  (flat or not). No finding for pass or unmeasured. Old-shape results (no
  `status`) are ignored.
  - `message`: `Text contrast ${ratio}:1 is below the required ${required}:1 — measured over ${glyphPixels} glyph pixels (worst ${minRatio}:1, median ${medianRatio}:1).`
  - `details`: `{ cssPath, textSample, box, ...(scopeId ? { vueScopeId } : {}) }`
  - evidence 1 `screenshot`: `{ path: cropPath, region: {x:0,y:0,width:cropWidth,height:cropHeight}, overlayPath, swatches: [ {label:'text', color: fgColor}, {label:'background (worst pixel)', color: worstBgColor, ratio: minRatio}, {label:'background (best pixel)', color: bestBgColor, ratio: maxRatio} ] }`
  - evidence 2 `computed-style` properties: `text`, `color` (textColor),
    `text colour used` (`${fgColor} (${fgSource === 'css' ? 'CSS colour' : 'rendered pixels'})`),
    `background at worst pixel`, `ratio` (`${ratio}:1 (1st percentile of ${glyphPixels} glyph pixels)`),
    `range` (`${minRatio}–${maxRatio}:1, median ${medianRatio}:1`), `required`,
    `failing pixels` (`${failingPixels} of ${glyphPixels}`), plus the existing var rows.
- axe `color-contrast` nodes (engines.ts): look up MeasuredSubjects of the same
  cell (`cellKey`) with `ref ∈ node.measureRefs`.
  - any `measured` → drop the node; count `settled`. If axe's own check data has a
    numeric `contrastRatio`, a matched subject is `flat`, `fgSource 'css'`, and
    `|axeRatio − medianRatio| > 0.1` → count `disagreements` and remember up to 5
    `{ selector, axe, measured }` examples.
  - no measured match → keep as axe declared it (violation stays violation,
    incomplete stays needs-review); count `unmatched`.
  - `EngineNormalization.superseded` becomes
    `{ settled: number; unmatched: number; disagreements: number; examples: Array<{ selector: string; axe: number; measured: number }> }`.
- `enrich/supersede.ts` `pixelBandContrast` provider → renamed `glyphContrast`
  (id `'glyph-contrast'`), boxes from results with `status === 'measured'`.
- `pipeline.ts` trace: `contrast: measured <m> text element(s) (<p> pass, <f> fail), <u> unmeasured; axe: <s> node(s) settled by measurement, <x> unmatched, <d> disagreement(s)` + one line per disagreement example.
- `record/schema.ts` screenshot evidence gains `overlayPath: z.string().optional()`.
  JSON sidecar passes it through. HTML: when `overlayPath` is present, stack the
  overlay `<img>` (inlined the same way) exactly over the crop; overlay visible at
  opacity .85, hidden on `:hover` of the figure; legend line under the swatches:
  "magenta = glyph pixels below the requirement · cyan = glyph pixels passing ·
  hover to see raw pixels". Old `samples` dots stay supported for old runs.

## 5. Ground-truth corpus (the accuracy oracle)

`test/fixtures/pages/contrast-truth.html` (+ `contrast-truth-photo.png`). Every
case is a block `<section data-case="Cnn" data-expect="pass|fail|none|gap-ok|limitation" data-ratio="x.xx">`
whose measured text **starts with the token `Cnn `**. `none` = no contrast finding
of any confidence may exist (invisible to readers). `gap-ok` = no violation may
exist; needs-review or a gap is acceptable. `data-ratio` (flat cases only) is the
exact WCAG ratio computed from the chosen colours, asserted ±0.05.

Required cases (ids fixed; add more after C45 if useful):

| id | case | expect |
|---|---|---|
| C01 | #767676 on #fff, 16px | pass (4.54) |
| C02 | #777777 on #fff, 16px | fail (4.48) |
| C03 | 24px #949494 on #fff | pass (large) |
| C04 | 24px colour chosen just under 3:1 on #fff | fail |
| C05 | 19px bold #949494 on #fff | pass (large bold) |
| C06 | 18px bold #949494 on #fff | fail (not large) |
| C07 | rgba(0,0,0,.4) on #fff | fail |
| C08 | black on #fff inside ancestor opacity .5 | fail |
| C09 | black on #fff under an absolutely positioned rgba(255,255,255,.7) shade | fail (rendered) |
| C10 | background-clip:text gradient #fff→#eee on #fff | fail |
| C11 | background-clip:text gradient #000→#333 on #fff | pass |
| C12 | 36px bold black on #fff parent containing C13 | pass |
| C13 | child span 36px bold #0096ff inside C12 | pass (large, ≈3.0+; compute exactly, pick a blue ≥3.05) |
| C14 | child span 16px #aaa inside a black-on-white paragraph | fail |
| C20 | `::before` content "C20 pseudo" #aaa on #fff | fail |
| C21 | placeholder "C21 placeholder" #767676 on #fff | pass |
| C22 | placeholder "C22 placeholder" #bbb on #fff | fail |
| C23 | input value "C23 value" #999 on #fff | fail |
| C24 | button black on #ff0 with 3px solid currentColor border | pass |
| C25 | link #fff on #0645ad with an inline SVG icon fill=currentColor | pass |
| C26 | #fff text with 0 0 4px #000 text-shadow on #fff | limitation |
| C27 | #fff on #fff (visible, not hidden) | fail (≈1:1) |
| C28 | #777 text fully covered by an opaque positioned div | gap-ok |
| C29 | sr-only (1px clip) text | none |
| C30 | text inside a `visibility:hidden` ancestor panel | none |
| C31 | opaque fixed header #111 with #fff "C31 header" | pass |
| C32 | black on #fff, JS reveal (IntersectionObserver → rAF opacity 0→1 over 600ms after 300ms delay) | pass |
| C33 | page-dark #0a0f14 section, lime #c3fd34 pill with black 16px bold text, same JS reveal | pass |
| C36 | 1400px-tall paragraph #595959 on #fff | pass |
| C37 | 1400px-tall paragraph #999 on #fff | fail |
| C38 | line 18 of a 200px `overflow:auto` box, #aaa on #fff | fail |
| C39 | line 2 of the same box, #333 on #fff | pass |
| C40 | open shadow DOM custom element text #bbb on #fff | fail |
| C41 | carousel slide clipped out by `overflow:hidden` | none |
| C42 | #fff text over `contrast-truth-photo.png` (light noisy image) | fail |
| C43 | #000 text over the same image (image has <0.5% isolated dark specks) | pass |
| C44 | black text on linear-gradient(90deg,#fff,#444) | fail |
| C45 | black text on linear-gradient(90deg,#fff,#bbb) | pass |

`scripts/score-contrast-truth.mjs [--cli <path-to-cli.js>] [--out <md>]`: serves the
fixture dir over `http://127.0.0.1:<free port>/` (node:http, no deps), runs
`node <cli> scan --url http://127.0.0.1:<port>/contrast-truth.html --max-pages 1`
in a temp cwd, renders `report --format json --out <tmp>/r.json`, and scores each
case from `defects` whose `requirementId` is `wcag22.1.4.3`. Attribution of a
defect to a case: search, in order, `element`, the computed-style `text`
property, `message`; within the first field that contains any `C\d\d ` token, the
earliest token wins. Per case: expected vs got (`violation` / `needs-review` /
none), measured ratio when present (parse `ratio` property or first `n.nn:1` in
message), pass/fail of the case. Prints and writes a markdown table plus totals:
TP, TN, FP, FN, unresolved (needs-review on a pass/fail case), ratio errors,
scan wall-time. Exit code 0 always (it is a report, not a gate).

## 6. Waves

All agents: model **sonnet**. Repo: `/Users/jeffjassky/Projects/foundry/packages/complykit`
(its own git repo, branch `glyph-contrast`). **Agents never commit, never run
`npm run build`, never touch files outside their ownership list.** Other agents
edit other files concurrently: when running `npx tsc --noEmit`, only fix errors in
your own files; report others. Run tests by file: `npx vitest run test/<file>`.
Match the surrounding code style: comments explain *why*, with the concrete failure
that motivated the rule; no comment noise on obvious lines. Final message: files
changed, test results (paste the summary lines), open issues.

| Wave | Agent | Depends on | Owns (create/modify/delete) |
|---|---|---|---|
| 1 | **A math** | — | `src/collect/browser/glyph-math.ts`, `test/glyph-math.test.ts` |
| 1 | **B corpus** | — | `test/fixtures/pages/contrast-truth.html`, `test/fixtures/pages/contrast-truth-photo.png`, `scripts/make-contrast-photo.mjs`, `scripts/score-contrast-truth.mjs`, `plans/contrast-truth-baseline.md` |
| 1 | **C page** | — | `src/collect/browser/glyph-init.ts`, `test/glyph-init.test.ts`, `test/fixtures/pages/glyph-init.html` |
| 2 | **W2 measure** | A, C | `src/collect/browser/glyph-measure.ts`, `test/glyph-measure.test.ts` |
| 2 | **E findings** | contract only | `src/record/schema.ts`, `src/rules/contrast/contrast.ts`, `src/contrast-reconcile.ts`, `src/engines.ts`, `src/enrich/supersede.ts`, `src/pipeline.ts`, `src/report/html.ts`, `src/report/json.ts`, `test/contrast-reconcile.test.ts`, `test/supersede.test.ts`, `test/html-report.test.ts`, `test/json-report.test.ts`, new `test/contrast-rule.test.ts` |
| 3 | **D integrate** | all above | `src/collect/browser/index.ts`, `src/collect/browser/screenshot.ts`, `src/collect/browser/session.ts`, `src/collect/browser/contrast.ts`, `src/collect/browser/axe.ts`; delete `pixel-band.ts`, `axe-contrast-measure.ts`, `test/pixel-band.test.ts`, `test/axe-contrast-measure.test.ts`; update `test/hidden-panel-contrast.test.ts`, `test/document-scroll-measure.test.ts`, `test/fixed-header-measure.test.ts`, `test/stitch-capture.test.ts`, `test/browser.test.ts`; `types/*.d.ts` if an export changed |
| 4 | **V verify** | D | anything needed to make the gates pass, plus `plans/DIVERGENCES.md`, `docs/reference/api.md` |

Wave 3 D specifics:
- `session.ts`: install `GLYPH_INIT` after `GEOMETRY_INIT` in `openMeasurementContext`.
- `screenshot.ts measureInBands`: overlap consecutive bands by 25% of the clear
  height (`step = max(1, round(clear * 0.75))`, band count recomputed) so ordinary
  elements are fully inside some band's clear strip. The `BandVisitor` signature may
  stay; the visitor ignores the PNG.
- `index.ts scanOnce`: `onBand` → `measureBand(page, state, ctx)` with that band's
  obstructions; after `captureScreenshot` → `measureRemaining`; then resolve axe
  `color-contrast` nodes with `resolveAxeTargets` and set `node.measureRefs` (keep
  the existing at-rest `box` re-read for all nodes); build the style-probe artifact
  from `state.done` (+ unmeasured); emit the `contrast-unmeasured` gaps. Remove
  `pixelBand`, `measureAxeContrastTargets`, `collectContrast`,
  `attributeGradientVars` usage (delete the now-dead code from `contrast.ts`; keep
  the file only if something still imports from it).
- Band-walk pages without geometry helpers (`!info` path) must still work: call
  `measureBand` once at offset 0.
- Existing browser tests keep their *intent* (fixed header, document scroll, inner
  scroller, hidden panel): rewrite their assertions against `MeasuredSubject`
  results (e.g. the fixed-header heading measures `pass` with the section's white
  background, not the header's colour).

Wave 4 V gates (all must pass; fix until they do):
1. `npm run typecheck`, `npm run boundaries`, `npm test` (0 failures; skipped
   browser suites are not acceptable — Chromium is installed).
2. `npm run build`, `npm run check-exports`.
3. `node scripts/score-contrast-truth.mjs --out plans/contrast-truth-after.md`:
   **FP = 0, FN = 0, unresolved = 0** over all non-`limitation` cases, every
   `data-ratio` within ±0.05. Report wall time.
4. Add the DIVERGENCES entry (pixel band → glyph mask; axe contrast settled by
   measurement with `contrast.text` as single reporter).

## 7. Orchestrator review & field verification (not delegated)

1. Review the full diff against this plan (contracts, restore journal
   correctness, no silent passes, dependency law).
2. Rescan maxedmarketing.ai and nofeargear.com; render HTML; for **every**
   contrast finding and a sample of passes around the known elements, crop the
   evidence and confirm by eye. Compare with the 2026-09-16 pre-change runs:
   the four known false results must be gone, the known real failures present
   with the same ratios.
3. Log results and runtimes in `plans/field-notes.md`; commit.
