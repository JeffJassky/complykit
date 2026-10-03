import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

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

export const TimelineSnapshot = z.object({
  site: z.object({ url: z.string(), host: z.string(), registrableDomain: z.string() }),
  scenario: ScenarioId,
  locationId: z.string(),
  startedAt: z.string(),
  durationMs: z.number(),
  gpc: z.boolean(),
  browser: z.object({ name: z.string(), version: z.string().optional() }),
  pages: z.array(z.object({ url: z.string(), title: z.string().optional() })),
  cookies: z.array(CookieSnapshot),
  storage: z.array(StorageSnapshot),
  frames: z.array(z.object({ url: z.string(), sandboxed: z.boolean().optional() })),
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

export const ScenarioSummary = z.object({
  scenario: ScenarioId,
  status: z.enum(['tested', 'not-tested', 'not-applicable']),
  reason: z.string().optional(),
  durationMs: z.number().optional(),
  banner: z.object({ found: z.boolean(), cmp: z.string().optional(), shownAtMs: z.number().optional() }).optional(),
  choice: z.object({ kind: z.string(), ok: z.boolean(), method: z.string() }).optional(),
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
  notTested: z.array(NotTestedItem),
  // Parties to research (plans/consent-design.md §4.2): unrecognized ones, and
  // recognized ones that behaved differently than their entry says ('drift').
  researchQueue: z.array(
    z.object({ partyId: z.string(), domain: z.string(), reason: z.string(), kind: z.enum(['unrecognized', 'drift']).default('unrecognized') }),
  ),
  redacted: z.boolean(),
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
