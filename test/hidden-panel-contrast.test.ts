import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { collectContrast } from '../src/collect/browser/contrast.js';

// A contrast candidate has to be something a reader can actually see.
//
// The collector used to check only the element's OWN computed style, so a
// closed mega-menu, an unopened modal or an off-slide carousel panel — all of
// which lay out with real geometry while an ancestor hides them — came through
// as candidates. The pixel pass then sampled whatever was painted at those
// coordinates, which is the page behind, and reported the panel's own text as
// failing against a background it never sits on. On the StoryFolder client that
// was 28 findings from one closed dropdown, at ratios around 1.03:1.

const PAGE_URL = pathToFileURL(
  fileURLToPath(new URL('./fixtures/pages/hidden-panel.html', import.meta.url)),
).href;

let chromiumAvailable = false;
try {
  const { chromium } = await import('playwright');
  chromiumAvailable = fs.existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}
const suite = chromiumAvailable ? describe : describe.skip;

suite('contrast candidates exclude what is not painted', () => {
  let browser: import('playwright').Browser;
  let page: import('playwright').Page;

  beforeAll(async () => {
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.goto(PAGE_URL, { waitUntil: 'load' });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it('skips a panel hidden by an ancestor, and keeps the visible copy', async () => {
    const pass = await collectContrast(
      page,
      { property: 'test', routePattern: '/', instanceUrl: PAGE_URL, viewport: 'desktop', colorScheme: 'light' },
      new Date().toISOString(),
    );
    // Candidates are identified by their ink: the fixture gives each block a
    // distinct one.
    const inks = pass.candidates.map((c) => c.textColor);

    // The closed panel's near-white ink is not a candidate at all.
    expect(inks).not.toContain('rgb(244, 246, 250)');
    // Both visible blocks still are — the fix must not blind the collector.
    expect(inks).toContain('rgb(160, 160, 160)'); // the pale paragraph
    expect(inks).toContain('rgb(201, 201, 207)'); // the pale hero copy
  }, 60_000);
});
