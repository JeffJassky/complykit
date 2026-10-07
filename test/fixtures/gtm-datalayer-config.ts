import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Timeline, TrackingEvaluation, inspectMarkup, type PartyInventoryItem } from '../../src/record/index.js';
import { buildMarkupSection } from '../../src/rules/tracking/index.js';
import { DEFAULT_KB } from '../../src/registry/index.js';

// Issues #47 + #48 together, generic (no client material): a WordPress page whose
// "delay JavaScript" optimizer serves the inline snippets as data: URL scripts
// (test/fixtures/pages/markup-data-url.html: GTM at line 8, the gtag.js loader at
// line 9, the gtag('config', 'G-TEST0001X') snippet at line 10, Meta at 11,
// TikTok percent-encoded at 13), and a GTM container that loads the G- destination
// itself (gtag/js?id=…&cx=c) because the page pushes the config into the
// dataLayer — no container tag carries G-TEST0001X.

const here = path.dirname(fileURLToPath(import.meta.url));
export const PAGE = 'https://www.example-shop.test/';
export const DEST = 'G-TEST0001X';
const GTM = 'https://www.googletagmanager.com/gtm.js?id=GTM-XXXX01';
const CX = `https://www.googletagmanager.com/gtag/js?id=${DEST}&l=dataLayer&cx=c&gtm=45x0`;
const site = { url: PAGE, host: 'www.example-shop.test', registrableDomain: 'example-shop.test' };

function markupSection() {
  const html = fs.readFileSync(path.join(here, 'pages/markup-data-url.html'), 'utf8');
  const tl = Timeline.parse({
    location: { id: 'de' },
    verification: { verdict: 'unknown', expected: {}, observed: {}, sources: [], checkedAt: '2026-10-06T00:00:00Z' },
    events: [],
    snapshot: { site, scenario: 'reject', locationId: 'de', startedAt: '2026-10-06T00:00:00Z', durationMs: 1000, gpc: false, browser: { name: 'chromium' }, pages: [{ url: PAGE }], cookies: [], storage: [], frames: [], markup: [inspectMarkup(html, PAGE, 0, 'navigation')] },
  });
  return buildMarkupSection([tl], DEFAULT_KB)!.section;
}

function party(partyId: string, label: string, categories: string[], impl: NonNullable<PartyInventoryItem['implementation']>, over: Partial<PartyInventoryItem> = {}): PartyInventoryItem {
  return {
    partyId,
    label,
    domain: `${partyId.split('.')[0]}.test`,
    hosts: [`${partyId.split('.')[0]}.test`],
    recognized: true,
    kbStatus: 'confirmed',
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

const markupEv = (line: number, note: string) => ({ class: 'direct-script' as const, kind: 'markup' as const, observed: false, page: PAGE, line, note });

export function dataLayerConfigEvaluation(): TrackingEvaluation {
  const inventory: PartyInventoryItem[] = [
    party('google.analytics', 'Google Analytics 4', ['analytics'], { class: 'gtm', evidence: [{ class: 'gtm', kind: 'loader', observed: true, url: GTM, note: `loaded by the GTM container ${GTM}, which loaded ${CX}` }], alsoSeen: [] }, { sources: ['injected'], loadedBy: [CX] }),
    party('google.tag-manager', 'Google Tag Manager / gtag.js', ['tag-manager'], { class: 'direct-script', evidence: [markupEv(8, 'the GTM snippet'), markupEv(9, 'the gtag.js loader')], alsoSeen: [] }),
    party('meta.pixel', 'Meta Pixel', ['advertising'], { class: 'direct-script', evidence: [markupEv(11, 'the Meta base code')], alsoSeen: [] }),
    party('tiktok.pixel', 'TikTok Pixel', ['advertising'], { class: 'direct-script', evidence: [markupEv(13, 'the TikTok base code')], alsoSeen: [] }),
  ];
  return TrackingEvaluation.parse({
    runId: 'datalayer-config-fixture',
    property: 'Example shop',
    site,
    versions: { kb: '0', registry: '0', package: '0' },
    startedAt: '2026-10-06T10:00:00Z',
    finishedAt: '2026-10-06T10:05:00Z',
    redacted: true,
    locations: [
      {
        spec: { id: 'de', label: 'Germany', country: 'DE', proxied: false },
        verification: { verdict: 'verified', expected: { country: 'DE' }, observed: { country: 'DE' }, sources: [], jurisdictions: ['eu'], checkedAt: '2026-10-06T10:00:00Z' },
        scenarios: [{ scenario: 'reject', status: 'tested', choice: { kind: 'reject', ok: true, method: 'selector' }, evidence: { screenshots: [] } }],
      },
    ],
    inventory,
    platform: { name: 'wordpress', signals: ['wp-content'] },
    markup: markupSection(),
    containers: [
      // Parsed; its one tag is for another vendor — none names G-TEST0001X.
      { id: 'GTM-XXXX01', kind: 'gtm', url: GTM, fetchedAt: '2026-10-06T10:00:00Z', status: 'parsed', tags: [{ tagId: 9, index: 0, template: '__baut', templateLabel: 'Microsoft Advertising UET', kind: 'tag', custom: false, partyId: 'microsoft.uet', identifiers: ['00000001'], firesOnPageLoad: true, consent: { status: 'none' } }] },
      { id: DEST, kind: 'gtag', url: CX, fetchedAt: '2026-10-06T10:00:00Z', status: 'parsed', tags: [{ tagId: 2, index: 0, template: '__dest_ga', templateLabel: 'GA4 destination', kind: 'tag', custom: false, partyId: 'google.analytics', identifiers: [DEST], firesOnPageLoad: true, consent: { status: 'built-in', builtIn: ['analytics_storage'] } }] },
    ],
    consentApi: [{ location: 'de', scenario: 'reject', apis: [], calls: 0, consentCalls: [], states: [], unknowns: [] }],
    notTested: [],
    researchQueue: [],
  });
}
