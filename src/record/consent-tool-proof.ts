import { z } from 'zod';

// complykit's OWN consent tool as the rescan sees it (client-consent epic,
// ticket D10): what the page exposed per scenario, and the run-level proof
// section the rule in src/rules/tracking/consent-tool-proof.ts decides from it.
//
// Two schemas, two owners:
//   ComplykitToolSnapshot — read by the browser collector on every landing,
//                           before any interaction (collect/browser/evaluation/
//                           complykit.ts). Facts only: the global, the config
//                           element's raw JSON (the site's own public markup),
//                           the cookie, the state, the diagnostics the tool
//                           writes about its own install, the gate markers.
//   ConsentToolProof      — the decided section on the evaluation record:
//                           config status, per-vendor control result, findings.
//                           Fail closed throughout: a vendor is 'controlled'
//                           only on an observation in a DENIED state with
//                           nothing fired AND an observation in a granted state
//                           where it ran (so it is still on the site and the
//                           tool is what holds it). Never a pass without both.

// --- what the page exposed ----------------------------------------------------------

/** `window.ComplyKit.diagnostics` as the tool wrote it (client/src/diagnostics.ts); unknown keys are dropped. */
export const ComplykitDiagnostics = z.object({
  gtm: z
    .object({
      dataLayer: z.string().optional(),
      regime: z.string().optional(),
      /** False when anything GTM-shaped ran before the consent defaults. */
      orderOk: z.boolean().optional(),
      containersLoadedBefore: z.array(z.string()).default([]),
      gtmEventBefore: z.boolean().optional(),
      containerScriptsBefore: z.array(z.string()).default([]),
      warnings: z.array(z.string()).default([]),
    })
    .optional(),
  adapters: z
    .object({
      regime: z.string().optional(),
      active: z.array(z.object({ adapter: z.string(), vendors: z.array(z.string()).default([]) })).default([]),
      waiting: z.array(z.string()).default([]),
      notes: z.array(z.unknown()).default([]),
    })
    .optional(),
  location: z.object({ source: z.string(), regime: z.string(), pending: z.boolean().optional(), gpc: z.boolean().optional() }).optional(),
  ui: z.object({ url: z.string().optional(), state: z.enum(['loading', 'loaded', 'failed']), error: z.string().optional() }).optional(),
  shopify: z.unknown().optional(),
  wix: z.unknown().optional(),
});
export type ComplykitDiagnostics = z.infer<typeof ComplykitDiagnostics>;

export const ComplykitToolSnapshot = z.object({
  /** The global, the config element or the cookie was on the page. */
  present: z.boolean(),
  global: z.boolean(),
  version: z.string().optional(),
  /** `<script type="application/json" id="complykit-config">` exists. */
  configElement: z.boolean(),
  /** Its raw text (the site's own public markup), capped; absent when there is no element. */
  configJson: z.string().optional(),
  cookiePresent: z.boolean(),
  /** `ComplyKit.get()` returned a state: the store started (the config was accepted). */
  running: z.boolean(),
  /** The state before any interaction (visitor id and timestamps dropped). */
  state: z
    .object({ status: z.enum(['chosen', 'unset']), regime: z.string(), gpc: z.boolean(), categories: z.record(z.boolean()), configHash: z.string().optional() })
    .optional(),
  diagnostics: ComplykitDiagnostics.optional(),
  /** Gate markers on the page: scripts released (data-ck-released) and still held (text/plain with a category). */
  gate: z.object({ released: z.number().int(), held: z.number().int(), heldCategories: z.array(z.string()).default([]) }),
  /** Our banner (#complykit-ui .ck-banner) was visible. */
  bannerShown: z.boolean(),
  /** The Privacy choices control or a data-complykit-open element was on the page. */
  reopenControl: z.boolean(),
});
export type ComplykitToolSnapshot = z.infer<typeof ComplykitToolSnapshot>;

// --- the decided section -------------------------------------------------------------

export const ConsentToolProofConfigStatus = z.enum([
  'ok', // parsed, the guard accepts it, the tool was seen running on it
  'refused', // the client's guard refuses it (wrong major, malformed): the tool does nothing
  'invalid', // the guard accepts it (the tool runs) but the full schema does not: edited after generation
  'not-json', // the element exists but its text is not JSON
  'missing', // the tool is on the page but no config element was found
]);
export type ConsentToolProofConfigStatus = z.infer<typeof ConsentToolProofConfigStatus>;

export const ConsentToolProofFindingCode = z.enum([
  'config-missing',
  'config-refused',
  'config-invalid',
  'config-edited', // hash does not match the body: edited by hand since generation
  'config-behind', // behind the workspace's latest config (hash differs) or this build's schema (older minor/major)
  'config-other-site', // generatedFrom.site is not the scanned registrable domain
  'tool-after-gtm', // the GTM bridge found a container / gtm.js event / gtm.js script before it ran
  'ui-not-loaded', // the banner file failed to load: no choice can be made, defaults stand
  'gate-rule-unrewritten', // an executable <script> in the served HTML matches a gate[] rule: never rewritten to text/plain
  'necessary-tracker', // a vendor the config lists as necessary behaved like a tracker / has a consent purpose
  'regime-mismatch', // the tool decided a regime that is not the scanned location's rules
  'vendor-not-controlled', // one or more vendors fired where the config denies their category
  'tool-not-running', // config element present, store never started in any scenario
  'gpc-not-honored', // the gpc scenario sent the signal; the running tool's state did not record it
  'vendor-not-in-config', // a tracker the config does not list ran where every non-necessary category was denied
  'gated-document-write', // a script the config gates calls document.write: not gateable asynchronously (released late, the write is ignored or wipes the page)
]);
export type ConsentToolProofFindingCode = z.infer<typeof ConsentToolProofFindingCode>;

