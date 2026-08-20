import {
  resolveFinding,
  type Finding,
  type RunId,
  type Artifact,
  type CoverageGap,
  type MatrixCell,
  type AccessLevel,
} from './record/index.js';
import { AXE_VERSION } from './registry/index.js';
import { ALL_RULES, evaluate, resolveCapsFor } from './rules/index.js';
import { normalizeEngineArtifacts } from './engines.js';
import { collectStatic } from './collect/static/index.js';
import type { RouteDiscoveryOptions } from './collect/browser/routes.js';

// The scan pipeline: collect artifacts, normalize engine output, evaluate our
// pure rules, and resolve everything into stored Findings. Kept OUT of the root
// export (it pulls collector deps) and out of cli/ (which is wiring only). The
// browser layer is loaded via dynamic import so a static-only run never requires
// the optional `playwright` peer.

/** Resolve a rule's RawFindings into stored Findings (producer: rule). */
function resolveRuleFindings(
  raws: ReturnType<typeof evaluate>,
  runId: RunId,
  packageVersion: string,
): Finding[] {
  return raws.map((raw) =>
    resolveFinding(raw, {
      caps: resolveCapsFor(raw.ruleId, raw.requirementId),
      runId,
      producer: { type: 'rule', packageVersion },
    }),
  );
}

// --- static layer -----------------------------------------------------------

export interface StaticScanOptions {
  runId: RunId;
  property: string;
  repoDir: string;
  tags?: string[];
  packageVersion: string;
}

export interface StaticScanResult {
  findings: Finding[];
  engineVersions: Record<string, string>;
  hasAiFeatures: boolean;
  fileCount: number;
  unmapped: Array<{ engine: string; engineRule: string; count: number }>;
  accessLevels: AccessLevel[];
}

export async function runStaticScan(opts: StaticScanOptions): Promise<StaticScanResult> {
  const collection = await collectStatic({ cwd: opts.repoDir, property: opts.property });
  const artifacts: Artifact[] = collection.artifacts;
  const tags = [...new Set([...(opts.tags ?? []), ...(collection.hasAiFeatures ? ['has-ai-features'] : [])])];

  const engine = normalizeEngineArtifacts(artifacts, { runId: opts.runId, engineVersions: collection.engineVersions });
  const raws = evaluate(artifacts, ALL_RULES, { property: opts.property, tags });
  const ruleFindings = resolveRuleFindings(raws, opts.runId, opts.packageVersion);

  return {
    findings: [...engine.findings, ...ruleFindings],
    engineVersions: collection.engineVersions,
    hasAiFeatures: collection.hasAiFeatures,
    fileCount: collection.fileCount,
    unmapped: engine.unmapped,
    accessLevels: ['repo'],
  };
}

// --- browser layer (M2 passive) --------------------------------------------

export interface BrowserScanOptions {
  runId: RunId;
  property: string;
  targetUrl: string;
  cwd?: string;
  tags?: string[];
  packageVersion: string;
  viewports?: string[];
  schemes?: Array<'light' | 'dark'>;
  routes?: RouteDiscoveryOptions;
}

export interface BrowserScanResult {
  findings: Finding[];
  gaps: CoverageGap[];
  matrix: MatrixCell[];
  accessLevels: AccessLevel[];
  engineVersions: Record<string, string>;
  unmapped: Array<{ engine: string; engineRule: string; count: number }>;
  spike: { closedShadowHosts: number; piercedClosedShadow: boolean };
  scanned: string[];
}

/**
 * The browser passive pass. Dynamic-imports collect/browser so the `playwright`
 * peer is only required when a browser scan actually runs. A missing peer
 * surfaces as a clear install message, not a module-resolution crash.
 */
export async function runBrowserScan(opts: BrowserScanOptions): Promise<BrowserScanResult> {
  let collectBrowser: typeof import('./collect/browser/index.js').collectBrowser;
  try {
    ({ collectBrowser } = await import('./collect/browser/index.js'));
  } catch {
    throw new Error(
      "the browser layer needs the 'playwright' peer. Install it with `npm i -D playwright` " +
        'and `npx playwright install chromium`, or run `complykit static` for the repo-only pass.',
    );
  }

  const collection = await collectBrowser({
    property: opts.property,
    targetUrl: opts.targetUrl,
    runId: opts.runId,
    cwd: opts.cwd,
    viewports: opts.viewports,
    schemes: opts.schemes,
    routes: opts.routes,
  });

  const engineVersions = { 'axe-core': AXE_VERSION };
  const engine = normalizeEngineArtifacts(collection.artifacts, { runId: opts.runId, engineVersions });
  const raws = evaluate(collection.artifacts, ALL_RULES, { property: opts.property, tags: opts.tags ?? [] });
  const ruleFindings = resolveRuleFindings(raws, opts.runId, opts.packageVersion);

  return {
    findings: [...engine.findings, ...ruleFindings],
    gaps: collection.gaps,
    matrix: collection.matrix,
    accessLevels: collection.accessLevels,
    engineVersions,
    unmapped: engine.unmapped,
    spike: collection.spike,
    scanned: collection.scanned,
  };
}
