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

  /** Every scroll container, innermost-first. */
  function scrollAncestors(el: Element): Element[] {
    const out: Element[] = [];
    let cur: Element | null = el.parentElement;
    while (cur) {
      if (scrolls(cur)) out.push(cur);
      cur = cur.parentElement;
    }
    return out;
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

  (window as unknown as { __ck?: unknown }).__ck = { contentBox, primaryScroller, scrollPrimaryTo, scrolls, obstructions };
};
