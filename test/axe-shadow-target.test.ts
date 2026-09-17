import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { runAxe } from '../src/collect/browser/axe.js';

// axe.ts's post-run pass resolves each node's element to attach source
// localization, an at-rest box, and the visible text a finding quotes. It used
// to do that by joining `node.target` into one string and calling
// `document.querySelector` — which works for a plain element but is flatly
// wrong for a shadow-DOM one: axe's target for such a node NESTS the shadow
// hop (`[["axe-shadow-el", "p"]]`), and joining a nested array stringifies it
// with a COMMA, turning the lookup into a selector LIST that can match some
// unrelated element instead of failing outright. See the fixture's own
// comment for the exact mechanism. This test drives the real axe-core engine
// (not a hand-built target array) so it proves the fix against what axe
// actually emits, not an assumption about its shape.

const PAGE_URL = pathToFileURL(fileURLToPath(new URL('./fixtures/pages/axe-shadow-target.html', import.meta.url))).href;

let chromiumAvailable = false;
try {
  const { chromium } = await import('playwright');
  chromiumAvailable = fs.existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}
const suite = chromiumAvailable ? describe : describe.skip;

interface AxeNodeLike {
  target?: unknown[];
  text?: string | null;
  box?: { x: number; y: number; width: number; height: number } | null;
}

suite('axe post-run localization resolves shadow-DOM targets by walking the shadow path', () => {
  let browser: import('playwright').Browser;
  let page: import('playwright').Page;

  beforeAll(async () => {
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
    page = await ctx.newPage();
    await page.goto(PAGE_URL, { waitUntil: 'load' });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it("quotes the shadow paragraph's own text and box, never the decoy a joined selector list could match", async () => {
    const artifact = await runAxe(page, { property: 'test', routePattern: '/', instanceUrl: PAGE_URL }, new Date().toISOString());
    expect(artifact.kind).toBe('axe-result');
    if (artifact.kind !== 'axe-result') return;
    const results = artifact.results as { violations: Array<{ id: string; nodes: AxeNodeLike[] }> };
    const rule = results.violations.find((r) => r.id === 'color-contrast');
    expect(rule, 'expected axe to flag the shadow paragraph\'s low contrast').toBeDefined();

    // The node whose target nests a shadow hop — proof this is exercising the
    // shadow path, not the plain-element case.
    const shadowNode = rule!.nodes.find((n) => n.target?.some((t) => Array.isArray(t)));
    expect(shadowNode, 'expected axe to report a node with a nested (shadow-path) target').toBeDefined();

    expect(shadowNode!.text).toBe('Low contrast text inside a shadow root.');
    expect(shadowNode!.text).not.toContain('Decoy');
    expect(shadowNode!.box).not.toBeNull();
    // The decoy sits at document top (y ≈ 0); the shadow paragraph is the
    // second block. Resolving to the wrong element would report the decoy's
    // box instead.
    expect(shadowNode!.box!.y).toBeGreaterThan(5);
  }, 60_000);
});
