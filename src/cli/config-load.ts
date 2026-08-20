import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Config, defineConfig, syntheticConfig, type Config as ConfigT } from '../config.js';

// Config discovery. The zero-config path (a bare --url) needs no file at all.
// A file may be .js / .mjs (default-exports a Config) or .json. TypeScript
// config loading (comply.config.ts) needs a runtime loader (tsx/jiti) and lands
// with the static layer — for now a .ts config is reported, not silently
// ignored.

const CANDIDATES = [
  'complykit.config.js',
  'complykit.config.mjs',
  'complykit.config.json',
  'comply.config.js',
  'comply.config.mjs',
  'comply.config.json',
];

export interface LoadedConfig {
  config: ConfigT;
  source: string; // "synthetic (--url)" or the file path
}

export async function loadConfigFor(
  opts: { url?: string; config?: string } = {},
  cwd = process.cwd(),
): Promise<LoadedConfig> {
  if (opts.url) {
    return { config: syntheticConfig(opts.url), source: 'synthetic (--url)' };
  }

  const explicit = opts.config ? path.resolve(cwd, opts.config) : undefined;
  const found = explicit ?? CANDIDATES.map((c) => path.join(cwd, c)).find((p) => fs.existsSync(p));

  if (!found) {
    throw new Error(
      'no config found and no --url given. Run `complykit init`, or scan a single URL with ' +
        '`complykit scan --url https://example.com`.',
    );
  }
  if (found.endsWith('.ts')) {
    throw new Error(
      `${found} is TypeScript; runtime TS config loading lands with the static layer. ` +
        'For now use a .js/.mjs/.json config or pass --url.',
    );
  }

  if (found.endsWith('.json')) {
    const raw = JSON.parse(fs.readFileSync(found, 'utf8'));
    return { config: defineConfig(raw), source: found };
  }

  const mod = (await import(pathToFileURL(found).href)) as { default?: unknown };
  const value = mod.default ?? mod;
  // The module may export a Config produced by defineConfig, or a plain object.
  return { config: Config.parse(value), source: found };
}
