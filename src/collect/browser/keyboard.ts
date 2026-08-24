import type { Page } from 'playwright';
import type { Artifact, Subject } from '../../record/index.js';

// Family C: the keyboard walk. Tab through the page recording focus order,
// whether each stop has a visible focus indicator, and any keyboard trap (focus
// that won't advance) or focus loss (focus landing on <body>). Runs on the
// measurement profile. Bounded — never tabs forever.

export interface FocusStop {
  index: number;
  tag: string;
  role: string | null;
  name: string;
  hasVisibleFocus: boolean;
  lostToBody: boolean;
  cssPath?: string; // selector path to the focused element
  href?: string; // for links
  html?: string; // the element's own opening tag (truncated) — dom-snippet evidence
  box?: { x: number; y: number; width: number; height: number }; // document-absolute — croppable evidence
}
export interface TrapRecord {
  atIndex: number;
  reason: 'no-advance' | 'cycle';
}

function readActive(): Omit<FocusStop, 'index'> {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) {
    return { tag: 'body', role: null, name: '', hasVisibleFocus: false, lostToBody: true };
  }
  const cs = getComputedStyle(el);
  // Heuristic visible-focus check: a focus ring is an outline or a box-shadow.
  const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
  const ring = cs.boxShadow !== 'none';
  // Stretched-link pattern: the ring lives on a wrapper via
  // `.card:has(a:focus-visible){outline:…}` while the link itself sets
  // outline:none. An ANCESTOR outline while this element holds focus is that
  // ring. Ancestor box-shadow deliberately does NOT count — cards carry static
  // shadows; a static container outline is rare enough to be a safe signal.
  let ancestorOutline = false;
  for (let a = el.parentElement, i = 0; a && i < 5 && !ancestorOutline; a = a.parentElement, i++) {
    const acs = getComputedStyle(a);
    ancestorOutline = acs.outlineStyle !== 'none' && parseFloat(acs.outlineWidth) > 0;
  }
  const name = (el.getAttribute('aria-label') ?? el.textContent ?? el.getAttribute('title') ?? '').trim().slice(0, 60);
  // A selector path to the element, so a focus finding points at WHICH control —
  // not just "a link". Mirrors the contrast collector's cssPath heuristic.
  const cssPath = (node: Element): string => {
    const parts: string[] = [];
    let cur: Element | null = node;
    while (cur && parts.length < 5 && cur.nodeType === 1) {
      let sel = cur.nodeName.toLowerCase();
      if (cur.id) { parts.unshift(`${sel}#${cur.id}`); break; }
      const parent: Element | null = cur.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.nodeName === cur!.nodeName);
        if (sibs.length > 1) sel += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
      }
      parts.unshift(sel);
      cur = cur.parentElement;
    }
    return parts.join('>');
  };
  // The element's opening tag only (attributes, no inner content) — enough to
  // identify it as evidence without dumping a whole subtree.
  const openTag = el.outerHTML.slice(0, el.outerHTML.indexOf('>') + 1 || 200).slice(0, 200);
  const r = el.getBoundingClientRect();
  const ck = (window as unknown as { __ck?: { contentBox(e: Element): { x: number; y: number; width: number; height: number } } }).__ck;
  return {
    box: ck ? ck.contentBox(el) : { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height },
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role'),
    name,
    hasVisibleFocus: outline || ring || ancestorOutline,
    lostToBody: false,
    cssPath: cssPath(el),
    href: (el as HTMLAnchorElement).href || undefined,
    html: openTag,
  };
}

export async function keyboardWalk(page: Page, subject: Subject, capturedAt: string, maxStops = 60): Promise<Artifact> {
  const stops: FocusStop[] = [];
  const traps: TrapRecord[] = [];
  try {
    // Start from the top of the document.
    await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      el?.blur();
      window.scrollTo(0, 0);
    });
    let prevSignature = '';
    let repeats = 0;
    for (let i = 0; i < maxStops; i++) {
      await page.keyboard.press('Tab');
      const active = (await page.evaluate(readActive)) as Omit<FocusStop, 'index'>;
      // Advance detection must key on the ELEMENT, not its appearance — a run
      // of sibling buttons sharing one label ("Read the full response" ×3) is
      // normal markup, not a trap. cssPath is per-element (ids/nth-of-type);
      // tag:name stays as the fallback when no path was computable.
      const signature = active.cssPath || `${active.tag}:${active.name}`;
      if (signature === prevSignature && !active.lostToBody) {
        repeats++;
        if (repeats >= 3) {
          traps.push({ atIndex: i, reason: 'no-advance' });
          // Record the trapped stop itself before bailing — the trap rule
          // looks the element up by index to name WHAT held focus.
          stops.push({ index: i, ...active });
          break;
        }
      } else {
        repeats = 0;
      }
      prevSignature = signature;
      stops.push({ index: i, ...active });
      // Reaching body twice early means focus escaped the page (or nothing focusable).
      if (active.lostToBody && i > 0 && stops[i - 1]?.lostToBody) break;
    }
  } catch {
    // Page closed mid-walk — return what we have.
  }
  return { kind: 'focus-walk', subject, capturedAt, stops: stops as unknown as Record<string, unknown>[], traps: traps as unknown as Record<string, unknown>[] };
}
