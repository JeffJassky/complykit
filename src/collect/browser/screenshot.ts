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
export type BandVisitor = (png: PNG, scrollOffset: number, index: number) => Promise<void>;

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

  // Document-scrolling page (or helpers unavailable): Playwright already does
  // the right thing.
  if (!info || !info.inner) {
    const buffer = await page.screenshot({ fullPage: true, type: 'png' });
    // A document-scrolling page renders in one piece: the full-page image and
    // the live DOM describe the same instant, so the visitor sees it directly.
    if (onBand) await onBand(PNG.sync.read(buffer), 0, 0);
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
  if (onBand) await onBand(first, 0, 0);

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
    if (onBand) await onBand(band, actual, i);
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
