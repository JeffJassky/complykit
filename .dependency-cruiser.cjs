// Dependency law from plans/package-structure.md, enforced mechanically so a
// boundary violation fails CI instead of a review comment. `npm run boundaries`.
//
//   registry  -> (nothing internal)
//   record    -> zod only
//   rules     -> record, registry          (pure; import NO collector)
//   collect/* -> record (+ its own heavy dep); never across static<->browser
//   judge     -> record, registry, SDK
//   report    -> record, registry
//   cli       -> everything; nothing imports cli
//   playwright -> only in collect/browser
//   @anthropic-ai/sdk -> only in judge

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'registry-imports-nothing-internal',
      comment: 'registry/ is pure data — imports nothing else in src (pre-carved for extraction).',
      severity: 'error',
      from: { path: '^src/registry/' },
      to: { path: '^src/', pathNot: '^src/registry/' },
    },
    {
      name: 'record-only-zod',
      comment: 'record/ is the hub; it imports nothing internal (zod is external).',
      severity: 'error',
      from: { path: '^src/record/' },
      to: { path: '^src/', pathNot: '^src/record/' },
    },
    {
      name: 'rules-are-pure',
      comment: 'rules/ import only record + registry — never a collector, never judge/report/cli.',
      severity: 'error',
      from: { path: '^src/rules/' },
      to: { path: '^src/', pathNot: '^src/(record|registry|rules)/' },
    },
    {
      name: 'report-only-record-registry',
      comment: 'report/ renders records; imports only record + registry.',
      severity: 'error',
      from: { path: '^src/report/' },
      to: { path: '^src/', pathNot: '^src/(record|registry|report)/' },
    },
    {
      name: 'collect-only-record',
      comment: 'collectors emit artifacts; they import record only (+ their own heavy dep).',
      severity: 'error',
      from: { path: '^src/collect/' },
      to: { path: '^src/', pathNot: '^src/(record|collect)/' },
    },
    {
      name: 'collect-static-browser-isolated',
      comment: 'no import across collect/static <-> collect/browser.',
      severity: 'error',
      from: { path: '^src/collect/static/' },
      to: { path: '^src/collect/browser/' },
    },
    {
      name: 'collect-browser-static-isolated',
      comment: 'no import across collect/browser <-> collect/static.',
      severity: 'error',
      from: { path: '^src/collect/browser/' },
      to: { path: '^src/collect/static/' },
    },
    {
      name: 'judge-scope',
      comment: 'judge/ imports record + registry (+ the Anthropic SDK).',
      severity: 'error',
      from: { path: '^src/judge/' },
      to: { path: '^src/', pathNot: '^src/(record|registry|judge)/' },
    },
    {
      name: 'nothing-imports-cli',
      comment: 'cli/ is the top of the graph — nothing else may import it.',
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/cli/' },
      to: { path: '^src/cli/' },
    },
    {
      name: 'playwright-only-in-collect-browser',
      comment: 'Playwright exists in exactly one place: collect/browser.',
      severity: 'error',
      from: { pathNot: '^src/collect/browser/' },
      to: { path: 'node_modules/(playwright|playwright-core)/' },
    },
    {
      name: 'anthropic-only-in-judge',
      comment: 'The Anthropic SDK exists in exactly one place: judge.',
      severity: 'error',
      from: { pathNot: '^src/judge/' },
      to: { path: 'node_modules/@anthropic-ai/sdk/' },
    },
    {
      name: 'no-circular',
      comment: 'Circular dependencies break the pipeline-stage model.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      comment: 'An unreferenced module is either dead or unregistered.',
      severity: 'warn',
      from: { orphan: true, pathNot: '(index|test-d)\\.ts$' },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
};
