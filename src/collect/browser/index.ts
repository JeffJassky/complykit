// collect/browser — the Playwright measurement pass (M2 passive: axe + contrast
// + screenshots + DOMSnapshot, over a tiered route × viewport × scheme matrix).
// The ONLY place Playwright is imported (dependency law). Emits BrowserArtifacts;
// imports record only. This module is the `./collect-browser` subpath export
// (playwright peer). Probes + GDPR evidence are M3.

import type { Browser } from 'playwright';
import type { Artifact, Subject, CoverageGap, MatrixCell, RunId, ViewportId, ColorScheme } from '../../record/index.js';
import type { Page } from 'playwright';
import { launchBrowser, openMeasurementContext, applyMeasurementCell, newPage, VIEWPORT_PRESETS, type ViewportSize } from './session.js';
import { settle } from './settle.js';
import { scrollThrough } from './scroll.js';
import { runAxe } from './axe.js';
import { collectContrast, attributeGradientVars, type ContrastCandidate } from './contrast.js';
import { pixelBand } from './pixel-band.js';
import { measureAxeContrastTargets } from './axe-contrast-measure.js';
import { captureScreenshot } from './screenshot.js';
import { captureSnapshot } from './snapshot.js';
import { keyboardWalk } from './keyboard.js';
import { captureConsent } from './consent.js';
import { discoverRoutes, type RouteDiscoveryOptions, type TraceFn } from './routes.js';

export { VIEWPORT_PRESETS } from './session.js';
export type { ContrastCandidate } from './contrast.js';
export { discoverRoutes } from './routes.js';
export type { RouteDiscovery, RouteDiscoveryOptions, TraceFn } from './routes.js';
export { structuralFingerprint } from './fingerprint.js';

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
  storageStatePath?: string; // resolved path from property.auth (kind: 'storage-state')
  trace?: TraceFn; // per-navigation narration; default no-op
}

export interface BrowserCollection {
  artifacts: Artifact[];
  gaps: CoverageGap[];
  matrix: MatrixCell[];
  accessLevels: Array<'public' | 'authed'>;
  spike: { closedShadowHosts: number; piercedClosedShadow: boolean };
  scanned: string[]; // instance urls actually scanned
}

