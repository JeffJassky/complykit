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

// Structural page fingerprint (routes.ts dedup signal): hashes the DOM
// skeleton (tags + roles, text/ids/classes stripped) so pages sharing one
// layout are sampled, not scanned exhaustively. Typed as unknown here (not
// Playwright's Page) to keep the published contract free of a hard
// dependency on playwright's types.
export function structuralFingerprint(page: unknown): Promise<string>;

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

// --- consent & tracking evaluation (plans/consent-design.md §2) -------------
import type {
  LocationSpec,
  LocationVerification,
  GeoSourceResult,
  ScenarioId,
  ScenarioSummary,
  NotTestedItem,
  Timeline,
  ContainerCapture,
} from './index.js';

export interface GeoSource {
  name: string;
  lookup(fetchJson: (url: string) => Promise<unknown>, spec: LocationSpec): Promise<Omit<GeoSourceResult, 'name'>>;
}
export const DEFAULT_GEO_SOURCES: GeoSource[];
export const LOCAL_LOCATION: LocationSpec;

export interface JourneyOptions {
  dwellMs?: number;
  pageDwellMs?: number;
  scrollSteps?: number;
  paths?: string[];
  maxPages?: number;
  navTimeoutMs?: number;
}
export function resolveJourney(j?: JourneyOptions): Required<Omit<JourneyOptions, 'paths'>> & { paths?: string[] };

export interface EvaluationPolicy {
  registrableDomain(host: string): string;
  verify(spec: LocationSpec, sources: GeoSourceResult[]): LocationVerification;
  scenariosFor(spec: LocationSpec, verification: LocationVerification): ScenarioId[];
}
export type EvaluationEvent =
  | { type: 'location'; location: string; verdict: string; observed?: string; scenarios: ScenarioId[]; note?: string }
  | { type: 'scenario-start'; location: string; scenario: ScenarioId }
  | {
      type: 'scenario-done';
      location: string;
      scenario: ScenarioId;
      status: 'tested' | 'not-tested' | 'not-applicable';
      reason?: string;
      requests: number;
      thirdPartyRequests: number;
      parties: number;
      cookies: number;
      durationMs: number;
      banner?: string;
    };
export interface ConsentEvaluationOptions {
  property: string;
  targetUrl: string;
  runId: RunId;
  cwd?: string;
  locations?: LocationSpec[];
  scenarios?: ScenarioId[];
  journey?: JourneyOptions;
  geoSources?: GeoSource[];
  rawEvidence?: boolean;
  har?: boolean;
  bannerWaitMs?: number;
  scenarioTimeoutMs?: number;
  launchArgs?: string[];
  concurrency?: number;
  policy: EvaluationPolicy;
  trace?: (line: string) => void;
  onEvent?: (e: EvaluationEvent) => void;
}
export interface LocationRun {
  spec: LocationSpec;
  verification: LocationVerification;
  scenarios: ScenarioSummary[];
}
export interface ConsentEvaluationCollection {
  artifacts: Artifact[];
  timelines: Timeline[];
  locations: LocationRun[];
  notTested: NotTestedItem[];
  site: { url: string; host: string; registrableDomain: string };
  autoconsentVersion?: string;
  /** Tag-manager containers the scenarios loaded, fetched through their location's context. */
  containers: ContainerCapture[];
  startedAt: string;
  finishedAt: string;
}
export function collectConsentEvaluation(opts: ConsentEvaluationOptions): Promise<ConsentEvaluationCollection>;
/** Browser-context settings (proxy, timezone, locale) for a location. Playwright's options type, kept loose here. */
export function contextOptionsFor(spec: LocationSpec): Record<string, unknown>;
export function redactHar(har: { log?: { entries?: unknown[]; comment?: string } }): void;
