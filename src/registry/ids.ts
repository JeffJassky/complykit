import { z } from 'zod';

// registry/ imports nothing internal (dependency law — it is pre-carved for
// standalone extraction). So it re-declares the branded ids rather than
// importing record's. This is not drift: zod's BRAND symbol is a single symbol
// per zod install, so `.brand<'RequirementId'>()` here and in record/ infer the
// *same* structural type — a RequirementId from a Requirement is assignable to
// the RequirementId a Finding cites, checked by the compiler.

export const RequirementId = z.string().min(1).brand<'RequirementId'>();
export type RequirementId = z.infer<typeof RequirementId>;

export const RuleId = z.string().min(1).brand<'RuleId'>();
export type RuleId = z.infer<typeof RuleId>;

export const InstrumentId = z.string().min(1).brand<'InstrumentId'>();
export type InstrumentId = z.infer<typeof InstrumentId>;

export const IsoDate = z.string().min(1);
export type IsoDate = z.infer<typeof IsoDate>;

export const Severity = z.enum(['critical', 'serious', 'moderate', 'minor']);
export type Severity = z.infer<typeof Severity>;

export const Confidence = z.enum(['violation', 'needs-review']);
export type Confidence = z.infer<typeof Confidence>;

export const asRequirementId = (s: string): RequirementId => s as RequirementId;
export const asRuleId = (s: string): RuleId => s as RuleId;
export const asInstrumentId = (s: string): InstrumentId => s as InstrumentId;
