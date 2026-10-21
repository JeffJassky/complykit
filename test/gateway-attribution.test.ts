// plans/gateway-attribution.md — a known tool's server gateway (Meta Conversions API Gateway on
// on.aws, a first-party relay) is recognised by who loaded it and where it posts, never asked about.
import { describe, it, expect } from 'vitest';
import { analyzeTimeline } from '../src/rules/tracking/analyze.js';
import { DEFAULT_KB, kbEntryOf } from '../src/registry/index.js';
import { knownTrackerReason } from '../src/consent-generator.js';
import { Timeline, TrackingEvaluation } from '../src/record/index.js';
import { generateConsentConfig } from '../src/consent-generator.js';
import { compatibilityEvaluation, PAGE } from './fixtures/compatibility-report.js';

const SITE = 'https://example-shop.test/';
const FBEVENTS = 'https://connect.facebook.net/en_US/fbevents.js';
const GATEWAY = 'https://d3-36c34dc0877246a0b32c4f4e24be6ce8.ecs.us-east-1.on.aws/events?cee=1';
const req = (id: string, url: string, o: Record<string, unknown> = {}) => ({
  type: 'request', t: 500, id, url, method: 'GET', resourceType: 'script', origin: 'page', pageUrl: SITE, pageIndex: 0,
  initiator: { type: 'parser', chain: [] }, status: 200, setCookies: [], ...o,
});
const timeline = (events: unknown[]) =>
  Timeline.parse({
    location: { id: 'us-ca', label: 'California', country: 'US', region: 'CA', proxied: false },
    verification: { verdict: 'verified', expected: { country: 'US' }, observed: { country: 'US', region: 'CA' }, sources: [], jurisdictions: ['us', 'us-ca'], checkedAt: '2026-10-21T00:00:00Z' },
    snapshot: { site: { url: SITE, host: 'example-shop.test', registrableDomain: 'example-shop.test' }, scenario: 'do-nothing', locationId: 'us-ca', startedAt: '2026-10-21T00:00:00Z', durationMs: 3000, gpc: false, browser: { name: 'chromium' }, pages: [{ url: SITE }], cookies: [], storage: [], frames: [], dns: [], notTested: [], evidence: {} },
    events,
  });
const parties = (events: unknown[]) => [...analyzeTimeline(timeline(events)).parties.values()];
const viaMeta = (url: string, o: Record<string, unknown> = {}) => req('g', url, { method: 'POST', resourceType: 'fetch', initiator: { type: 'script', chain: [FBEVENTS, SITE] }, ...o });

describe('a known tool’s server gateway is recognised by its loader and its endpoint', () => {
  it('Meta’s script posting to /events on an unknown host is Meta’s Conversions API Gateway, classified like Meta Pixel', () => {
    const ps = parties([req('m', FBEVENTS), viaMeta(GATEWAY)]);
    const g = ps.find((p) => p.partyId.startsWith('gateway:'))!;
    expect(g).toBeDefined();
    expect(g.partyId).toBe('gateway:meta.pixel:on.aws');
    expect(g.gatewayOf).toBe('meta.pixel');
    expect(g.recognized).toBe(true);
    expect(g.categories).toEqual(['advertising']);
    expect(g.label).toMatch(/^Meta Pixel .*gateway.*on\.aws/i);
    expect(g.domain).toBe('on.aws');
    expect(ps.some((p) => p.partyId === 'unknown:on.aws')).toBe(false);
    // Meta Pixel itself is still a party of its own.
    expect(ps.some((p) => p.partyId === 'meta.pixel')).toBe(true);
  });

  it('controls: the same host stays unknown without Meta’s loader, or without Meta’s endpoint', () => {
    const fromSite = parties([req('m', FBEVENTS), viaMeta(GATEWAY, { initiator: { type: 'script', chain: ['https://example-shop.test/assets/app.js'] } })]);
    expect(fromSite.map((p) => p.partyId)).toContain('unknown:on.aws');
    const otherPath = parties([req('m', FBEVENTS), viaMeta('https://d3-abc.ecs.us-east-1.on.aws/static/pixel.js')]);
    expect(otherPath.map((p) => p.partyId)).toContain('unknown:on.aws');
    expect(otherPath.some((p) => p.partyId.startsWith('gateway:'))).toBe(false);
  });

  it('a host the knowledge base already knows is never re-attributed as a gateway', () => {
    const ps = parties([req('m', FBEVENTS), viaMeta('https://www.google-analytics.com/events')]);
    expect(ps.some((p) => p.partyId.startsWith('gateway:'))).toBe(false);
    expect(ps.some((p) => p.partyId === 'google.analytics')).toBe(true);
  });

  it('a gateway on the site’s own domain is still the vendor’s, not first party', () => {
    const ps = parties([req('m', FBEVENTS), viaMeta('https://capi.example-shop.test/events')]);
    const g = ps.find((p) => p.partyId.startsWith('gateway:meta.pixel:'))!;
    expect(g).toBeDefined();
    expect(g.gatewayOf).toBe('meta.pixel');
  });

  it('lookups by party id resolve a gateway to its entry (tracker guard, owner judgement)', () => {
    expect(kbEntryOf(DEFAULT_KB, 'gateway:meta.pixel:on.aws')?.id).toBe('meta.pixel');
    expect(kbEntryOf(DEFAULT_KB, 'meta.pixel')?.id).toBe('meta.pixel');
    expect(kbEntryOf(DEFAULT_KB, 'unknown:on.aws')).toBeUndefined();
    expect(knownTrackerReason({ partyId: 'gateway:meta.pixel:on.aws', behavesLikeTracker: false, trackerSignals: [] }, DEFAULT_KB)).toMatch(/advertising/);
  });

  it('the seed cites its sources: every gateway rule belongs to an entry with a documentation URL', () => {
    const withGateways = DEFAULT_KB.entries.filter((e) => e.match.gateways?.length);
    expect(withGateways.map((e) => e.id)).toContain('meta.pixel');
    for (const e of withGateways) expect(e.provenance.sources?.length, e.id).toBeGreaterThan(0);
  });
});

