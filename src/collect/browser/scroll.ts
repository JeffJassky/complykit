import type { Page } from 'playwright';

// Lazy loading (pitfall #9): below-fold content and images do not exist until
// scrolled, so alt/contrast checks miss half the page. Incremental scroll-
// through before scanning; infinite-scroll detection stops after N screens and
// records the cap (a coverage fact, not a silent truncation).

export interface ScrollResult {
  screens: number;
  capped: boolean; // hit the screen cap before the page stopped growing
}

export async function scrollThrough(page: Page, maxScreens = 10): Promise<ScrollResult> {
  let screens = 0;
  let capped = false;
  try {
    let lastHeight = 0;
    for (; screens < maxScreens; screens++) {
      const height = await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
        return document.body.scrollHeight;
      });
      await page.waitForTimeout(150); // let lazy content request
      if (height === lastHeight) break; // page stopped growing
      lastHeight = height;
    }
    capped = screens >= maxScreens;
    await page.evaluate(() => window.scrollTo(0, 0)); // back to top for capture
  } catch {
    // Page closed/navigated — return what we counted.
  }
  return { screens, capped };
}
