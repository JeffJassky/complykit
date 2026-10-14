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
export { buildTrackingEvaluation, platformOf, ALWAYS_NOT_TESTED } from './summary.js';
export type { EvaluationInput } from './summary.js';
export { analyzeConsentApi, consentApiCalls, interpretCall, summarizeConsentApi, CONTROL_APIS, CONSENT_API_LABEL } from './consent-api.js';
export { evaluateCompatibility, compatibilityFor, behaviorCellsFrom, consentToolDefaultFinding, consentApiOf, consentTypesFor, regimeOf, verdictRank, purposeScopeOf } from './compatibility.js';
export type { BehaviorCell, CompatibilityInput, CompatibilityEvaluationInput } from './compatibility.js';
export { evaluateConsentToolProof, configBehaviorCells, expectedGrantedFor } from './consent-tool-proof.js';
export type { ConsentToolProofInput } from './consent-tool-proof.js';
export type { ConsentApiCall, ConsentAction, ConsentApiState, ConsentApiStateKind, ConsentApiAnalysis } from './consent-api.js';
export { buildMarkupSection, matchMarkupElement } from './markup.js';
export type { MarkupBuild } from './markup.js';
export { parseGtmContainer, parseContainers, extractContainerData, locateContainerData, rewriteContainerConsent } from './gtm.js';
export type { ContainerConsentRewrite, ContainerConsentRewriteResult } from './gtm.js';
export { classifyImplementations, classifyImplementation, firstPartyCollectEndpoints, scriptIndex, isGtmContainerUrl, otherTagManagerOf, OTHER_TAG_MANAGERS } from './implementation.js';
export type { CollectEndpoint, ImplementationInput, ScriptIndex } from './implementation.js';
export { buildLegalGuide, GUIDE_SCENARIOS } from './legal-guide.js';
export type { LegalGuide } from './legal-guide.js';
