import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ConsentToolRecord } from './consent-tool.js';
import { ComplykitToolSnapshot, ConsentToolProof } from './consent-tool-proof.js';
import type { Artifact } from './artifact.js';
import { MarkupDataUrl, MarkupPage, redactMarkupPages } from './markup.js';

// Consent & tracking evaluation records (plans/consent-design.md §2.4, §3).
//
// Two layers:
//   1. The TIMELINE — what one browser did in one scenario from one location:
//      an ordered event log (t = ms since the scenario began) plus an end-of-
//      visit snapshot. Collectors emit it inside a `consent-timeline` artifact
//      (whose inner shape is Loose in artifact.ts, like every other artifact);
//      rules parse it with these schemas. In memory it carries raw values —
//      analysis needs them to recognise an ID sent in a request as the value of
//      a cookie. Anything persisted goes through `redactTimeline` first.
//   2. The EVALUATION — the run-level summary a report renders: locations and
//      their verification, the scenario grid, the party inventory, and every
//      not-tested item. Persisted as `<run>/tracking.json`.
//
// Nothing here says "compliant". The strongest statement is "no finding
// observed" for what was actually tested.

export const TRACKING_SCHEMA_VERSION = 1;

// --- Scenarios ----------------------------------------------------------------

export const ScenarioId = z.enum([
  'do-nothing', // load, wait, never touch the banner
  'browse', // full journey, never touch the banner
  'dismiss', // close the banner without choosing, then browse
  'reject', // reject all, reload, browse
  'accept', // accept all, browse
  'partial', // accept one category (analytics) only, browse
  'withdraw', // accept, browse, withdraw via the site's settings, reload, browse
  'gpc', // Global Privacy Control from the first request; banner untouched
  'opt-out-all', // GPC + reject + the site's opt-out link, then browse
  'opt-out-link', // find and walk the opt-out link; never submit
  'return-visit', // reject, then come back: remembered? re-prompted? trackers?
  'markers', // fake ad-click IDs in the URL + typed (unsubmitted) marker input
]);
export type ScenarioId = z.infer<typeof ScenarioId>;

// --- Locations ----------------------------------------------------------------

export const ProxySpec = z.object({
  server: z.string().min(1), // 'socks5://127.0.0.1:1080', 'http://gluetun-de:8888'
  username: z.string().optional(),
  password: z.string().optional(),
  bypass: z.string().optional(),
});
export type ProxySpec = z.infer<typeof ProxySpec>;

export const LocationSpec = z.object({
  id: z.string().min(1), // 'local', 'de', 'us-ca'
  label: z.string().optional(), // 'Germany (Frankfurt)'
  // Expected place. Omitted for 'local': whatever verifies is what it is.
  country: z.string().length(2).optional(),
  region: z.string().optional(), // 'CA'
  proxy: ProxySpec.optional(),
  timezone: z.string().optional(), // 'Europe/Berlin'
  locale: z.string().optional(), // 'de-DE'
  scenarios: z.array(ScenarioId).optional(), // default set derived from jurisdiction
});
export type LocationSpec = z.infer<typeof LocationSpec>;

export const GeoSourceResult = z.object({
  name: z.string(),
  ip: z.string().optional(),
  country: z.string().optional(),
  region: z.string().optional(),
  city: z.string().optional(),
  org: z.string().optional(),
  error: z.string().optional(),
});
export type GeoSourceResult = z.infer<typeof GeoSourceResult>;

export const LocationVerification = z.object({
  verdict: z.enum(['verified', 'mismatch', 'unknown']),
  expected: z.object({ country: z.string().optional(), region: z.string().optional() }),
  observed: z.object({
    ip: z.string().optional(),
    country: z.string().optional(),
    region: z.string().optional(),
    city: z.string().optional(),
  }),
  sources: z.array(GeoSourceResult),
  // What the site / its consent tool said the visitor's region was, when readable.
  siteReported: z.array(z.object({ source: z.string(), value: z.string() })).default([]),
  // Jurisdiction codes the VERIFIED place falls in ([] unless verified).
  jurisdictions: z.array(z.string()).default([]),
  // True when country is verified but the expected region could not be (state
  // geolocation is reliable only for exits well inside a state).
  regionUnverified: z.boolean().optional(),
  checkedAt: z.string(),
  note: z.string().optional(),
});
export type LocationVerification = z.infer<typeof LocationVerification>;

// --- Timeline events ------------------------------------------------------------

export const Initiator = z.object({
  // 'parser' (markup), 'script' (a JS call stack), 'preload', 'other', …
  type: z.string(),
  // Script/document URLs, nearest first: the call stack, then the chain of
  // scripts that inserted those scripts (from the attribution shim).
  chain: z.array(z.string()).default([]),
  // The element that caused it, when the shim saw it inserted ('img', 'script', 'iframe').
  element: z.string().optional(),
});
export type Initiator = z.infer<typeof Initiator>;

export const SetCookie = z.object({
  name: z.string(),
  domain: z.string().optional(),
  maxAgeSec: z.number().optional(),
  expires: z.string().optional(),
  sameSite: z.string().optional(),
});

export const RequestEvent = z.object({
  type: z.literal('request'),
  t: z.number(),
  id: z.string(),
  url: z.string(),
  method: z.string(),
  resourceType: z.string(),
  // Where in the browser it came from. 'exit-beacon' = sent while the page was
  // closing (recovered by the shim; the browser's own events miss these).
  origin: z.enum(['page', 'frame', 'worker', 'service-worker', 'exit-beacon']),
  frameUrl: z.string().optional(),
  sandboxedFrame: z.boolean().optional(),
  pageUrl: z.string(), // top document at the time
  pageIndex: z.number().int(), // nth page of the journey (0 = landing)
  initiator: Initiator,
  // The id of the request this one is a redirect hop of (a 3xx response led
  // here). Absent on records from older builds and on first requests.
  redirectedFrom: z.string().optional(),
  postData: z.string().optional(), // truncated
  status: z.number().optional(),
  failure: z.string().optional(),
  setCookies: z.array(SetCookie).default([]),
  responseHeaders: z.record(z.string()).optional(), // selected (server-timing, content-type)
});
export type RequestEvent = z.infer<typeof RequestEvent>;

