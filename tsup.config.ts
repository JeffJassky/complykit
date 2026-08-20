import { defineConfig } from 'tsup';

// Dual ESM/CJS output. Source is ESM-only, but a host compiled to CommonJS
// can only `require()` — an ESM-only package fails there with ERR_REQUIRE_ESM.
// Shipping both keeps `import { defineConfig } from '@jeffjassky/complykit'`
// and `require('@jeffjassky/complykit')` both working.
//
// One entry per subpath export (package-structure.md dependency law): the root
// is dep-light (record + registry + report), and the heavy collectors sit
// behind their peer deps on their own subpaths. playwright and
// @anthropic-ai/sdk are peers, so tsup externalizes them automatically — a
// consumer without them can still import the root and `./registry`.
//
// `dts` is OFF: the published declarations are the hand-written ones in
// `types/`. `tsc --noEmit` keeps them honest (house-style.md, traps #21).
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    registry: 'src/registry/index.ts',
    'collect-static': 'src/collect/static/index.ts',
    'collect-browser': 'src/collect/browser/index.ts',
    judge: 'src/judge/index.ts',
    cli: 'src/cli/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: false,
  sourcemap: true,
  clean: true,
  target: 'node20',
  outExtension: ({ format }) => ({
    js: format === 'cjs' ? '.cjs' : '.js',
  }),
  splitting: false,
  treeshake: true,
  // The bin is ESM (dist/cli.js). tsup preserves the source shebang.
});
