// The a11y ESLint plugins ship no type declarations. We only touch `.rules`
// (to enumerate rule ids) and the plugin object itself (to hand ESLint), so an
// ambient `any` module is sufficient — collect/static validates everything it
// reads out of ESLint's result at runtime.
declare module 'eslint-plugin-jsx-a11y';
declare module 'eslint-plugin-vuejs-accessibility';
