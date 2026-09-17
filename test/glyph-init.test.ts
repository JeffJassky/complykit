import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { GEOMETRY_INIT } from '../src/collect/browser/geometry-init.js';
import { GLYPH_INIT, type PageTextSubject, type GlyphPageApi } from '../src/collect/browser/glyph-init.js';

// The glyph-mask method (plans/glyph-contrast-plan.md section 4.2) depends on
// two things nothing else in the pipeline tests directly: that enumerate()
// finds exactly the text a reader can see (no more, no less), and that
// hide()/restore() can make ONLY a subject's glyphs disappear and bring them
// back byte-for-byte. Get either wrong and every contrast verdict built on top
// is either blind to real text or hallucinates a diff. So the proof here is
// pixels: screenshots before/after hide, and before/after restore, decoded
// with pngjs and compared exactly.

const PAGE_URL = pathToFileURL(fileURLToPath(new URL('./fixtures/pages/glyph-init.html', import.meta.url))).href;

let chromiumAvailable = false;
try {
  const { chromium } = await import('playwright');
  chromiumAvailable = fs.existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}
const suite = chromiumAvailable ? describe : describe.skip;

interface CkWindow {
  __ck?: { glyph?: GlyphPageApi };
}

// A fully generic `K extends keyof GlyphPageApi` forwarding signature defeats
// TypeScript's argument-count checking across the method union (every call
// site was accepted as "0 args expected"), so this is typed loosely on
// purpose — it is test plumbing, not part of the page contract.
async function callGlyph(
  page: import('playwright').Page,
  method: keyof GlyphPageApi,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ...args: any[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  return page.evaluate(
    ({ method, args }) => {
      const w = window as unknown as CkWindow;
      const glyph = w.__ck?.glyph;
      if (!glyph) throw new Error('window.__ck.glyph not installed');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (glyph[method] as any)(...args);
    },
    { method, args },
  );
}

function findByCssPath(subjects: PageTextSubject[], needle: string): PageTextSubject | undefined {
  return subjects.find((s) => s.cssPath.includes(needle));
}

interface EnumerateResult {
  subjects: PageTextSubject[];
  truncated: boolean;
  svgTextCount: number;
}
async function enumerateSubjects(
  page: import('playwright').Page,
  opts: { viewportOnly?: boolean; refs?: number[] } = {},
): Promise<EnumerateResult> {
  return callGlyph(page, 'enumerate', opts) as Promise<EnumerateResult>;
}
async function hideKeys(page: import('playwright').Page, keys: string[]): Promise<void> {
  await callGlyph(page, 'hide', keys);
}
async function restoreAll(page: import('playwright').Page): Promise<void> {
  await callGlyph(page, 'restore');
}
async function settledOf(page: import('playwright').Page, keys: string[]): Promise<{ running: number; moved: number }> {
  return callGlyph(page, 'settled', keys) as Promise<{ running: number; moved: number }>;
}
async function resolveAxe(
  page: import('playwright').Page,
  targets: string[][],
): Promise<Array<{ ref: number | null; measureRefs: number[] }>> {
  return callGlyph(page, 'resolveAxeTargets', targets) as Promise<Array<{ ref: number | null; measureRefs: number[] }>>;
}
async function describeRefs(
  page: import('playwright').Page,
  refs: number[],
): Promise<
  Array<{
    ref: number;
    sourceFile: string | null;
    scopeId: string | null;
    fgVars: string[];
    bgVars: string[];
    bgImageVars: string[];
    flat: boolean;
    bgColor: string | null;
    cascadeRatio: number | null;
  }>
> {
  return callGlyph(page, 'describe', refs);
}
async function scrollTo(
  page: import('playwright').Page,
  ref: number,
  viewportY: number,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return callGlyph(page, 'scrollSubjectTo', ref, viewportY);
}

suite('glyph-init page API', () => {
  let browser: import('playwright').Browser;
  let page: import('playwright').Page;

  beforeAll(async () => {
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 900, height: 700 } });
    // Install order per the plan: GEOMETRY_INIT then GLYPH_INIT.
    await ctx.addInitScript(GEOMETRY_INIT);
    await ctx.addInitScript(GLYPH_INIT);
    page = await ctx.newPage();
    await page.goto(PAGE_URL, { waitUntil: 'load' });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  // ---------------------------------------------------------------------
  // enumerate
  // ---------------------------------------------------------------------
  describe('enumerate', () => {
    it('installs window.__ck.glyph regardless of the plumbing', async () => {
      const has = await page.evaluate(() => {
        const w = window as unknown as CkWindow;
        return typeof w.__ck?.glyph?.enumerate === 'function';
      });
      expect(has).toBe(true);
    });

    it('finds direct text nodes only: a coloured child span is its own subject, excluded from the parent', async () => {
      const { subjects } = await enumerateSubjects(page);
      const parent = findByCssPath(subjects, 'parent-span');
      const child = subjects.find((s) => s.textSample === 'coloured child');
      expect(parent).toBeDefined();
      expect(child).toBeDefined();
      expect(parent!.ref).not.toBe(child!.ref);
      expect(parent!.color).toBe('rgb(10, 10, 10)');
      expect(child!.color).toBe('rgb(200, 30, 30)');
      // The parent's own rects must not include where the span's text sits:
      // none of the parent's rects should be fully inside the child's rect.
      for (const pr of parent!.rects) {
        for (const cr of child!.rects) {
          const insideChild = pr.x >= cr.x && pr.y >= cr.y && pr.x + pr.width <= cr.x + cr.width && pr.y + pr.height <= cr.y + cr.height;
          expect(insideChild).toBe(false);
        }
      }
    });

    it('skips whitespace-only text nodes', async () => {
      const { subjects } = await enumerateSubjects(page);
      const whitespaceOwner = subjects.find((s) => s.textSample === '');
      expect(whitespaceOwner).toBeUndefined();
      const real = findByCssPath(subjects, 'whitespace-parent');
      expect(real).toBeDefined();
      expect(real!.textSample).toBe('Real text here.');
    });

    it('skips text under a visibility:hidden or opacity:0 ancestor', async () => {
      const { subjects } = await enumerateSubjects(page);
      expect(subjects.some((s) => s.textSample === 'hidden by visibility')).toBe(false);
      expect(subjects.some((s) => s.textSample === 'hidden by opacity')).toBe(false);
    });

    it('finds ::before pseudo text and skips a private-use icon-font ::before', async () => {
      const { subjects } = await enumerateSubjects(page);
      const before = subjects.find((s) => s.kind === 'before' && s.textSample === 'before text');
      expect(before).toBeDefined();
      expect(before!.cssPath).toContain('before-el');
      const iconOwners = subjects.filter((s) => s.cssPath.includes('icon-before'));
      expect(iconOwners.some((s) => s.kind === 'before')).toBe(false);
    });

    it('finds a placeholder subject and a value subject', async () => {
      const { subjects } = await enumerateSubjects(page);
      const placeholder = subjects.find((s) => s.kind === 'placeholder' && s.cssPath.includes('placeholder-input'));
      expect(placeholder).toBeDefined();
      expect(placeholder!.textSample).toBe('a placeholder');
      const value = subjects.find((s) => s.kind === 'value' && s.cssPath.includes('value-input'));
      expect(value).toBeDefined();
      expect(value!.textSample).toBe('an input value');
    });

    it('finds text inside an open shadow root', async () => {
      const { subjects } = await enumerateSubjects(page);
      const shadow = subjects.find((s) => s.textSample === 'shadow text');
      expect(shadow).toBeDefined();
      expect(shadow!.color).toBe('rgb(150, 150, 150)');
    });

    it('applies the large-text rules at the boundary sizes', async () => {
      const { subjects } = await enumerateSubjects(page);
      const s24 = findByCssPath(subjects, 'large24');
      const s1866 = findByCssPath(subjects, 'large1866bold');
      const s18 = findByCssPath(subjects, 'notlarge18bold');
      expect(s24!.large).toBe(true);
      expect(s24!.required).toBe(3);
      expect(s1866!.large).toBe(true);
      expect(s1866!.required).toBe(3);
      expect(s18!.large).toBe(false);
      expect(s18!.required).toBe(4.5);
    });

    it('computes opacity as the product over the owner and all ancestors', async () => {
      const { subjects } = await enumerateSubjects(page);
      const s = findByCssPath(subjects, 'opacity-inner');
      expect(s).toBeDefined();
      expect(s!.opacity).toBeCloseTo(0.25, 5);
    });

    it('flags background-clip:text as paintedByBackground', async () => {
      const { subjects } = await enumerateSubjects(page);
      const s = findByCssPath(subjects, 'gradient-text');
      expect(s).toBeDefined();
      expect(s!.paintedByBackground).toBe(true);
    });

    it('viewportOnly keeps only on-screen subjects; refs keeps only named owners', async () => {
      const all = await enumerateSubjects(page);
      const offscreen = all.subjects.find((s) => s.cssPath.includes('offscreen-far'));
      expect(offscreen).toBeDefined();

      const onScreen = await enumerateSubjects(page, { viewportOnly: true });
      expect(onScreen.subjects.some((s) => s.cssPath.includes('offscreen-far'))).toBe(false);
      expect(onScreen.subjects.length).toBeGreaterThan(0);

      const oneRef = await enumerateSubjects(page, { refs: [offscreen!.ref] });
      expect(oneRef.subjects).toHaveLength(1);
      expect(oneRef.subjects[0].ref).toBe(offscreen!.ref);
    });

    it('counts visible SVG <text> elements separately from subjects', async () => {
      const { svgTextCount } = await enumerateSubjects(page);
      expect(svgTextCount).toBe(0); // fixture has no <svg><text> — the icon is a <circle>
    });
  });

  // ---------------------------------------------------------------------
  // hide / restore
  // ---------------------------------------------------------------------
  describe('hide / restore', () => {
    async function screenshotRect(rect: { x: number; y: number; width: number; height: number }, pad = 2): Promise<PNG> {
      const clip = {
        x: Math.max(0, Math.floor(rect.x) - pad),
        y: Math.max(0, Math.floor(rect.y) - pad),
        width: Math.ceil(rect.width) + pad * 2,
        height: Math.ceil(rect.height) + pad * 2,
      };
      const buf = await page.screenshot({ type: 'png', clip });
      return PNG.sync.read(buf);
    }

    function pixelsEqual(a: PNG, b: PNG): boolean {
      if (a.width !== b.width || a.height !== b.height) return false;
      return Buffer.compare(a.data, b.data) === 0;
    }

    function hasAnyInk(png: PNG, expectedBg: [number, number, number]): boolean {
      for (let i = 0; i < png.data.length; i += 4) {
        const d = Math.abs(png.data[i] - expectedBg[0]) + Math.abs(png.data[i + 1] - expectedBg[1]) + Math.abs(png.data[i + 2] - expectedBg[2]);
        if (d > 6) return true;
      }
      return false;
    }

    it('hides the border-el owner text but leaves the border, the currentColor SVG icon, an inheriting descendant, and a distinctly-coloured child span pixel-identical; restore is exact', async () => {
      const owner = await page.$('#border-el');
      await owner!.scrollIntoViewIfNeeded();
      const { subjects } = await enumerateSubjects(page, { viewportOnly: true });
      const subject = subjects.find((s) => s.kind === 'text' && s.cssPath.includes('border-el'));
      expect(subject).toBeDefined();

      const box = await owner!.boundingBox();
      const before = await screenshotRect(box!);
      const hadStyle = await page.evaluate(() => document.getElementById('border-el')!.hasAttribute('style'));
      expect(hadStyle).toBe(false);

      await hideKeys(page, [subject!.key]);
      const afterHide = await screenshotRect(box!);
      // The owner's own text rects must show no ink: every pixel in them
      // matches the page background (white) exactly.
      for (const r of subject!.rects) {
        const crop = await screenshotRect(r);
        expect(hasAnyInk(crop, [255, 255, 255])).toBe(false);
      }
      expect(pixelsEqual(before, afterHide)).toBe(false); // the text really did change something

      await restoreAll(page);
      const styleAfter = await page.evaluate(() => document.getElementById('border-el')!.hasAttribute('style'));
      expect(styleAfter).toBe(false);

      const afterRestore = await screenshotRect(box!);
      expect(pixelsEqual(before, afterRestore)).toBe(true);

      // restore() twice is harmless.
      await restoreAll(page);
      const afterRestore2 = await screenshotRect(box!);
      expect(pixelsEqual(before, afterRestore2)).toBe(true);
    }, 30_000);

    it('restore puts back an exact pre-existing inline style, including !important', async () => {
      const before = await page.evaluate(() => document.getElementById('prestyled')!.getAttribute('style'));
      expect(before).toContain('red');

      const { subjects } = await enumerateSubjects(page);
      const subject = subjects.find((s) => s.cssPath.includes('prestyled'));
      expect(subject).toBeDefined();
      await hideKeys(page, [subject!.key]);
      await restoreAll(page);

      const after = await page.evaluate(() => document.getElementById('prestyled')!.getAttribute('style'));
      expect(after).toBe(before);
    });

    it('restore leaves no style attribute on an element that never had one', async () => {
      const hadBefore = await page.evaluate(() => document.getElementById('nostyle')!.hasAttribute('style'));
      expect(hadBefore).toBe(false);

      const { subjects } = await enumerateSubjects(page);
      const subject = subjects.find((s) => s.cssPath.includes('nostyle'));
      expect(subject).toBeDefined();
      await hideKeys(page, [subject!.key]);
      const hadDuringHide = await page.evaluate(() => document.getElementById('nostyle')!.hasAttribute('style'));
      expect(hadDuringHide).toBe(true);
      await restoreAll(page);

      const hadAfter = await page.evaluate(() => document.getElementById('nostyle')!.hasAttribute('style'));
      expect(hadAfter).toBe(false);
    });

    it('hides and restores a ::before pseudo subject pixel-exactly', async () => {
      const el = await page.$('#before-hide');
      await el!.scrollIntoViewIfNeeded();
      const box = await el!.boundingBox();
      const before = await screenshotRect(box!);

      const { subjects } = await enumerateSubjects(page, { viewportOnly: true });
      const subject = subjects.find((s) => s.kind === 'before' && s.cssPath.includes('before-hide'));
      expect(subject).toBeDefined();

      await hideKeys(page, [subject!.key]);
      for (const r of subject!.rects) {
        const crop = await screenshotRect(r, 0);
        expect(hasAnyInk(crop, [255, 255, 255])).toBe(false);
      }

      await restoreAll(page);
      const afterRestore = await screenshotRect(box!);
      expect(pixelsEqual(before, afterRestore)).toBe(true);
    });

    it('hides and restores a placeholder subject pixel-exactly', async () => {
      const el = await page.$('#placeholder-hide');
      await el!.scrollIntoViewIfNeeded();
      const box = await el!.boundingBox();
      const before = await screenshotRect(box!);

      const { subjects } = await enumerateSubjects(page, { viewportOnly: true });
      const subject = subjects.find((s) => s.kind === 'placeholder' && s.cssPath.includes('placeholder-hide'));
      expect(subject).toBeDefined();

      await hideKeys(page, [subject!.key]);
      for (const r of subject!.rects) {
        const crop = await screenshotRect(r, 0);
        expect(hasAnyInk(crop, [255, 255, 255])).toBe(false);
      }

      await restoreAll(page);
      const afterRestore = await screenshotRect(box!);
      expect(pixelsEqual(before, afterRestore)).toBe(true);
    });

    it('hides and restores shadow-root text pixel-exactly', async () => {
      const box = await page.evaluate(() => {
        const host = document.querySelector('#shadow-host-hide glyph-shadow-hide-el')!;
        const p = (host as Element & { shadowRoot: ShadowRoot }).shadowRoot.getElementById('shadow-hide-text')!;
        const r = p.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      });
      await page.evaluate(() => {
        document.querySelector('#shadow-host-hide')!.scrollIntoView({ block: 'center' });
      });
      const boxAfterScroll = await page.evaluate(() => {
        const host = document.querySelector('#shadow-host-hide glyph-shadow-hide-el')!;
        const p = (host as Element & { shadowRoot: ShadowRoot }).shadowRoot.getElementById('shadow-hide-text')!;
        const r = p.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      });
      void box;
      const before = await screenshotRect(boxAfterScroll);

      const { subjects } = await enumerateSubjects(page, { viewportOnly: true });
      const subject = subjects.find((s) => s.textSample === 'shadow hide text');
      expect(subject).toBeDefined();

      await hideKeys(page, [subject!.key]);
      for (const r of subject!.rects) {
        const crop = await screenshotRect(r, 0);
        expect(hasAnyInk(crop, [255, 255, 255])).toBe(false);
      }

      await restoreAll(page);
      const afterRestore = await screenshotRect(boxAfterScroll);
      expect(pixelsEqual(before, afterRestore)).toBe(true);
    });

    it('hides and restores gradient (background-clip:text) glyphs pixel-exactly', async () => {
      const el = await page.$('#gradient-hide');
      await el!.scrollIntoViewIfNeeded();
      const box = await el!.boundingBox();
      const before = await screenshotRect(box!);

      const { subjects } = await enumerateSubjects(page, { viewportOnly: true });
      const subject = subjects.find((s) => s.cssPath.includes('gradient-hide'));
      expect(subject).toBeDefined();
      expect(subject!.paintedByBackground).toBe(true);

      await hideKeys(page, [subject!.key]);
      const afterHide = await screenshotRect(box!);
      expect(pixelsEqual(before, afterHide)).toBe(false);

      await restoreAll(page);
      const afterRestore = await screenshotRect(box!);
      expect(pixelsEqual(before, afterRestore)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------
  // settled
  // ---------------------------------------------------------------------
  describe('settled', () => {
    it('reports a running Web Animations API animation, then 0 once it finishes', async () => {
      const { subjects } = await enumerateSubjects(page, { viewportOnly: false });
      const subject = subjects.find((s) => s.cssPath.includes('anim-target'));
      expect(subject).toBeDefined();

      await page.evaluate((ref) => {
        const w = window as unknown as { __ckAnimRegistry?: Element[] };
        void w;
        const el = document.querySelectorAll('#anim-target')[0] as HTMLElement;
        (el as HTMLElement & { __ckAnim?: Animation }).__ckAnim = el.animate(
          [{ transform: 'translateX(0px)' }, { transform: 'translateX(40px)' }],
          { duration: 5000, iterations: 1 },
        );
        void ref;
      }, subject!.ref);

      const running = await settledOf(page, [subject!.key]);
      expect(running.running).toBeGreaterThan(0);

      await page.evaluate(() => {
        const el = document.getElementById('anim-target') as HTMLElement & { __ckAnim?: Animation };
        el.__ckAnim?.finish();
      });
      const finished = await settledOf(page, [subject!.key]);
      expect(finished.running).toBe(0);
    }, 20_000);

    it('reports moved > 0 while a rAF-driven opacity changes, then 0 once it stops', async () => {
      const { subjects } = await enumerateSubjects(page, { viewportOnly: false });
      const subject = subjects.find((s) => s.cssPath.includes('raf-target'));
      expect(subject).toBeDefined();

      // Establish a baseline reading so the FIRST call after this one is a
      // real comparison, not the documented "first call: 0".
      await settledOf(page, [subject!.key]);

      await page.evaluate(() => {
        const el = document.getElementById('raf-target') as HTMLElement;
        el.style.opacity = '0.3';
        const w = window as unknown as { __ckRafDone?: boolean };
        w.__ckRafDone = false;
        let n = 0;
        function step(): void {
          n++;
          el.style.opacity = String(0.3 + (n % 2) * 0.4);
          if (n < 6) requestAnimationFrame(step);
          else w.__ckRafDone = true;
        }
        requestAnimationFrame(step);
      });

      // Poll settled() a few times while the rAF loop is still changing the
      // element; at least one of these polls must land mid-loop and see it move.
      let sawMoved = false;
      for (let i = 0; i < 8; i++) {
        const r = await settledOf(page, [subject!.key]);
        if (r.moved > 0) sawMoved = true;
        await page.waitForTimeout(16);
      }
      expect(sawMoved).toBe(true);

      await page.waitForFunction(() => (window as unknown as { __ckRafDone?: boolean }).__ckRafDone === true);
      // Two consecutive stable reads after the loop has stopped.
      await settledOf(page, [subject!.key]);
      const stable = await settledOf(page, [subject!.key]);
      expect(stable.moved).toBe(0);
    }, 20_000);
  });

  // ---------------------------------------------------------------------
  // resolveAxeTargets
  // ---------------------------------------------------------------------
  describe('resolveAxeTargets', () => {
    it('resolves a plain selector and includes descendant subject owners in measureRefs', async () => {
      await enumerateSubjects(page); // populate ownersEverSeen
      const [result] = await resolveAxe(page, [['#axe-plain-target']]);
      expect(result.ref).not.toBeNull();
      const descendantRef = (await enumerateSubjects(page)).subjects.find((s) =>
        s.cssPath.includes('axe-plain-target'),
      );
      // The <p> inside #axe-plain-target owns a text subject; its ref must be
      // among measureRefs alongside the target's own ref.
      expect(result.measureRefs).toContain(result.ref);
      if (descendantRef) expect(result.measureRefs).toContain(descendantRef.ref);
      expect(result.measureRefs.length).toBeGreaterThan(1);
    });

    it('resolves a shadow-DOM path', async () => {
      await enumerateSubjects(page);
      const [result] = await resolveAxe(page, [['glyph-axe-shadow-el', 'p']]);
      expect(result.ref).not.toBeNull();
      expect(result.measureRefs).toContain(result.ref);
    });

    it('returns null ref and empty measureRefs for an invalid selector', async () => {
      const [result] = await resolveAxe(page, [['#does-not-exist-anywhere']]);
      expect(result).toEqual({ ref: null, measureRefs: [] });
    });
  });

  // ---------------------------------------------------------------------
  // describe
  // ---------------------------------------------------------------------
  describe('describe', () => {
    it('reports flat, bgColor and cascadeRatio for a flat colour stack', async () => {
      const { subjects } = await enumerateSubjects(page);
      const subject = subjects.find((s) => s.cssPath.includes('flat-inner-text'));
      expect(subject).toBeDefined();
      const [d] = await describeRefs(page, [subject!.ref]);
      expect(d.flat).toBe(true);
      expect(d.bgColor).toBe('rgb(240,240,240)');
      expect(d.cascadeRatio).not.toBeNull();
      expect(d.cascadeRatio!).toBeGreaterThan(1);
    });

    it('reports flat: false under a gradient ancestor', async () => {
      const { subjects } = await enumerateSubjects(page);
      const subject = subjects.find((s) => s.cssPath.includes('gradient-ancestor-text'));
      expect(subject).toBeDefined();
      const [d] = await describeRefs(page, [subject!.ref]);
      expect(d.flat).toBe(false);
      expect(d.bgColor).toBeNull();
      expect(d.cascadeRatio).toBeNull();
    });

    it('reports fgVars for a colour set via a CSS variable', async () => {
      const { subjects } = await enumerateSubjects(page);
      const subject = subjects.find((s) => s.cssPath.includes('var-text'));
      expect(subject).toBeDefined();
      const [d] = await describeRefs(page, [subject!.ref]);
      expect(d.fgVars).toContain('--brand-color');
    });
  });

  // ---------------------------------------------------------------------
  // scrollSubjectTo
  // ---------------------------------------------------------------------
  describe('scrollSubjectTo', () => {
    it('lands the owner top at the requested viewport y on a long document', async () => {
      const { subjects } = await enumerateSubjects(page);
      const subject = subjects.find((s) => s.cssPath.includes('long-doc-target'));
      expect(subject).toBeDefined();
      const rect = await scrollTo(page, subject!.ref, 120);
      expect(rect).not.toBeNull();
      expect(Math.abs(rect!.y - 120)).toBeLessThanOrEqual(1);
    });

    it('lands the owner top at the requested viewport y inside an inner scroll container', async () => {
      // enumerate() only finds a subject that is currently PAINTED (plan
      // section 4.2); the target starts below the fold of its own 300px
      // scroll container, so it must be scrolled into view there first — the
      // real pipeline does this via geometry-init's innerScrollers/
      // scrollInnerTo during the band walk, ahead of ever calling enumerate.
      await page.evaluate(() => {
        document.getElementById('inner-scroll-shell')!.scrollTop = 900;
      });
      const { subjects } = await enumerateSubjects(page);
      const subject = subjects.find((s) => s.cssPath.includes('inner-scroll-target'));
      expect(subject).toBeDefined();
      const rect = await scrollTo(page, subject!.ref, 40);
      expect(rect).not.toBeNull();
      expect(Math.abs(rect!.y - 40)).toBeLessThanOrEqual(1);
    });
  });
});
