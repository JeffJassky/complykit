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
async function measureInBands(page: Page, info: ScrollerInfo, onBand: BandVisitor): Promise<void> {
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
    await page.waitForTimeout(120); // lazy content + scroll-linked effects settle
    // Obstructions are re-read per band: headers hide on scroll-down, banners
    // get dismissed, and a stale rect would reject good measurements.
    const bandObs = await readObstructions(page);
    const band = PNG.sync.read(await page.screenshot({ type: 'png' }));
    await onBand(band, actual, i, bandObs);
  }

  await page.evaluate(() => {
    const ck = (window as unknown as { __ck?: { scrollPrimaryTo(o: number): number } }).__ck;
    ck?.scrollPrimaryTo(0);
  });
}

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
    await page.waitForTimeout(120); // lazy content + scroll-linked effects settle
    const band = PNG.sync.read(await page.screenshot({ type: 'png' }));
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
