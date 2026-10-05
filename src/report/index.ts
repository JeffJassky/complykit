// report/ — renderers, diff, budget gate, coverage. Imports record + registry
// only (dependency law): the CI diff/report tooling stays Chromium-free.

export * from './vocabulary.js';
export * from './diff.js';
export * from './render.js';
export * from './sarif.js';
export * from './html.js';
export * from './json.js';
export * from './model.js';
export * from './coverage.js';
export * from './dispositions.js';
export * from './consent-model.js';
export * from './consent-html.js';
export * from './consent-md.js';

export type { ResearchWorkflow, ResearchItem } from './research.js';
