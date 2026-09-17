// Public types for `@jeffjassky/complykit/collect-browser` — the Playwright
// measurement pass (M2 passive: axe + contrast + screenshots + DOMSnapshot over
// a tiered route × viewport × scheme matrix). Behind the `playwright` peer.
// Emits browser Artifacts; imports record only.

import type { Artifact, CoverageGap, MatrixCell, RunId, ColorScheme } from './index.js';

export interface ViewportSize {
  id: string;
  width: number;
  height: number;
}
export const VIEWPORT_PRESETS: Record<string, ViewportSize>;

export interface RouteDiscoveryOptions {
  sitemap?: boolean;
  crawl?: { maxPages: number; sameOrigin: boolean };
  include?: string[];
  exclude?: string[];
  cap?: number;
}
export interface RouteDiscovery {
  urls: string[];
  sitemapUsed: boolean;
  crawledPages: number;
}
// discoverRoutes takes a Playwright Page; typed as unknown here to avoid a hard
// dependency on playwright's types in the published contract.
export function discoverRoutes(page: unknown, baseUrl: string, opts?: RouteDiscoveryOptions): Promise<RouteDiscovery>;

// A subject the glyph-mask contrast walk (glyph-measure.ts) found and either
// measured directly off the rendered pixels or left unmeasured, with a
// reason. One per text/pseudo-element/placeholder/value subject on the page;
// carried in the `style-probe` (`check: 'contrast'`) artifact's `results`.
export interface MeasuredSubject {
  key: string;
  ref: number;
  kind: 'text' | 'before' | 'after' | 'placeholder' | 'value';
  cssPath: string;
  textSample: string;
  sourceFile: string | null;
  scopeId: string | null;
  fgVars?: string[];
  bgVars?: string[];
  bgImageVars?: string[];
  textColor: string;
  fontSizePx: number;
  bold: boolean;
  large: boolean;
  required: number;
  paintedByBackground?: boolean;
  flat: boolean;
  bgColor: string | null;
  cascadeRatio: number | null;
  box: { x: number; y: number; width: number; height: number };
  status: 'measured' | 'unmeasured';
  unmeasuredReason?: 'never-stable' | 'occluded' | 'cap' | 'error';
  measuredAt?: 'band' | 'rest';
  verdict?: 'pass' | 'fail';
  ratio?: number;
  minRatio?: number;
  medianRatio?: number;
  maxRatio?: number;
  glyphPixels?: number;
  failingPixels?: number;
  fgSource?: 'css' | 'rendered';
  fgColor?: string;
  worstBgColor?: string;
  bestBgColor?: string;
  cropPath?: string;
  overlayPath?: string;
  cropWidth?: number;
  cropHeight?: number;
}

export interface CollectBrowserOptions {
  property: string;
  targetUrl: string;
  runId: RunId;
  cwd?: string;
  viewports?: string[];
  schemes?: ColorScheme[];
  routes?: RouteDiscoveryOptions;
  perPageTimeoutMs?: number;
}
export interface BrowserCollection {
  artifacts: Artifact[];
  gaps: CoverageGap[];
  matrix: MatrixCell[];
  accessLevels: Array<'public'>;
  spike: { closedShadowHosts: number; piercedClosedShadow: boolean };
  scanned: string[];
}
export function collectBrowser(opts: CollectBrowserOptions): Promise<BrowserCollection>;
