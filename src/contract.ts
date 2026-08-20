// Compile-time drift guard between the zod-inferred internal types and the
// hand-written published contract in types/. This file is type-only — never
// bundled (no entry imports it), only judged by `tsc --noEmit`. It replaces the
// house "src imports its types from types/" mechanism, which a zod-first package
// cannot use (see plans/DIVERGENCES.md #4). If a schema grows or drops a field,
// one of the mutual-assignability checks below stops compiling.

import type * as Public from '../types/index.js';
import type {
  RawFinding,
  Finding,
  Evidence,
  Producer,
  Verdict,
  Subject,
  StructuralLocator,
  Run,
  MatrixCell,
  CoverageGap,
  Disposition,
  Artifact,
} from './record/index.js';
import type {
  Config,
  Property,
  Targets,
  AuthConfig,
  RoutesConfig,
  BudgetConfig,
  ReviewConfig,
} from './config.js';
import type {
  Requirement,
  Instrument,
  Citation,
  EngineRuleMapping,
  VerifiedUrl,
} from './registry/index.js';
import type { RuleMeta, Rule, LlmRule } from './rules/index.js';

type Assignable<A, B> = A extends B ? true : false;
type Mutual<A, B> = Assignable<A, B> extends true
  ? Assignable<B, A> extends true
    ? true
    : false
  : false;
type Expect<T extends true> = T;

// Each line fails to compile if the internal shape and the published shape
// diverge. Names are `_check_X` so an error points straight at the drifted type.
export type _check_RawFinding = Expect<Mutual<RawFinding, Public.RawFinding>>;
export type _check_Finding = Expect<Mutual<Finding, Public.Finding>>;
export type _check_Evidence = Expect<Mutual<Evidence, Public.Evidence>>;
export type _check_Producer = Expect<Mutual<Producer, Public.Producer>>;
export type _check_Verdict = Expect<Mutual<Verdict, Public.Verdict>>;
export type _check_Subject = Expect<Mutual<Subject, Public.Subject>>;
export type _check_StructuralLocator = Expect<Mutual<StructuralLocator, Public.StructuralLocator>>;
export type _check_Run = Expect<Mutual<Run, Public.Run>>;
export type _check_MatrixCell = Expect<Mutual<MatrixCell, Public.MatrixCell>>;
export type _check_CoverageGap = Expect<Mutual<CoverageGap, Public.CoverageGap>>;
export type _check_Disposition = Expect<Mutual<Disposition, Public.Disposition>>;
export type _check_Artifact = Expect<Mutual<Artifact, Public.Artifact>>;

export type _check_Config = Expect<Mutual<Config, Public.Config>>;
export type _check_Property = Expect<Mutual<Property, Public.Property>>;
export type _check_Targets = Expect<Mutual<Targets, Public.Targets>>;
export type _check_AuthConfig = Expect<Mutual<AuthConfig, Public.AuthConfig>>;
export type _check_RoutesConfig = Expect<Mutual<RoutesConfig, Public.RoutesConfig>>;
export type _check_BudgetConfig = Expect<Mutual<BudgetConfig, Public.BudgetConfig>>;
export type _check_ReviewConfig = Expect<Mutual<ReviewConfig, Public.ReviewConfig>>;

export type _check_Requirement = Expect<Mutual<Requirement, Public.Requirement>>;
export type _check_Instrument = Expect<Mutual<Instrument, Public.Instrument>>;
export type _check_Citation = Expect<Mutual<Citation, Public.Citation>>;
export type _check_EngineRuleMapping = Expect<Mutual<EngineRuleMapping, Public.EngineRuleMapping>>;
export type _check_VerifiedUrl = Expect<Mutual<VerifiedUrl, Public.VerifiedUrl>>;

export type _check_RuleMeta = Expect<Mutual<RuleMeta, Public.RuleMeta>>;
export type _check_Rule = Expect<Mutual<Rule, Public.Rule>>;
export type _check_LlmRule = Expect<Mutual<LlmRule, Public.LlmRule>>;
