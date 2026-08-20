// collect/browser — the Playwright measurement pass (M2 passive: axe + contrast
// + screenshots + DOMSnapshot, over a tiered route × viewport × scheme matrix).
// The ONLY place Playwright is imported (dependency law). Emits BrowserArtifacts;
// imports record only. This module is the `./collect-browser` subpath export
// (playwright peer). Probes + GDPR evidence are M3.

import type { Browser } from 'playwright';
import type { Artifact, Subject, CoverageGap, MatrixCell, RunId, ViewportId, ColorScheme } from '../../record/index.js';
import { launchBrowser, openMeasurementContext, newPage, VIEWPORT_PRESETS, type ViewportSize } from './session.js';
import { settle } from './settle.js';
import { scrollThrough } from './scroll.js';
import { runAxe } from './axe.js';
import { collectContrast, type ContrastCandidate } from './contrast.js';
import { decodePng, pixelBand } from './pixel-band.js';
import { captureScreenshot } from './screenshot.js';
import { captureSnapshot } from './snapshot.js';
import { keyboardWalk } from './keyboard.js';
import { captureConsent } from './consent.js';
import { discoverRoutes, type RouteDiscoveryOptions } from './routes.js';

export { VIEWPORT_PRESETS } from './session.js';
export type { ContrastCandidate } from './contrast.js';
export { discoverRoutes } from './routes.js';
export type { RouteDiscovery, RouteDiscoveryOptions } from './routes.js';

export interface CollectBrowserOptions {
  property: string;
  targetUrl: string;
  runId: RunId;
  cwd?: string;
  viewports?: string[]; // preset ids; default ['desktop']
  schemes?: ColorScheme[]; // default ['light']
  routes?: RouteDiscoveryOptions;
  perPageTimeoutMs?: number; // hard per-page budget (pitfall #10); default 20s
  probes?: boolean; // keyboard walk etc. (default true); tiered to default vp × light
  consent?: boolean; // three-way GDPR evidence pass (default true); per-property
}

export interface BrowserCollection {
  artifacts: Artifact[];
  gaps: CoverageGap[];
  matrix: MatrixCell[];
  accessLevels: Array<'public'>;
  spike: { closedShadowHosts: number; piercedClosedShadow: boolean };
  scanned: string[]; // instance urls actually scanned
}

function routePatternOf(url: string): string {
  // Passive M2: no router, so the pattern is the path with numeric ids masked.
  try {
    const u = new URL(url);
    return u.pathname.replace(/\/\d+(?=\/|$)/g, '/:id') || '/';
  } catch {
    return url;
  }
}

async function scanOnce(
  browser: Browser,
  url: string,
  viewport: ViewportSize,
  scheme: ColorScheme,
  opts: CollectBrowserOptions,
  capturedAt: string,
  runProbes: boolean,
): Promise<{ artifacts: Artifact[]; gaps: CoverageGap[]; spike?: { closedShadowHosts: number; piercedClosedShadow: boolean } }> {
  const context = await openMeasurementContext(browser, { scheme, viewport });
  const page = await newPage(context);
  const artifacts: Artifact[] = [];
  const gaps: CoverageGap[] = [];
  const subject: Subject = {
    property: opts.property,
    routePattern: routePatternOf(url),
    instanceUrl: url,
    viewport: viewport.id as ViewportId,
    colorScheme: scheme,
  };
  page.setDefaultTimeout(opts.perPageTimeoutMs ?? 20000);
  try {
    await page.goto(url, { waitUntil: 'commit', timeout: opts.perPageTimeoutMs ?? 20000 });
    await settle(page);
    const scroll = await scrollThrough(page);
    if (scroll.capped) gaps.push({ reason: 'scroll-cap', subject, note: `${scroll.screens} screens` });

    const shot = await captureScreenshot(page, subject, {
      runId: opts.runId, cwd: opts.cwd, viewport: viewport.id as ViewportId, scheme, capturedAt,
    });
    artifacts.push(shot.artifact);

    // Contrast + pixel-band escalation for non-flat candidates.
    const contrast = await collectContrast(page, subject, capturedAt);
    try {
      const png = decodePng(shot.buffer);
      for (const c of contrast.candidates) {
        if (!c.flat) {
          const band = pixelBand(png, c);
          if (band) Object.assign(c, { measuredBand: band.band, minRatio: band.minRatio, maxRatio: band.maxRatio });
        }
      }
    } catch {
      /* undecodable screenshot — candidates stay unresolved (needs-review) */
    }
    artifacts.push(contrast.artifact);

    artifacts.push(await runAxe(page, subject, capturedAt));

    const snap = await captureSnapshot(page, subject, capturedAt);
    artifacts.push(snap.artifact);
    gaps.push(...snap.gaps);

    // Family C probes (keyboard walk) — tiered to the default viewport × light
    // only (keyboard behaviour rarely varies by scheme; the style checks catch
    // the symptom when it does).
    if (runProbes) {
      artifacts.push(await keyboardWalk(page, subject, capturedAt));
    }
    return { artifacts, gaps, spike: { closedShadowHosts: snap.spike.closedShadowHosts, piercedClosedShadow: snap.spike.piercedClosedShadow } };
  } catch (err) {
    gaps.push({ reason: 'crash', subject, note: err instanceof Error ? err.message.slice(0, 120) : 'page error' });
    return { artifacts, gaps };
  } finally {
    await context.close();
  }
}