function normalizeForTrace(u: string): string {
  try {
    const url = new URL(u);
    url.hash = '';
    return url.toString();
  } catch {
    return u;
  }
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
  page: Page,
  url: string,
  viewport: ViewportSize,
  scheme: ColorScheme,
  opts: CollectBrowserOptions,
  capturedAt: string,
  runProbes: boolean,
  alreadyLoaded = false,
): Promise<{ artifacts: Artifact[]; gaps: CoverageGap[]; spike?: { closedShadowHosts: number; piercedClosedShadow: boolean } }> {
  // Reuse the one measurement page. For the first cell of a page the crawl has
  // ALREADY loaded and settled it at this viewport × scheme (single-visit pass),
  // so skip the redundant navigation; other cells retarget and reload.
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
    if (!alreadyLoaded) {
      await applyMeasurementCell(page, viewport, scheme);
      await page.goto(url, { waitUntil: 'commit', timeout: opts.perPageTimeoutMs ?? 20000 });
      await settle(page);
    }
    const landed = page.url();
    opts.trace?.(
      `scan ${viewport.id}/${scheme} → ${url}` +
        (normalizeForTrace(landed) !== normalizeForTrace(url) ? ` ⇒ landed ${landed} (redirected)` : ''),
    );
    const scroll = await scrollThrough(page);
    if (scroll.capped) gaps.push({ reason: 'scroll-cap', subject, note: `${scroll.screens} screens` });

    // Contrast measurement runs INSIDE the capture, once per band, while the
    // page is still scrolled there. Measuring afterwards against the finished
    // image was wrong on any still-loading page: one route's scroller grew from
    // 2208px to 3703px between capture and measurement, so boxes addressed
    // pixels that had moved and produced precise, confident, fictional ratios.
    // axe runs BEFORE the capture, not after, so the elements it disputes can be
    // measured inside a band like everything else. axe reports `incomplete` when
    // it cannot walk to a background — a pseudo-element over the text, an
    // overlapping box, a gradient — and those are exactly the elements the
    // contrast collector drops, because the flat cascade says they pass. So
    // nothing measured them and axe's "could not be determined" stood: 211
    // findings on the client, every one of them a question the pixels can
    // answer. Resolving them after the walk, as this used to, produced
    // candidates with no measurement at all.
    const axeArtifact = await runAxe(page, subject, capturedAt);
    const axeResults = axeArtifact.kind === 'axe-result' ? axeArtifact.results : null;

    const measured = new Map<string, ContrastCandidate>();
    let truncated = false;
    let candidates: ContrastCandidate[] = [];
    let contrast: Awaited<ReturnType<typeof collectContrast>> | null = null;

    const shot = await captureScreenshot(page, subject, {
      runId: opts.runId, cwd: opts.cwd, viewport: viewport.id as ViewportId, scheme, capturedAt,
      onBand: async (bandPng, offset) => {
        const pass = await collectContrast(page, subject, capturedAt);
        if (pass.truncated) truncated = true;
        if (!contrast) contrast = pass; // keep the first artifact; results are merged below
        for (const c of pass.candidates) {
          // Identity is the ELEMENT, not where it happened to be. Including the
          // box in the key looked harmless while every page was visited once,
          // but a band walk re-reads the DOM at each offset, and a page with
          // sticky sections, scroll-linked pinning or reveal transforms puts
          // the same element at a different contentBox in every band. Each band
          // then minted a new key for it: one client route went from ~900
          // findings to ~45,000, the same text over and over at the offsets it
          // travelled through.
          const key = c.cssPath;
          const already = measured.get(key);
          if (already?.measuredBand) continue; // already measured in an earlier band
          const vb = c.viewportBox;
          // Only elements actually ON SCREEN in this band can be measured from
          // it. An element off-screen in every band still gets RECORDED, without
          // a band — it surfaces as "ratio could not be proven" rather than
          // disappearing. Dropping the candidates we failed to measure would
          // turn a coverage hole into a clean bill of health.
          if (!vb || vb.y + vb.height <= 0 || vb.y >= bandPng.height) {
            if (!already) measured.set(key, c);
            continue;
          }
          // Occlusion is decided in the collector, per element, by hit-testing
          // the compositor — not here by rectangle. A fixed header overlaps
          // everything beneath it, but its own text is painted on top and is
          // perfectly measurable, and rejecting by rect threw that away too.
          // Anything genuinely covered arrives with no viewportBox and was
          // skipped above.
          // Measure EVERY candidate, flat stacks included: a flat cascade is not
          // proof of what rendered, and engines.ts reconciles axe's inferred
          // verdicts against these measurements.
          const band = pixelBand(bandPng, c, vb);
          if (band) {
            Object.assign(c, {
              measuredBand: band.band,
              minRatio: band.minRatio,
              maxRatio: band.maxRatio,
              // Overlay markers are stored in capture space, so shift the
              // band-relative sample points by this band's scroll offset.
              samples: band.samples.map((pt) => ({ x: pt.x, y: pt.y + offset })),
              fgColor: band.fgColor,
              bgLoColor: band.bgLoColor,
              bgHiColor: band.bgHiColor,
              ratioLo: band.ratioLo,
              ratioHi: band.ratioHi,
            });
          }
          measured.set(key, c);
        }

        // Now the elements axe disputed but our collector never offered — the
        // flat-and-passing ones it drops. Same band, same instant, same pixel
        // pass; the only difference is where the selector came from.
        if (axeResults) {
          try {
            // Only MEASURED candidates count as already covered. Passing the
            // whole map would exclude a target the moment it was seen once,
            // even though it was off screen in that band and never measured —
            // so it would never be revisited in the band that does have it on
            // screen, and would sit unmeasured for the rest of the scan.
            const covered = [...measured.values()].filter((c) => c.measuredBand);
            const disputed = await measureAxeContrastTargets(page, axeResults, covered);
            for (const c of disputed) {
              const key = c.cssPath;
              if (measured.get(key)?.measuredBand) continue;
              const vb = c.viewportBox;
              if (!vb || vb.y + vb.height <= 0 || vb.y >= bandPng.height) {
                if (!measured.has(key)) measured.set(key, c);
                continue;
              }
              const band = pixelBand(bandPng, c, vb);
              if (band) {
                Object.assign(c, {
                  measuredBand: band.band,
                  minRatio: band.minRatio,
                  maxRatio: band.maxRatio,
                  samples: band.samples.map((pt) => ({ x: pt.x, y: pt.y + offset })),
                  fgColor: band.fgColor,
                  bgLoColor: band.bgLoColor,
                  bgHiColor: band.bgHiColor,
                  ratioLo: band.ratioLo,
                  ratioHi: band.ratioHi,
                });
              }
              measured.set(key, c);
            }
          } catch {
            /* best-effort — axe's own verdict stands unreconciled */
          }
        }
      },
    });
    artifacts.push(shot.artifact);
    if (shot.stitched) {
      opts.trace?.(`capture ${viewport.id}/${scheme} → stitched ${shot.bands} band(s) from an inner scroll container`);
    }
    if (shot.cappedPx && shot.cappedPx > 0) {
      // Content past the band cap is NOT in the capture, so nothing below it can
      // be measured. Say so rather than let the missing pixels read as clean.
      gaps.push({ reason: 'scroll-cap', subject, note: `${Math.round(shot.cappedPx)}px below the capture cap` });
    }

    // Fall back to a single pass if the capture never invoked a band visitor.
    if (!contrast) contrast = await collectContrast(page, subject, capturedAt);
    // The candidate cap truncated the page: text past it was never eligible for
    // measurement, so axe's verdicts there stand unreconciled. Say so.
    if (truncated) {
      gaps.push({ reason: 'scroll-cap', subject, note: 'contrast candidate cap reached; text past it was not measured' });
    }
    candidates = measured.size ? [...measured.values()] : contrast.candidates;
    // Re-read geometry at the page's resting state.
    //
    // A candidate's box is whatever contentBox said in the band that measured
    // it. Sticky sections, scroll-linked pinning and reveal transforms move an
    // element between bands, so that box can be hundreds of pixels from where
    // the same element sits at rest. That matters because contrast-reconcile
    // matches axe's findings to our measurements GEOMETRICALLY, within 2px, and
    // axe runs once, at rest: a stale box means no match, so a measurement we
    // actually took never gets to answer axe's "background could not be
    // determined" and the finding stays needs-review. On the client's marketing
    // routes that was ~1,600 findings' worth of measurement thrown away.
    //
    // The ratios stay as measured — those are the pixels the element really had.
    // Only where it is gets refreshed. (`samples` are overlay markers in the
    // capture space of that band and are deliberately left alone.)
    if (measured.size) {
      try {
        const rested = (await page.evaluate((paths: string[]) => {
          const ck = (window as unknown as { __ck?: { contentBox(e: Element): { x: number; y: number; width: number; height: number } } }).__ck;
          return paths.map((p) => {
            let el: Element | null = null;
            try { el = document.querySelector(p); } catch { el = null; }
            if (!el) return null;
            if (ck) return ck.contentBox(el);
            const r = el.getBoundingClientRect();
            return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
          });
        }, candidates.map((c) => c.cssPath))) as ({ x: number; y: number; width: number; height: number } | null)[];
        for (let i = 0; i < candidates.length; i++) {
          const box = rested[i];
          if (box && box.width > 0 && box.height > 0) candidates[i].box = box;
        }
      } catch {
        /* best-effort — the band's box stands */
      }
    }
    // axe's geometry needs the same treatment, and for the same reason: it ran
    // BEFORE the band walk (so its disputed elements could be measured in one),
    // and the walk fires reveals and settles lazy images, so the layout it saw
    // is not the layout at rest. contrast-reconcile matches the two sets
    // geometrically within 2px, so leaving axe on its old boxes threw away
    // every measurement the walk had just taken — 1,258 unmatched nodes.
    if (axeArtifact.kind === 'axe-result') {
      try {
        type AxeNode = { target?: string[]; box?: { x: number; y: number; width: number; height: number } };
        const payload = axeArtifact.results as { violations?: Array<{ nodes?: AxeNode[] }>; incomplete?: Array<{ nodes?: AxeNode[] }> };
        const nodes: AxeNode[] = [];
        for (const list of [payload.violations, payload.incomplete]) {
          for (const rule of list ?? []) for (const n of rule.nodes ?? []) nodes.push(n);
        }
        const sels = nodes.map((n) => n.target?.join(' ') ?? '');
        const rested = (await page.evaluate((paths: string[]) => {
          const ck = (window as unknown as { __ck?: { contentBox(e: Element): { x: number; y: number; width: number; height: number } } }).__ck;
          return paths.map((sel) => {
            if (!sel) return null;
            let el: Element | null = null;
            try { el = document.querySelector(sel); } catch { el = null; }
            if (!el) return null;
            if (ck) return ck.contentBox(el);
            const r = el.getBoundingClientRect();
            return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
          });
        }, sels)) as ({ x: number; y: number; width: number; height: number } | null)[];
        for (let i = 0; i < nodes.length; i++) {
          const box = rested[i];
          if (box && box.width > 0 && box.height > 0) nodes[i].box = box;
        }
      } catch {
        /* best-effort — unmatched nodes keep axe's own verdict */
      }
    }

    contrast.candidates = candidates;
    if (contrast.artifact.kind === 'style-probe') {
      contrast.artifact.results = candidates as unknown as Record<string, unknown>[];
      contrast.artifact.screenshotPath = shot.artifact.kind === 'screenshot' ? shot.artifact.path : undefined;
    }
    // Name the CSS variables the AUTHORED gradient declarations actually use,
    // while the element is still on this load.
    await attributeGradientVars(page, contrast.candidates);
    artifacts.push(contrast.artifact);

    if (axeArtifact.kind === 'axe-result' && shot.artifact.kind === 'screenshot') {
      axeArtifact.screenshotPath = shot.artifact.path;
    }
    artifacts.push(axeArtifact);

    const snap = await captureSnapshot(page, subject, capturedAt);
    artifacts.push(snap.artifact);
    gaps.push(...snap.gaps);

    // Family C probes (keyboard walk) — tiered to the default viewport × light
    // only (keyboard behaviour rarely varies by scheme; the style checks catch
    // the symptom when it does).
    if (runProbes) {
      const walk = await keyboardWalk(page, subject, capturedAt);
      if (walk.kind === 'focus-walk' && shot.artifact.kind === 'screenshot') {
        walk.screenshotPath = shot.artifact.path;
      }
      artifacts.push(walk);
    }
    return { artifacts, gaps, spike: { closedShadowHosts: snap.spike.closedShadowHosts, piercedClosedShadow: snap.spike.piercedClosedShadow } };
  } catch (err) {
    gaps.push({ reason: 'crash', subject, note: err instanceof Error ? err.message.slice(0, 120) : 'page error' });
    return { artifacts, gaps };
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
    // Tiered matrix — passive checks over the full viewport × scheme matrix;
    // probes only on the default viewport × light (browser-analysis-design tier).
    const runProbes = opts.probes !== false;
    let instances = 0;
    let probeStates = 0;

    // Single-visit pass: ONE reused context/page both crawls AND measures. The
    // crawl loads each page once at cell 0 (viewport[0] × scheme[0]); a page that
    // passes sampling is measured inline via `onKeep` — cell 0 reuses that very
    // load (no re-navigation), the remaining cells retarget and reload. This
    // removes the old second full visit of every kept page.
    const measureCtx = await openMeasurementContext(browser, {
      scheme: schemes[0],
      viewport: viewports[0],
      storageStatePath: opts.storageStatePath,
    });
    const measurePage = await newPage(measureCtx);

    // Reset the page to cell 0 before each crawl navigation, so fingerprints are
    // always computed at the same viewport × scheme (a prior onKeep may have left
    // the page on another cell).
    const prepareVisit = async (): Promise<void> => {
      await applyMeasurementCell(measurePage, viewports[0], schemes[0]);
    };

    // Measure one kept page across the matrix. cell 0 = the crawl's current load.
    const measureMatrix = async (page: Page, url: string): Promise<void> => {
      let scannedThis = false;
      for (let vi = 0; vi < viewports.length; vi++) {
        for (let si = 0; si < schemes.length; si++) {
          const isProbeTier = runProbes && vi === 0 && schemes[si] === 'light';
          const isCell0 = vi === 0 && si === 0;
          const res = await scanOnce(page, url, viewports[vi], schemes[si], opts, capturedAt, isProbeTier, isCell0);
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
    };

    let urls: string[] = [];
    try {
      urls = (
        await discoverRoutes(measurePage, opts.targetUrl, {
          ...opts.routes,
          trace: opts.trace,
          prepareVisit,
          onKeep: (page, url) => measureMatrix(page, url),
        })
      ).urls;
    } finally {
      await measureCtx.close();
    }

    // Evidence pass — three-way consent capture, ONCE per property (site-wide
    // behaviour), on a pristine evidence profile.
    if (opts.consent !== false && urls.length) {
      const entrySubject: Subject = { property: opts.property, routePattern: routePatternOf(urls[0]), instanceUrl: urls[0] };
      const consent = await captureConsent(browser, urls[0], entrySubject, viewports[0], capturedAt, opts.runId, opts.cwd, opts.storageStatePath);
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
    return { artifacts, gaps, matrix, accessLevels: opts.storageStatePath ? ['public', 'authed'] : ['public'], spike, scanned };
  } finally {
    await browser.close();
  }
}
