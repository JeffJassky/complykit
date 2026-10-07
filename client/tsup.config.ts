import { defineConfig } from 'tsup';

// Core IIFE + UI IIFE + core ESM. The core IIFE is what a site pastes or self-hosts
// (global `ComplyKit`); the ESM is for bundler consumers and tests. No runtime
// dependencies, so there is nothing to externalize. The IIFE's gzipped size is
// a hard budget, enforced by scripts/check-size.mjs.
export default defineConfig([
  {
    entry: { 'complykit-consent': 'src/index.ts' },
    format: ['iife'],
    globalName: 'ComplyKit',
    outExtension: () => ({ js: '.js' }),
    target: 'es2018',
    minify: true,
    sourcemap: false,
    clean: true,
    dts: false,
  },
  // The UI file (banner, settings layer, Privacy choices control): loaded by
  // the core from the same folder, async. Own budget (12 KB gz).
  {
    entry: { 'complykit-consent-ui': 'src/ui/entry.ts' },
    format: ['iife'],
    outExtension: () => ({ js: '.js' }),
    target: 'es2018',
    minify: true,
    sourcemap: false,
    clean: false,
    dts: false,
  },
  {
    entry: { 'complykit-consent.esm': 'src/index.ts' },
    format: ['esm'],
    outExtension: () => ({ js: '.js' }),
    target: 'es2018',
    sourcemap: true,
    clean: false,
    dts: false,
  },
]);
