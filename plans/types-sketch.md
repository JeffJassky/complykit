# compliance — key TypeScript shapes (2026-08-19)

Sketch of the core types in `record/` and `registry/`, consistent with
[registry-design.md](registry-design.md), [package-structure.md](package-structure.md),
and the record model in [README.md](README.md). Zod-first: record shapes are zod
schemas with inferred types, because they cross process boundaries (agents write
via `comply finding add`, runs are read back from disk) and must validate at
runtime. Registry and rule interfaces are compile-time TS — they live in code,
reviewed in PRs.

## Identity primitives

```ts
// Branded ids — structurally strings, nominally distinct.
type RequirementId = string & { readonly __brand: "RequirementId" }; // "wcag22.1.4.3"
type RuleId        = string & { readonly __brand: "RuleId" };        // "consent.click-asymmetry"
type Fingerprint   = string & { readonly __brand: "Fingerprint" };
type RunId         = string & { readonly __brand: "RunId" };
```

## Registry: Requirement + Instrument

```ts
interface Requirement {
  id: RequirementId;
  instrument: InstrumentId;                  // "wcag" | "gdpr" | "eu-ai-act" | "en-301-549" | …
  citation: Citation;                        // structured, per-instrument family
  title: string;
  text: string;                              // normative excerpt
  authority?: AuthorityRef[];                // EDPB guidelines etc.
  urls: VerifiedUrl[];
  effective: { from: IsoDate; until?: IsoDate };
  version?: string;                          // WCAG "2.1" | "2.2"
  appliesIf?: ApplicabilityTag[];            // matched against property tags
  severity: Severity;                        // default guidance; rules may narrow, never raise
  supersedes?: RequirementId;                // append-mostly registry: reinterpretation = new entry
  volatile?: boolean;                        // recheck-each-release flag
}

type Citation =
  | { kind: "article";   article: number; paragraph?: number; point?: string }   // GDPR, AI Act
  | { kind: "sc";        principle: number; guideline: number; sc: number; level: "A" | "AA" | "AAA" } // WCAG
  | { kind: "clause";    clause: string }                                        // EN 301 549 "9.1.4.3"
  | { kind: "section";   title: number; section: string };                       // US code

interface Instrument {
  id: InstrumentId;
  name: string;
  jurisdiction: string[];
  textLicense: string;                       // official-text reproduction terms
  incorporates?: Array<{                     // the cross-law edges
    instrument: InstrumentId;
    filter: RequirementFilter;               // e.g. { version: "2.1", maxLevel: "AA" }
  }>;
}

interface VerifiedUrl { href: string; verified?: IsoDate; botBlocked?: boolean }
type Severity = "critical" | "serious" | "moderate" | "minor";
type ApplicabilityTag = "targets-eu" | "processes-personal-data" | "has-ai-features"
                      | "public-sector" | (string & {});
```

## Registry: Rule

Metadata uniform across layers; the evaluator is pure over artifacts. The
`consumes` tuple types the evaluator's input — the compile-time enforcement of
"rules never touch collectors."

```ts
interface RuleMeta {
  id: RuleId;
  requirements: [RequirementId, ...RequirementId[]];
  layer: "static" | "browser" | "llm";
  confidence: "violation" | "needs-review";  // the max this rule may assert
  detects: "presence" | "absence";           // absence → fingerprint on requirement+subject
  severity?: Severity;                       // narrows the requirement default only
  evidence: EvidenceKind[];                  // kinds evaluate() MUST attach
  remediation: string;
  falsePositives?: string;
}

interface Rule<const K extends readonly ArtifactKind[] = readonly ArtifactKind[]>
  extends RuleMeta {
  consumes: K;
  applies?(ctx: PropertyContext): boolean;   // applicability beyond registry tags
  evaluate(input: ArtifactsOf<K>, ctx: EvalContext): RawFinding[];  // PURE
}

// { "axe-result": AxeResultArtifact[], "dom-snapshot": DomSnapshotArtifact[] } …
type ArtifactsOf<K extends readonly ArtifactKind[]> = {
  [P in K[number]]: Extract<Artifact, { kind: P }>[];
};

// LLM rules: the implementation IS data. judge/ executes these; a single
// built-in rule converts the resulting VerdictArtifacts into findings.
interface LlmRule extends RuleMeta {
  layer: "llm";
  mode: "adjudicate" | "sweep";
  rubric: string;                            // prompt template
  rubricVersion: string;                     // part of the verdict cache key
  schemeSensitive?: boolean;                 // send dark/mobile variants?
  escalation?: "cheap-first" | "strong-only";
}

// External engines map in (axe, jsx-a11y, vue-a11y, equal-access):
interface EngineRuleMapping {
  engine: string;                            // "axe-core"
  engineVersion: string;                     // pinned; unmapped-on-upgrade breaks CI
  engineRule: string;                        // "color-contrast"
  requirements: RequirementId[];
  confidence: "violation" | "needs-review";
}
```

