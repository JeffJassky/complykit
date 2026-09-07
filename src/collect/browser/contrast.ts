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
  // Source localization, straight from the framework runtime when available:
  // Vue dev builds hang the component instance off its root element
  // (el.__vueParentComponent), and instance.type.__file is the SFC's source
  // path. scopeId (the data-v-xxxxxxxx style-scope hash) is the fallback for
  // builds where __file is stripped — the pipeline maps it back to a file.
  sourceFile: string | null;
  scopeId: string | null;
  // CSS custom properties whose value, RESOLVED IN THIS ELEMENT'S CONTEXT,
  // equals the violating colour — so a fix can target `--text-muted` instead of
  // hunting a literal. Computed styles resolve var() away, but the declarations
  // in document.styleSheets still expose the names; each is re-resolved per
  // element (theme scoping and overrides included) and colour-normalized.
  fgVars?: string[];
  bgVars?: string[]; // flat backgrounds only (exact context-resolved match)
  // Variables named IN THE AUTHORED background/background-image declaration of
  // the element that owns the non-flat background (gradient stops etc.). Read
  // from the CSSOM declaration — where var() survives — never inferred by
  // matching measured pixels to values (a sampled mid-gradient grey would
  // falsely accuse any token that happens to hold that grey).
  bgImageVars?: string[];
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
  // The element's rect in the CURRENT viewport. Pixel measurement uses this
  // against the band captured at this scroll position; `box` (capture space)
  // stays the stable identity/evidence coordinate.
  viewportBox?: { x: number; y: number; width: number; height: number };
  // Assigned AFTER collection by the pixel-band escalation (index.ts) — the
  // measured verdict and the exact colours it read off the screenshot.
  measuredBand?: 'pass' | 'fail' | 'ambiguous';
  minRatio?: number;
  maxRatio?: number;
  samples?: Array<{ x: number; y: number }>;
  fgColor?: string;
  bgLoColor?: string;
  bgHiColor?: string;
  ratioLo?: number;
  ratioHi?: number;
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

  // --- CSS variable attribution -------------------------------------------
  // All custom-property names declared anywhere in same-origin stylesheets
  // (cross-origin sheets throw on cssRules — skipped). Cached on window.
  function cssVarNames(): string[] {
    const w = window as unknown as { __ckVarNames?: string[] };
    if (w.__ckVarNames) return w.__ckVarNames;
    const names = new Set<string>();
    const walk = (rules: CSSRuleList): void => {
      for (const r of Array.from(rules)) {
        const st = (r as CSSStyleRule).style;
        if (st) {
          for (let i = 0; i < st.length; i++) {
            const p = st[i];
            if (p.startsWith('--')) names.add(p);
          }
        }
        const sub = (r as CSSMediaRule).cssRules;
        if (sub) walk(sub);
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        if (sheet.cssRules) walk(sheet.cssRules);
      } catch {
        /* cross-origin */
      }
    }
    w.__ckVarNames = Array.from(names).slice(0, 600);
    return w.__ckVarNames;
  }
  // Normalize any CSS colour string to a computed rgb() via a probe element.
  // Memoized — theme values repeat across thousands of lookups.
  const normMemo = new Map<string, string>();
  let probeEl: HTMLElement | null = null;
  function normColor(v: string): string {
    const hit = normMemo.get(v);
    if (hit !== undefined) return hit;
    if (!probeEl) {
      probeEl = document.createElement('div');
      probeEl.style.display = 'none';
      document.body.appendChild(probeEl);
    }
    probeEl.style.color = '';
    probeEl.style.color = v;
    const out = probeEl.style.color ? getComputedStyle(probeEl).color : '';
    normMemo.set(v, out);
    return out;
  }
  // Which declared variables resolve, on THIS element, to each target colour.
  function matchVars(el: Element, targets: Array<string | null>): string[][] {
    const out: string[][] = targets.map(() => []);
    const norms = targets.map((t) => (t ? normColor(t) : ''));
    if (!norms.some(Boolean)) return out;
    const cs = getComputedStyle(el);
    for (const name of cssVarNames()) {
      const raw = cs.getPropertyValue(name).trim();
      if (!raw) continue;
      const norm = normColor(raw);
      if (!norm) continue;
      for (let i = 0; i < norms.length; i++) {
        if (norms[i] && norms[i] === norm && out[i].length < 4) out[i].push(name);
      }
    }
    return out;
  }

  // Nearest owning Vue SFC, via the dev-build component instance chain. Climbs
  // DOM ancestors to the first element that carries an instance, then the
  // component parent chain to the first with a source file. null in prod builds.
  function vueFile(el: Element): string | null {
    let node: Element | null = el;
    while (node) {
      const inst = (node as unknown as { __vueParentComponent?: { type?: { __file?: string }; parent?: unknown } })
        .__vueParentComponent;
      if (inst) {
        let c: { type?: { __file?: string }; parent?: unknown } | undefined = inst;
        while (c) {
          const f = c.type?.__file;
          if (typeof f === 'string' && f) return f;
          c = c.parent as typeof c;
        }
        return null;
      }
      node = node.parentElement;
    }
    return null;
  }
  // Nearest self-or-ancestor style-scope id (data-v-xxxxxxxx attribute).
  function vueScopeId(el: Element): string | null {
    let node: Element | null = el;
    while (node) {
      for (const a of node.getAttributeNames()) {
        const m = a.match(/^data-v-([0-9a-f]{7,8})$/);
        if (m) return m[1];
      }
      node = node.parentElement;
    }
    return null;
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

  function ckBox(el: Element, r: DOMRect): { x: number; y: number; width: number; height: number } {
    const ck = (window as unknown as { __ck?: { contentBox(e: Element): { x: number; y: number; width: number; height: number } } }).__ck;
    return ck ? ck.contentBox(el) : { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
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
    // The element's OWN styles are not enough. A closed mega-menu, a carousel
    // slide, a modal that has not opened: these lay out with real geometry
    // while an ancestor hides them with opacity, visibility or
    // content-visibility. Measuring one samples whatever is painted at those
    // coordinates — the page behind it — and reports the panel's text as
    // failing against a background it never sits on. On one real site that was
    // a closed dropdown, laid out over the hero, reported at 1.03:1.
    // checkVisibility asks the engine the question directly, ancestors
    // included; where it is missing, the own-style check above still stands.
    const check = (el as Element & {
      checkVisibility?: (o: Record<string, boolean>) => boolean;
    }).checkVisibility;
    if (
      typeof check === 'function' &&
      !check.call(el, { opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })
    ) {
      continue;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;

    const fg = parseRgb(cs.color);
    if (!fg) continue;
    // Fully transparent text (alpha 0) is invisible, not a contrast defect —
    // flagging it is a false positive (and it produces the confusing ratio-less
    // findings). Skip it here; a hidden-text a11y concern is a different rule.
    if (fg[3] === 0) continue;
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
    const bgStr = flat ? `rgb(${bg!.map((n) => Math.round(n)).join(',')})` : null;
    const [fgVars, bgVars] = matchVars(el, [cs.color, bgStr]);
    out.push({
      cssPath: cssPath(el),
      sourceFile: vueFile(el),
      scopeId: vueScopeId(el),
      fgVars: fgVars.length ? fgVars : undefined,
      bgVars: bgVars.length ? bgVars : undefined,
      textSample: text.length > 80 ? text.slice(0, 80) + '…' : text,
      fontSizePx,
      bold,
      large,
      textColor: cs.color,
      bgColor: bgStr,
      flat,
      ratio: r === null ? null : Math.round(r * 100) / 100,
      required,
      // Document-absolute (viewport rect + scroll): correct as a crop region
      // into the full-page screenshot regardless of scroll position, and the
      // geometry key for cross-collector element matching (supersede pass).
      // Capture space: rect + the scroll offset of every scrolling ancestor
      // (geometry-init.ts). Identical to rect + window.scroll when the document
      // scrolls; correct too when an inner container does.
      box: ckBox(el, rect),
      viewportBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    });
    if (out.length >= 400) break; // bound the payload
  }
  return out;
}

export interface ContrastCollection {
  artifact: Artifact;
  candidates: ContrastCandidate[];
}

// Gradient variable attribution for NON-FLAT candidates — HIGH-CONFIDENCE ONLY.
// Computed styles resolve var() away, but the AUTHORED declarations in the
// CSSOM keep it. So: climb to the ancestor that owns the background image (the
// same element that made effectiveBg bail), find every stylesheet rule that
// actually applies to it (el.matches(selectorText)) plus its inline style, and
// read the var() names verbatim out of the authored background declarations.
// These are the tokens the code actually uses. We deliberately do NOT match
// measured band pixels against variable values — a sampled mid-gradient grey
// would falsely accuse any token that happens to hold that grey.
export async function attributeGradientVars(page: Page, candidates: ContrastCandidate[]): Promise<void> {
  const targets = candidates.map((c, i) => ({ i, sel: c.cssPath })).filter((t) => t.sel && !candidates[t.i].flat);
  if (!targets.length) return;
  try {
    const resolved = (await page.evaluate((ts: Array<{ i: number; sel: string }>) => {
      // Every (selector, authored background declaration containing var()) pair
      // in same-origin stylesheets. Cached on window.
      interface BgRule {
        sel: string;
        vars: string[];
      }
      function bgVarRules(): BgRule[] {
        const w = window as unknown as { __ckBgVarRules?: BgRule[] };
        if (w.__ckBgVarRules) return w.__ckBgVarRules;
        const out: BgRule[] = [];
        const VAR_RE = /var\(\s*(--[A-Za-z0-9_-]+)/g;
        const walk = (rules: CSSRuleList): void => {
          for (const r of Array.from(rules)) {
            const sr = r as CSSStyleRule;
            if (sr.style && sr.selectorText) {
              const authored = sr.style.getPropertyValue('background-image') || sr.style.getPropertyValue('background');
              if (authored && authored.includes('var(')) {
                const vars = [...authored.matchAll(VAR_RE)].map((m) => m[1]);
                if (vars.length) out.push({ sel: sr.selectorText, vars });
              }
            }
            const sub = (r as CSSMediaRule).cssRules;
            if (sub) walk(sub);
          }
        };
        for (const sheet of Array.from(document.styleSheets)) {
          try {
            if (sheet.cssRules) walk(sheet.cssRules);
          } catch {
            /* cross-origin */
          }
        }
        w.__ckBgVarRules = out;
        return out;
      }
      const VAR_RE = /var\(\s*(--[A-Za-z0-9_-]+)/g;
      return ts.map((t) => {
        try {
          const start = document.querySelector(t.sel);
          if (!start) return { i: t.i, vars: [] };
          // The background owner: first self-or-ancestor with a background image
          // (what made the flat-colour compositor bail).
          let owner: Element | null = start;
          while (owner) {
            const bi = getComputedStyle(owner).backgroundImage;
            if (bi && bi !== 'none') break;
            owner = owner.parentElement;
          }
          if (!owner) return { i: t.i, vars: [] };
          const vars = new Set<string>();
          // Inline style keeps authored var() too.
          const inline =
            (owner as HTMLElement).style?.getPropertyValue('background-image') ||
            (owner as HTMLElement).style?.getPropertyValue('background');
          if (inline) for (const m of inline.matchAll(VAR_RE)) vars.add(m[1]);
          for (const rule of bgVarRules()) {
            try {
              if (owner.matches(rule.sel)) for (const v of rule.vars) vars.add(v);
            } catch {
              /* unsupported selector */
            }
          }
          return { i: t.i, vars: Array.from(vars).slice(0, 6) };
        } catch {
          return { i: t.i, vars: [] };
        }
      });
    }, targets)) as Array<{ i: number; vars: string[] }>;
    for (const r of resolved) {
      if (r.vars.length) candidates[r.i].bgImageVars = r.vars;
    }
  } catch {
    /* page gone — attribution stays empty */
  }
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
