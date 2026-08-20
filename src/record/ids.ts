import { z } from 'zod';

// Branded ids — structurally strings, nominally distinct, so a RequirementId
// cannot be passed where a RuleId is wanted. zod's `.brand()` gives both the
// runtime validator and the compile-time brand from one declaration.

export const RequirementId = z.string().min(1).brand<'RequirementId'>();
export type RequirementId = z.infer<typeof RequirementId>;

export const RuleId = z.string().min(1).brand<'RuleId'>();
export type RuleId = z.infer<typeof RuleId>;

export const Fingerprint = z.string().regex(/^[0-9a-f]{64}$/).brand<'Fingerprint'>();
export type Fingerprint = z.infer<typeof Fingerprint>;

export const RunId = z.string().min(1).brand<'RunId'>();
export type RunId = z.infer<typeof RunId>;

export const InstrumentId = z.string().min(1).brand<'InstrumentId'>();
export type InstrumentId = z.infer<typeof InstrumentId>;

export const IsoDate = z.string().min(1); // ISO 8601; validated shape kept loose on purpose
export type IsoDate = z.infer<typeof IsoDate>;

/** Cast a raw string to a branded id without re-validating (internal use). */
export const asRequirementId = (s: string): RequirementId => s as RequirementId;
export const asRuleId = (s: string): RuleId => s as RuleId;
export const asRunId = (s: string): RunId => s as RunId;
export const asInstrumentId = (s: string): InstrumentId => s as InstrumentId;
