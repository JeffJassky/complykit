// Consent & tracking analysis + location rules (plans/consent-design.md §2.6, §3).
// Pure: everything here runs over consent-timeline artifacts.

export * from './rules.js';
export { analyzeTimeline, analyzeArtifacts, parseTimelines, PHASE_LABEL, UNCONSENTED, PRE_INTERACTION } from './analyze.js';
export type { Phase, PartyFacts, PartyRequest, PartyStore, TimelineAnalysis } from './analyze.js';
export { parseFields, classifyFields, findMarkers, markerNeedles, FIELD_LABEL } from './fields.js';
export type { Field, FieldKind, MarkerHit, MarkerSet } from './fields.js';
export { decodeConsent, allDenied, adsRestricted } from './decoders.js';
export type { DecodedConsent, Signal } from './decoders.js';
export { defaultScenarios, quickScenarios, locationPreset, optOutSignalStates, decideVerification } from './plan.js';
export { buildTrackingEvaluation, ALWAYS_NOT_TESTED } from './summary.js';
export type { EvaluationInput } from './summary.js';
