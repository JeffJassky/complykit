// Page-side glyph-mask helpers, installed once per context (see plans/glyph-contrast-plan.md
// section 4.2). This is the "make only the text disappear" half of the contrast
// method: enumerate every text-bearing subject on the page, hide exactly its
// glyphs (pinning every other currentColor-derived paint — borders, icons,
// descendant colours — so a before/after screenshot diff isolates only the
// glyph pixels), and restore precisely.
//
// Self-contained on purpose: this whole module is one function, serialized by
// Playwright's addInitScript and run INSIDE the page. It cannot close over
// anything declared outside GLYPH_INIT, and it cannot import anything —
// Node-side `Rect`/`PageTextSubject`/`GlyphPageApi` types below exist only for
// callers on the Node side (glyph-measure.ts) to type the values that cross
// the page.evaluate boundary; they compile away and are never referenced by
// GLYPH_INIT itself.

export type SubjectKind = 'text' | 'before' | 'after' | 'placeholder' | 'value';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageTextSubject {
  key: string; // `${ref}:${kind}`
  ref: number; // __ck.register(owner)
  kind: SubjectKind;
  cssPath: string;
  textSample: string;
  color: string;
  opacity: number;
  fontSizePx: number;
  bold: boolean;
  large: boolean;
  required: number;
  paintedByBackground: boolean;
  rects: Rect[];
  painted: Rect | null;
  box: Rect;
}

export interface GlyphDescribeResult {
  ref: number;
  sourceFile: string | null;
  scopeId: string | null;
  fgVars: string[];
  bgVars: string[];
  bgImageVars: string[];
  flat: boolean;
  bgColor: string | null;
  cascadeRatio: number | null;
}

export interface GlyphAxeTarget {
  ref: number | null;
  measureRefs: number[];
}

/** The shape `window.__ck.glyph` has, for Node-side callers typing `page.evaluate`. */
export interface GlyphPageApi {
  enumerate(opts: { viewportOnly?: boolean; refs?: number[] }): {
    subjects: PageTextSubject[];
    truncated: boolean;
    svgTextCount: number;
  };
  hide(keys: string[]): void;
  restore(): void;
  settled(keys: string[]): { running: number; moved: number };
  resolveAxeTargets(targets: string[][]): GlyphAxeTarget[];
  describe(refs: number[]): GlyphDescribeResult[];
  scrollSubjectTo(ref: number, viewportY: number): Rect | null;
  /** Elements painted OVER this subject's text at its current scroll position
   *  (neither its ancestors nor its descendants), outermost only, as css paths.
   *  With `hide`, each is also made transparent (journaled; undone by
   *  `restore`). */
  overlaysOver(key: string, hide: boolean): string[];
}

/**
 * Ambiguity resolved: GEOMETRY_INIT does `window.__ck = {...}` WHOLESALE on
 * every navigation (it does not merge). The plan's tested order is
 * GEOMETRY_INIT then GLYPH_INIT, which is enough for a one-time attach — but
 * the job explicitly asks this to also survive the reverse order without
 * touching geometry-init.ts. A one-time attach cannot survive a LATER wholesale
 * reassignment of `window.__ck`, and nothing here can hook into when
 * geometry-init.ts happens to run. The only thing that can intercept an
 * arbitrary future `window.__ck = X` is a property descriptor on `window`
 * itself: this defines `__ck` as a getter/setter whose setter stamps `.glyph`
 * onto whatever object is assigned, before storing it. So regardless of
 * install order (or of anything else ever doing `window.__ck = {...}` again),
 * `window.__ck.glyph` is always `window.__ckGlyph`. `window.__ckGlyph` is kept
 * as the plain, ordinary holder of the api object — the thing every glyph
 * method call ultimately runs against — exactly as named in the job.
 */