export const WebSocketEvent = z.object({
  type: z.literal('websocket'),
  t: z.number(),
  url: z.string(),
  direction: z.enum(['open', 'sent']),
  payload: z.string().optional(), // truncated
  pageIndex: z.number().int(),
});
export type WebSocketEvent = z.infer<typeof WebSocketEvent>;

export const CookieWriteEvent = z.object({
  type: z.literal('cookie-write'),
  t: z.number(),
  name: z.string(),
  value: z.string(),
  attributes: z.string().optional(),
  frameUrl: z.string(),
  chain: z.array(z.string()).default([]),
  pageIndex: z.number().int(),
});
export type CookieWriteEvent = z.infer<typeof CookieWriteEvent>;

export const StorageWriteEvent = z.object({
  type: z.literal('storage-write'),
  t: z.number(),
  area: z.enum(['local', 'session']),
  key: z.string(),
  value: z.string(),
  frameUrl: z.string(),
  chain: z.array(z.string()).default([]),
  pageIndex: z.number().int(),
});
export type StorageWriteEvent = z.infer<typeof StorageWriteEvent>;

export const ActionEvent = z.object({
  type: z.literal('action'),
  t: z.number(),
  action: z.enum(['navigate', 'click', 'scroll', 'type', 'key', 'wait', 'reload', 'eval']),
  detail: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(), // page title after a navigation
  pageIndex: z.number().int(),
});
export type ActionEvent = z.infer<typeof ActionEvent>;

export const BannerEvent = z.object({
  type: z.literal('banner'),
  t: z.number(),
  state: z.enum(['shown', 'not-found', 'gone', 'reappeared']),
  cmp: z.string().optional(),
  via: z.string().optional(), // 'autoconsent' | 'known-selector' | 'heuristic'
  pageIndex: z.number().int(),
});
export type BannerEvent = z.infer<typeof BannerEvent>;

export const ChoiceEvent = z.object({
  type: z.literal('choice'),
  t: z.number(),
  choice: z.enum(['accept', 'reject', 'dismiss', 'partial', 'withdraw', 'opt-out-link']),
  ok: z.boolean(), // the click happened AND (where readable) the stored choice reflects it
  method: z.string(), // 'autoconsent:<cmp>' | 'selector' | 'heuristic' | 'escape' | 'api:<name>'
  clicks: z.number().int().optional(),
  note: z.string().optional(),
  pageIndex: z.number().int(),
});
export type ChoiceEvent = z.infer<typeof ChoiceEvent>;

export const ConsentReadoutEvent = z.object({
  type: z.literal('consent-readout'),
  t: z.number(),
  label: z.string(), // 'after-load' | 'after-choice' | 'end'
  data: z.record(z.unknown()),
  pageIndex: z.number().int(),
});
export type ConsentReadoutEvent = z.infer<typeof ConsentReadoutEvent>;

export const ScreenshotEvent = z.object({
  type: z.literal('screenshot'),
  t: z.number(),
  label: z.string(),
  path: z.string(), // run-relative evidence path
  pageIndex: z.number().int(),
});
export type ScreenshotEvent = z.infer<typeof ScreenshotEvent>;

export const OptOutWalkEvent = z.object({
  type: z.literal('opt-out-walk'),
  t: z.number(),
  found: z.boolean(),
  linkText: z.string().optional(),
  href: z.string().optional(),
  hasIcon: z.boolean().optional(),
  steps: z.number().int().optional(),
  requiredFields: z.array(z.string()).default([]),
  confirmation: z.string().optional(), // text that confirms an opt-out, if shown
  landedUrl: z.string().optional(),
  performed: z.boolean().optional(), // the scan used the opt-out control (never a form asking for personal data)
  pageIndex: z.number().int(),
});
export type OptOutWalkEvent = z.infer<typeof OptOutWalkEvent>;

export const NoteEvent = z.object({
  type: z.literal('note'),
  t: z.number(),
  text: z.string(),
  pageIndex: z.number().int(),
});
export type NoteEvent = z.infer<typeof NoteEvent>;

// A call into a vendor's consent / tag API, recorded in the page by the shim
// (plans/client-consent-design.md §3, "consent-API misuse"). Arguments are
// redacted IN THE PAGE to their shape: command words in the first two positions,
// consent values (granted/denied, booleans, region codes) and dataLayer event
// names survive; every other value becomes '<string>' / '<number>' / ….
// kind 'ready' = the vendor's library took over its global (the real library
// replaced the stub, or GTM replaced dataLayer.push) — the "loaded" moment.
export const ConsentApiName = z.enum(['google', 'meta', 'tiktok', 'clarity', 'microsoft-uet', 'tcf', 'gpp', 'shopify']);
export type ConsentApiName = z.infer<typeof ConsentApiName>;

export const ConsentApiEvent = z.object({
  type: z.literal('consent-api'),
  t: z.number(),
  api: ConsentApiName,
  kind: z.enum(['call', 'ready']),
  call: z.string(), // 'gtag' | 'dataLayer.push' | 'fbq' | 'ttq.grantConsent' | 'uetq.push' | 'Shopify.customerPrivacy.setTrackingConsent' | …
  args: z.array(z.unknown()).default([]),
  frameUrl: z.string(),
  top: z.boolean(),
  chain: z.array(z.string()).default([]),
  pageIndex: z.number().int(),
});
export type ConsentApiEvent = z.infer<typeof ConsentApiEvent>;

export const TimelineEvent = z.discriminatedUnion('type', [
  RequestEvent,
  WebSocketEvent,
  CookieWriteEvent,
  StorageWriteEvent,
  ActionEvent,
  BannerEvent,
  ChoiceEvent,
  ConsentReadoutEvent,
  ScreenshotEvent,
  OptOutWalkEvent,
  NoteEvent,
  ConsentApiEvent,
]);
export type TimelineEvent = z.infer<typeof TimelineEvent>;

// --- End-of-visit snapshot -------------------------------------------------------

export const CookieSnapshot = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  path: z.string().optional(),
  expires: z.number(), // epoch seconds; -1 = session
  httpOnly: z.boolean(),
  secure: z.boolean(),
  sameSite: z.string().optional(),
});
export type CookieSnapshot = z.infer<typeof CookieSnapshot>;

export const StorageSnapshot = z.object({
  origin: z.string(),
  area: z.enum(['local', 'session', 'indexeddb']),
  key: z.string(),
  value: z.string().optional(),
});
export type StorageSnapshot = z.infer<typeof StorageSnapshot>;

