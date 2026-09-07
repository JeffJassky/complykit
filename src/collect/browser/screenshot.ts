import type { Page } from 'playwright';
import { PNG } from 'pngjs';
import { putEvidence, type Artifact, type Subject, type ViewportId, type ColorScheme, type RunId } from '../../record/index.js';

// Family F: the screenshot substrate. Full-page capture per route × viewport ×
// scheme — evidence for C1 whether or not any deterministic rule fired, and the
// pixel source for the contrast pixel-band pass. Stored content-addressed so a
// repeated identical page costs one write.

export interface ScreenshotResult {
  artifact: Artifact;
  buffer: Buffer;
  /** True when the capture was stitched from an inner scroll container. */
  stitched?: boolean;
  /** Bands captured; > 1 means content did not fit one screen. */
  bands?: number;
  /** Content that exceeded the band cap and is therefore NOT in the capture. */
  cappedPx?: number;
}

interface ScrollerInfo {
  inner: boolean;
  top: number;
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}

const MAX_BANDS = 12; // a bound on capture cost; overflow is reported, not hidden

// The measurement walk has a separate, looser cap. MAX_BANDS bounds the size of
// a STITCHED IMAGE; a measurement band is a throwaway screenshot, so the only
// cost is time. Capping it at 12 quietly stopped measuring below ~9,000px on a
// 14,500px marketing page — and unmeasured text does not disappear, it becomes
// "ratio could not be proven", which is how coverage loss disguises itself as a
// pile of new needs-review findings.
const MAX_MEASURE_BANDS = 40;

/**
 * Called once per captured band, while the page is still scrolled there.
 *
 * Measuring pixels is only valid against a capture of the SAME instant. An app
 * that is still loading changes height under you: on one route the scroller grew
 * from 2208px to 3703px between the capture and the measurement pass, so every
 * measured box addressed pixels that had since moved — producing confident,
 * precise, entirely fictional ratios (white-on-dark text "measured" at 1.02:1).
 * Collectors that need pixels run here instead, where geometry and image agree.
 */
export interface Rect { x: number; y: number; width: number; height: number }

export interface Obstructions {
  /** Viewport rects of fixed/sticky elements painted over the content. */
  rects: Rect[];
  topInset: number;
  bottomInset: number;
}

export type BandVisitor = (png: PNG, scrollOffset: number, index: number, obstructions: Obstructions) => Promise<void>;

const NO_OBSTRUCTIONS: Obstructions = { rects: [], topInset: 0, bottomInset: 0 };

async function readObstructions(page: Page): Promise<Obstructions> {
  const o = (await page.evaluate(() => {
    const ck = (window as unknown as { __ck?: { obstructions(): unknown } }).__ck;
    return ck?.obstructions ? ck.obstructions() : null;
  })) as Obstructions | null;
  return o ?? NO_OBSTRUCTIONS;
}

/**
 * A screenshot that can fail without taking the whole cell with it.
 *
 * `page.screenshot()` waits for `document.fonts.ready`, so one webfont that
 * never resolves stalls it — and under the page-wide default timeout that
 * aborts the scan of that route entirely, turning a missing band into a
 * `crash` gap and throwing away every finding for the cell. A band is worth
 * less than that: if one cannot be captured, stop measuring and keep what the
 * earlier bands found.
 */
const BAND_SHOT_TIMEOUT_MS = 8000;

async function safeShot(page: Page): Promise<Buffer | null> {
  try {
    return await page.screenshot({ type: 'png', timeout: BAND_SHOT_TIMEOUT_MS });
  } catch {
    return null;
  }
}

