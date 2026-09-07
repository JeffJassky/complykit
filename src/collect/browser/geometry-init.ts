// Page-side geometry helpers, installed once per context.
//
// Two assumptions were baked into every collector and both are wrong for app
// shells: that the DOCUMENT scrolls, and that `window.scrollY` therefore
// locates an element in the captured image. Modern shells pin the document
// (`body { overflow: hidden }`) and scroll an inner container, so the document
// stays exactly viewport-tall while content lives at y > viewportHeight. The
// consequences were silent: `fullPage: true` captured one screen, the scroll-
// through pass scrolled nothing (so lazy content never loaded), and every
// pixel measurement of a below-fold element clipped to zero and returned "ratio
// could not be proven" — 43 of 50 remaining contrast findings in this app.
//
// Nothing here guesses at frameworks or class names. A scroll container is
// decidable from the DOM exactly as the browser decides it: it overflows and
// its computed overflow allows scrolling.

export const GEOMETRY_INIT = (): void => {
  const MIN_OVERFLOW = 32; // ignore a few px of rounding slop

  function scrolls(el: Element): boolean {
    const over = el.scrollHeight - el.clientHeight;
    if (over <= MIN_OVERFLOW) return false;
    const oy = getComputedStyle(el).overflowY;
    return oy === 'auto' || oy === 'scroll' || el === document.scrollingElement;
  }

  /**
   * Every INNER scroll container, innermost-first. The document's own
   * scroller is excluded on purpose: contentBox already adds window.scrollY,
   * and counting <html>'s scrollTop on top of it doubled the document offset
   * for every box read mid-walk — an element at 14,517 reported 28,451 while
   * parked at 13,934. It went unnoticed because the at-rest re-read happens at
   * scrollY 0, where the double is 0.
   */
  function scrollAncestors(el: Element): Element[] {
    const out: Element[] = [];
    const doc = document.scrollingElement ?? document.documentElement;
    let cur: Element | null = el.parentElement;
    while (cur) {
      if (cur !== doc && cur !== document.body && scrolls(cur)) out.push(cur);
      cur = cur.parentElement;
    }
    return out;
  }

  /**
   * A stable handle on an element for the life of the page.
   *
   * The collector's cssPath is a positional fingerprint — good enough to name a
   * finding, not good enough to find the element again: `div>div>div:nth-of-
   * type(2)>p>span:nth-of-type(1)` matches dozens of nodes and querySelector
   * returns the first. Re-reading geometry "at rest" through that selector
   * landed on the wrong element and stamped its box onto the measurement, so
   * the reconciliation — which matches axe's node to ours geometrically —
   * missed by 50px and reported a measured, passing element as unresolved.
   * 44 of 85 residual findings on the client were this.
   */
  const registry: Element[] = [];
  function register(el: Element): number {
    const i = registry.indexOf(el);
    if (i >= 0) return i;
    registry.push(el);
    return registry.length - 1;
  }
  function boxOf(ref: number): { x: number; y: number; width: number; height: number } | null {
    const el = registry[ref];
    if (!el || !el.isConnected) return null;
    return contentBox(el);
  }

  /**
   * The element's position in CAPTURE SPACE: viewport rect plus the scroll
   * offset of every scrolling ancestor. With the document scrolling this is the
   * familiar rect + window.scrollY; with an inner scroller it is the position in
   * the stitched capture. One definition, both layouts.
   */
  function contentBox(el: Element): { x: number; y: number; width: number; height: number } {
    const r = el.getBoundingClientRect();
    let x = r.x + window.scrollX;
    let y = r.y + window.scrollY;
    for (const s of scrollAncestors(el)) {
      x += s.scrollLeft;
      y += s.scrollTop;
    }
    return { x, y, width: r.width, height: r.height };
  }

  /**
   * The container the page actually scrolls: the scroller with the largest
   * scrollable distance, preferring the one covering the most viewport area
   * when several tie. Returns the document scroller's metrics when the document
   * itself scrolls, so callers have one shape to handle.
   */
  function primaryScroller(): {
    inner: boolean;
    top: number; // the scroller's viewport-relative top edge
    clientHeight: number;
    scrollHeight: number;
    scrollTop: number;
  } {
    const doc = document.scrollingElement ?? document.documentElement;
    let best: Element | null = null;
    let bestOver = 0;
    const all = document.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (el === doc || el === document.body) continue;
      if (!scrolls(el)) continue;
      const over = el.scrollHeight - el.clientHeight;
      const r = el.getBoundingClientRect();
      if (r.width * r.height < 10000) continue; // a small scrolling widget is not the page
      if (over > bestOver) {
        bestOver = over;
        best = el;
      }
    }
    const docOver = doc.scrollHeight - doc.clientHeight;
    if (!best || docOver >= bestOver) {
      return { inner: false, top: 0, clientHeight: doc.clientHeight, scrollHeight: doc.scrollHeight, scrollTop: doc.scrollTop };
    }
    const r = best.getBoundingClientRect();
    (window as unknown as { __ckScroller?: Element }).__ckScroller = best;
    return { inner: true, top: r.y, clientHeight: best.clientHeight, scrollHeight: best.scrollHeight, scrollTop: best.scrollTop };
  }

  function scrollPrimaryTo(offset: number): number {
    const info = primaryScroller();
    if (!info.inner) {
      window.scrollTo(0, offset);
      const doc = document.scrollingElement ?? document.documentElement;
      return doc.scrollTop;
    }
    const el = (window as unknown as { __ckScroller?: Element }).__ckScroller;
    if (!el) return 0;
    el.scrollTop = offset;
    return el.scrollTop;
  }

  /**
   * The fixed and sticky elements PAINTED OVER the scrolling content, as
   * viewport rects, plus the insets they occupy at the top and bottom edges.
   *
   * A viewport screenshot is what the camera sees, not what the document says:
   * a fixed header is drawn over whatever content is scrolled beneath it. Any
   * pixel measurement of an element under that header samples the header. On
   * this app the header is 136px of rgba(13,10,23,.875), so a near-black
   * heading on a white section — parked at a scroll offset that put it in the
   * top 136px — measured as near-black on dark purple: a confident, precise,
   * fictional failure.
   *
   * Two uses. The insets let the band walk park content clear of the chrome;
   * the rects let a measurement pass reject anything still overlapped, rather
   * than measure it against pixels that belong to something else.
   */
  function obstructions(): {
    rects: { x: number; y: number; width: number; height: number }[];
    topInset: number;
    bottomInset: number;
  } {
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const rects: { x: number; y: number; width: number; height: number }[] = [];
    let topInset = 0;
    let bottomInset = 0;
    const all = document.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
      if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue;
      // A nested fixed child is inside its fixed ancestor's rect; keeping both
      // is harmless for the intersection test and cheap.
      rects.push({ x: r.x, y: r.y, width: r.width, height: r.height });
      // Only a band spanning most of the width actually costs usable rows; a
      // floating chat bubble in a corner does not, and insetting for it would
      // throw away most of the viewport.
      if (r.width < vw * 0.5) continue;
      if (r.top <= 0 && r.bottom > topInset) topInset = r.bottom;
      if (r.bottom >= vh && vh - r.top > bottomInset) bottomInset = vh - r.top;
    }
    // Never let chrome claim the whole screen; leave a usable strip.
    const cap = vh * 0.4;
    return { rects, topInset: Math.min(topInset, cap), bottomInset: Math.min(bottomInset, cap) };
  }

  /**
   * The rect a reader can actually SEE for this element, or null.
   *
   * Two things stand between "it has a bounding box" and "you can look at it",
   * and both produced whole classes of fictional contrast findings:
   *
   *  - Clipping. `getBoundingClientRect` reports where an element WOULD be.
   *    Inside `overflow: hidden` — a fixed-height transcript panel, a masked
   *    carousel, a collapsed section — the overflowing lines still lay out and
   *    still report a position, but nothing of them is drawn. Sampling there
   *    reads the section underneath.
   *  - Occlusion. Something is painted on top. Rects cannot settle this: a
   *    fixed header overlaps everything beneath it, but its OWN text is on top
   *    and perfectly measurable, so rejecting by rectangle throws away the
   *    header's contents along with what they cover.
   *
   * So: intersect with every clipping ancestor, then ask the compositor via
   * `elementFromPoint`, which honours stacking contexts, z-index, clips and
   * transforms. A hit counts when it is the element, a descendant (a glyph
   * span), or an ancestor (the point fell between glyphs onto the element's own
   * background — exactly the pixel we want to sample). Nine points, because one
   * can land in a gap. Points outside the viewport cannot be hit-tested, so
   * they are not evidence of occlusion; an element off-screen in this band is
   * left for a band that has it on screen.
   *
   * Lives here so the contrast collector and the axe-target measurement pass
   * cannot drift apart on it — they did, and the second one reintroduced the
   * first one's bug.
   */
  /**
   * Does this element hide what is behind it? A translucent shade over a hero
   * dims the text beneath, but the text is still what the reader sees — and
   * what the reader sees, dimmed, is exactly what should be measured. Only an
   * opaque surface (a solid fill, an image, a video) takes the pixels away.
   */
  function opaque(el: Element): boolean {
    const cs = getComputedStyle(el);
    if (parseFloat(cs.opacity) < 1) return false;
    if (/^(IMG|VIDEO|CANVAS|SVG)$/i.test(el.tagName)) return true;
    const m = cs.backgroundColor.match(/rgba?\(([^)]+)\)/);
    const a = m ? (m[1].split(',')[3] === undefined ? 1 : parseFloat(m[1].split(',')[3])) : 0;
    if (a >= 1) return true;
    // A background image with no opaque colour behind it: a gradient with
    // alpha is see-through, a raster is not. Gradients are far more common as
    // overlays, so err toward measuring; a raster is handled by the IMG case
    // when it is an element, and is rare as a CSS background over text.
    return false;
  }

  function paintedBox(el: Element): { x: number; y: number; width: number; height: number } | null {
    const rect = el.getBoundingClientRect();
    // A 1x1 (or thinner) box is the visually-hidden idiom: text for screen
    // readers, clipped to nothing on screen. Nobody sees it, so there is
    // nothing to measure and nothing to report.
    if (rect.width < 2 || rect.height < 2) return null;
    let left = rect.left, top = rect.top, right = rect.right, bottom = rect.bottom;
    let cur = el.parentElement;
    while (cur) {
      const cs = getComputedStyle(cur);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        const r = cur.getBoundingClientRect();
        if (cs.overflowX !== 'visible') { left = Math.max(left, r.left); right = Math.min(right, r.right); }
        if (cs.overflowY !== 'visible') { top = Math.max(top, r.top); bottom = Math.min(bottom, r.bottom); }
        if (right - left < 1 || bottom - top < 1) return null;
      }
      cur = cur.parentElement;
    }

    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    let testable = 0;
    for (let i = 1; i <= 3; i++) {
      for (let j = 1; j <= 3; j++) {
        const x = left + ((right - left) * i) / 4;
        const y = top + ((bottom - top) * j) / 4;
        if (x < 0 || y < 0 || x >= vw || y >= vh) continue;
        testable++;
        const hit = document.elementFromPoint(x, y);
        if (!hit) continue;
        if (hit === el || el.contains(hit) || hit.contains(el)) {
          return { x: left, y: top, width: right - left, height: bottom - top };
        }
        // Something unrelated is on top. If it is see-through, the text is
        // still visible — dimmed — and that dimmed rendering is the honest
        // thing to measure. Check every layer between it and us, since a
        // translucent shade may itself sit inside an opaque panel.
        let layer: Element | null = hit;
        let blocked = false;
        while (layer && layer !== document.documentElement && !layer.contains(el)) {
          if (opaque(layer)) { blocked = true; break; }
          layer = layer.parentElement;
        }
        if (!blocked) return { x: left, y: top, width: right - left, height: bottom - top };
      }
    }
    // Nothing testable means we learned nothing, not that it is hidden.
    if (testable === 0) return { x: left, y: top, width: right - left, height: bottom - top };
    return null;
  }

  /**
   * Scroll containers OTHER than the page's own, currently on screen.
   *
   * The band walk scrolls the primary scroller and nothing else. A fixed-height
   * transcript box, a sticky documentation sidebar, a carousel track: each is
   * its own scroller, and everything past its first screen is laid out, clipped,
   * and never brought into view by the walk — so it is never measured. On the
   * client that was every transcript row past the fourth; on the help centre,
   * every sidebar link below the fold of an 800px viewport. The walk asks for
   * these per band and steps through each one it has not walked yet.
   */
  function innerScrollers(): Array<{ ref: number; top: number; clientHeight: number; scrollHeight: number }> {
    const doc = document.scrollingElement ?? document.documentElement;
    const vh = document.documentElement.clientHeight;
    const out: Array<{ ref: number; top: number; clientHeight: number; scrollHeight: number }> = [];
    const all = document.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (el === doc || el === document.body) continue;
      if (!scrolls(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width * r.height < 10000) continue;
      if (r.bottom <= 0 || r.top >= vh) continue;
      const primary = (window as unknown as { __ckScroller?: Element }).__ckScroller;
      if (el === primary) continue;
      out.push({ ref: register(el), top: r.top, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight });
    }
    return out;
  }

  function scrollInnerTo(ref: number, offset: number): number {
    const el = registry[ref];
    if (!el) return 0;
    el.scrollTop = offset;
    return el.scrollTop;
  }

  (window as unknown as { __ck?: unknown }).__ck = { contentBox, primaryScroller, scrollPrimaryTo, scrolls, obstructions, paintedBox, register, boxOf, innerScrollers, scrollInnerTo };
};