// Raw platform evidence read from the page (collector output; the registry's
// classifyPlatform decides). Names of probed globals and asset URLs, never values.
export const PlatformSignals = z.object({
  globals: z.array(z.string()),
  generator: z.string().optional(),
  assetUrls: z.array(z.string()),
  templateVersion: z.string().optional(),
});
export type PlatformSignals = z.infer<typeof PlatformSignals>;

// The decided platform: which one built the page and which consent plugin it runs.
export const PlatformFingerprint = z.object({
  name: z.enum(['shopify', 'wix', 'squarespace', 'wordpress']),
  version: z.string().optional(),
  consentPlugin: z.string().optional(),
  wpConsentApi: z.boolean().optional(),
  evidence: z.array(z.string()).default([]),
});
export type PlatformFingerprint = z.infer<typeof PlatformFingerprint>;

export const TimelineSnapshot = z.object({
  site: z.object({ url: z.string(), host: z.string(), registrableDomain: z.string() }),
  scenario: ScenarioId,
  locationId: z.string(),
  startedAt: z.string(),
  durationMs: z.number(),
  gpc: z.boolean(),
  // Repeat visits (A7): 1 = the normal run; 2+ = a pass under network + CPU throttling.
  run: z.number().int().optional(),
  throttled: z.boolean().optional(),
  browser: z.object({ name: z.string(), version: z.string().optional() }),
  pages: z.array(z.object({ url: z.string(), title: z.string().optional() })),
  cookies: z.array(CookieSnapshot),
  storage: z.array(StorageSnapshot),
  frames: z.array(z.object({ url: z.string(), sandboxed: z.boolean().optional() })),
  platformSignals: PlatformSignals.optional(),
  // Static markup inspection (A1): the served HTML of each visited page, parsed.
  // Absent = not run (an older collector), never "nothing found".
  markup: z.array(MarkupPage).optional(),
  dns: z.array(z.object({ host: z.string(), cname: z.array(z.string()) })).default([]),
  markers: z
    .object({
      email: z.string(),
      text: z.string(),
      clickIds: z.record(z.string()),
    })
    .optional(),
  // Things this scenario could not observe or do, stated, never silently clean.
  notTested: z.array(z.string()).default([]),
  // Where the visit's time went: one row per step path ("land", "browse.page.navigate"),
  // repeats aggregated; slowest first. Absent = an older collector.
  steps: z
    .array(z.object({ step: z.string(), count: z.number().int(), ms: z.number(), maxMs: z.number(), open: z.boolean().optional() }))
    .optional(),
  evidence: z
    .object({
      har: z.string().optional(),
      timeline: z.string().optional(),
    })
    .default({}),
});
export type TimelineSnapshot = z.infer<typeof TimelineSnapshot>;

export const Timeline = z.object({
  location: LocationSpec,
  verification: LocationVerification,
  events: z.array(TimelineEvent),
  snapshot: TimelineSnapshot,
});
export type Timeline = z.infer<typeof Timeline>;

// --- Evaluation (persisted, rendered) --------------------------------------------

export const PartySource = z.enum([
  'markup', // a tag in the site's own HTML
  'markup-leak', // an <img>/<iframe>/preload/<noscript> in markup — leaks even with script gating
  'injected', // added at runtime by another script (tag manager, app, plugin)
  'platform', // a platform sandbox, worker or service worker (e.g. web-pixel sandboxes)
  'first-party-proxy', // a first-party subdomain whose DNS points at a tracker
  'unknown',
]);
export type PartySource = z.infer<typeof PartySource>;

// How the party got onto the page — one of the seven implementations
// (plans/client-consent-design.md §3), decided by src/rules/tracking/implementation.ts
// with the precedence documented there. 'unknown' = no evidence decided it (fail closed).
export const ImplementationClass = z.enum([
  'direct-script', // #1 a <script> in the site's HTML (or the site's own code)
  'markup-leak', // #2 <img>/<iframe>/preload/<noscript> in the HTML — fetched before any script runs
  'gtm', // #3 Google Tag Manager
  'other-tag-manager', // #4 Tealium, Adobe Launch, Segment, Ensighten
  'platform', // #5 injected by Shopify / Wix / Squarespace / a WordPress plugin
  'cname', // #6 a first-party subdomain whose DNS points at the tracker
  'server-side-suspected', // #7 a first-party collect endpoint — forwarding possible, unverifiable
  'unknown',
]);
export type ImplementationClass = z.infer<typeof ImplementationClass>;

export const ImplementationEvidence = z.object({
  class: ImplementationClass, // the class this piece of evidence supports
  // markup        — a tag in the served HTML (A1 finding)
  // container-tag — a tag in a parsed GTM container mapped to this party (A2), or
  //                 a Google tag (gtag.js) destination / setting on its load chain
  // source        — the scan saw the party's first request come from there (PartySource)
  // loader        — a script in its load chain (loadedBy)
  // cname         — a first-party host CNAME'd to the party
  // endpoint      — a first-party collect endpoint or server-container URL
  // none          — why nothing decided it
  kind: z.enum(['markup', 'container-tag', 'source', 'loader', 'cname', 'endpoint', 'none']),
  // true = the scan saw the tracker load this way; false = static presence or inference.
  observed: z.boolean(),
  note: z.string(),
  page: z.string().optional(),
  line: z.number().int().optional(),
  verdict: z.string().optional(), // markup verdict
  containerId: z.string().optional(),
  tagId: z.number().int().optional(),
  url: z.string().optional(), // loader URL, or endpoint sample (host + path, query keys only)
  host: z.string().optional(), // CNAME'd host
  target: z.string().optional(), // CNAME target
});
export type ImplementationEvidence = z.infer<typeof ImplementationEvidence>;

export const PartyImplementation = z.object({
  class: ImplementationClass,
  evidence: z.array(ImplementationEvidence), // deciding evidence first
  alsoSeen: z.array(ImplementationClass).default([]), // other classes with evidence, in precedence order
});
export type PartyImplementation = z.infer<typeof PartyImplementation>;