export const GLYPH_INIT = (): void => {
  type Rgba = { r: number; g: number; b: number; a: number };

  // --- element registry -----------------------------------------------------
  // Refs must agree with GEOMETRY_INIT's shared registry (resolveAxeTargets
  // matches an axe target's ref against enumerate()'s subject refs, and both
  // MUST have come from the same array or the numbers mean nothing to each
  // other). geometry-init.ts does not expose a ref -> element lookup, only
  // register() and boxOf(), so this keeps its own ref -> element map, filled in
  // lockstep every time it asks the shared registry for a ref: register()
  // always returns the same index for the same element, so mapping that index
  // to the element here, at the moment we learn it, is always correct no
  // matter who else calls register() or in what order.
  const refToEl = new Map<number, Element>();
  // Fallback registry, used ONLY if geometry-init's helpers are not installed
  // (a misconfigured test, not the product path — session.ts always installs
  // GEOMETRY_INIT first). Keeps this file working stand-alone rather than
  // throwing "cannot read properties of undefined" the first time a caller
  // forgets the dependency.
  const fallbackRegistry: Element[] = [];
  function fallbackRegister(el: Element): number {
    const i = fallbackRegistry.indexOf(el);
    if (i >= 0) return i;
    fallbackRegistry.push(el);
    return fallbackRegistry.length - 1;
  }
  function fallbackContentBox(el: Element): Rect {
    const r = el.getBoundingClientRect();
    return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
  }
  function fallbackPaintedBox(el: Element): Rect | null {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }

  interface CkHelpers {
    register(el: Element): number;
    contentBox(el: Element): Rect;
    paintedBox(el: Element): Rect | null;
    glyph?: GlyphPageApi;
    [key: string]: unknown;
  }

  // Every owner ever seen by enumerate(), across every call this page has made
  // — resolveAxeTargets needs the FULL history (an axe node resolved at rest,
  // long after the walk, still has to find subjects the walk enumerated on an
  // earlier band).
  const ownersEverSeen = new Set<Element>();

  function registerEl(el: Element): number {
    const c = ck();
    const ref = c.register(el);
    refToEl.set(ref, el);
    return ref;
  }
  function elFromRef(ref: number): Element | null {
    const el = refToEl.get(ref);
    return el && el.isConnected ? el : el ?? null;
  }

  function opaqueLayer(el: Element): boolean {
    const cs = getComputedStyle(el);
    if (parseFloat(cs.opacity) < 1) return false;
    if (/^(IMG|VIDEO|CANVAS|SVG)$/i.test(el.tagName)) return true;
    const m = cs.backgroundColor.match(/rgba?\(([^)]+)\)/);
    const a = m ? (m[1].split(',')[3] === undefined ? 1 : parseFloat(m[1].split(',')[3])) : 0;
    return a >= 1;
  }

  /**
   * A shadow-aware reimplementation of geometry-init's `paintedBox`, kept
   * local rather than reused because the shared one has a real bug for
   * shadow-DOM subjects that this file cannot patch (out of scope: geometry-
   * init.ts is owned elsewhere). `document.elementFromPoint` never pierces an
   * open shadow root — it reports the HOST as the hit — and climbing from
   * that host toward the shadow-internal element via `.contains()` never
   * reaches it either (containment doesn't cross shadow boundaries), so every
   * on-screen shadow-DOM subject was misreported as "occluded" by the first
   * opaque ancestor above the host (on this fixture, the page's own white
   * body background) even though it is exactly what is painted at that
   * point. Asking the element's OWN root (its ShadowRoot, which supports
   * `elementFromPoint` too) for the hit test resolves within the tree the
   * element actually renders in.
   */
  function paintedBoxLocal(el: Element): Rect | null {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    let left = rect.left;
    let top = rect.top;
    let right = rect.right;
    let bottom = rect.bottom;
    let cur = el.parentElement;
    while (cur) {
      const cs = getComputedStyle(cur);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        const r = cur.getBoundingClientRect();
        if (cs.overflowX !== 'visible') {
          left = Math.max(left, r.left);
          right = Math.min(right, r.right);
        }
        if (cs.overflowY !== 'visible') {
          top = Math.max(top, r.top);
          bottom = Math.min(bottom, r.bottom);
        }
        if (right - left < 1 || bottom - top < 1) return null;
      }
      cur = cur.parentElement;
    }

    const ownerRoot = el.getRootNode();
    const hitRoot: Document | ShadowRoot = ownerRoot instanceof ShadowRoot ? ownerRoot : document;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    let testable = 0;
    for (let i = 1; i <= 3; i++) {
      for (let j = 1; j <= 3; j++) {
        const x = left + ((right - left) * i) / 4;
        const y = top + ((bottom - top) * j) / 4;
        if (x < 0 || y < 0 || x >= vw || y >= vh) continue;
        testable++;
        const hit = hitRoot.elementFromPoint(x, y);
        if (!hit) continue;
        if (hit === el || el.contains(hit) || hit.contains(el)) {
          return { x: left, y: top, width: right - left, height: bottom - top };
        }
        let layer: Element | null = hit;
        let blocked = false;
        while (layer && !layer.contains(el)) {
          if (opaqueLayer(layer)) {
            blocked = true;
            break;
          }
          layer = layer.parentElement;
        }
        if (!blocked) return { x: left, y: top, width: right - left, height: bottom - top };
      }
    }
    if (testable === 0) return { x: left, y: top, width: right - left, height: bottom - top };
    return null;
  }

  // --- colour / geometry helpers ---------------------------------------------
  function parseRgba(s: string | null | undefined): Rgba | null {
    if (!s) return null;
    const m = /rgba?\(([^)]+)\)/.exec(s);
    if (!m) return null;
    const parts = m[1].split(',').map((p) => parseFloat(p));
    if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }

  function isPaintedByBackground(cs: CSSStyleDeclaration): boolean {
    const fillRaw = (cs as CSSStyleDeclaration & { webkitTextFillColor?: string }).webkitTextFillColor;
    const fill = fillRaw ? parseRgba(fillRaw) : null;
    const clip = cs.backgroundClip || cs.getPropertyValue('background-clip');
    const webkitClip =
      (cs as CSSStyleDeclaration & { webkitBackgroundClip?: string }).webkitBackgroundClip ||
      cs.getPropertyValue('-webkit-background-clip');
    return (fill !== null && fill.a === 0) || clip === 'text' || webkitClip === 'text';
  }

  function effectiveOpacity(el: Element): number {
    let node: Element | null = el;
    let result = 1;
    while (node) {
      const o = parseFloat(getComputedStyle(node).opacity);
      if (!Number.isNaN(o)) result *= o;
      const parent: Element | null = node.parentElement;
      if (parent) {
        node = parent;
        continue;
      }
      const root = node.getRootNode();
      node = root instanceof ShadowRoot ? root.host : null;
    }
    return result;
  }

  /** True when `node` is inside `ancestor`, crossing open shadow boundaries. */
  function containsAcrossShadow(ancestor: Element, node: Element): boolean {
    if (ancestor.contains(node)) return true;
    let cur: Element | null = node;
    while (cur) {
      const root: Node = cur.getRootNode();
      if (root instanceof ShadowRoot) {
        const host: Element = root.host;
        if (ancestor === host || ancestor.contains(host)) return true;
        cur = host;
      } else {
        break;
      }
    }
    return false;
  }

  function contentRectViewport(el: Element): Rect {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const bt = parseFloat(cs.borderTopWidth) || 0;
    const bb = parseFloat(cs.borderBottomWidth) || 0;
    const bl = parseFloat(cs.borderLeftWidth) || 0;
    const br = parseFloat(cs.borderRightWidth) || 0;
    const pt = parseFloat(cs.paddingTop) || 0;
    const pb = parseFloat(cs.paddingBottom) || 0;
    const pl = parseFloat(cs.paddingLeft) || 0;
    const pr = parseFloat(cs.paddingRight) || 0;
    return {
      x: r.x + bl + pl,
      y: r.y + bt + pt,
      width: Math.max(0, r.width - bl - br - pl - pr),
      height: Math.max(0, r.height - bt - bb - pt - pb),
    };
  }

  function sampleText(s: string): string {
    const collapsed = (s || '').replace(/\s+/g, ' ').trim();
    return collapsed.length > 80 ? collapsed.slice(0, 80) + '…' : collapsed;
  }

  // Same generator as contrast.ts cssPath() — a duplicate, not an import,
  // because this file cannot import anything (it is serialized into the
  // page). Any drift between the two would only affect display naming, never
  // correctness, but keeping them byte-identical avoids surprising diffs
  // between glyph and legacy evidence for the same element.
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

  function unquoteContent(raw: string): string {
    let s = raw.trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      s = s.slice(1, -1);
    }
    return s.replace(/\\(.)/g, '$1');
  }

  function ck(): CkHelpers {
    const w = window as unknown as { __ck?: CkHelpers };
    if (!w.__ck) w.__ck = {} as CkHelpers;
    const c = w.__ck;
    // Patch in fallbacks only where geometry-init hasn't provided the real
    // thing — never clobber a real helper that is already there.
    if (typeof c.register !== 'function') c.register = fallbackRegister;
    if (typeof c.contentBox !== 'function') c.contentBox = fallbackContentBox;
    if (typeof c.paintedBox !== 'function') c.paintedBox = fallbackPaintedBox;
    return c;
  }

  // ---------------------------------------------------------------------------
  // enumerate
  // ---------------------------------------------------------------------------
  const MAX_SUBJECTS = 5000;

  function within(el: Element): boolean {
    const chk = (el as Element & { checkVisibility?: (o: Record<string, boolean>) => boolean }).checkVisibility;
    if (typeof chk === 'function') {
      return chk.call(el, { opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true });
    }
    return true;
  }

  function sizeAndBold(cs: CSSStyleDeclaration): { fontSizePx: number; bold: boolean; large: boolean; required: number } {
    const fontSizePx = parseFloat(cs.fontSize) || 16;
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const bold = weight >= 700;
    const large = fontSizePx >= 24 || (fontSizePx >= 18.66 && bold);
    return { fontSizePx, bold, large, required: large ? 3 : 4.5 };
  }

  function enumerate(opts: { viewportOnly?: boolean; refs?: number[] }): {
    subjects: PageTextSubject[];
    truncated: boolean;
    svgTextCount: number;
  } {
    const viewportOnly = !!(opts && opts.viewportOnly);
    const refFilter = opts && opts.refs ? new Set(opts.refs) : null;
    const eligible: PageTextSubject[] = [];
    let truncated = false;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;

    function push(subject: PageTextSubject): void {
      if (eligible.length >= MAX_SUBJECTS) {
        truncated = true;
        return;
      }
      eligible.push(subject);
    }

    function tryTextSubject(el: Element): void {
      const directText: Node[] = [];
      for (const child of Array.from(el.childNodes)) {
        if (child.nodeType === 3 && (child.textContent ?? '').trim().length > 0) directText.push(child);
      }
      if (directText.length === 0) return;
      if (!within(el)) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const cs = getComputedStyle(el);
      const color = parseRgba(cs.color);
      const paintedByBg = isPaintedByBackground(cs);
      if ((!color || color.a === 0) && !paintedByBg) return;
      const painted = paintedBoxLocal(el);
      if (painted === null) return;

      const rects: Rect[] = [];
      for (const tn of directText) {
        const range = document.createRange();
        range.selectNodeContents(tn);
        for (const r of Array.from(range.getClientRects())) {
          if (r.width > 0 && r.height > 0) rects.push({ x: r.x, y: r.y, width: r.width, height: r.height });
        }
      }
      if (rects.length === 0) return;

      const { fontSizePx, bold, large, required } = sizeAndBold(cs);
      const ref = registerEl(el);
      ownersEverSeen.add(el);
      push({
        key: `${ref}:text`,
        ref,
        kind: 'text',
        cssPath: cssPath(el),
        textSample: sampleText(directText.map((n) => n.textContent ?? '').join(' ')),
        color: cs.color,
        opacity: effectiveOpacity(el),
        fontSizePx,
        bold,
        large,
        required,
        paintedByBackground: paintedByBg,
        rects,
        painted,
        box: ck().contentBox(el),
      });
    }

    function tryPseudoSubject(el: Element, which: 'before' | 'after'): void {
      let cs: CSSStyleDeclaration;
      try {
        cs = getComputedStyle(el, `::${which}`);
      } catch {
        return;
      }
      const content = cs.content;
      if (!content || content === 'none' || content === 'normal') return;
      const text = unquoteContent(content);
      if (!text) return;
      let hasReal = false;
      for (const ch of text) {
        if (/\s/.test(ch)) continue;
        const cp = ch.codePointAt(0) ?? 0;
        if (cp >= 0xe000 && cp <= 0xf8ff) continue; // icon-font glyph: WCAG 1.4.11, not 1.4.3
        hasReal = true;
        break;
      }
      if (!hasReal) return;
      if (!within(el)) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const color = parseRgba(cs.color);
      const paintedByBg = isPaintedByBackground(cs);
      if ((!color || color.a === 0) && !paintedByBg) return;
      const painted = paintedBoxLocal(el);
      if (painted === null) return;

      const { fontSizePx, bold, large, required } = sizeAndBold(cs);
      const ownOpacity = parseFloat(cs.opacity);
      const opacity = effectiveOpacity(el) * (Number.isNaN(ownOpacity) ? 1 : ownOpacity);
      const ref = registerEl(el);
      ownersEverSeen.add(el);
      push({
        key: `${ref}:${which}`,
        ref,
        kind: which,
        cssPath: cssPath(el),
        textSample: sampleText(text),
        color: cs.color,
        opacity,
        fontSizePx,
        bold,
        large,
        required,
        paintedByBackground: paintedByBg,
        rects: [contentRectViewport(el)],
        painted,
        box: ck().contentBox(el),
      });
    }

    const VALUE_INPUT_TYPES = new Set(['text', 'email', 'search', 'tel', 'url', 'number', 'submit', 'button', 'reset']);

    function tryPlaceholderSubject(el: Element): void {
      if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return;
      const input = el as HTMLInputElement | HTMLTextAreaElement;
      const placeholder = input.getAttribute('placeholder') || '';
      if (!placeholder.trim()) return;
      if ((input.value ?? '').length > 0) return;
      if (!within(el)) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      let cs: CSSStyleDeclaration;
      try {
        cs = getComputedStyle(el, '::placeholder');
      } catch {
        cs = getComputedStyle(el);
      }
      const color = parseRgba(cs.color);
      if (!color || color.a === 0) return;
      const painted = paintedBoxLocal(el);
      if (painted === null) return;

      const { fontSizePx, bold, large, required } = sizeAndBold(cs);
      const ref = registerEl(el);
      ownersEverSeen.add(el);
      push({
        key: `${ref}:placeholder`,
        ref,
        kind: 'placeholder',
        cssPath: cssPath(el),
        textSample: sampleText(placeholder),
        color: cs.color,
        opacity: effectiveOpacity(el),
        fontSizePx,
        bold,
        large,
        required,
        paintedByBackground: false,
        rects: [contentRectViewport(el)],
        painted,
        box: ck().contentBox(el),
      });
    }

    function tryValueSubject(el: Element): void {
      let text = '';
      if (el.tagName === 'TEXTAREA') {
        text = (el as HTMLTextAreaElement).value || '';
      } else if (el.tagName === 'INPUT') {
        const type = ((el as HTMLInputElement).getAttribute('type') || 'text').toLowerCase();
        if (!VALUE_INPUT_TYPES.has(type)) return;
        text = (el as HTMLInputElement).value ?? '';
      } else if (el.tagName === 'SELECT') {
        const sel = el as HTMLSelectElement;
        const opt = sel.options[sel.selectedIndex];
        text = opt ? opt.textContent ?? '' : '';
      } else {
        return;
      }
      if (!text.trim()) return;
      if (!within(el)) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const cs = getComputedStyle(el);
      const color = parseRgba(cs.color);
      const paintedByBg = isPaintedByBackground(cs);
      if ((!color || color.a === 0) && !paintedByBg) return;
      const painted = paintedBoxLocal(el);
      if (painted === null) return;

      const { fontSizePx, bold, large, required } = sizeAndBold(cs);
      const ref = registerEl(el);
      ownersEverSeen.add(el);
      push({
        key: `${ref}:value`,
        ref,
        kind: 'value',
        cssPath: cssPath(el),
        textSample: sampleText(text),
        color: cs.color,
        opacity: effectiveOpacity(el),
        fontSizePx,
        bold,
        large,
        required,
        paintedByBackground: paintedByBg,
        rects: [contentRectViewport(el)],
        painted,
        box: ck().contentBox(el),
      });
    }

    function walk(root: Element | ShadowRoot): void {
      for (const el of Array.from(root.children)) {
        if (eligible.length >= MAX_SUBJECTS) {
          truncated = true;
          return;
        }
        tryTextSubject(el);
        tryPseudoSubject(el, 'before');
        tryPseudoSubject(el, 'after');
        tryPlaceholderSubject(el);
        tryValueSubject(el);
        if (el.shadowRoot) walk(el.shadowRoot);
        walk(el);
      }
    }
    walk(document.body);

    let svgTextCount = 0;
    for (const t of Array.from(document.querySelectorAll('svg text'))) {
      if (within(t)) svgTextCount++;
    }

    let result = eligible;
    if (refFilter) result = result.filter((s) => refFilter.has(s.ref));
    if (viewportOnly) {
      result = result.filter((s) =>
        s.rects.some((r) => r.width > 0 && r.height > 0 && r.x < vw && r.x + r.width > 0 && r.y < vh && r.y + r.height > 0),
      );
    }
    return { subjects: result, truncated, svgTextCount };
  }

  // ---------------------------------------------------------------------------
  // hide / restore
  // ---------------------------------------------------------------------------
  const PIN_PROPS = [
    'border-top-color',
    'border-right-color',
    'border-bottom-color',
    'border-left-color',
    'outline-color',
    'text-decoration-color',
    'text-emphasis-color',
    'column-rule-color',
    'fill',
    'stroke',
    'box-shadow',
    'text-shadow',
    '-webkit-text-stroke-color',
  ];

  type JournalEntry =
    | { type: 'prop'; el: HTMLElement | SVGElement; prop: string; value: string; priority: string }
    | { type: 'attr'; el: Element; name: string; had: boolean; value: string | null }
    | { type: 'style'; styleEl: HTMLStyleElement };

  let journal: JournalEntry[] = [];
  // Which elements this hide() call has already recorded the ORIGINAL
  // style-attribute presence for, so restore() can drop the attribute entirely
  // when it was absent before — `removeProperty` alone leaves a lingering
  // `style=""` in some engines, which fails the "attribute absent again" case.
  let styleAbsentInitially = new Set<Element>();
  let styleTouched = new Set<Element>();
  let pseudoTokenCounter = 0;

  function styleableEl(el: Element): HTMLElement | SVGElement {
    return el as unknown as HTMLElement | SVGElement;
  }

  function setProp(el: Element, prop: string, value: string): void {
    const target = styleableEl(el);
    if (!styleTouched.has(el)) {
      styleTouched.add(el);
      // Whether to drop the attribute entirely on restore is decided from
      // `style.length` (declared properties), not `hasAttribute('style')`: a
      // later, unrelated `page.screenshot({ clip })` call can reflect a
      // transient EMPTY `style=""` attribute onto elements inside the clipped
      // region (observed independently of this code, with plain DOM calls),
      // and reading `hasAttribute` at just the wrong moment mistook that for
      // a real pre-existing attribute — permanently leaving `style=""`
      // behind after restore. An empty declaration list means the same thing
      // either way (no author style), so `length === 0` is both the correct
      // and the race-proof test.
      if (target.style.length === 0) styleAbsentInitially.add(el);
    }
    journal.push({
      type: 'prop',
      el: target,
      prop,
      value: target.style.getPropertyValue(prop),
      priority: target.style.getPropertyPriority(prop),
    });
    target.style.setProperty(prop, value, 'important');
  }

  function setAttr(el: Element, name: string, value: string): void {
    journal.push({ type: 'attr', el, name, had: el.hasAttribute(name), value: el.getAttribute(name) });
    el.setAttribute(name, value);
  }

  function hidePseudo(el: Element, kind: 'before' | 'after' | 'placeholder'): void {
    const token = `ck${pseudoTokenCounter++}`;
    const prevAttr = el.getAttribute('data-ck-g');
    setAttr(el, 'data-ck-g', prevAttr ? `${prevAttr} ${token}` : token);

    const root = el.getRootNode();
    const parent: HTMLElement | ShadowRoot = root === document ? document.head : (root as ShadowRoot);
    const styleEl = document.createElement('style');
    styleEl.setAttribute('data-ck-glyph', '');
    const pseudoSel = kind === 'placeholder' ? '::placeholder' : `::${kind}`;
    styleEl.textContent = `[data-ck-g~="${token}"]${pseudoSel}{color:transparent!important;-webkit-text-fill-color:transparent!important}`;
    parent.appendChild(styleEl);
    journal.push({ type: 'style', styleEl });
  }

  /** Whether `prop` currently paints anything on an element with this style. */
  function pinIsPainted(cs: CSSStyleDeclaration, prop: string): boolean {
    const none = (v: string): boolean => v === 'none' || v === 'hidden' || v === '';
    const width = (v: string): boolean => (parseFloat(v) || 0) > 0;
    const side = /^border-(top|right|bottom|left)-color$/.exec(prop);
    if (side) {
      return !none(cs.getPropertyValue(`border-${side[1]}-style`)) && width(cs.getPropertyValue(`border-${side[1]}-width`));
    }
    switch (prop) {
      case 'outline-color':
        return !none(cs.getPropertyValue('outline-style')) && width(cs.getPropertyValue('outline-width'));
      case 'text-decoration-color':
        return !none(cs.getPropertyValue('text-decoration-line'));
      case 'text-emphasis-color':
        return !none(cs.getPropertyValue('text-emphasis-style'));
      case 'column-rule-color':
        return !none(cs.getPropertyValue('column-rule-style')) && width(cs.getPropertyValue('column-rule-width'));
      case 'box-shadow':
      case 'text-shadow':
        return !none(cs.getPropertyValue(prop));
      case '-webkit-text-stroke-color':
        return width(cs.getPropertyValue('-webkit-text-stroke-width'));
      case 'fill':
      case 'stroke':
        // Only SVG content paints with these; on an HTML owner they are inert.
        return false;
      default:
        return true;
    }
  }

  function hide(keys: string[]): void {
    if (!Array.isArray(keys) || keys.length === 0) return;
    const parsed: Array<{ el: Element; kind: SubjectKind }> = [];
    const hiddenOwners = new Set<Element>();
    for (const key of keys) {
      const idx = key.indexOf(':');
      if (idx < 0) continue;
      const ref = parseInt(key.slice(0, idx), 10);
      const kind = key.slice(idx + 1) as SubjectKind;
      const el = elFromRef(ref);
      if (!el || !el.isConnected) continue;
      parsed.push({ el, kind });
      if (kind === 'text' || kind === 'value') hiddenOwners.add(el);
    }
    if (parsed.length === 0) return;

    // Phase 1: read every computed value this call will need BEFORE any write
    // touches the DOM. A parent/child pair (a coloured span inside a black
    // paragraph, C12/C13 in the truth corpus) can both be in this same batch;
    // writing `color: transparent` on the parent first would make the child's
    // computed `color` (if it inherits) read back as the parent's NEW value,
    // corrupting the very thing being pinned to preserve its look.
    interface TextRead {
      el: Element;
      kind: 'text' | 'value';
      pins: Record<string, string>;
      paintedByBg: boolean;
      descendants: Array<{ el: Element; color: string; fill: string }>;
    }
    const reads: Array<TextRead | { el: Element; kind: 'before' | 'after' | 'placeholder' }> = [];
    for (const { el, kind } of parsed) {
      if (kind === 'text' || kind === 'value') {
        const cs = getComputedStyle(el);
        // Pin only paints that are actually DRAWN. A pin is meant to be a no-op
        // (same value, now independent of `color`), but writing it into the
        // style attribute is not free: WordPress core ships
        // `:where([style*=border-top-color]){border-top-style:solid}`, so a
        // pinned border colour on an element with no border made a 3px
        // (medium) black border appear in screenshot B. Every heading and
        // paragraph on a WordPress page then "measured" its text colour against
        // that phantom line at 1:1 — 42 false failures on one route.
        const pins: Record<string, string> = {};
        for (const p of PIN_PROPS) if (pinIsPainted(cs, p)) pins[p] = cs.getPropertyValue(p);
        const ownColor = cs.color;
        const descendants: TextRead['descendants'] = [];
        for (const d of Array.from(el.querySelectorAll('*'))) {
          if (hiddenOwners.has(d)) continue; // that descendant's own glyphs are being hidden too
          const dcs = getComputedStyle(d);
          // Only a descendant whose colour could be inherited from the owner
          // needs pinning; one with its own different colour is unaffected, and
          // every avoidable style-attribute write is another chance to match a
          // page's `[style*=…]` selector.
          if (dcs.color !== ownColor) continue;
          descendants.push({
            el: d,
            color: dcs.color,
            fill: (dcs as CSSStyleDeclaration & { webkitTextFillColor?: string }).webkitTextFillColor || '',
          });
        }
        reads.push({ el, kind, pins, paintedByBg: isPaintedByBackground(cs), descendants });
      } else {
        reads.push({ el, kind: kind as 'before' | 'after' | 'placeholder' });
      }
    }

    // Phase 2: write, journaling as we go.
    for (const r of reads) {
      if (r.kind === 'text' || r.kind === 'value') {
        const tr = r as TextRead;
        setProp(tr.el, 'color', 'transparent');
        setProp(tr.el, '-webkit-text-fill-color', 'transparent');
        if (tr.paintedByBg) setProp(tr.el, 'background-image', 'none');
        for (const p of Object.keys(tr.pins)) setProp(tr.el, p, tr.pins[p]);
        for (const d of tr.descendants) {
          setProp(d.el, 'color', d.color);
          if (d.fill) setProp(d.el, '-webkit-text-fill-color', d.fill);
        }
      } else {
        hidePseudo(r.el, r.kind);
      }
    }
  }

  function restore(): void {
    // Force the browser to resolve any pending attribute/style reflection
    // for every touched element before replaying the journal. Observed
    // empirically (plain DOM calls, unrelated to the replay logic below): a
    // `page.screenshot({ clip })` taken while a hidden subject's inline
    // styles are still applied can leave the "style" content attribute's
    // reflection PENDING; reading it here — before we start removing
    // properties — is what makes `style.length === 0` further down actually
    // true by the time we act on it, instead of racing a stale cached read.
    for (const el of styleTouched) {
      void styleableEl(el).style.cssText;
      void el.hasAttribute('style');
    }
    for (let i = journal.length - 1; i >= 0; i--) {
      const entry = journal[i];
      if (entry.type === 'prop') {
        if (entry.value) entry.el.style.setProperty(entry.prop, entry.value, entry.priority);
        else entry.el.style.removeProperty(entry.prop);
      } else if (entry.type === 'attr') {
        if (entry.had && entry.value !== null) entry.el.setAttribute(entry.name, entry.value);
        else entry.el.removeAttribute(entry.name);
      } else {
        entry.styleEl.parentNode?.removeChild(entry.styleEl);
      }
    }
    journal = [];
    for (const el of styleAbsentInitially) {
      const target = styleableEl(el);
      if (target.style.length === 0) el.removeAttribute('style');
    }
    // A later, unrelated `page.screenshot({ clip })` call can reflect a
    // transient EMPTY `style=""` attribute back onto elements inside the
    // clipped region (observed with plain DOM calls, nothing to do with the
    // hide/restore logic above) — force layout/style to settle now, while
    // this call still owns the synchronous turn, so that side effect has
    // nothing left to disturb.
    for (const el of styleAbsentInitially) void getComputedStyle(el).color;
    styleAbsentInitially = new Set();
    styleTouched = new Set();
  }

  // ---------------------------------------------------------------------------
  // settled
  // ---------------------------------------------------------------------------
  const lastState = new Map<number, { opacity: number; rect: { x: number; y: number; width: number; height: number } }>();

  function settled(keys: string[]): { running: number; moved: number } {
    const owners: Array<{ ref: number; el: Element }> = [];
    for (const key of keys) {
      const idx = key.indexOf(':');
      if (idx < 0) continue;
      const ref = parseInt(key.slice(0, idx), 10);
      const el = elFromRef(ref);
      if (el) owners.push({ ref, el });
    }

    let running = 0;
    const anims = typeof document.getAnimations === 'function' ? document.getAnimations() : [];
    for (const a of anims) {
      if (a.playState !== 'running' && !a.pending) continue;
      const effect = a.effect as (AnimationEffect & { target?: Element | null; getTiming?: () => EffectTiming }) | null;
      const target = effect?.target;
      if (!target) continue;
      const timing = effect?.getTiming ? effect.getTiming() : undefined;
      if (timing && timing.iterations === Infinity) continue;
      const related = owners.some(({ el }) => target === el || containsAcrossShadow(target, el));
      if (related) running++;
    }

    let moved = 0;
    for (const { ref, el } of owners) {
      const opacity = effectiveOpacity(el);
      const r = el.getBoundingClientRect();
      const rect = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
      const prev = lastState.get(ref);
      if (prev) {
        const rectChanged =
          prev.rect.x !== rect.x || prev.rect.y !== rect.y || prev.rect.width !== rect.width || prev.rect.height !== rect.height;
        const opacityChanged = Math.abs(prev.opacity - opacity) > 1e-6;
        if (rectChanged || opacityChanged) moved++;
      }
      lastState.set(ref, { opacity, rect });
    }
    return { running, moved };
  }

  // ---------------------------------------------------------------------------
  // resolveAxeTargets
  // ---------------------------------------------------------------------------
  function resolveAxeTargets(targets: string[][]): GlyphAxeTarget[] {
    return targets.map((path) => {
      try {
        if (!path || path.length === 0) return { ref: null, measureRefs: [] };
        let root: Document | ShadowRoot = document;
        let el: Element | null = null;
        for (let i = 0; i < path.length; i++) {
          const found: Element | null = root.querySelector(path[i]);
          if (!found) return { ref: null, measureRefs: [] };
          el = found;
          if (i < path.length - 1) {
            const sr: ShadowRoot | null = found.shadowRoot;
            if (!sr) return { ref: null, measureRefs: [] };
            root = sr;
          }
        }
        if (!el) return { ref: null, measureRefs: [] };
        const ref = registerEl(el);
        const measureRefs = [ref];
        for (const owner of ownersEverSeen) {
          if (owner !== el && containsAcrossShadow(el, owner)) measureRefs.push(registerEl(owner));
        }
        return { ref, measureRefs };
      } catch {
        return { ref: null, measureRefs: [] };
      }
    });
  }

  // ---------------------------------------------------------------------------
  // describe — ported from contrast.ts collectInPage / attributeGradientVars,
  // addressed by ref instead of cssPath (a cssPath can match the wrong element
  // once the DOM has moved on; a ref never does).
  // ---------------------------------------------------------------------------
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

  // Composite the ancestor background stack over white; null if any layer
  // (crossing shadow hosts, unlike the original page-only walk in contrast.ts —
  // shadow-root text subjects need the same answer) uses a background image.
  function effectiveBg(el: Element): [number, number, number] | null {
    let node: Element | null = el;
    const layers: Array<[number, number, number, number]> = [];
    while (node) {
      const cs = getComputedStyle(node);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
      const parsed = parseRgba(cs.backgroundColor);
      if (parsed && parsed.a > 0) layers.push([parsed.r, parsed.g, parsed.b, parsed.a]);
      const parent: Element | null = node.parentElement;
      if (parent) {
        node = parent;
        continue;
      }
      const root = node.getRootNode();
      node = root instanceof ShadowRoot ? root.host : null;
    }
    let base: [number, number, number] = [255, 255, 255];
    for (let i = layers.length - 1; i >= 0; i--) {
      const [lr, lg, lb, la] = layers[i];
      base = [lr * la + base[0] * (1 - la), lg * la + base[1] * (1 - la), lb * la + base[2] * (1 - la)];
    }
    return base;
  }

  interface BgVarRule {
    sel: string;
    vars: string[];
  }
  function bgVarRules(): BgVarRule[] {
    const w = window as unknown as { __ckBgVarRules?: BgVarRule[] };
    if (w.__ckBgVarRules) return w.__ckBgVarRules;
    const out: BgVarRule[] = [];
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

  function gradientVarsFor(startEl: Element): string[] {
    let owner: Element | null = startEl;
    while (owner) {
      const bi = getComputedStyle(owner).backgroundImage;
      if (bi && bi !== 'none') break;
      owner = owner.parentElement;
    }
    if (!owner) return [];
    const vars = new Set<string>();
    const VAR_RE = /var\(\s*(--[A-Za-z0-9_-]+)/g;
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
    return Array.from(vars).slice(0, 6);
  }

  function srgbLum(rgb: [number, number, number]): number {
    const f = (c: number): number => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
  }
  function ratioOf(a: [number, number, number], b: [number, number, number]): number {
    const l1 = srgbLum(a);
    const l2 = srgbLum(b);
    const hi = Math.max(l1, l2);
    const lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  }

  function describe(refs: number[]): GlyphDescribeResult[] {
    return refs.map((ref) => {
      const el = elFromRef(ref);
      if (!el) {
        return { ref, sourceFile: null, scopeId: null, fgVars: [], bgVars: [], bgImageVars: [], flat: true, bgColor: null, cascadeRatio: null };
      }
      const cs = getComputedStyle(el);
      const bg = effectiveBg(el);
      const flat = bg !== null;
      const bgStr = bg ? `rgb(${bg.map((n) => Math.round(n)).join(',')})` : null;
      const [fgVars, bgVars] = matchVars(el, [cs.color, bgStr]);
      const bgImageVars = flat ? [] : gradientVarsFor(el);
      const fg = parseRgba(cs.color);
      const cascadeRatio = flat && bg && fg ? Math.round(ratioOf([fg.r, fg.g, fg.b], bg) * 100) / 100 : null;
      return {
        ref,
        sourceFile: vueFile(el),
        scopeId: vueScopeId(el),
        fgVars,
        bgVars,
        bgImageVars,
        flat,
        bgColor: bgStr,
        cascadeRatio,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // scrollSubjectTo
  // ---------------------------------------------------------------------------
  function scrollsY(e: Element): boolean {
    const over = e.scrollHeight - e.clientHeight;
    if (over <= 0) return false;
    const oy = getComputedStyle(e).overflowY;
    return oy === 'auto' || oy === 'scroll';
  }

  function scrollSubjectTo(ref: number, viewportY: number): Rect | null {
    const el = elFromRef(ref);
    if (!el || !el.isConnected) return null;
    el.scrollIntoView({ block: 'start', inline: 'nearest' });

    let scroller: Element | null = null;
    let cur: Element | null = el.parentElement;
    while (cur) {
      if (scrollsY(cur)) {
        scroller = cur;
        break;
      }
      cur = cur.parentElement;
    }
    // scrollIntoView parks the top near the scroller's/viewport's own top edge;
    // shift by the measured delta rather than assuming it landed at exactly 0,
    // so a sticky header or rounding does not throw the target off by a few px.
    const t0 = el.getBoundingClientRect().top;
    const delta = t0 - viewportY;
    if (scroller) scroller.scrollTop += delta;
    else window.scrollBy(0, delta);

    if (!el.isConnected) return null;
    const after = el.getBoundingClientRect();
    return { x: after.x, y: after.y, width: after.width, height: after.height };
  }

  // ---------------------------------------------------------------------------
  // overlaysOver
  // ---------------------------------------------------------------------------
  // What the browser itself says is stacked above the text: hit-test sample
  // points across the subject's line boxes with elementsFromPoint, and keep
  // every element above the owner that is not part of it. Stacking order,
  // z-index, transforms and fixed/sticky/absolute positioning are all resolved
  // by the browser, not re-derived here. `pointer-events:none` would drop a
  // scrim out of the hit test, so it is overridden for the duration of the
  // query. Only asked about text that already FAILED as rendered: whether an
  // overlay matters is decided by re-measuring with it hidden, never by
  // guessing from its opacity.
  function overlaysOver(key: string, doHide: boolean): string[] {
    const idx = key.indexOf(':');
    if (idx < 0) return [];
    const owner = elFromRef(parseInt(key.slice(0, idx), 10));
    if (!owner || !owner.isConnected) return [];
    const kind = key.slice(idx + 1);

    let boxes: DOMRect[] = [];
    if (kind === 'text') {
      const range = document.createRange();
      range.selectNodeContents(owner);
      boxes = Array.from(range.getClientRects());
      range.detach();
    }
    if (boxes.length === 0) boxes = Array.from(owner.getClientRects());

    const root = owner.getRootNode();
    const hitRoot: Document | ShadowRoot = root instanceof ShadowRoot ? root : document;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const pe = document.createElement('style');
    pe.textContent = '*{pointer-events:auto!important}';
    (root instanceof ShadowRoot ? root : document.head).appendChild(pe);
    const found = new Set<Element>();
    try {
      for (const b of boxes.slice(0, 40)) {
        if (b.width < 1 || b.height < 1) continue;
        for (let i = 1; i <= 5; i++) {
          const x = b.left + (b.width * i) / 6;
          const y = b.top + b.height / 2;
          if (x < 0 || y < 0 || x >= vw || y >= vh) continue;
          for (const hit of hitRoot.elementsFromPoint(x, y)) {
            if (hit === owner || containsAcrossShadow(hit, owner)) break; // reached the text's own layer
            if (containsAcrossShadow(owner, hit)) continue; // the text's own children
            if (hit === pe) continue;
            found.add(hit);
          }
        }
      }
    } finally {
      pe.remove();
    }
    const outer = Array.from(found).filter((el) => !Array.from(found).some((o) => o !== el && o.contains(el)));
    if (doHide) for (const el of outer) setProp(el, 'visibility', 'hidden');
    return outer.map(cssPath);
  }

  // ---------------------------------------------------------------------------
  const api: GlyphPageApi = { enumerate, hide, restore, settled, resolveAxeTargets, describe, scrollSubjectTo, overlaysOver };
  const w = window as unknown as { __ckGlyph?: GlyphPageApi; __ck?: CkHelpers };
  w.__ckGlyph = api;

  let ckValue: CkHelpers | undefined = w.__ck;
  function stamp(v: CkHelpers | undefined): CkHelpers | undefined {
    if (v && typeof v === 'object') v.glyph = api;
    return v;
  }
  const existingDescriptor = Object.getOwnPropertyDescriptor(window, '__ck');
  if (!existingDescriptor || existingDescriptor.configurable) {
    Object.defineProperty(window, '__ck', {
      configurable: true,
      get(): CkHelpers | undefined {
        return ckValue;
      },
      set(v: CkHelpers | undefined) {
        ckValue = stamp(v);
      },
    });
  }
  ckValue = stamp(ckValue ?? ({} as CkHelpers));
};