export async function collectBrowser(opts: CollectBrowserOptions): Promise<BrowserCollection> {
  const capturedAt = new Date().toISOString();
  const viewports = (opts.viewports ?? ['desktop']).map((id) => VIEWPORT_PRESETS[id]).filter(Boolean);
  const schemes = opts.schemes ?? (['light'] as ColorScheme[]);
  const browser = await launchBrowser();
  const artifacts: Artifact[] = [];
  const gaps: CoverageGap[] = [];
  const scanned: string[] = [];
  let spike = { closedShadowHosts: 0, piercedClosedShadow: false };

  try {
    // Route discovery on a throwaway context.
    const discoveryCtx = await openMeasurementContext(browser, { scheme: 'light', viewport: viewports[0] });
    const discoveryPage = await newPage(discoveryCtx);
    let urls: string[];
    try {
      urls = (await discoverRoutes(discoveryPage, opts.targetUrl, opts.routes)).urls;
    } finally {
      await discoveryCtx.close();
    }

    // Tiered matrix — passive checks over the full viewport × scheme matrix;
    // probes only on the default viewport × light (browser-analysis-design tier).
    const runProbes = opts.probes !== false;
    let instances = 0;
    let probeStates = 0;
    for (const url of urls) {
      let scannedThis = false;
      for (let vi = 0; vi < viewports.length; vi++) {
        for (let si = 0; si < schemes.length; si++) {
          const isProbeTier = runProbes && vi === 0 && schemes[si] === 'light';
          const res = await scanOnce(browser, url, viewports[vi], schemes[si], opts, capturedAt, isProbeTier);
          artifacts.push(...res.artifacts);
          gaps.push(...res.gaps);
          if (isProbeTier) probeStates++;
          if (res.spike && (res.spike.piercedClosedShadow || res.spike.closedShadowHosts > spike.closedShadowHosts)) {
            spike = res.spike;
          }
          scannedThis = true;
        }
      }
      if (scannedThis) {
        scanned.push(url);
        instances++;
      }
    }

    // Evidence pass — three-way consent capture, ONCE per property (site-wide
    // behaviour), on a pristine evidence profile.
    if (opts.consent !== false && urls.length) {
      const entrySubject: Subject = { property: opts.property, routePattern: routePatternOf(urls[0]), instanceUrl: urls[0] };
      const consent = await captureConsent(browser, urls[0], entrySubject, viewports[0], capturedAt);
      artifacts.push(...consent.artifacts);
      gaps.push(...consent.gaps);
    }

    const matrix: MatrixCell[] = [
      {
        family: 'passive',
        routePatterns: new Set(scanned.map(routePatternOf)).size,
        instances,
        viewports: viewports.map((v) => v.id as ViewportId),
        schemes,
        states: 1,
      },
      { family: 'probes', routePatterns: runProbes ? new Set(scanned.map(routePatternOf)).size : 0, instances: probeStates, viewports: viewports.slice(0, 1).map((v) => v.id as ViewportId), schemes: ['light'], states: probeStates },
      { family: 'evidence', routePatterns: opts.consent !== false ? 1 : 0, instances: opts.consent !== false ? 1 : 0, viewports: viewports.slice(0, 1).map((v) => v.id as ViewportId), schemes: ['light'], states: 3 },
    ];
    return { artifacts, gaps, matrix, accessLevels: ['public'], spike, scanned };
  } finally {
    await browser.close();
  }
}