export const PartyInventoryItem = z.object({
  partyId: z.string(), // KB entry id, or 'unknown:<registrable domain>'
  label: z.string(),
  owner: z.string().optional(),
  domain: z.string(), // registrable domain
  hosts: z.array(z.string()),
  recognized: z.boolean(),
  kbStatus: z.enum(['confirmed', 'proposed', 'unrecognized']),
  categories: z.array(z.string()),
  behavesLikeTracker: z.boolean(),
  trackerSignals: z.array(z.string()),
  sends: z.array(z.string()), // field kinds observed
  stores: z.array(z.object({ name: z.string(), kind: z.string(), lifetimeDays: z.number().nullable() })),
  sources: z.array(PartySource),
  loadedBy: z.array(z.string()), // injector script URLs (nearest first), deduped
  // Which of the seven implementations (§3); absent on records from older builds.
  implementation: PartyImplementation.optional(),
  consentApi: z.string().optional(),
  // A few request URLs (host + path, query KEYS only — values are data) so an
  // unrecognized party can be researched from the record alone.
  samples: z.array(z.string()).default([]),
  seenIn: z.array(
    z.object({
      location: z.string(),
      scenario: ScenarioId,
      requests: z.number().int(),
      firstMs: z.number(),
      phases: z.array(z.string()),
    }),
  ),
});
export type PartyInventoryItem = z.infer<typeof PartyInventoryItem>;

// Why a visit was skipped or its choice not completed, as a code the report sorts into "not
// applicable" (nothing to test), "couldn't test" (the scan's limit) or "blocked" (the site stopped
// the visitor — a problem). Absent on reports written before it: the report falls back to the reason.
export const SkipCause = z.enum([
  'no-banner', // no banner was shown, so there was no choice to make
  'no-close', // the banner has no way to close it without choosing
  'settings-dead', // a visible settings control opened nothing
  'no-category-choice', // the settings offer no per-category choice
  'no-withdraw-entry', // no way to reopen the consent settings after a choice
  'no-opt-out-link', // no opt-out link was found
  'opt-out-asks-personal-data', // the opt-out asks for personal data the scan does not submit
  'choice-failed', // the scan could not make or confirm the choice
  'timeout',
  'crashed',
  'bot-blocked',
]);
export type SkipCause = z.infer<typeof SkipCause>;

export const ScenarioSummary = z.object({
  scenario: ScenarioId,
  status: z.enum(['tested', 'not-tested', 'not-applicable']),
  reason: z.string().optional(),
  cause: SkipCause.optional(),
  durationMs: z.number().optional(),
  banner: z.object({ found: z.boolean(), cmp: z.string().optional(), shownAtMs: z.number().optional() }).optional(),
  // The consent tool and its stored default on this scenario's fresh profile, read before any interaction.
  consentTool: ConsentToolRecord.optional(),
  // complykit's own tool as this scenario's landing exposed it (D10); absent = not on the page or not read.
  complykit: ComplykitToolSnapshot.optional(),
  choice: z.object({ kind: z.string(), ok: z.boolean(), method: z.string() }).optional(),
  // The opt-out link walk on this scenario's visit, when one ran: why an opt-out was or was not completed.
  optOutWalk: z
    .object({ found: z.boolean(), linkText: z.string().optional(), requiredFields: z.array(z.string()).default([]), performed: z.boolean().optional() })
    .optional(),
  // Visits that completed for this scenario (1 = a single run; 2 = plus the throttled pass).
  runs: z.number().int().optional(),
  counts: z
    .object({ requests: z.number().int(), thirdPartyRequests: z.number().int(), parties: z.number().int(), cookies: z.number().int() })
    .optional(),
  evidence: z
    .object({ har: z.string().optional(), timeline: z.string().optional(), screenshots: z.array(z.string()).default([]) })
    .default({ screenshots: [] }),
});
export type ScenarioSummary = z.infer<typeof ScenarioSummary>;

export const LocationSummary = z.object({
  spec: LocationSpec.omit({ proxy: true }).extend({ proxied: z.boolean() }),
  verification: LocationVerification,
  scenarios: z.array(ScenarioSummary),
});
export type LocationSummary = z.infer<typeof LocationSummary>;

export const NotTestedItem = z.object({
  scope: z.enum(['location', 'scenario', 'page', 'flow', 'frame', 'signal']),
  id: z.string(),
  location: z.string().optional(),
  reason: z.string(),
});
export type NotTestedItem = z.infer<typeof NotTestedItem>;

// Redacted, scenario-specific facts for the report matrix. Counts never include values.
const BehaviorObservation = z.object({
  location: z.string(), scenario: ScenarioId, run: z.number().int().optional(), throttled: z.boolean().optional(), pages: z.number().int().optional(), durationMs: z.number(),knownPartyIds:z.array(z.string()),
  // What the journey did in each phase (D10 follow-up, journey parity): the
  // pages it was on (pageIndex values) and the steps it took ('navigate',
  // 'scroll', 'search'). Absent on records from older builds.
  journey: z.record(z.object({ pageIndexes: z.array(z.number().int()), steps: z.array(z.string()) })).optional(),
  parties: z.array(z.object({
    // Phase keys are the analysis phases, plus 'withdraw-grace': requests sent
    // on the withdraw page that are not post-withdraw activity (≤ 1 s after the
    // withdraw step, or page-exit sends once the reload started, before the next
    // page commits), and 'reject-grace': the same 1 s for a reject that revoked a
    // granted state, for a vendor active before it (#57). Every phase list a rule
    // sums leaves them out.
    partyId: z.string(), dataRequests: z.number().int(), requestPhases: z.array(z.string()),dataRequestPhases:z.record(z.number().int()),limitedRequestsByPhase:z.record(z.number().int()).default({}),
    // Requests that carried no data (the party's own script, iframe document,
    // pixel image, …) per phase: a load the consent tool's gate exists to
    // prevent. Absent on records from older builds (then unknown, not zero).
    loadRequestsByPhase: z.record(z.number().int()).optional(),
    stores: z.array(z.object({name:z.string(),kind:z.string(),writePhase:z.string().optional(),writePhases:z.array(z.string()),presentAtEnd:z.boolean(),thirdParty:z.boolean().optional(),attribution:z.enum(['observed','known-name'])})),
  })),
});
// --- Markup inspection (plans/client-consent-design.md §3 #1–#2, §5 item 2) ----------

