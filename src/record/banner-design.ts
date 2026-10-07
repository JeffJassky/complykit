import { z } from 'zod';

// The consent-banner design readout (ticket F6): what the browser measured
// about a banner, so pure rules (rules/consent/banner-design.ts) can judge it
// against the dark-pattern findings in plans/research-consent-law.md §1.2,
// §3.1, §3.3. Collected by collect/browser/evaluation/banner-design.ts and
// carried in the consent timeline as `consent-readout` events with the labels
// below — the timeline already flows to rules and evidence files, so no new
// artifact kind is needed.
//
// The readout stays raw where a judgment is involved (colors as the browser
// computed them, boxes in CSS px); the math that turns colors into contrast
// ratios lives here, pure, so the collector, the rules and the tests share it.
// Anything the browser could not measure is null / absent and named in
// `unmeasured` — a rule never reads a missing value as a pass.

export const BANNER_DESIGN_LABEL = 'banner-design';
export const BANNER_SECOND_LAYER_LABEL = 'banner-second-layer';
export const BANNER_AFTER_CHOICE_LABEL = 'banner-after-choice';

const Box = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });

/** How the banner was found: our own tool by its documented hooks, a known tool's selectors, or the strict heuristic. */
export const BannerSource = z.enum(['complykit', 'known-selector', 'heuristic']);
export type BannerSource = z.infer<typeof BannerSource>;

/** Page usability behind a banner (cookie wall measurement). */
export const BannerBlocking = z.object({
  /** Fraction (0–1) of sample points outside the banner where the topmost element is the banner or an overlay; null = not measurable. */
  covered: z.number().nullable(),
  /** Page content is inert / aria-hidden, or the banner is a modal dialog (showModal). */
  inert: z.boolean(),
  /** html/body scrolling switched off (overflow hidden, body position fixed). */
  scrollLocked: z.boolean(),
  /** The document is taller than the viewport (a scroll lock only matters if so). */
  scrollable: z.boolean(),
});
export type BannerBlocking = z.infer<typeof BannerBlocking>;

export const BannerControl = z.object({
  role: z.enum(['accept', 'reject', 'manage', 'close']),
  tag: z.string(), // 'button' | 'a' | 'input' | 'div' …
  text: z.string(),
  box: Box,
  fontSizePx: z.number(),
  fontWeight: z.number(),
  /** Computed text color. */
  color: z.string(),
  /** Background colors from the control outward until an opaque one (innermost first). */
  backgrounds: z.array(z.string()),
  /** A background image/gradient sits under the text — contrast is not measurable from colors. */
  backgroundImage: z.boolean(),
  /** Has a visible border (width > 0, not transparent). */
  bordered: z.boolean(),
  /** Inside the viewport without scrolling the page. */
  inViewport: z.boolean(),
  /** The topmost element at its center is the control (not clipped by an inner scroller, not covered). */
  reachable: z.boolean(),
  /** Document order among the banner's controls (0 = first). */
  domIndex: z.number().int(),
});
export type BannerControl = z.infer<typeof BannerControl>;

export const BannerLink = z.object({ text: z.string(), href: z.string().optional(), inFooter: z.boolean().optional() });
export type BannerLink = z.infer<typeof BannerLink>;

/** First layer: everything visible on landing, before any click. */
export const BannerFirstLayer = z.object({
  /** A banner was on screen and readable in the top document. */
  found: z.boolean(),
  source: BannerSource.optional(),
  cmp: z.string().optional(),
  bannerBox: Box.optional(),
  /** Background colors of the banner root outward until an opaque one. */
  bannerBackgrounds: z.array(z.string()).default([]),
  /** The banner is a modal dialog. */
  modal: z.boolean().default(false),
  controls: z.array(BannerControl).default([]),
  /** The banner's visible text (truncated). */
  text: z.string().default(''),
  links: z.array(BannerLink).default([]),
  blocking: BannerBlocking.optional(),
  /** Page-wide links whose words are a statutory opt-out label or close to one (CCPA §7013/§7015). */
  optOutLinks: z.array(BannerLink).default([]),
  /** Did the page carry our own tool (#complykit-config / #complykit-ui)? */
  complykit: z.boolean().default(false),
  unmeasured: z.array(z.string()).default([]),
});
export type BannerFirstLayer = z.infer<typeof BannerFirstLayer>;

export const BannerToggle = z.object({
  label: z.string(),
  checked: z.boolean(),
  disabled: z.boolean(),
  kind: z.enum(['checkbox', 'switch']),
  /** Our tool's category id (data-ck-category), when known. */
  category: z.string().optional(),
});
export type BannerToggle = z.infer<typeof BannerToggle>;

