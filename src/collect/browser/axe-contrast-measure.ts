import type { Page } from 'playwright';
import { PNG } from 'pngjs';
import { pixelBand } from './pixel-band.js';
import type { ContrastCandidate } from './contrast.js';

// Measure the elements axe COULDN'T resolve.
//
// The contrast collector keeps only candidates its own cascade walk finds
// suspect: a flat stack that already passes is dropped as uninteresting. But
// "the cascade passes" and "the pixels pass" are different claims. When another
// element overlaps the text, axe reports `incomplete` ("background color could
// not be determined because it is overlapped by another element") while our
// cascade walk happily resolves the ancestor colour and drops the candidate —
// so exactly the elements in dispute had no measurement.
//
// This pass closes that hole: after axe runs, take its color-contrast targets,
// read each element's text colour and size, and pixel-measure the same region
// off the cell's capture. The results ride along in the contrast artifact, where
// engines.ts reconciles them against axe's verdict (contrast-reconcile.ts).
// Elements the collector already measured are skipped — the richer candidate,
// which knows whether the background is flat, wins.

interface Resolved {
  ref?: number;
  paintedByBackground?: boolean;
  sel: string;
  textColor: string;
  fontSizePx: number;
  bold: boolean;
  textSample: string | null;
  box: { x: number; y: number; width: number; height: number } | null;
  viewportBox: { x: number; y: number; width: number; height: number } | null;
}

type Box = NonNullable<Resolved['box']>;

/** Same element: centres and both dimensions within 2px (see contrast-reconcile). */
function coincides(a: Box, b: Box): boolean {
  const TOL = 2;
  if (Math.abs(a.width - b.width) > TOL || Math.abs(a.height - b.height) > TOL) return false;
  return Math.hypot(a.x + a.width / 2 - (b.x + b.width / 2), a.y + a.height / 2 - (b.y + b.height / 2)) <= TOL;
}

/** color-contrast targets out of an axe result payload (violations + incomplete). */
export function axeContrastTargets(results: unknown): string[] {
  const payload = results as { violations?: unknown; incomplete?: unknown };
  const out: string[] = [];
  for (const list of [payload?.violations, payload?.incomplete]) {
    if (!Array.isArray(list)) continue;
    for (const rule of list as Array<{ id?: string; nodes?: Array<{ target?: unknown }> }>) {
      if (rule?.id !== 'color-contrast' || !Array.isArray(rule.nodes)) continue;
      for (const node of rule.nodes) {
        if (Array.isArray(node?.target) && node.target.every((t) => typeof t === 'string')) {
          out.push((node.target as string[]).join(' '));
        }
      }
    }
  }
  return [...new Set(out)];
}