// One tracker tag found in a page's served HTML, matched to a party.
//   gateable — an executable <script>: rewrite it to type="text/plain" and the
//              consent tool can hold it back
//   leak     — <img>/<iframe>/preload·prefetch·stylesheet <link>, or anything
//              in <noscript>: the browser fetches it itself, no consent tool can
//   hint     — dns-prefetch / preconnect: opens a connection (DNS lookup, and
//              for preconnect the visitor's IP reaches the host); no request
//   held     — already switched off in markup (type="text/plain", data-src)
export const MarkupVerdict = z.enum(['gateable', 'leak', 'hint', 'held']);
export type MarkupVerdict = z.infer<typeof MarkupVerdict>;

export const MarkupFinding = z.object({
  partyId: z.string(), // KB entry id, or 'unknown:<registrable domain>'
  label: z.string(),
  recognized: z.boolean(),
  verdict: MarkupVerdict,
  // When it loads: 'page-load', or 'javascript-disabled' for <noscript>
  // content (fires only for visitors without JavaScript — exactly when no
  // consent tool can run).
  trigger: z.enum(['page-load', 'javascript-disabled']).optional(),
  kind: z.enum(['script', 'img', 'iframe', 'link']),
  context: z.enum(['document', 'noscript']),
  page: z.string(), // page URL
  line: z.number().int(), // 1-based line in the served HTML (first time seen)
  url: z.string().optional(), // src / href (URLs are evidence; query values kept like request URLs)
  inline: z.boolean(), // an inline script (no src)
  attributes: z.record(z.string()).default({}),
  matchedBy: z.enum(['host', 'inline-pattern', 'inline-host', 'inline-id']),
  match: z.string(), // the host, or the matched inline text (≤ 80 chars, never the body)
  // An inline snippet whose body calls document.write (MarkupElement.documentWrite): not gateable asynchronously.
  documentWrite: z.boolean().optional(),
  // Tag ids read from an inline (or data: URL) body — G-…, AW-…, GTM-… — so a
  // rule can find "the snippet that configures G-X" (never the body itself).
  ids: z.array(z.string()).optional(),
  // The script's code is a data: URL (its payload is never recorded).
  dataUrl: MarkupDataUrl.pick({ attribute: true, mediaType: true, encoding: true }).optional(),
  // A performance plugin delays the script and runs it itself (MarkupElement.optimizer): not consent gating.
  optimizer: z.string().optional(),
  locations: z.array(z.string()), // location ids whose served HTML had it
  alsoOn: z.array(z.string()).default([]), // other page URLs with the same tag
  // Tags folded into this row on its first page (scenarios and locations repeat
  // the same tag; an unrecognized host's tags of one kind are folded together).
  occurrences: z.number().int().default(1),
});
export type MarkupFinding = z.infer<typeof MarkupFinding>;

export const MarkupSection = z.object({
  pages: z.array(
    z.object({
      url: z.string(),
      status: z.enum(['inspected', 'not-inspected']),
      via: z.enum(['navigation', 'refetch']).optional(),
      reason: z.string().optional(),
      locations: z.array(z.string()),
      elements: z.number().int(), // elements of interest found (all, matched or not)
      bytes: z.number().int().optional(),
    }),
  ),
  findings: z.array(MarkupFinding),
  // Parties the network evidence attributes to markup that static inspection
  // did not find a tag for (an unvisited variant, a tag added by a server-side
  // include on another request, or a gap in matching). Listed, never dropped.
  unexplained: z.array(z.object({ partyId: z.string(), source: z.string(), reason: z.string() })).default([]),
});
export type MarkupSection = z.infer<typeof MarkupSection>;

// --- Tag-manager containers (plans/client-consent-design.md §3 #3, §5 item 1) -------
//
// What the collector hands the parser: one fetched container file per id seen
// loading. `source` is in memory only (the file is written to evidence); the
// persisted record below carries the parsed shape.
export const ContainerCapture = z.object({
  id: z.string(), // 'GTM-XXXX01' | 'G-…' | 'AW-…' | 'DC-…'
  kind: z.enum(['gtm', 'gtag']), // gtm.js container | gtag/js destination config
  url: z.string(), // the URL fetched (host + path + id; `l=` and cache-busters dropped)
  locationId: z.string(), // which location's context fetched it
  seenOn: z.array(z.string()).default([]), // page URLs whose visit loaded it (≤ 5)
  fetchedAt: z.string(),
  status: z.enum(['ok', 'error']),
  httpStatus: z.number().int().optional(),
  bytes: z.number().int().optional(),
  evidencePath: z.string().optional(), // run-relative path of the saved file
  source: z.string().optional(), // the file body; never persisted in tracking.json
  error: z.string().optional(),
});
export type ContainerCapture = z.infer<typeof ContainerCapture>;

// Consent status of one tag, from the container alone:
//   required      — the tag carries an "additional consent" requirement: GTM
//                   holds it until every listed type is granted — but only
//                   where a 'denied' default is set first (an unset type
//                   counts as granted), so this alone is not proof of gating
//   built-in      — a Google tag with built-in Consent Mode checks: it FIRES
//                   regardless and only changes what it sends (cookieless pings)
//   template-checks — a sandboxed template whose code reads consent state;
//                   whether it holds anything back is up to that code, unverified
//   none          — no requirement of any kind: fires whenever its trigger does
//   unknown       — a template this parser cannot characterise, or a consent
//                   setting it could not resolve. Never reported as gated.
export const TagConsentStatus = z.enum(['required', 'built-in', 'template-checks', 'none', 'unknown']);
export type TagConsentStatus = z.infer<typeof TagConsentStatus>;

