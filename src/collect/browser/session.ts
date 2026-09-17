import type { Browser, BrowserContext, Page } from 'playwright';
import { GEOMETRY_INIT } from './geometry-init.js';
import { GLYPH_INIT } from './glyph-init.js';

// The ONLY place Playwright is imported (dependency law). Session + profile
// management. Two profiles exist by design (browser-analysis-design pitfall #3):
// the MEASUREMENT profile freezes animations, reduces motion, and blocks
// ad/analytics domains for deterministic a11y measurement; the EVIDENCE profile
// (M3) is pristine so captured tracker behaviour is representative. M2 is the
// passive measurement pass.

export type ColorScheme = 'light' | 'dark';

export interface ViewportSize {
  id: string;
  width: number;
  height: number;
}

export const VIEWPORT_PRESETS: Record<string, ViewportSize> = {
  mobile: { id: 'mobile', width: 375, height: 812 },
  tablet: { id: 'tablet', width: 768, height: 1024 },
  desktop: { id: 'desktop', width: 1280, height: 800 },
};

// Blocked in the MEASUREMENT profile only — ads/analytics inject nondeterminism
// (pitfall #2). The evidence profile (M3) must NOT block these.
const MEASUREMENT_BLOCK = [
  'googletagmanager.com', 'google-analytics.com', 'doubleclick.net', 'connect.facebook.net',
  'hotjar.com', 'mixpanel.com', 'segment.com', 'segment.io', 'fullstory.com', 'clarity.ms',
  'amplitude.com', 'sentry.io', 'analytics',
];

// Injected before any page script: kill animation/transition timing so a
// measurement pass is stable frame to frame.
const FREEZE_CSS = `*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;scroll-behavior:auto!important;caret-color:transparent!important;}`;

export async function launchBrowser(): Promise<Browser> {
  const { chromium } = await import('playwright');
  return chromium.launch({ headless: process.env.COMPLYKIT_HEADED !== '1' });
}

export interface MeasurementContextOptions {
  scheme: ColorScheme;
  viewport: ViewportSize;
  block?: boolean; // default true — measurement profile
  storageStatePath?: string; // authed session, from property.auth (kind: 'storage-state')
}

export async function openMeasurementContext(
  browser: Browser,
  opts: MeasurementContextOptions,
): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: opts.viewport.width, height: opts.viewport.height },
    colorScheme: opts.scheme,
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
    storageState: opts.storageStatePath,
    // The measurement profile injects axe + probes as inline scripts; a page
    // CSP (script-src 'self') would crash every cell. The instrument bypasses
    // the page's CSP — the EVIDENCE profile (consent capture) does not, so
    // captured behaviour stays representative.
    bypassCSP: true,
  });

  if (opts.block !== false) {
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (MEASUREMENT_BLOCK.some((d) => url.includes(d))) return route.abort();
      return route.continue();
    });
  }

  // Geometry helpers first: every collector locates elements through these, so
  // one definition of "where is this element in the capture" serves document-
  // scrolling pages and inner-scroller app shells alike. GLYPH_INIT is
  // installed right after: the glyph-mask contrast walk (glyph-measure.ts)
  // needs both `window.__ck` (registry, boxOf, obstructions) and
  // `window.__ck.glyph` (enumerate/hide/restore/settled) on every navigation,
  // and GLYPH_INIT's own property-descriptor trick (see its header comment)
  // means the two survive in either install order — but this order is the one
  // the corpus tests run under, so it stays canonical.
  await context.addInitScript(GEOMETRY_INIT);
  await context.addInitScript(GLYPH_INIT);

  await context.addInitScript((css: string) => {
    const apply = (): void => {
      const style = document.createElement('style');
      style.setAttribute('data-complykit', 'freeze');
      style.textContent = css;
      document.documentElement.appendChild(style);
    };
    if (document.documentElement) apply();
    else document.addEventListener('DOMContentLoaded', apply);
  }, FREEZE_CSS);

  return context;
}

// Retarget an already-open measurement page to a new viewport × scheme cell,
// instead of tearing down the context and opening a fresh window per cell. The
// route-block and freeze-CSS init script live on the context and persist; only
// the viewport and emulated media change here, applied BEFORE the cell's goto so
// the page loads at the right size and colour scheme. This keeps the whole
// passive matrix on ONE window (no per-cell focus theft in headed mode) and
// skips ~64 context create/destroy cycles.
export async function applyMeasurementCell(
  page: Page,
  viewport: ViewportSize,
  scheme: ColorScheme,
): Promise<void> {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
}

export async function newPage(context: BrowserContext): Promise<Page> {
  return context.newPage();
}

// The EVIDENCE profile (browser-analysis-design pitfall #3): a PRISTINE browser
// — no ad/analytics blocking, no animation freeze, no reduced-motion — so the
// captured tracker/consent behaviour is representative of what a real visitor
// gets. One fresh context per consent path (pitfall #4: consent state must not
// leak between the pre/reject/accept captures).
export async function openEvidenceContext(
  browser: Browser,
  viewport: ViewportSize,
  storageStatePath?: string,
): Promise<BrowserContext> {
  return browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    storageState: storageStatePath,
  });
}