/**
 * Wait until the page has stopped moving under us.
 *
 * A fixed `waitForTimeout` is a guess, and on a real marketing page it is the
 * wrong one: reveal transitions here run 520-800ms and images arrive without
 * intrinsic size, so 120ms after a scroll the layout is still settling. The
 * screenshot is taken at one instant and the DOM is read a moment later, so
 * anything that moves in between makes the two describe different layouts —
 * which is how a transcript line came to be "measured" against the photo
 * thumbnail of the row above it. Between two passes of one scan the document
 * grew by 1,215px this way.
 *
 * Polling the DOM is not enough on its own. A scroll-linked component — a
 * sticky scrubber, a pinned split — animates with rAF-driven transforms toward
 * a target: document height, scroll offset and image count are all constant
 * while the content is still sliding. So the last word goes to the pixels: two
 * consecutive identical frames mean nothing is moving, whatever the DOM says.
 * On the client's two scrubbed pages that difference accounted for 261 of 354
 * contrast violations, every one of them sampling the same near-white pixel of
 * an app screenshot that had not finished moving into place.
 *
 * A hard cap keeps a page that animates forever (a carousel, a ticker, a video)
 * to a bounded wait rather than hanging the scan.
 */
async function settleLayout(page: Page, capMs = 1500): Promise<Buffer | null> {
  const start = Date.now();
  let lastDom = '';
  let lastFrame: Buffer | null = null;
  let domStable = false;
  while (Date.now() - start < capMs) {
    const dom = (await page.evaluate(() => {
      const doc = document.scrollingElement ?? document.documentElement;
      let pending = 0;
      const imgs = document.images;
      for (let i = 0; i < imgs.length; i++) if (!imgs[i].complete) pending++;
      return `${doc.scrollHeight}|${Math.round(doc.scrollTop)}|${pending}|${document.readyState}`;
    })) as string;
    domStable = dom === lastDom;
    lastDom = dom;

    // Only start comparing frames once the cheap check agrees; a growing
    // document will not produce two identical frames anyway.
    if (!domStable) {
      lastFrame = null;
      await page.waitForTimeout(80);
      continue;
    }
    const frame = await safeShot(page);
    if (!frame) return lastFrame; // cannot compare frames; the DOM check stands
    if (lastFrame && lastFrame.equals(frame)) return frame;
    lastFrame = frame;
    await page.waitForTimeout(80);
  }
  return lastFrame;
}

/**
 * Walk a document-scrolling page a screen at a time, handing the visitor each
 * viewport-sized band while the page is parked at that offset — the only moment
 * `viewportBox` and the pixels describe the same layout.
 *
 * The bands are for MEASUREMENT only; the evidence image is captured separately
 * with `fullPage`. Document scroll offsets and full-page image coordinates are
 * the same space, so samples shifted by `offset` still address the stored image.
 *
 * Why not measure against the fullPage image directly (what this path used to
 * do): candidates carry `viewportBox`, which agrees with a full-page image only
 * inside the first screen; and `fullPage` resizes the viewport to the whole
 * document to capture beyond it, firing IntersectionObservers, scroll-linked
 * reveals and vh-based layout, so the DOM read afterwards describes a different
 * layout than the image. Both produce the exact failure this file warns about.
 *
 * Why the step is not simply the viewport height: a fixed header is painted over
 * whatever is scrolled beneath it, so content parked in those rows is measured
 * against the header. Stepping by the UNOBSTRUCTED height and scrolling back by
 * the top inset puts every row of the document into some band's clear strip.
 */
/**
 * Step through every inner scroll container visible in this band that has not
 * been walked yet, handing the visitor a fresh frame at each step. The page's
 * own scroll does not move, so `offset` stays the band's; what changes is what
 * the container shows, and the visitor re-reads the DOM so it sees that.
 */
