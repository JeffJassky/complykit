import type { Browser, BrowserContext, Page } from 'playwright';

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
  return chromium.launch({ headless: true });
}

export interface MeasurementContextOptions {
  scheme: ColorScheme;
  viewport: ViewportSize;
  block?: boolean; // default true — measurement profile
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
  });

  if (opts.block !== false) {
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (MEASUREMENT_BLOCK.some((d) => url.includes(d))) return route.abort();
      return route.continue();
    });
  }

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

export async function newPage(context: BrowserContext): Promise<Page> {
  return context.newPage();
}
