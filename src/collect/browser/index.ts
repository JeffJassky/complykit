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
import { captureScreenshot, type Obstructions } from './screenshot.js';
import { captureSnapshot } from './snapshot.js';
import { keyboardWalk } from './keyboard.js';
import { captureConsent } from './consent.js';
import { discoverRoutes, type RouteDiscoveryOptions, type TraceFn } from './routes.js';
import { createGlyphRunState, measureBand, measureRemaining, type MeasuredSubject, type MeasureContext } from './glyph-measure.js';

export { VIEWPORT_PRESETS } from './session.js';
export type { MeasuredSubject } from './glyph-measure.js';
export { discoverRoutes } from './routes.js';
export type { RouteDiscovery, RouteDiscoveryOptions, TraceFn } from './routes.js';
export { structuralFingerprint } from './fingerprint.js';
export {
  collectConsentEvaluation,
  contextOptionsFor,
  resolveJourney,
  redactHar,
  DEFAULT_GEO_SOURCES,
  LOCAL_LOCATION,
} from './evaluation/index.js';
export type {
  ConsentEvaluationOptions,
  ConsentEvaluationCollection,
  EvaluationPolicy,
  LocationRun,
  GeoSource,
  JourneyOptions,
} from './evaluation/index.js';

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
    // axe runs BEFORE the capture, not after, so its color-contrast targets
    // exist for the later at-rest resolution pass below, in the same DOM the
    // glyph walk measured.
    const axeArtifact = await runAxe(page, subject, capturedAt);

    // Glyph-mask contrast walk (plans/glyph-contrast-plan.md §4.3): each band
    // hides exactly the on-screen, non-overlapping subjects' glyphs and diffs
    // against the pixels behind them — no cascade guess, no background image
    // blind spot, no wrong-instant read of a still-revealing element. `state`
    // accumulates `done`/`pending` across every band AND the rest pass below.
    const state = createGlyphRunState();
    const measureCtx: MeasureContext = {
      runId: opts.runId,
      cwd: opts.cwd,
      obstructions: { topInset: 0, bottomInset: 0 },
      trace: opts.trace,
    };

    const shot = await captureScreenshot(page, subject, {
      runId: opts.runId, cwd: opts.cwd, viewport: viewport.id as ViewportId, scheme, capturedAt,
      onBand: async (_bandPng, _offset, _index, obstructions: Obstructions) => {
        // measureBand reads ctx.obstructions itself (it needs topInset/
        // bottomInset to decide which subjects are fully clear of page chrome
        // at THIS scroll position) — refresh it from what the capture just
        // read for this exact band, the same obstructions screenshot.ts used
        // to park the band in the first place.
        measureCtx.obstructions = obstructions;
        await measureBand(page, state, measureCtx);
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

    // Mop-up pass: whatever the band walk left pending (never fully on screen
    // at rest, overlapping another subject, or the page never invoked a band
    // visitor at all — the `!info` fallback already called measureBand once
    // at offset 0 via the same onBand callback) gets scrolled to and measured
    // individually, tall subjects sliced, everything else marked unmeasured
    // with a reason rather than silently dropped.
    await measureRemaining(page, state, measureCtx);
    const measuredSubjects: MeasuredSubject[] = [...state.done.values()];

    // axe's color-contrast nodes are settled against these measurements
    // (contrast-reconcile.ts / engines.ts): resolve each node's element (and
    // its text-owning descendants) to page-side refs, AT REST, in the same
    // DOM the glyph walk just measured — not the layout axe saw before the
    // walk fired reveals and settled lazy images.
    if (axeArtifact.kind === 'axe-result') {
      try {
        type AxeContrastNode = { target?: (string | string[])[]; measureRefs?: number[] | null };
        const payload = axeArtifact.results as {
          violations?: Array<{ id: string; nodes?: AxeContrastNode[] }>;
          incomplete?: Array<{ id: string; nodes?: AxeContrastNode[] }>;
        };
        const nodes: AxeContrastNode[] = [];
        for (const list of [payload.violations, payload.incomplete]) {
          for (const rule of list ?? []) {
            if (rule.id !== 'color-contrast') continue;
            for (const n of rule.nodes ?? []) nodes.push(n);
          }
        }
        if (nodes.length) {
          // Same conversion axe.ts uses: a nested array entry IS the shadow
          // path; a flat array of strings is one plain-DOM path.
          const paths = nodes.map((n) => {
            const t = n.target;
            if (!t || t.length === 0) return [];
            const nested = t.find((x): x is string[] => Array.isArray(x));
            return nested ?? (t as string[]);
          });
          const resolved = (await page.evaluate((ps: string[][]) => {
            const glyph = (window as unknown as { __ck?: { glyph?: { resolveAxeTargets(t: string[][]): Array<{ ref: number | null; measureRefs: number[] }> } } }).__ck?.glyph;
            return glyph ? glyph.resolveAxeTargets(ps) : ps.map(() => ({ ref: null, measureRefs: [] }));
          }, paths)) as Array<{ ref: number | null; measureRefs: number[] }>;
          for (let i = 0; i < nodes.length; i++) {
            nodes[i].measureRefs = resolved[i]?.measureRefs ?? [];
          }
        }
      } catch {
        /* best-effort — unresolved nodes keep axe's own verdict (unmatched) */
      }
    }

    // Coverage gaps for what the walk could not measure: unmeasured is never a
    // silent pass. One gap per unmeasured reason, plus SVG `<text>` (outside
    // this method's scope entirely — canvas/image text is unchanged non-goal
    // territory) and the subject-cap truncation, both from one final
    // whole-page enumerate() now that the page is at rest.
    try {
      const enumResult = (await page.evaluate(() => {
        const glyph = (window as unknown as { __ck?: { glyph?: { enumerate(o: object): { truncated: boolean; svgTextCount: number } } } }).__ck?.glyph;
        return glyph ? glyph.enumerate({}) : { truncated: false, svgTextCount: 0 };
      })) as { truncated: boolean; svgTextCount: number };
      if (enumResult.truncated) {
        gaps.push({ reason: 'scroll-cap', subject, note: 'text subject cap (5000) reached; text past it was not measured' });
      }
      if (enumResult.svgTextCount > 0) {
        gaps.push({ reason: 'contrast-unmeasured', subject, note: `${enumResult.svgTextCount} SVG text element(s) not measured` });
      }
    } catch {
      /* best-effort — no gap recorded rather than a crashed cell */
    }
    const unmeasuredReasonCounts = new Map<string, number>();
    for (const m of measuredSubjects) {
      // Covered text that was re-checked with its overlay hidden is reported by
      // contrast.text as needs-review, naming the overlay; it is not a gap.
      if (m.status === 'unmeasured' && m.unmeasuredReason && !m.unobscured) {
        unmeasuredReasonCounts.set(m.unmeasuredReason, (unmeasuredReasonCounts.get(m.unmeasuredReason) ?? 0) + 1);
      }
    }
    for (const [reason, n] of unmeasuredReasonCounts) {
      gaps.push({ reason: 'contrast-unmeasured', subject, note: `${n} text element(s): ${reason}` });
    }

    const contrastArtifact: Artifact = {
      kind: 'style-probe',
      subject,
      capturedAt,
      check: 'contrast',
      results: measuredSubjects as unknown as Record<string, unknown>[],
      screenshotPath: shot.artifact.kind === 'screenshot' ? shot.artifact.path : undefined,
    };
    artifacts.push(contrastArtifact);

    // axe's boxes are re-read at rest for the same reason the refs are: axe ran
    // BEFORE the walk, and the walk fires reveals and settles lazy images, so
    // the layout axe saw is not the one the evidence image shows. The box is
    // what crops an unsettled node's screenshot and what signal fusion
    // (enrich/supersede.ts) matches on. Targets are walked hop by hop: joining a
    // shadow path into one selector resolved `<p>` inside `<my-card>` to the
    // FIRST `<p>` on the page, and stamped that element's box on the finding.
    if (axeArtifact.kind === 'axe-result') {
      try {
        type AxeNode = { target?: (string | string[])[]; box?: { x: number; y: number; width: number; height: number } };
        const payload = axeArtifact.results as { violations?: Array<{ nodes?: AxeNode[] }>; incomplete?: Array<{ nodes?: AxeNode[] }> };
        const nodes: AxeNode[] = [];
        for (const list of [payload.violations, payload.incomplete]) {
          for (const rule of list ?? []) for (const n of rule.nodes ?? []) nodes.push(n);
        }
        const paths = nodes.map((n) => {
          const t = n.target;
          if (!t || t.length === 0) return [];
          const nested = t.find((x): x is string[] => Array.isArray(x));
          return nested ?? [(t as string[]).join(' ')];
        });
        const rested = (await page.evaluate((ps: string[][]) => {
          const ck = (window as unknown as { __ck?: { contentBox(e: Element): { x: number; y: number; width: number; height: number } } }).__ck;
          return ps.map((path) => {
            if (!path.length) return null;
            let root: Document | ShadowRoot | null = document;
            let el: Element | null = null;
            for (const sel of path) {
              if (!root) return null;
              try { el = root.querySelector(sel); } catch { return null; }
              if (!el) return null;
              root = el.shadowRoot;
            }
            if (!el) return null;
            if (ck) return ck.contentBox(el);
            const r = el.getBoundingClientRect();
            return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
          });
        }, paths)) as ({ x: number; y: number; width: number; height: number } | null)[];
        for (let i = 0; i < nodes.length; i++) {
          const box = rested[i];
          if (box && box.width > 0 && box.height > 0) nodes[i].box = box;
        }
      } catch {
        /* best-effort — nodes keep the box axe.ts resolved */
      }
    }

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