export const ConsentToolProofFinding = z.object({
  code: ConsentToolProofFindingCode,
  message: z.string(),
  // JSON-pointer-style references into the evaluation record, where a fact backs it.
  refs: z.array(z.string()).default([]),
  details: z.record(z.unknown()).optional(),
});
export type ConsentToolProofFinding = z.infer<typeof ConsentToolProofFinding>;

/** One scenario visit compared against the deployed config, for one vendor. */
export const VendorControlObservation = z.object({
  location: z.string(),
  scenario: z.string(),
  run: z.number().int().optional(),
  /** Regime the expectation was computed under (the tool's own, or the location's rules when the tool did not say). */
  regime: z.string(),
  /** Whether the config grants the vendor's category in this scenario under that regime. */
  expectedGranted: z.boolean(),
  // fired      — data requests or storage writes in the scenario's phases
  // restricted — only consent-denied / restricted-mode requests, nothing stored
  // loaded     — no data sent, nothing stored, but the vendor's own script /
  //              iframe / pixel loaded (what a gate exists to prevent)
  // held       — nothing recorded in those phases
  observed: z.enum(['fired', 'restricted', 'loaded', 'held']),
  requests: z.number().int(),
  stores: z.number().int(),
  /** Requests that carried no data (the vendor's own script / resources) in those phases. Absent when the record did not count them. */
  loads: z.number().int().optional(),
  /** What the journey did in those phases: distinct pages and steps ('navigate', 'scroll', 'search'). Absent when not recorded. */
  journey: z.object({ pages: z.number().int(), steps: z.array(z.string()) }).optional(),
  /** Withdraw, or a reject that revoked a granted state: requests right after the choice (or page-exit sends) not counted as post-choice activity (see the note). */
  graceRequests: z.number().int().optional(),
  /** Set when the tool decided a weaker regime than the location's rules: the law's regime, and whether IT grants the category here. */
  lawRegime: z.string().optional(),
  expectedGrantedByLaw: z.boolean().optional(),
  note: z.string().optional(),
  ref: z.string().optional(),
  /** True for the phases before the visitor's choice in a choice scenario (compared against the config's default). */
  beforeChoice: z.boolean().optional(),
});
export type VendorControlObservation = z.infer<typeof VendorControlObservation>;

export const VendorControlResult = z.enum(['controlled', 'not-controlled', 'not-observed']);
export type VendorControlResult = z.infer<typeof VendorControlResult>;

export const VendorControlProof = z.object({
  id: z.string(), // vendor id = KB entry id = inventory partyId
  label: z.string(),
  category: z.string(),
  /** What the config says controls it (gate | api | platform | none). */
  control: z.string(),
  result: VendorControlResult,
  reason: z.string(),
  /** True when the vendor was seen in the inventory of this run at all. */
  seen: z.boolean(),
  observations: z.array(VendorControlObservation),
});
export type VendorControlProof = z.infer<typeof VendorControlProof>;

export const ConsentToolProof = z.object({
  /** complykit's tool was on the page in at least one scenario. Everything else is empty when false. */
  detected: z.boolean(),
  version: z.string().optional(),
  /** Scenarios whose landing saw the tool, out of those tested. */
  seenIn: z.array(z.object({ location: z.string(), scenario: z.string(), running: z.boolean(), bannerShown: z.boolean() })),
  config: z.object({
    status: ConsentToolProofConfigStatus,
    /** Header read without validation (readConsentConfigHeader): names what is deployed even when refused. */
    version: z.string().optional(),
    hash: z.string().optional(),
    generatedFrom: z.object({ runId: z.string().optional(), at: z.string().optional(), site: z.string().optional(), complykit: z.string().optional(), kb: z.string().optional() }).optional(),
    /** Against this build's schema version. */
    versionStatus: z.string().optional(),
    /** False when the deployed body does not hash to its `hash` (edited since generation). Absent when not parsed. */
    hashMatches: z.boolean().optional(),
    guard: z.object({ ok: z.boolean(), reason: z.string().optional(), detail: z.string().optional() }).optional(),
    issues: z.array(z.object({ path: z.string(), message: z.string() })).default([]),
    /** The workspace's latest config, when the scan had the workspace. */
    // same: the deployed config is the workspace's latest — equal hash, or equal
    // content apart from generatedFrom (a regeneration that changed nothing; sameContent true).
    workspace: z.object({ hash: z.string().optional(), at: z.string().optional(), runId: z.string().optional(), same: z.boolean(), sameContent: z.boolean().optional() }).optional(),
  }),
  vendors: z.array(VendorControlProof),
  totals: z.object({ controlled: z.number().int(), notControlled: z.number().int(), notObserved: z.number().int() }),
  findings: z.array(ConsentToolProofFinding),
  /** How each scenario was driven when the tool was detected (exact selectors / API), from the choice records. */
  driven: z.array(z.object({ location: z.string(), scenario: z.string(), choice: z.string(), ok: z.boolean(), method: z.string() })),
  /** What the proof could not cover, in plain words. Never implied clean. */
  notTested: z.array(z.string()),
  /** What the vendor comparisons cover: most pages one compared visit reached, locations compared, fewest visits per compared scenario. */
  scope: z.object({ pages: z.number().int().optional(), locations: z.number().int(), runs: z.number().int() }).optional(),
});
export type ConsentToolProof = z.infer<typeof ConsentToolProof>;
