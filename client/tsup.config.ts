import { defineConfig } from 'tsup';
// @ts-ignore plain .mjs helper without types
import { buildId } from './scripts/build-id.mjs';

// Changes whenever anything under src/ changes; pins the UI / add-on URLs (?v=) and is published as ComplyKit.build.
const define = { __CK_BUILD__: JSON.stringify(buildId()) };

// Core IIFE + UI IIFE + add-on IIFE + core ESM. The core IIFE is what a site pastes or self-hosts
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
    define,
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
    define,
    minify: true,
    sourcemap: false,
    clean: false,
    dts: false,
  },
  // The add-on (companion) file: source adapters for the site's own banner, loaded
  // by the core in config.mode 'companion'. Own budget (8 KB gz).
  {
    entry: { 'complykit-consent-companion': 'src/companion/entry.ts' },
    format: ['iife'],
    outExtension: () => ({ js: '.js' }),
    target: 'es2018',
    define,
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
    define,
    sourcemap: true,
    clean: false,
    dts: false,
  },
]);