/** Second layer: the default state of the category toggles. */
export const BannerSecondLayer = z.object({
  source: BannerSource.optional(),
  /** 'dom' = read without opening (rendered but hidden); 'opened' = after opening the settings; 'not-found' = no toggles. */
  via: z.enum(['dom', 'opened', 'not-found']),
  toggles: z.array(BannerToggle).default([]),
  unmeasured: z.array(z.string()).default([]),
});
export type BannerSecondLayer = z.infer<typeof BannerSecondLayer>;

export const WithdrawalControl = z.object({
  text: z.string(),
  via: z.enum(['complykit', 'known-widget', 'link']),
  inFooter: z.boolean().default(false),
});
export type WithdrawalControl = z.infer<typeof WithdrawalControl>;

/** Right after a choice: is the page usable, and is there a visible way back into the settings? */
export const BannerAfterChoice = z.object({
  choice: z.enum(['accept', 'reject']),
  bannerVisible: z.boolean(),
  blocking: BannerBlocking.optional(),
  controls: z.array(WithdrawalControl).default([]),
  /** A consent-tool JS API that can reopen the settings (not visible to a visitor by itself). */
  api: z.string().optional(),
  unmeasured: z.array(z.string()).default([]),
});
export type BannerAfterChoice = z.infer<typeof BannerAfterChoice>;

// --- Color math (WCAG 2.x relative luminance) -----------------------------------

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Parse a computed color: rgb()/rgba() (legacy or space syntax) and color(srgb …). Anything else → undefined. */
export function parseCssColor(s: string): Rgba | undefined {
  const t = s.trim().toLowerCase();
  if (t === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  let m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(t);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a };
  }
  m = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(t);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
    return { r: Number(m[1]) * 255, g: Number(m[2]) * 255, b: Number(m[3]) * 255, a };
  }
  return undefined;
}

function over(top: Rgba, under: Rgba): Rgba {
  const a = top.a + under.a * (1 - top.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (x: number, y: number): number => (x * top.a + y * under.a * (1 - top.a)) / a;
  return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b), a };
}

/**
 * Composite a background stack (innermost first) into one opaque color. A stack
 * that never reaches an opaque layer is composited over white (the canvas
 * default) and flagged `assumed`. undefined when a layer is unparseable.
 */
export function effectiveBackground(stack: readonly string[]): { color: Rgba; assumed: boolean } | undefined {
  let acc: Rgba = { r: 0, g: 0, b: 0, a: 0 };
  for (const s of stack) {
    const c = parseCssColor(s);
    if (!c) return undefined;
    acc = over(acc, c);
    if (acc.a >= 0.999) return { color: { ...acc, a: 1 }, assumed: false };
  }
  return { color: over(acc, { r: 255, g: 255, b: 255, a: 1 }), assumed: true };
}

function luminance(c: Rgba): number {
  const ch = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

/** WCAG contrast ratio between two opaque colors (1–21). */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Text contrast of a control against its own effective background; undefined when not measurable. */
export function controlTextContrast(c: BannerControl): number | undefined {
  if (c.backgroundImage) return undefined;
  const bg = effectiveBackground(c.backgrounds);
  const fg = parseCssColor(c.color);
  if (!bg || !fg) return undefined;
  return contrastRatio(over(fg, bg.color), bg.color);
}

/**
 * How much the control's own surface stands out from the banner behind it
 * (contrast of control background vs banner background). ~1 = the control has
 * no surface of its own (a text link); a filled, colored button scores high.
 */
export function controlEmphasis(c: BannerControl, bannerBackgrounds: readonly string[]): number | undefined {
  if (c.backgroundImage) return undefined;
  const own = effectiveBackground(c.backgrounds);
  const banner = effectiveBackground(bannerBackgrounds);
  if (!own || !banner) return undefined;
  return contrastRatio(own.color, banner.color);
}

// --- Withdrawal / settings wording ------------------------------------------------

/** Link or button wording that reopens consent settings (footer link patterns, CBTF ¶¶31–35). */
export const WITHDRAWAL_LINK_TEXT =
  /cookie[- ]?(settings|preferences|choices|consent)|privacy (settings|preferences|choices)|manage (cookies|consent|(my )?preferences|privacy)|consent (settings|preferences|choices)|change (cookie|consent|privacy) (settings|preferences)|withdraw (my )?consent|your privacy choices|cookie-einstellungen|paramètres des cookies|gérer (les )?cookies/i;

/**
 * Heuristic: does banner text read as English? The required-wording checks are
 * English patterns; other languages are reported as not tested, never passed.
 */
export function looksEnglish(text: string): boolean {
  const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
  if (words.length < 4) return false;
  const common = new Set(['the', 'and', 'we', 'you', 'to', 'of', 'for', 'our', 'your', 'use', 'this', 'with', 'or', 'by', 'on', 'can', 'site', 'website']);
  const hits = words.filter((w) => common.has(w)).length;
  return hits >= 2 && hits / words.length >= 0.08;
}
