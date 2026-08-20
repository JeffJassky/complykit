// collect/static — file discovery, ESLint/a11y-plugin runner (pass 1), and the
// bespoke inventories (pass 2). Emits StaticArtifacts; imports record only
// (+ its own lint deps). This module is the `./collect-static` subpath export.
// It does NOT map engine rules to requirements — that needs the registry, which
// collectors may not import; the normalizer (src/engines.ts) does the mapping.

import type { Artifact } from '../../record/index.js';
import { discover } from './discover.js';
import { detectFramework } from './framework.js';
import { runEslint, staticEngineVersions } from './eslint-runner.js';
import { scanInventories } from './inventories.js';

export { discover, SOURCE_EXTENSIONS } from './discover.js';
export { detectFramework } from './framework.js';
export { staticEngineVersions } from './eslint-runner.js';
export type { Discovered, DiscoverOptions } from './discover.js';
export type { FrameworkInfo } from './framework.js';
export type { InventoryItem } from './inventories.js';

export interface CollectStaticOptions {
  cwd: string;
  property: string;
  capturedAt?: string;
  include?: string[];
  exclude?: string[];
}

export interface StaticCollection {
  artifacts: Artifact[];
  hasAiFeatures: boolean; // derived from repo evidence, feeds the has-ai-features tag
  engineVersions: Record<string, string>;
  fileCount: number;
}

export async function collectStatic(opts: CollectStaticOptions): Promise<StaticCollection> {
  const capturedAt = opts.capturedAt ?? new Date().toISOString();
  const discovered = discover({ cwd: opts.cwd, include: opts.include, exclude: opts.exclude });
  const framework = detectFramework(opts.cwd);

  const lintArtifacts = await runEslint(discovered, framework, {
    cwd: discovered.root,
    property: opts.property,
    capturedAt,
  });
  const inventory = scanInventories(discovered, capturedAt, opts.property);

  const artifacts: Artifact[] = [...lintArtifacts, ...inventory.artifacts];
  return {
    artifacts,
    hasAiFeatures: inventory.hasAiFeatures,
    engineVersions: staticEngineVersions(),
    fileCount: discovered.files.length,
  };
}