export const ContainerTag = z.object({
  tagId: z.number().int(), // the id the GTM UI shows for the tag
  index: z.number().int(), // position in resource.tags (what rules reference)
  template: z.string(), // '__gaawe', '__html', '__cvt_ABC12' …
  templateLabel: z.string(), // 'GA4 Event', 'Custom HTML', 'Custom template'
  // tag     — sends something or loads a vendor
  // helper  — a listener GTM installs to drive triggers (click, scroll, timer)
  // setting — a Google tag setting from gtag.js (enhanced measurement, signals…)
  kind: z.enum(['tag', 'helper', 'setting']),
  custom: z.boolean(), // a sandboxed (gallery / custom) template
  paused: z.boolean().default(false),
  partyId: z.string().optional(), // KB entry id
  partyLabel: z.string().optional(),
  mappedBy: z.enum(['template', 'parameter', 'signature', 'permission', 'host']).optional(),
  identifiers: z.array(z.string()).default([]), // measurement / conversion / pixel ids as configured
  loads: z.array(z.string()).default([]), // hosts the tag injects scripts from or sends pixels to
  // Firing conditions, one line per rule that adds the tag (OR between lines).
  triggers: z.array(z.string()).default([]),
  // Exceptions: rules that block it.
  exceptions: z.array(z.string()).default([]),
  // Events named in its triggers ('gtm.js', 'gtm.dom', 'purchase', …) — '*' when
  // a trigger does not pin the event.
  events: z.array(z.string()).default([]),
  firesOnPageLoad: z.boolean(), // a trigger fires on gtm.init / gtm.js / gtm.dom / gtm.load
  consent: z.object({
    status: TagConsentStatus,
    additional: z.array(z.string()).default([]), // explicit consent types required
    builtIn: z.array(z.string()).default([]), // types a built-in check reads
    note: z.string().optional(),
  }),
  sequencing: z.object({ setup: z.array(z.number().int()), teardown: z.array(z.number().int()) }).optional(),
  // Scalar parameters worth showing (settings tags; the selected vtp_* values).
  settings: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
});
export type ContainerTag = z.infer<typeof ContainerTag>;

export const TagContainer = z.object({
  id: z.string(),
  kind: z.enum(['gtm', 'gtag']),
  url: z.string(),
  fetchedAt: z.string(),
  locationId: z.string().optional(),
  seenOn: z.array(z.string()).default([]),
  evidencePath: z.string().optional(),
  // parsed      — the runtime data was read; `tags` is complete for that version
  // unreadable  — fetched but not in a shape this parser knows: nothing below
  //               is a claim about the container ('could not be read')
  // not-fetched — the fetch failed; same
  status: z.enum(['parsed', 'unreadable', 'not-fetched']),
  reason: z.string().optional(),
  version: z.string().optional(), // the container version served
  tags: z.array(ContainerTag).default([]),
  counts: z
    .object({
      tags: z.number().int(),
      helpers: z.number().int(),
      settings: z.number().int(),
      required: z.number().int(),
      builtIn: z.number().int(),
      templateChecks: z.number().int(),
      none: z.number().int(),
      unknown: z.number().int(),
      unmapped: z.number().int(),
    })
    .optional(),
  // Templates no table or signature could place (function ids) — the honest
  // residue, listed so a reader can map them by hand.
  unmappedTemplates: z.array(z.string()).default([]),
  consentMode: z
    .object({
      // A tag fires on the Consent Initialization trigger (gtm.init_consent).
      initTrigger: z.boolean(),
      // Tags (labels) whose template code sets Consent Mode defaults.
      defaultsSetBy: z.array(z.string()),
      // Tags whose template code updates consent state (a CMP template).
      updatedBy: z.array(z.string()),
    })
    .optional(),
  warnings: z.array(z.string()).default([]),
});
export type TagContainer = z.infer<typeof TagContainer>;

// --- Consent-API observations (plans/client-consent-design.md §3 "consent-API misuse"; A3) ---
//
// One per timeline (location × scenario × run): what the page told each vendor's
// consent API, reduced to the consent-bearing calls (defaults, updates, grants,
// revokes, holds, and the "loaded" moment), the three derived states, and what
// the recorder could not see. Measurement calls are counted, not listed.
export const ConsentApiObservedCall = z.object({
  t: z.number(),
  api: ConsentApiName,
  call: z.string(),
  command: z.string().optional(),
  action: z.enum(['default', 'update', 'grant', 'revoke', 'hold', 'measure', 'read', 'ready', 'other']),
  phase: z.string(),
  // Consent values as told to the vendor (keys as the vendor names them).
  consent: z.record(z.enum(['granted', 'denied'])).optional(),
  grants: z.boolean(),
  denies: z.boolean(),
  // Scoped to a region list: whether it applied to this visitor is not decided.
  regional: z.boolean(),
  pageIndex: z.number().int(),
});
export type ConsentApiObservedCall = z.infer<typeof ConsentApiObservedCall>;

export const ConsentApiObservation = z.object({
  location: z.string(),
  scenario: ScenarioId,
  run: z.number().int().optional(),
  apis: z.array(ConsentApiName),
  calls: z.number().int(), // every recorded call, listed or not
  consentCalls: z.array(ConsentApiObservedCall),
  states: z.array(
    z.object({
      state: z.enum(['default-after-load', 'not-called-after-refusal', 'grant-on-load']),
      api: ConsentApiName,
      t: z.number(),
      phase: z.string(),
      reason: z.string(),
    }),
  ),
  unknowns: z.array(z.string()),
});
export type ConsentApiObservation = z.infer<typeof ConsentApiObservation>;

// --- Compatibility verdict (plans/client-consent-design.md §5; B1) --------------------
//
// Per tool: can a consent tool control it, and what has to change. Decided by
// src/rules/tracking/compatibility.ts from the implementation class (A6), the
// served HTML (A1), parsed containers (A2), consent-API observations (A3), the
// consent tool's stored default (A4), the platform (A5) and the vendor's
// control facts (A8). Behavior outranks all of it: `behaviorMismatch` is set
// from the scenario observations and the change list says so first.
//
//   gateable       — a <script> in the HTML the owner rewrites to type="text/plain";
//                    requires a 'gateable' markup finding for the party and no leak
//   tag-manager    — loaded by GTM or another manager: fix in the container; or
//                    by a Google tag (gtag.js) snippet in the HTML: fix through its
//                    Consent Mode default and settings (never 'gateable': the
//                    located tag is the Google tag's, not the party's)
//   platform       — injected by the platform: use its consent API
//   uncontrollable — markup leak, CNAME cookies, server-side: no tool fixes it
//   unknown        — evidence missing or the loader unidentified (never a pass)
export const CompatibilityVerdict = z.enum(['gateable', 'tag-manager', 'platform', 'uncontrollable', 'unknown']);
export type CompatibilityVerdict = z.infer<typeof CompatibilityVerdict>;