## Subject + fingerprint

The subject is what a finding is *about*; the fingerprint is derived from its
stable parts only.

```ts
interface Subject {
  property: string;
  // exactly one locus:
  routePattern?: string;                     // "/product/:id" — never the instance URL
  file?: { path: string; line?: number };    // static findings (line = evidence, not identity)
  // refinement (browser findings):
  instanceUrl?: string;                      // evidence, not identity
  state?: string;                            // interaction-state id ("nav-open")
  viewport?: ViewportId;
  colorScheme?: "light" | "dark";
  locator?: StructuralLocator;
}

interface StructuralLocator {                // survives restyling; CSS paths don't
  role: string;                              // "button"
  name?: string;                             // accessible name
  landmark?: string;                         // "banner", "main"
  ordinal: number;                           // nth match within landmark
  cssPath?: string;                          // debugging evidence ONLY — never hashed
}

// fingerprint(ruleId | requirementId, subject) → Fingerprint
//   presence: ruleId + property + routePattern|file.path + locator(role,name,landmark,ordinal)
//   absence:  requirementId + property + routePattern?      (README: absence keys on requirement+subject)
// Deliberately excluded: instanceUrl, line numbers, cssPath, viewport/scheme
// (a contrast failure in dark mode is the SAME finding as in light — the
// variants land in evidence).
```

## Finding + Evidence + Verdict

```ts
interface RawFinding {                       // what evaluate() returns
  ruleId: RuleId;
  requirementId: RequirementId;              // must be one of the rule's requirements
  subject: Subject;
  confidence: "violation" | "needs-review";  // ≤ rule's declared max
  message: string;                           // one sentence, human-first
  details?: unknown;                         // unconstrained blob (README: thin schema)
  evidence: Evidence[];
}

interface Finding extends RawFinding {       // after normalization (run-store owns this)
  fingerprint: Fingerprint;
  severity: Severity;                        // resolved: rule narrow ?? requirement default
  producer: Producer;
  runId: RunId;
}

type Producer =
  | { type: "engine"; name: string; version: string }               // axe said
  | { type: "rule";   packageVersion: string }                      // our evaluator said
  | { type: "agent";  model: string; rubricVersion: string };       // Claude said

type Evidence =
  | { kind: "screenshot";  path: string; region?: Box; pageState?: string }
  | { kind: "dom-snippet"; html: string; locator?: StructuralLocator }
  | { kind: "computed-style"; properties: Record<string, string> }
  | { kind: "network-request"; url: string; initiatorChain: string[];
      phase?: ConsentPhase; resourceType?: string }
  | { kind: "cookie"; name: string; domain: string; phase: ConsentPhase;
      flags: { secure: boolean; httpOnly: boolean; sameSite?: string };
      classification?: CookieClass }
  | { kind: "file"; path: string; line: number; snippet: string }
  | { kind: "interaction-log"; steps: InteractionStep[] }
  | { kind: "verdict"; model: string; rubricVersion: string;
      cropPath: string; verdict: VerdictValue; reason: string };

type ConsentPhase = "pre-consent" | "post-reject" | "post-accept";
type EvidenceKind = Evidence["kind"];

interface Verdict {                          // C1 structured output (zod-enforced at the API)
  verdict: VerdictValue;                     // "violation" | "pass" | "unclear"
  requirementId: RequirementId;              // constrained to the rule under test
  reason: string;
  leads?: Array<{ mark: number; suspicion: string }>;  // sweep only → adjudication queue
}
```

## Artifacts (collect/ → rules/ contract)

