// report/ — renderers, diff, budget gate, coverage. Imports record + registry
// only (dependency law): the CI diff/report tooling stays Chromium-free.

export * from './vocabulary.js';
export * from './diff.js';
export * from './render.js';
export * from './sarif.js';
export * from './coverage.js';
