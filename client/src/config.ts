// The config contract, as the client sees it (ticket D2). One re-export of the
// dependency-free module in the complykit package: the types (import them
// type-only), the version policy, the structural guard and the fail-closed
// category default. The zod schema that fully validates a config lives in
// src/record/consent-config.ts and is NEVER bundled here — the generator
// validated the config before it was pasted; `hash` says whether it changed.
//
// The runtime reader that finds the inline config in the snippet and calls
// `guardConsentToolConfig` is ticket D3's.
export {
  CONSENT_CONFIG_MAJOR,
  CONSENT_CONFIG_VERSION,
  CONSENT_CONFIG_ELEMENT_ID,
  NECESSARY_CATEGORY,
  REGIMES,
  FALLBACK_REGIME,
  CONSENT_MODE_SIGNALS,
  CONSENT_ADAPTER_IDS,
  CONSENT_STRING_KEYS,
  parseConsentConfigVersion,
  consentConfigVersionStatus,
  readConsentConfigHeader,
  guardConsentToolConfig,
  isNecessaryCategory,
  consentCategoryDefault,
} from '../../src/record/consent-config-guard.js';
export type {
  Regime,
  RegimeSource,
  ConsentCategory,
  VendorControl,
  ConsentVendor,
  GateRule,
  ConsentModeSignal,
  GtmConfig,
  ConsentPlatform,
  ConsentTheme,
  ConsentLayout,
  ConsentStringKey,
  ConsentStringTable,
  ConsentStateConfig,
  ConsentRecordEndpoint,
  ConsentToolConfig,
  ConsentConfigHeader,
  ConsentConfigVersionStatus,
  ConsentConfigGuardResult,
} from '../../src/record/consent-config-guard.js';
