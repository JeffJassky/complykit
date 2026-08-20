// Public types for `@jeffjassky/complykit/collect-static` — file discovery,
// the ESLint/a11y-plugin runner (pass 1), and the bespoke inventories (pass 2).
// Emits static Artifacts; imports record only (+ its own lint deps). It does NOT
// map engine rules to requirements — that is the normalizer's job (root export
// `normalizeEngineArtifacts`), because collectors may not import the registry.

import type { Artifact } from './index.js';

export const SOURCE_EXTENSIONS: string[];

export interface DiscoverOptions {
  cwd: string;
  include?: string[];
  exclude?: string[];
}
export interface Discovered {
  root: string;
  files: string[];
  byExt: Record<string, string[]>;
}
export function discover(opts: DiscoverOptions): Discovered;

export interface FrameworkInfo {
  react: boolean;
  vue: boolean;
  deps: Record<string, string>;
}
export function detectFramework(cwd: string): FrameworkInfo;

export interface InventoryItem {
  name: string;
  file: string;
  line: number;
  evidence: string;
  detail?: string;
}

export function staticEngineVersions(): Record<string, string>;

export interface CollectStaticOptions {
  cwd: string;
  property: string;
  capturedAt?: string;
  include?: string[];
  exclude?: string[];
}
export interface StaticCollection {
  artifacts: Artifact[];
  hasAiFeatures: boolean;
  engineVersions: Record<string, string>;
  fileCount: number;
}
export function collectStatic(opts: CollectStaticOptions): Promise<StaticCollection>;
