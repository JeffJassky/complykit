import type { Page } from 'playwright';
import type { Artifact, Subject } from '../../record/index.js';

// Family B: computed-style contrast (WCAG 1.4.3), ours, beyond axe. The hard
// part is the EFFECTIVE background (pitfall #1): an element's own background is
// usually transparent, so we composite the ancestor stack. Deterministic ONLY
// for flat-colour stacks; a background image/gradient or an unresolved alpha is
// marked `flat: false` and left for the pixel-band / C1 escalation (M4). We
// never guess a ratio the cascade can't prove.

export interface ContrastCandidate {
  cssPath: string;
  textSample: string;
  fontSizePx: number;
  bold: boolean;
  large: boolean;
  textColor: string;
  bgColor: string | null;
  flat: boolean;
  ratio: number | null;
  required: number;
  box: { x: number; y: number; width: number; height: number };
}

// This function is serialized and run INSIDE the page. Keep it self-contained.
function collectInPage(): ContrastCandidate[] {
  function parseRgb(s: string): [number, number, number, number] | null {
    const m = s.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(',').map((p) => parseFloat(p.trim()));
    const [r, g, b, a = 1] = parts;
    return [r, g, b, a];
  }
  function lum(r: number, g: number, b: number): number {
    const f = (c: number): number => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  function ratio(fg: [number, number, number], bg: [number, number, number]): number {
    const l1 = lum(...fg);
    const l2 = lum(...bg);
    const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
    return (hi + 0.05) / (lo + 0.05);
  }
  // Composite the ancestor background stack over white. Returns null if any
  // ancestor uses a background image/gradient (not a flat colour).
  function effectiveBg(el: Element): [number, number, number] | null {
    let node: Element | null = el;
    let r = 255,
      g = 255,
      b = 255,
      accumA = 0; // accumulate from the element outward, over white base
    const layers: Array<[number, number, number, number]> = [];
    while (node) {
      const cs = getComputedStyle(node);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null; // image/gradient
      const parsed = parseRgb(cs.backgroundColor);
      if (parsed) {
        const [pr, pg, pb, pa] = parsed;
        if (pa > 0) layers.push([pr, pg, pb, pa]);
      }
      node = node.parentElement;
    }
    // Composite layers from outermost (last) to innermost (first) over white.
    let base: [number, number, number] = [255, 255, 255];
    for (let i = layers.length - 1; i >= 0; i--) {
      const [lr, lg, lb, la] = layers[i];
      base = [lr * la + base[0] * (1 - la), lg * la + base[1] * (1 - la), lb * la + base[2] * (1 - la)];
      accumA = 1;
    }
    void r;
    void g;
    void b;
    void accumA;
    return base;
  }

  function cssPath(el: Element): string {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && parts.length < 5 && node.nodeType === 1) {
      let sel = node.nodeName.toLowerCase();
      if (node.id) {
        sel += `#${node.id}`;
        parts.unshift(sel);
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.nodeName === node!.nodeName);
        if (sibs.length > 1) sel += `:nth-of-type(${sibs.indexOf(node) + 1})`;
      }
      parts.unshift(sel);
      node = node.parentElement;
    }
    return parts.join('>');
  }

  const out: ContrastCandidate[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set<Element>();
  let textNode: Node | null;
  while ((textNode = walker.nextNode())) {
    const text = (textNode.textContent ?? '').trim();
    if (text.length < 2) continue;
    const el = textNode.parentElement;
    if (!el || seen.has(el)) continue;
    seen.add(el);

    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;

    const fg = parseRgb(cs.color);
    if (!fg) continue;
    const fontSizePx = parseFloat(cs.fontSize) || 16;
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const bold = weight >= 700;
    const large = fontSizePx >= 24 || (fontSizePx >= 18.66 && bold);
    const required = large ? 3 : 4.5;

    const bg = effectiveBg(el);
    const flat = bg !== null;
    const r = flat ? ratio([fg[0], fg[1], fg[2]], bg) : null;

    // Keep only failing flat candidates and all ambiguous ones (escalation set).
    if (flat && r !== null && r >= required) continue;
    out.push({
      cssPath: cssPath(el),
      textSample: text.slice(0, 80),
      fontSizePx,
      bold,
      large,
      textColor: cs.color,
      bgColor: flat ? `rgb(${bg!.map((n) => Math.round(n)).join(',')})` : null,
      flat,
      ratio: r === null ? null : Math.round(r * 100) / 100,
      required,
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    });
    if (out.length >= 400) break; // bound the payload
  }
  return out;
}

export interface ContrastCollection {
  artifact: Artifact;
  candidates: ContrastCandidate[];
}

export async function collectContrast(page: Page, subject: Subject, capturedAt: string): Promise<ContrastCollection> {
  const candidates = (await page.evaluate(collectInPage)) as ContrastCandidate[];
  return {
    candidates,
    artifact: {
      kind: 'style-probe',
      subject,
      capturedAt,
      check: 'contrast',
      results: candidates as unknown as Record<string, unknown>[],
    },
  };
}