```ts
interface ArtifactBase {
  kind: ArtifactKind;
  subject: Subject;                          // page-state or file scope it was captured at
  capturedAt: IsoDate;
  payloadPath?: string;                      // heavy payloads live in evidence/, not memory
}

type Artifact =
  | (ArtifactBase & { kind: "dom-snapshot";  nodes: SnapshotNode[] })
  | (ArtifactBase & { kind: "axe-result";    results: AxeResults })
  | (ArtifactBase & { kind: "static-scan";   engine: string; results: EngineResult[] })
  | (ArtifactBase & { kind: "inventory";     category: "tracker" | "ai-framework" | "pii";
                                             items: InventoryItem[] })
  | (ArtifactBase & { kind: "cookie-capture"; phase: ConsentPhase; cookies: CookieRecord[];
                                             storage: StorageRecord[] })
  | (ArtifactBase & { kind: "network-log";   phase: ConsentPhase; requests: RequestRecord[] })
  | (ArtifactBase & { kind: "consent-flow";  cmp?: string; clicksToAccept: number;
                                             clicksToReject: number | null;
                                             buttonMetrics: ButtonMetric[] })
  | (ArtifactBase & { kind: "focus-walk";    stops: FocusStop[]; traps: TrapRecord[] })
  | (ArtifactBase & { kind: "screenshot";    path: string; viewport: ViewportId;
                                             scheme: "light" | "dark"; pageState?: string })
  | (ArtifactBase & { kind: "verdict";       ruleId: RuleId; cropHash: string;
                                             result: Verdict; model: string });
```

## Run + coverage + disposition

```ts
interface Run {
  id: RunId;
  property: string;
  startedAt: IsoDate; finishedAt?: IsoDate;
  versions: {
    package: string;
    registry: string;                        // stamped — findings mean what this version meant
    engines: Record<string, string>;         // axe, eslint plugins…
    models?: Record<string, string>;         // C1 model ids
  };
  gitSha?: string;
  accessLevels: Array<"public" | "authed" | "repo" | "infra">;   // exercised, not configured
  matrix: MatrixCell[];                      // what actually ran, per check family
  gaps: CoverageGap[];                       // explicit, never silent
  rulesExecuted: RuleId[];                   // feeds actual (not theoretical) coverage
}

interface MatrixCell {
  family: "passive" | "probes" | "evidence" | "sweep";
  routePatterns: number; instances: number;
  viewports: ViewportId[]; schemes: Array<"light" | "dark">; states: number;
}

interface CoverageGap {
  reason: "cross-origin-iframe" | "closed-shadow-root" | "page-timeout"
        | "bot-blocked" | "scroll-cap" | "no-key" | "crash";
  subject: Subject;
  note?: string;
}

interface Disposition {                      // comply.dispositions.yaml entries
  fingerprint: Fingerprint;
  status: "open" | "fixed" | "accepted-risk" | "false-positive" | "wont-fix";
  by: string; at: IsoDate; why: string;
}
```

## Design notes

- **Zod-first for record shapes**: `const Finding = z.object({...})`,
  `type Finding = z.infer<typeof Finding>` — one source of truth, runtime
  validation exactly at the boundaries (`finding add`, run-store reads,
  C1 structured output). Rule/Requirement interfaces stay compile-time.
- **Discriminated unions everywhere** (`Evidence.kind`, `Artifact.kind`,
  `Producer.type`, `Citation.kind`) — exhaustiveness-checked switches in
  renderers; adding a kind breaks compilation where handling is missing.
- **`details` is deliberately `unknown`** — README's thin-schema decision.
  Structure that matters gets promoted to Evidence kinds; everything else
  rides the blob without schema churn.
- **Fingerprint inputs are a closed list** — what's excluded (instance URLs,
  line numbers, CSS paths, viewport/scheme) is as load-bearing as what's
  included. Variants of one defect converge on one finding; evidence carries
  the variants.
- **`confidence` on the finding is capped by the rule's declared max** and
  `severity` resolves as rule-narrowing-requirement — both checked in
  `registry/verify.ts` + the `finding add` validator, so no producer
  (including an agent) can inflate its own authority.
- **`ArtifactsOf<K>`** makes "rules never touch collectors" a compile error,
  not a review comment — an evaluator asking for a Playwright page has no
  type to ask through.
```
