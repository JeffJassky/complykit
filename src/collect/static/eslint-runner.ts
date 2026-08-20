import { createRequire } from 'node:module';
import type { Artifact } from '../../record/index.js';
import type { Discovered } from './discover.js';
import type { FrameworkInfo } from './framework.js';

// Pass 1 (static-analysis-design.md): wrap the lint ecosystems for template a11y
// breadth. ESLint programmatic API with OUR curated flat config — every plugin
// rule enabled at `warn`, the host repo's own config ignored. We don't gate on
// ESLint severity; we read the messages and map them (mappings live in the
// registry, which collectors may not import — the normalizer does that).
//
// Only this file touches ESLint. It emits `static-scan` artifacts whose results
// carry { engine, engineRule, file, line, message } — the normalizer's contract.

const require = createRequire(import.meta.url);

interface StaticScanResultItem {
  engineRule: string;
  file: string;
  line: number;
  column?: number;
  message: string;
  ordinal: number; // nth occurrence of this rule in this file — the fingerprint anchor
}

function pkgVersion(name: string): string {
  try {
    return (require(`${name}/package.json`) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

function allRuleIds(plugin: { rules?: Record<string, unknown> }, prefix: string): Record<string, 'warn'> {
  const out: Record<string, 'warn'> = {};
  for (const name of Object.keys(plugin.rules ?? {})) out[`${prefix}/${name}`] = 'warn';
  return out;
}

export interface EslintRunOptions {
  cwd: string;
  property: string;
  capturedAt: string;
}

export async function runEslint(
  discovered: Discovered,
  framework: FrameworkInfo,
  opts: EslintRunOptions,
): Promise<Artifact[]> {
  // Load ESLint + plugins lazily so a static-free run never pays for them.
  const { ESLint } = (await import('eslint')) as typeof import('eslint');
  const tsParser = await import('@typescript-eslint/parser');
  const jsxA11y = (await import('eslint-plugin-jsx-a11y')).default as { rules?: Record<string, unknown> };
  const vueA11y = (await import('eslint-plugin-vuejs-accessibility')).default as { rules?: Record<string, unknown> };
  const vueParser = await import('vue-eslint-parser');

  const jsxRules = allRuleIds(jsxA11y, 'jsx-a11y');
  const vueRules = allRuleIds(vueA11y, 'vuejs-accessibility');

  // Flat config. `overrideConfigFile: true` ignores any host eslintrc/flat config.
  const overrideConfig: unknown[] = [];
  if (framework.react || discovered.byExt['.jsx'] || discovered.byExt['.tsx']) {
    overrideConfig.push({
      files: ['**/*.{js,jsx,mjs,cjs,ts,tsx}'],
      languageOptions: {
        parser: tsParser,
        parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' },
      },
      plugins: { 'jsx-a11y': jsxA11y },
      rules: jsxRules,
    });
  }
  if (framework.vue || discovered.byExt['.vue']) {
    overrideConfig.push({
      files: ['**/*.vue'],
      languageOptions: {
        parser: vueParser,
        parserOptions: { parser: tsParser, ecmaFeatures: { jsx: false }, sourceType: 'module' },
      },
      plugins: { 'vuejs-accessibility': vueA11y },
      rules: vueRules,
    });
  }
  if (overrideConfig.length === 0) return [];

  const eslint = new ESLint({
    cwd: opts.cwd,
    errorOnUnmatchedPattern: false,
    // eslint's types lag the flat-config option names; the shape is correct.
    overrideConfigFile: true as never,
    overrideConfig: overrideConfig as never,
  });

  const targets = discovered.files.filter((f) => /\.(jsx|tsx|vue)$/.test(f));
  if (targets.length === 0) return [];
  const results = await eslint.lintFiles(targets.map((f) => `${opts.cwd}/${f}`));

  // Group results by engine (a message's ruleId prefix names the plugin).
  const byEngine: Record<string, StaticScanResultItem[]> = {
    'eslint-plugin-jsx-a11y': [],
    'eslint-plugin-vuejs-accessibility': [],
  };
  for (const res of results) {
    const relFile = res.filePath.startsWith(opts.cwd)
      ? res.filePath.slice(opts.cwd.length + 1)
      : res.filePath;
    for (const msg of res.messages) {
      if (!msg.ruleId) continue;
      const [prefix, ...rest] = msg.ruleId.split('/');
      const engine =
        prefix === 'jsx-a11y'
          ? 'eslint-plugin-jsx-a11y'
          : prefix === 'vuejs-accessibility'
            ? 'eslint-plugin-vuejs-accessibility'
            : undefined;
      if (!engine) continue;
      byEngine[engine].push({
        engineRule: rest.join('/'),
        file: relFile,
        line: msg.line ?? 1,
        column: msg.column,
        message: msg.message,
        ordinal: 0, // assigned below, per (file, rule)
      });
    }
  }

  // Assign a stable ordinal per (file, rule): the nth occurrence. This is the
  // fingerprint anchor for static findings — line numbers shift every commit, so
  // they live in evidence only, never in identity (static-analysis-design.md).
  for (const items of Object.values(byEngine)) {
    const counters = new Map<string, number>();
    for (const item of items) {
      const key = `${item.file}::${item.engineRule}`;
      const n = counters.get(key) ?? 0;
      item.ordinal = n;
      counters.set(key, n + 1);
    }
  }

  const artifacts: Artifact[] = [];
  for (const [engine, items] of Object.entries(byEngine)) {
    if (items.length === 0) continue;
    artifacts.push({
      kind: 'static-scan',
      subject: { property: opts.property },
      capturedAt: opts.capturedAt,
      engine,
      results: items as unknown as Record<string, unknown>[],
    });
  }
  // Stamp engine versions on a marker artifact-less path: callers read versions
  // from the collector return via getStaticEngineVersions().
  return artifacts;
}

/** Installed versions of the pass-1 engines, for run.json stamping. */
export function staticEngineVersions(): Record<string, string> {
  return {
    'eslint-plugin-jsx-a11y': pkgVersion('eslint-plugin-jsx-a11y'),
    'eslint-plugin-vuejs-accessibility': pkgVersion('eslint-plugin-vuejs-accessibility'),
    eslint: pkgVersion('eslint'),
  };
}
