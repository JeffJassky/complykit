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

export interface ContrastCandidate {
  cssPath: string;
  textSample: string;
  fontSizePx: number;
  bold: boolean;
  large: boolean;
  textColor: string;
  bgColor: string | null;
  flat: boolean;
  ratio: number | null;
  required: number;
  box: { x: number; y: number; width: number; height: number };
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