async function walkInnerScrollers(
  page: Page,
  offset: number,
  index: number,
  obs: Obstructions,
  onBand: BandVisitor,
  walked: Set<number>,
): Promise<void> {
  const scrollers = (await page.evaluate(() => {
    const ck = (window as unknown as { __ck?: { innerScrollers(): unknown } }).__ck;
    return ck?.innerScrollers ? ck.innerScrollers() : [];
  })) as Array<{ ref: number; top: number; clientHeight: number; scrollHeight: number }>;
  for (const sc of scrollers) {
    if (walked.has(sc.ref)) continue;
    walked.add(sc.ref);
    const step = Math.max(1, sc.clientHeight);
    const steps = Math.min(MAX_MEASURE_BANDS, Math.ceil(sc.scrollHeight / step));
    for (let k = 1; k < steps; k++) {
      const got = (await page.evaluate(([ref, o]: [number, number]) => {
        const ck = (window as unknown as { __ck?: { scrollInnerTo(r: number, o: number): number } }).__ck;
        return ck?.scrollInnerTo ? ck.scrollInnerTo(ref, o) : 0;
      }, [sc.ref, k * step] as [number, number])) as number;
      if (got <= 0) break;
      const frame = (await settleLayout(page)) ?? (await safeShot(page));
      if (!frame) break;
      await onBand(PNG.sync.read(frame), offset, index, obs);
    }
    await page.evaluate((ref: number) => {
      const ck = (window as unknown as { __ck?: { scrollInnerTo(r: number, o: number): number } }).__ck;
      ck?.scrollInnerTo?.(ref, 0);
    }, sc.ref);
  }
}

async function measureInBands(page: Page, info: ScrollerInfo, onBand: BandVisitor): Promise<void> {
  const walked = new Set<number>();
  const obs = await readObstructions(page);
  const clear = Math.max(1, info.clientHeight - obs.topInset - obs.bottomInset);
  const needed = Math.ceil(info.scrollHeight / clear);
  const bands = Math.min(Math.max(needed, 1), MAX_MEASURE_BANDS);

  for (let i = 0; i < bands; i++) {
    // Park so the rows this band is responsible for land below the top chrome.
    const target = Math.max(0, i * clear - obs.topInset);
    const actual = (await page.evaluate((offset: number) => {
      const ck = (window as unknown as { __ck?: { scrollPrimaryTo(o: number): number } }).__ck;
      if (ck) return ck.scrollPrimaryTo(offset);
      window.scrollTo(0, offset);
      return (document.scrollingElement ?? document.documentElement).scrollTop;
    }, target)) as number;
    // The frame the page settled on IS the band image: taking another would
    // reopen the gap this is here to close.
    const settled = (await settleLayout(page)) ?? (await safeShot(page));
    if (!settled) break; // the page will not give us a frame; keep what we have
    // Obstructions are re-read per band: headers hide on scroll-down, banners
    // get dismissed, and a stale rect would reject good measurements.
    const bandObs = await readObstructions(page);
    await onBand(PNG.sync.read(settled), actual, i, bandObs);
    await walkInnerScrollers(page, actual, i, bandObs, onBand, walked);
  }

  await page.evaluate(() => {
    const ck = (window as unknown as { __ck?: { scrollPrimaryTo(o: number): number } }).__ck;
    ck?.scrollPrimaryTo(0);
  });
}

/**
 * Capture the whole scrollable content even when the DOCUMENT does not scroll.
 *
 * `fullPage: true` only knows about document scroll. An app shell that pins the
 * document and scrolls an inner container yields exactly one screen — and every
 * below-fold element then sits outside the image, where a pixel measurement
 * clips to nothing and reports "could not be proven". So: find the container the
 * page actually scrolls, walk it a screen at a time, and compose the bands into
 * one tall image whose coordinate space matches `__ck.contentBox` (rect + the
 * scroll offsets of every scrolling ancestor).
 *
 * Rows above the scroller (a fixed header) come from the first band; each later
 * band contributes only the scroller's own rows, so page chrome is not repeated
 * down the composite.
 */
