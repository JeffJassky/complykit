import { TrackingEvaluation, type PartyInventoryItem } from '../../src/record/index.js';

// A generic consent evaluation for the B2 compatibility section and change
// list (no client material): one verified EU location, reject + accept, and
// one tool per verdict — a leaking pixel observed running after rejection, a
// rewritable analytics tag that stayed off, a GTM-loaded pixel, a platform
// tool, an unidentified loader, and a CDN whose purpose needs no consent.

export const PAGE = 'https://www.example-shop.test/';
const GTAG = 'https://www.googletagmanager.com/gtag/js?id=G-XXXX01';
const GTM = 'https://www.googletagmanager.com/gtm.js?id=GTM-XXXX01';

function party(partyId: string, label: string, categories: string[], impl: NonNullable<PartyInventoryItem['implementation']>, over: Partial<PartyInventoryItem> = {}): PartyInventoryItem {
  return {
    partyId,
    label,
    domain: `${partyId.replace(/^unknown:/, '').split('.')[0]}.test`,
    hosts: [`${partyId.replace(/^unknown:/, '').split('.')[0]}.test`],
    recognized: !partyId.startsWith('unknown:'),
    kbStatus: partyId.startsWith('unknown:') ? 'unrecognized' : 'confirmed',
    categories,
    behavesLikeTracker: true,
    trackerSignals: [],
    sends: ['page-address'],
    stores: [],
    sources: [],
    loadedBy: [],
    implementation: impl,
    samples: [],
    seenIn: [],
    ...over,
  };
}

const ev = (cls: NonNullable<PartyInventoryItem['implementation']>['class'], note: string, over: Record<string, unknown> = {}) => ({ class: cls, evidence: [{ class: cls, kind: 'source' as const, observed: true, note, ...over }], alsoSeen: [] });

export const inventory: PartyInventoryItem[] = [
  party('meta.pixel', 'Meta Pixel', ['advertising'], ev('markup-leak', 'a <noscript> image pixel in the HTML', { page: PAGE, line: 40 })),
  party('google.analytics', 'Google Analytics 4', ['analytics'], ev('direct-script', 'a <script> in the page', { url: GTAG, page: PAGE, line: 12 })),
  party('tiktok.pixel', 'TikTok Pixel', ['advertising'], ev('gtm', `loaded by the GTM container ${GTM}`, { kind: 'loader', url: GTM })),
  party('google.ads.ccm', 'Google Ads', ['advertising'], ev('platform', 'injected by the Shopify web-pixel sandbox')),
  party('unknown:tracker.test', 'tracker.test', ['unknown'], ev('unknown', 'its first request had no initiator the scan could trace')),
  party('cloudflare', 'Cloudflare', ['cdn'], ev('direct-script', 'a <script> in the page', { page: PAGE, line: 5 })),
];

const loc = {
  spec: { id: 'de', label: 'Germany', country: 'DE', proxied: false },
  verification: { verdict: 'verified', expected: { country: 'DE' }, observed: { country: 'DE' }, sources: [], jurisdictions: ['eu'], checkedAt: '2026-10-06T10:00:00Z' },
  scenarios: [
    { scenario: 'reject', status: 'tested', choice: { kind: 'reject', ok: true, method: 'selector' }, evidence: { screenshots: [] } },
    { scenario: 'accept', status: 'tested', choice: { kind: 'accept', ok: true, method: 'selector' }, evidence: { screenshots: [] } },
  ],
};

const facts = (partyId: string, phase: string, requests: number) => ({ partyId, dataRequests: requests, requestPhases: [phase], dataRequestPhases: { [phase]: requests }, limitedRequestsByPhase: {}, stores: [] });
const known = inventory.map((p) => p.partyId);

export function compatibilityEvaluation(): TrackingEvaluation {
  return TrackingEvaluation.parse({
    runId: 'b2-fixture',
    property: 'Example shop',
    site: { url: PAGE, host: 'www.example-shop.test', registrableDomain: 'example-shop.test' },
    versions: { kb: '0', registry: '0', package: '0' },
    startedAt: '2026-10-06T10:00:00Z',
    finishedAt: '2026-10-06T10:05:00Z',
    redacted: true,
    locations: [loc],
    inventory,
    platform: { name: 'shopify', signals: ['window.Shopify'] },
    behaviorObservations: [
      // After rejection: the pixel still sends; analytics stays quiet.
      { location: 'de', scenario: 'reject', run: 1, pages: 3, durationMs: 9000, knownPartyIds: known, parties: [facts('meta.pixel', 'after-reject', 2)] },
      { location: 'de', scenario: 'accept', run: 1, pages: 3, durationMs: 9000, knownPartyIds: known, parties: [facts('meta.pixel', 'after-accept', 2), facts('google.analytics', 'after-accept', 3)] },
    ],
    markup: {
      pages: [{ url: PAGE, status: 'inspected', locations: ['de'], elements: 4 }],
      findings: [
        { partyId: 'google.analytics', label: 'Google Analytics 4', recognized: true, verdict: 'gateable', trigger: 'page-load', kind: 'script', context: 'document', page: PAGE, line: 12, url: GTAG, inline: false, attributes: { async: '', src: GTAG }, matchedBy: 'host', match: 'www.googletagmanager.com', locations: ['de'], alsoOn: ['https://www.example-shop.test/cart'] },
        { partyId: 'meta.pixel', label: 'Meta Pixel', recognized: true, verdict: 'leak', trigger: 'javascript-disabled', kind: 'img', context: 'noscript', page: PAGE, line: 40, url: 'https://www.facebook.com/tr?id=000000&ev=PageView&noscript=1', inline: false, attributes: { height: '1', width: '1' }, matchedBy: 'host', match: 'www.facebook.com', locations: ['de'] },
        { partyId: 'meta.pixel', label: 'Meta Pixel', recognized: true, verdict: 'gateable', trigger: 'page-load', kind: 'script', context: 'document', page: PAGE, line: 38, inline: true, attributes: {}, matchedBy: 'inline-pattern', match: "fbq('init'", locations: ['de'] },
        { partyId: 'cloudflare', label: 'Cloudflare', recognized: true, verdict: 'gateable', trigger: 'page-load', kind: 'script', context: 'document', page: PAGE, line: 5, url: 'https://cdn.cloudflare.test/x.js', inline: false, attributes: { src: 'https://cdn.cloudflare.test/x.js' }, matchedBy: 'host', match: 'cdn.cloudflare.test', locations: ['de'] },
      ],
      unexplained: [],
    },
    containers: [
      {
        id: 'GTM-XXXX01',
        kind: 'gtm',
        url: GTM,
        fetchedAt: '2026-10-06T10:00:00Z',
        status: 'parsed',
        tags: [{ tagId: 7, index: 0, template: '__cvt_X', templateLabel: 'Custom template', kind: 'tag', custom: true, partyId: 'tiktok.pixel', firesOnPageLoad: true, consent: { status: 'none' } }],
      },
    ],
    notTested: [],
    researchQueue: [],
  });
}
