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
  const name = (el.getAttribute('aria-label') ?? el.textContent ?? el.getAttribute('title') ?? '').trim().slice(0, 60);
  return {
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role'),
    name,
    hasVisibleFocus: outline || ring,
    lostToBody: false,
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
      const signature = `${active.tag}:${active.name}`;
      if (signature === prevSignature && !active.lostToBody) {
        repeats++;
        if (repeats >= 3) {
          traps.push({ atIndex: i, reason: 'no-advance' });
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