export async function measureAxeContrastTargets(
  page: Page,
  results: unknown,
  existing: ContrastCandidate[],
): Promise<ContrastCandidate[]> {
  const selectors = axeContrastTargets(results);
  if (selectors.length === 0) return [];

  let resolved: Resolved[];
  try {
    resolved = (await page.evaluate((sels: string[]) => {
      const ckBox = (el: Element, r: DOMRect): { x: number; y: number; width: number; height: number } => {
        const ck = (window as unknown as { __ck?: { contentBox(e: Element): { x: number; y: number; width: number; height: number } } }).__ck;
        return ck ? ck.contentBox(el) : { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
      };
      return sels.map((sel) => {
        try {
          const el = document.querySelector(sel);
          if (!el) return { sel, textColor: '', fontSizePx: 16, bold: false, textSample: null, box: null, viewportBox: null };
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          const raw = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
          // The same visibility question the contrast collector asks, from the
          // same shared helper: an element clipped out of a panel, or painted
          // over by something else, has a rect but no pixels of its own, and
          // measuring there reads whatever shows through. This pass resolves
          // axe's selectors instead of walking text nodes, and it originally
          // took the bare bounding rect — reintroducing exactly the bug the
          // collector had just been fixed for: 21 fictional violations, all at
          // a uniform 2.38:1.
          const ckv = (window as unknown as { __ck?: { paintedBox(e: Element): { x: number; y: number; width: number; height: number } | null } }).__ck;
          const painted = ckv?.paintedBox ? ckv.paintedBox(el) : { x: r.x, y: r.y, width: r.width, height: r.height };
          // Gradient text (`background-clip: text` + a transparent fill): the
          // glyphs ARE the background, so a pixel band compares the gradient
          // with itself and returns ~1.1:1 for a perfectly legible headline.
          // The collector already refuses to measure these; this path is the
          // other way in, and it has to refuse too — otherwise axe's honest
          // "incomplete" gets revised into a confident, wrong violation.
          const fillRaw = (cs as CSSStyleDeclaration & { webkitTextFillColor?: string }).webkitTextFillColor;
          const clipsToText =
            cs.backgroundClip === 'text' ||
            (cs as CSSStyleDeclaration & { webkitBackgroundClip?: string }).webkitBackgroundClip === 'text';
          const transparentFill = !!fillRaw && /rgba?\([^)]*,\s*0\s*\)$/.test(fillRaw);
          const paintedByBackground = clipsToText || transparentFill;
          const ckReg = (window as unknown as { __ck?: { register(e: Element): number } }).__ck;
          return {
            sel,
            ref: ckReg?.register ? ckReg.register(el) : undefined,
            paintedByBackground: paintedByBackground || undefined,
            textColor: cs.color,
            fontSizePx: parseFloat(cs.fontSize) || 16,
            bold: (parseInt(cs.fontWeight, 10) || 400) >= 700,
            textSample: raw ? (raw.length > 80 ? raw.slice(0, 80) + '…' : raw) : null,
            // Document-absolute, matching every other collector's geometry key.
            box: r.width >= 1 && r.height >= 1 ? ckBox(el, r) : null,
            viewportBox: painted && painted.width >= 1 && painted.height >= 1 ? painted : null,
          };
        } catch {
          return { sel, textColor: '', fontSizePx: 16, bold: false, textSample: null, box: null, viewportBox: null };
        }
      });
    }, selectors)) as Resolved[];
  } catch {
    return []; // page gone — axe's own verdict stands unreconciled
  }

  // Our own capture, taken now: measuring against an image made earlier is only
  // valid if the page has not moved since, and a loading app moves. Elements
  // off-screen at this scroll position are simply not measured — no measurement
  // is honest, a measurement of the wrong pixels is not.
  let png: PNG;
  try {
    png = PNG.sync.read(await page.screenshot({ type: 'png' }));
  } catch {
    return [];
  }

  const added: ContrastCandidate[] = [];
  for (const r of resolved) {
    if (!r.box || !r.textColor || !r.viewportBox) continue;
    if (existing.some((c) => c.box && coincides(c.box, r.box as Box))) continue;
    const vb = r.viewportBox;
    if (vb.y + vb.height <= 0 || vb.y >= png.height) continue; // off-screen right now
    const large = r.fontSizePx >= 24 || (r.fontSizePx >= 18.66 && r.bold);
    const candidate: ContrastCandidate = {
      ref: r.ref,
      paintedByBackground: r.paintedByBackground,
      cssPath: r.sel,
      sourceFile: null,
      scopeId: null,
      textSample: r.textSample ?? '',
      fontSizePx: r.fontSizePx,
      bold: r.bold,
      large,
      textColor: r.textColor,
      bgColor: null,
      // Flat marks this as "not contrast.text's business" — that rule owns the
      // non-flat backlog and skips flat stacks, so these stay reconciliation-only
      // and can never become a second finding for the same element.
      flat: true,
      ratio: null,
      required: large ? 3 : 4.5,
      box: r.box,
    };
    const band = pixelBand(png, candidate, vb);
    if (!band) continue;
    Object.assign(candidate, {
      measuredBand: band.band,
      minRatio: band.minRatio,
      maxRatio: band.maxRatio,
      samples: band.samples,
      fgColor: band.fgColor,
      bgLoColor: band.bgLoColor,
      bgHiColor: band.bgHiColor,
      ratioLo: band.ratioLo,
      ratioHi: band.ratioHi,
    });
    added.push(candidate);
  }
  return added;
}