// A gateway never gets a to-do of its own: its hold follows its loader's.
describe('the to-do list folds a server gateway into its loader’s task', () => {
  const GW = 'gateway:meta.pixel:on.aws';
  const withGateway = (opts: { held?: boolean } = {}): TrackingEvaluation => {
    const base = compatibilityEvaluation();
    const meta = base.inventory.find((p) => p.partyId === 'meta.pixel')!;
    const gw = { ...structuredClone(meta), partyId: GW, label: 'Meta Pixel (server gateway on on.aws)', domain: 'on.aws', hosts: ['d3-abc.ecs.us-east-1.on.aws'], gatewayOf: 'meta.pixel', implementation: { class: 'unknown', evidence: [], alsoSeen: [] } };
    const raw = structuredClone(base) as unknown as { inventory: unknown[]; markup: { findings: Array<{ partyId: string; verdict: string }> }; behaviorObservations: Array<{ knownPartyIds: string[]; parties: Array<Record<string, unknown>>; scenario: string }> };
    raw.inventory.push(gw);
    // Meta's one fix here is holding its fbevents.js tag (the fixture's no-JavaScript fallback and inline snippet would be more tasks).
    const fbevents = 'https://connect.facebook.net/en_US/fbevents.js';
    raw.markup.findings = raw.markup.findings.filter((f) => f.partyId !== 'meta.pixel');
    raw.markup.findings.push({ partyId: 'meta.pixel', label: 'Meta Pixel', recognized: true, verdict: 'gateable', trigger: 'page-load', kind: 'script', context: 'document', page: PAGE, line: 38, url: fbevents, inline: false, attributes: { async: '', src: fbevents }, matchedBy: 'host', match: 'connect.facebook.net', locations: ['de'] } as never);
    raw.inventory = raw.inventory.map((p) => ((p as { partyId: string }).partyId === 'meta.pixel' ? { ...(p as object), implementation: { class: 'direct-script', evidence: [{ class: 'direct-script', kind: 'source', observed: true, note: 'a <script> in the page', url: fbevents, page: PAGE, line: 38 }], alsoSeen: [] } } : p));
    for (const o of raw.behaviorObservations) {
      o.knownPartyIds.push(GW);
      for (const f of [...o.parties]) if (f.partyId === 'meta.pixel') o.parties.push({ ...f, partyId: GW });
    }
    if (opts.held) for (const o of raw.behaviorObservations) o.parties = o.parties.filter((f) => f.partyId !== 'meta.pixel' && f.partyId !== GW);
    return TrackingEvaluation.parse(raw);
  };
  const tasksOf = (ev: TrackingEvaluation) => generateConsentConfig(ev, { complykitVersion: '0.0.0-test', now: '2026-10-21T12:00:00.000Z' }).tasks;

  it('exactly one task names Meta Pixel, it covers the gateway, and no task is the gateway alone', () => {
    const tasks = tasksOf(withGateway());
    const metaTasks = tasks.filter((t) => [t.title, ...t.tools].some((x) => /Meta Pixel/.test(x)));
        expect(metaTasks).toHaveLength(1);
    const [meta] = metaTasks;
    expect(meta.partyIds).toEqual(expect.arrayContaining(['meta.pixel', GW]));
    expect(meta.alsoFixes?.join(' ')).toMatch(/Also covers its server gateway on on\.aws/);
    expect(meta.title).not.toMatch(/gateway/);
    // Nothing is the gateway's alone: no task whose parties are only gateways, none titled for it, none waiting on it.
    expect(tasks.filter((t) => t.partyIds.length > 0 && t.partyIds.every((id) => id.startsWith('gateway:')))).toEqual([]);
    expect(tasks.filter((t) => /gateway/i.test(t.title))).toEqual([]);
    // The gateway's own change items stay findable through the task that covers them.
    expect(meta.aliases?.length).toBeGreaterThan(0);
  });

  it('a loader held everywhere leaves the gateway no task either', () => {
    const tasks = tasksOf(withGateway({ held: true }));
    expect(tasks.some((t) => t.partyIds.includes(GW))).toBe(false);
  });
});