export const CompatibilityChangeKind = z.enum([
  'behavior-mismatch', // first whenever behavior disagreed with expectations: the current setup does not hold it
  'rewrite-tag', // a <script> in the served HTML → type="text/plain" + data-category (page:line)
  'remove-leak', // an <img>/<iframe>/preload/<noscript> element in the HTML (page:line)
  'gate-gtm-tag', // a GTM tag lacking a proven consent requirement (container, tag id, consent types)
  'set-consent-default', // a denied Consent Mode default before the container / tag loads
  'configure-tag-manager', // a non-GTM manager: gate the tag inside it (internals not readable)
  'use-platform-api', // the platform's consent API / dashboard setting
  'call-consent-api', // the vendor's own consent call, alongside gating (never instead)
  'change-dns', // a first-party CNAME to the vendor
  'accepted-exposure', // nothing on the page controls it; accept in writing or remove the integration
  'needs-a-look', // the loader could not be identified
]);
export type CompatibilityChangeKind = z.infer<typeof CompatibilityChangeKind>;

export const CompatibilityChange = z.object({
  kind: CompatibilityChangeKind,
  note: z.string(),
  page: z.string().optional(),
  line: z.number().int().optional(),
  url: z.string().optional(),
  element: z.string().optional(), // '<img> in <noscript>', 'inline <script>'
  containerId: z.string().optional(),
  tagId: z.number().int().optional(),
  consentTypes: z.array(z.string()).optional(), // Consent Mode types to require / default
  api: z.string().optional(), // the consent API to call (vendor or platform)
  platform: z.string().optional(),
  manager: z.string().optional(),
  host: z.string().optional(),
  target: z.string().optional(),
  // Why this change is needed, beyond what `note` says — shown with the item
  // in the change list (a rewrite item otherwise shows only its snippets).
  why: z.string().optional(),
  // A Google tag destination (G-…/AW-…/DC-…) that a GTM container loads itself
  // because the page pushes gtag('config', id) into the dataLayer — no
  // container tag carries it, so the change is in the page, not in GTM.
  destinationId: z.string().optional(),
});
export type CompatibilityChange = z.infer<typeof CompatibilityChange>;

export const CompatibilityReason = z.object({
  source: z.enum(['behavior', 'implementation', 'markup', 'container', 'consent-api', 'consent-tool', 'control', 'platform']),
  note: z.string(),
  // JSON-pointer-style reference into the evaluation record ('/markup/findings/3').
  ref: z.string().optional(),
});
export type CompatibilityReason = z.infer<typeof CompatibilityReason>;

export const PartyCompatibility = z.object({
  partyId: z.string(),
  label: z.string(),
  implementation: ImplementationClass,
  verdict: CompatibilityVerdict,
  // Does the purpose need consent (the matrix's groups)? 'not-required' parties
  // (necessary / cdn / captcha / payments / consent) carry no changes: the
  // verdict only describes how they load. Optional for records built before it.
  purpose: z.enum(['needs-consent', 'context', 'not-required', 'unclassified']).optional(),
  // Behavior disagreed with the expected behavior in at least one tested
  // location × scenario (active when expected off). Outranks the verdict.
  behaviorMismatch: z.boolean(),
  // At least one location × scenario could be compared (verified location, a
  // known regime, a classified purpose). false = behavior not established.
  behaviorChecked: z.boolean(),
  reasons: z.array(CompatibilityReason),
  changes: z.array(CompatibilityChange),
});
export type PartyCompatibility = z.infer<typeof PartyCompatibility>;

// The consent tool's stored default on a fresh profile (A4), as a finding:
// decoded state that grants a non-necessary category without a recorded choice.
// 'not-observed' is never "nothing granted".
export const ConsentToolDefaultFinding = z.object({
  status: z.enum(['grants-by-default', 'no-grants-decoded', 'not-observed']),
  vendor: z.string().nullable().optional(),
  grants: z.array(z.string()), // categories granted by default (union)
  observed: z.array(z.object({ location: z.string(), scenario: ScenarioId, source: z.string(), grants: z.array(z.string()) })),
  note: z.string(),
});
export type ConsentToolDefaultFinding = z.infer<typeof ConsentToolDefaultFinding>;

export const CompatibilitySection = z.object({
  parties: z.array(PartyCompatibility),
  consentTool: ConsentToolDefaultFinding,
  // Which inputs the verdicts had. A missing input weakens verdicts; it never strengthens them.
  inputs: z.object({ markup: z.boolean(), containers: z.boolean(), consentApi: z.boolean(), consentTool: z.boolean(), behavior: z.boolean() }),
});
export type CompatibilitySection = z.infer<typeof CompatibilitySection>;

// Local-copy mode (D11 "prove the loop"): the scanner rewrote the site's own
// documents inside ITS OWN browser — the generated snippet first in <head>,
// the change list's tag rewrites, local files served at the tool's path, and
// simulated tag-manager settings on the fetched container. Nothing was
// installed on the site. A run carrying this is evidence about the rewritten
// copy only, never about the live site; the report says so first.
export const LocalCopyRecord = z.object({
  file: z.string(), // the spec file, as given
  origin: z.string(), // documents from this origin were rewritten
  /** Was anything inserted first in <head>? */
  head: z.boolean(),
  /** Documents rewritten (route-fulfilled), and ones the rewrite could not read (left as served). */
  documents: z.object({ rewritten: z.number().int(), unreadable: z.number().int() }),
  /** First few distinct failure messages behind "unreadable" / "unchanged" (the rewrite threw; the response was served as-is). */
  errors: z.array(z.string()).default([]),
  /** Per replacement: how many documents it applied to (0 = never matched — the "Now" markup differs from what was served). */
  replacements: z.array(z.object({ label: z.string(), applied: z.number().int() })),
  /** Same-origin paths served from local files, with request counts. */
  served: z.array(z.object({ path: z.string(), requests: z.number().int() })),
  /** Resources rewritten in flight (tag-manager containers). */
  resources: z.array(z.object({ url: z.string(), status: z.enum(['rewritten', 'unchanged', 'not-seen']), note: z.string().optional() })),
});
export type LocalCopyRecord = z.infer<typeof LocalCopyRecord>;

