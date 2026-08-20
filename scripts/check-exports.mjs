#!/usr/bin/env node
/**
 * Diff the VALUE exports of each published .d.ts against the built bundle, both
 * ways. This closes the blind spot test-d.ts has: `import type { X }` compiles
 * whether X is a runtime const or a bare type alias, so a value export declared
 * type-only sails through a type-position test. This asks the TypeScript checker
 * which names each .d.ts exports in VALUE position, imports the built bundle,
 * and diffs. Runs AFTER build — it needs the artifact. See standards/traps.md #9.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// (declaration file, built ESM bundle) pairs — one per subpath export.
const PAIRS = [
  ['types/index.d.ts', 'dist/index.js'],
  ['types/registry.d.ts', 'dist/registry.js'],
  ['types/collect-static.d.ts', 'dist/collect-static.js'],
  ['types/collect-browser.d.ts', 'dist/collect-browser.js'],
  ['types/judge.d.ts', 'dist/judge.js'],
];

/** Names a .d.ts exports in VALUE position (const/function/class/enum). */
function valueExports(dtsRel) {
  const file = path.join(root, dtsRel);
  const program = ts.createProgram([file], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) return new Set();
  const out = new Set();
  for (const sym of checker.getExportsOfModule(moduleSymbol)) {
    // A value export has one of these meanings; a pure type/interface does not.
    const f = sym.flags;
    const isValue =
      f & ts.SymbolFlags.Variable ||
      f & ts.SymbolFlags.Function ||
      f & ts.SymbolFlags.Class ||
      f & ts.SymbolFlags.Enum ||
      f & ts.SymbolFlags.ValueModule;
    // Re-exports (Alias) resolve to their target's meaning.
    if (f & ts.SymbolFlags.Alias) {
      const target = checker.getAliasedSymbol(sym);
      const tf = target.flags;
      if (
        tf & ts.SymbolFlags.Variable ||
        tf & ts.SymbolFlags.Function ||
        tf & ts.SymbolFlags.Class ||
        tf & ts.SymbolFlags.Enum
      ) {
        out.add(sym.name);
      }
      continue;
    }
    if (isValue) out.add(sym.name);
  }
  return out;
}

let failed = false;
for (const [dts, bundle] of PAIRS) {
  const bundlePath = path.join(root, bundle);
  if (!fs.existsSync(bundlePath)) {
    console.error(`missing build artifact: ${bundle} (run npm run build first)`);
    process.exitCode = 1;
    continue;
  }
  const declared = valueExports(dts);
  const mod = await import(pathToFileURL(bundlePath).href);
  const actual = new Set(Object.keys(mod).filter((k) => k !== 'default'));

  const missingInBundle = [...declared].filter((n) => !actual.has(n));
  const missingInDts = [...actual].filter((n) => !declared.has(n));

  if (missingInBundle.length || missingInDts.length) {
    failed = true;
    console.error(`\n${dts} <-> ${bundle}`);
    if (missingInBundle.length)
      console.error(`  declared as a value but NOT exported by the bundle: ${missingInBundle.join(', ')}`);
    if (missingInDts.length)
      console.error(`  exported by the bundle but NOT declared as a value: ${missingInDts.join(', ')}`);
  }
}

if (failed) {
  console.error('\ncheck-exports: value-export contract drifted (see above).');
  process.exit(1);
}
console.log('check-exports: value exports match the declarations.');
