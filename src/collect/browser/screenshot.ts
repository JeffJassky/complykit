import type { Page } from 'playwright';
import { putEvidence, type Artifact, type Subject, type ViewportId, type ColorScheme, type RunId } from '../../record/index.js';

// Family F: the screenshot substrate. Full-page capture per route × viewport ×
// scheme — evidence for C1 whether or not any deterministic rule fired, and the
// pixel source for the contrast pixel-band pass. Stored content-addressed so a
// repeated identical page costs one write.

export interface ScreenshotResult {
  artifact: Artifact;
  buffer: Buffer;
}

export async function captureScreenshot(
  page: Page,
  subject: Subject,
  opts: { runId: RunId; cwd?: string; viewport: ViewportId; scheme: ColorScheme; pageState?: string; capturedAt: string },
): Promise<ScreenshotResult> {
  const buffer = await page.screenshot({ fullPage: true, type: 'png' });
  const rel = putEvidence(opts.runId, buffer, 'png', opts.cwd);
  return {
    buffer,
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