export const TrackingEvaluation = z.object({
  schemaVersion: z.number().int().default(TRACKING_SCHEMA_VERSION),
  runId: z.string(),
  property: z.string(),
  site: z.object({ url: z.string(), host: z.string(), registrableDomain: z.string() }),
  versions: z.object({ kb: z.string(), registry: z.string(), package: z.string(), autoconsent: z.string().optional() }),
  startedAt: z.string(),
  finishedAt: z.string(),
  locations: z.array(LocationSummary),
  inventory: z.array(PartyInventoryItem),
  platform: PlatformFingerprint.optional(),
  behaviorObservations: z.array(BehaviorObservation).optional(),
  // Static markup inspection; absent = not run.
  markup: MarkupSection.optional(),
  // Tag-manager containers seen loading, fetched and parsed; absent = none seen
  // or the collector did not look. A container that could not be read is
  // listed with status 'unreadable' — its tags are unknown, not gated.
  containers: z.array(TagContainer).optional(),
  // What the page told each vendor's consent API, per timeline (A3); absent =
  // not recorded (an older collector), never "no calls".
  consentApi: z.array(ConsentApiObservation).optional(),
  // Per-tool compatibility verdicts and the owner's change list (B1); absent on
  // records from older builds.
  compatibility: CompatibilitySection.optional(),
  // complykit's own consent tool, when installed: deployed config vs reality
  // (D10, src/rules/tracking/consent-tool-proof.ts). Absent on older records;
  // `detected: false` when the rescan looked and found none.
  consentToolProof: ConsentToolProof.optional(),
  // Local-copy mode (above): present only when the scanner rewrote the site in
  // its own browser. Absent = the site as served.
  localCopy: LocalCopyRecord.optional(),
  notTested: z.array(NotTestedItem),
  // Parties to research (plans/consent-design.md §4.2): unrecognized ones, and
  // recognized ones that behaved differently than their entry says ('drift').
  researchQueue: z.array(
    z.object({ partyId: z.string(), domain: z.string(), reason: z.string(), kind: z.enum(['unrecognized', 'drift']).default('unrecognized') }),
  ),
  redacted: z.boolean(),
  // The site workspace applied to this run (src/site-workspace.ts): its
  // classifications that matched something observed, and the tasks the team had
  // marked done. Absent = no workspace given.
  siteWorkspace: z
    .object({
      domain: z.string().optional(),
      appliedAt: z.string(),
      classifications: z.array(
        z.object({
          key: z.string(), // 'class:<id>'
          kind: z.enum(['tool', 'storage']),
          partyId: z.string(),
          domain: z.string(),
          storageKind: z.string().optional(),
          name: z.string().optional(),
          categories: z.array(z.string()),
          at: z.string().optional(),
          by: z.string().optional(),
        }),
      ),
      doneTasks: z.array(z.object({ key: z.string(), at: z.string().optional(), by: z.string().optional() })), // keys without 'task:'
      // Site-wide decisions (workspace 'decision:*' keys). limitedPings: consent-denied pings
      // where they would need a decision (EU/UK, wiretap states before a choice or after a refusal).
      decisions: z
        .object({ limitedPings: z.object({ choice: z.enum(['allow', 'hold']), at: z.string().optional(), by: z.string().optional() }).optional() })
        .optional(),
    })
    .optional(),
});
export type TrackingEvaluation = z.infer<typeof TrackingEvaluation>;

// --- Redaction ---------------------------------------------------------------------

/** Stable short digest — lets two redacted records still show "same value". */
export function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12)}`;
}

function redactValue(v: string): string {
  return v ? `${digest(v)} (${v.length} chars)` : v;
}

/**
 * Strip values out of a timeline before it is written anywhere: cookie and
 * storage values, script-written values and request bodies become digests.
 * URLs stay — they ARE the evidence, and the visitor is synthetic — but the
 * site's own tokens in bodies and cookies do not leave the machine by default.
 */
export function redactTimeline(t: Timeline): Timeline {
  return {
    ...t,
    location: { ...t.location, proxy: t.location.proxy ? { server: t.location.proxy.server } : undefined },
    events: t.events.map((e) => {
      switch (e.type) {
        case 'request':
          return e.postData ? { ...e, postData: `[redacted ${e.postData.length} chars, ${digest(e.postData)}]` } : e;
        case 'cookie-write':
        case 'storage-write':
          return { ...e, value: redactValue(e.value) };
        case 'websocket':
          return e.payload ? { ...e, payload: `[redacted ${e.payload.length} chars]` } : e;
        default:
          return e;
      }
    }),
    snapshot: {
      ...t.snapshot,
      cookies: t.snapshot.cookies.map((c) => ({ ...c, value: redactValue(c.value) })),
      storage: t.snapshot.storage.map((s) => ({ ...s, value: s.value === undefined ? undefined : redactValue(s.value) })),
      ...(t.snapshot.markup ? { markup: redactMarkupPages(t.snapshot.markup) } : {}),
    },
  };
}

// --- Persistence -------------------------------------------------------------------

export const TRACKING_FILE = 'tracking.json';

export function writeTrackingEvaluation(dir: string, evaluation: TrackingEvaluation): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, TRACKING_FILE);
  fs.writeFileSync(file, JSON.stringify(TrackingEvaluation.parse(evaluation), null, 2));
  return file;
}

/** The run's evaluation, or undefined for a run that had no consent evaluation. */
export function readTrackingEvaluation(dir: string): TrackingEvaluation | undefined {
  const file = path.join(dir, TRACKING_FILE);
  if (!fs.existsSync(file)) return undefined;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof raw.schemaVersion === 'number' && raw.schemaVersion > TRACKING_SCHEMA_VERSION) {
    throw new Error(`${file}: tracking schemaVersion ${raw.schemaVersion} is newer than this build understands (${TRACKING_SCHEMA_VERSION}).`);
  }
  return TrackingEvaluation.parse(raw);
}

/** One visit's timeline as the rules consume it (a `consent-timeline` artifact). */
export function timelineArtifact(tl: Timeline, property: string, instanceUrl: string, capturedAt: string): Artifact {
  const runSuffix = (tl.snapshot.run ?? 1) > 1 ? `-run${tl.snapshot.run}` : '';
  return {
    kind: 'consent-timeline',
    subject: { property, routePattern: '*', instanceUrl, state: `${tl.location.id}/${tl.snapshot.scenario}${runSuffix}` },
    capturedAt,
    payloadPath: tl.snapshot.evidence.timeline,
    scenario: tl.snapshot.scenario,
    location: tl.location as unknown as Record<string, unknown>,
    verification: tl.verification as unknown as Record<string, unknown>,
    events: tl.events as unknown as Record<string, unknown>[],
    snapshot: tl.snapshot as unknown as Record<string, unknown>,
  };
}
