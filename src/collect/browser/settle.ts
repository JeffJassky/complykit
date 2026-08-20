import type { Page } from 'playwright';

// The settle protocol (browser-analysis-design pitfall #2): network-idle +
// double-rAF stability + fonts.ready. Without it, findings flap run-to-run and
// poison `diff` and the fingerprint history. Bounded — never waits forever.

export interface SettleOptions {
  timeoutMs?: number; // hard cap; overrun is a partial-coverage fact, not a hang
}

export async function settle(page: Page, opts: SettleOptions = {}): Promise<{ timedOut: boolean }> {
  const timeout = opts.timeoutMs ?? 8000;
  let timedOut = false;
  try {
    await page.waitForLoadState('networkidle', { timeout });
  } catch {
    timedOut = true; // slow/streaming page — proceed with what rendered
  }
  try {
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const done = (): void => resolve();
          // double rAF: layout has settled for at least one painted frame.
          requestAnimationFrame(() => requestAnimationFrame(done));
        }),
    );
    await page.evaluate(() => (document as unknown as { fonts?: { ready: Promise<unknown> } }).fonts?.ready);
  } catch {
    // Page navigated or closed mid-settle — caller handles as a gap.
  }
  return { timedOut };
}