async function captureScrollableContent(
  page: Page,
  onBand?: BandVisitor,
): Promise<{ buffer: Buffer; stitched: boolean; bands: number; cappedPx: number }> {
  const info = (await page.evaluate(() => {
    const ck = (window as unknown as { __ck?: { primaryScroller(): ScrollerInfoLike } }).__ck;
    return ck ? ck.primaryScroller() : null;
    type ScrollerInfoLike = { inner: boolean; top: number; clientHeight: number; scrollHeight: number; scrollTop: number };
  })) as ScrollerInfo | null;

  // Document-scrolling page: `fullPage` remains the EVIDENCE image — one CDP
  // call, fixed chrome drawn once, no stitching seams — but it is not a safe
  // thing to measure against (see measureInBands).
  if (!info || !info.inner) {
    const buffer = await page.screenshot({ fullPage: true, type: 'png' });
    if (onBand) {
      if (!info) {
        // No geometry helpers — one band at the top is all we can honestly claim.
        await onBand(PNG.sync.read(buffer), 0, 0, NO_OBSTRUCTIONS);
      } else {
        await measureInBands(page, info, onBand);
      }
    }
    return { buffer, stitched: false, bands: 1, cappedPx: 0 };
  }

  const step = Math.max(1, info.clientHeight);
  const needed = Math.ceil(info.scrollHeight / step);
  const bands = Math.min(needed, MAX_BANDS);
  const cappedPx = needed > bands ? info.scrollHeight - bands * step : 0;

  const first = PNG.sync.read(await page.screenshot({ type: 'png' }));
  const composite = new PNG({ width: first.width, height: Math.ceil(info.top + bands * step) });
  // Band 0 whole (it carries the chrome above the scroller too).
  PNG.bitblt(first, composite, 0, 0, first.width, Math.min(first.height, composite.height), 0, 0);
  if (onBand) await onBand(first, 0, 0, await readObstructions(page));

  for (let i = 1; i < bands; i++) {
    const target = i * step;
    const actual = (await page.evaluate((offset: number) => {
      const ck = (window as unknown as { __ck?: { scrollPrimaryTo(o: number): number } }).__ck;
      return ck ? ck.scrollPrimaryTo(offset) : 0;
    }, target)) as number;
    const settled = (await settleLayout(page)) ?? (await safeShot(page));
    if (!settled) break; // the page will not give us a frame; keep what we have
    const band = PNG.sync.read(settled);
    // Copy only the scroller's rows; `actual` may differ from `target` at the
    // end of the range, so place the band where it really landed.
    const srcTop = Math.round(info.top);
    const height = Math.min(band.height - srcTop, composite.height - Math.round(info.top + actual));
    if (height > 0) {
      PNG.bitblt(band, composite, 0, srcTop, band.width, height, 0, Math.round(info.top + actual));
    }
    // Hand the visitor this band's pixels WHILE the page is still at this scroll
    // position — the only moment its pixels and the live DOM agree.
    if (onBand) await onBand(band, actual, i, await readObstructions(page));
  }

  await page.evaluate(() => {
    const ck = (window as unknown as { __ck?: { scrollPrimaryTo(o: number): number } }).__ck;
    ck?.scrollPrimaryTo(0);
  });
  return { buffer: PNG.sync.write(composite), stitched: true, bands, cappedPx };
}

export async function captureScreenshot(
  page: Page,
  subject: Subject,
  opts: { runId: RunId; cwd?: string; viewport: ViewportId; scheme: ColorScheme; pageState?: string; capturedAt: string; onBand?: BandVisitor },
): Promise<ScreenshotResult> {
  const cap = await captureScrollableContent(page, opts.onBand);
  const buffer = cap.buffer;
  const rel = putEvidence(opts.runId, buffer, 'png', opts.cwd);
  return {
    buffer,
    stitched: cap.stitched,
    bands: cap.bands,
    cappedPx: cap.cappedPx,
    artifact: {
      kind: 'screenshot',
      subject,
      capturedAt: opts.capturedAt,
      path: rel,
      viewport: opts.viewport,
      scheme: opts.scheme,
      pageState: opts.pageState,
    },
  };
}
