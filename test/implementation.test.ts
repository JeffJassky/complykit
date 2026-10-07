import { describe, it, expect } from 'vitest';
import { Timeline, type MarkupFinding, type PartyInventoryItem, type TagContainer, type ContainerTag } from '../src/record/index.js';
import {
  classifyImplementations,
  classifyImplementation,
  firstPartyCollectEndpoints,
  isGtmContainerUrl,
  scriptIndex,
  type ScriptIndex,
  otherTagManagerOf,
  buildTrackingEvaluation,
  type ImplementationInput,
} from '../src/rules/tracking/index.js';

// A6: one implementation class per party (client-consent design §3), with the
// precedence documented in src/rules/tracking/implementation.ts. Fixtures only.

const site = { url: 'https://www.example-shop.test/', host: 'www.example-shop.test', registrableDomain: 'example-shop.test' };
const PAGE = site.url;
const GTM = 'https://www.googletagmanager.com/gtm.js?id=GTM-XXXX01';

function party(partyId: string, over: Partial<PartyInventoryItem> = {}): PartyInventoryItem {
  const domain = over.domain ?? `${partyId.split('.')[0]}.test`;
  return {
    partyId,
    label: partyId,
    domain,
    hosts: [domain],
    recognized: !partyId.startsWith('unknown:'),
    kbStatus: 'confirmed',
    categories: ['advertising'],
    behavesLikeTracker: true,
    trackerSignals: [],
    sends: [],
    stores: [],
    sources: [],
    loadedBy: [],
    samples: [],
    seenIn: [{ location: 'local', scenario: 'do-nothing', requests: 1, firstMs: 10, phases: ['no-banner'] }],
    ...over,
  };
}

function finding(partyId: string, verdict: MarkupFinding['verdict'], over: Partial<MarkupFinding> = {}): MarkupFinding {
  return {
    partyId,
    label: partyId,
    recognized: true,
    verdict,
    trigger: verdict === 'leak' ? 'javascript-disabled' : undefined,
    kind: verdict === 'leak' ? 'img' : 'script',
    context: verdict === 'leak' ? 'noscript' : 'document',
    page: PAGE,
    line: 12,
    inline: verdict !== 'leak',
    attributes: {},
    matchedBy: 'inline-pattern',
    match: 'fbq(',
    locations: ['local'],
    alsoOn: [],
    occurrences: 1,
    ...over,
  };
}

function tag(partyId: string, over: Partial<ContainerTag> = {}): ContainerTag {
  return {
    tagId: 7,
    index: 0,
    template: '__cvt_X',
    templateLabel: 'Custom template',
    kind: 'tag',
    custom: true,
    paused: false,
    partyId,
    identifiers: [],
    loads: [],
    triggers: [],
    exceptions: [],
    events: [],
    firesOnPageLoad: true,
    consent: { status: 'none', additional: [], builtIn: [] },
    ...over,
  };
}

function container(tags: ContainerTag[], over: Partial<TagContainer> = {}): TagContainer {
  return { id: 'GTM-XXXX01', kind: 'gtm', url: GTM, fetchedAt: '2026-10-06T00:00:00Z', seenOn: [], status: 'parsed', tags, unmappedTemplates: [], warnings: [], ...over };
}

function markup(findings: MarkupFinding[]): ImplementationInput['markup'] {
  return { pages: [{ url: PAGE, status: 'inspected', locations: ['local'], elements: findings.length }], findings, unexplained: [] };
}

const one = (p: PartyInventoryItem, input: Partial<ImplementationInput> = {}) => classifyImplementation(p, { site, ...input });

describe('each class', () => {
  it('direct-script: first request traced to a <script> in the page', () => {
    const r = one(party('meta.pixel', { sources: ['markup'], loadedBy: [PAGE] }));
    expect(r.class).toBe('direct-script');
    expect(r.evidence[0]).toMatchObject({ kind: 'source', observed: true, url: PAGE });
  });

  it('direct-script: a gateable tag in the HTML with no traced request', () => {
    const r = one(party('meta.pixel', { sources: ['unknown'] }), { markup: markup([finding('meta.pixel', 'gateable')]) });
    expect(r.class).toBe('direct-script');
    expect(r.evidence[0]).toMatchObject({ kind: 'markup', observed: false, page: PAGE, line: 12, verdict: 'gateable' });
  });

  it('direct-script: a tag already held in markup (type="text/plain")', () => {
    const r = one(party('meta.pixel'), { markup: markup([finding('meta.pixel', 'held')]) });
    expect(r.class).toBe('direct-script');
    expect(r.evidence[0].note).toMatch(/already held back/);
  });

  it('markup-leak: a <noscript><img> in the HTML', () => {
    const r = one(party('meta.pixel'), { markup: markup([finding('meta.pixel', 'leak')]) });
    expect(r.class).toBe('markup-leak');
    expect(r.evidence[0]).toMatchObject({ kind: 'markup', line: 12, verdict: 'leak' });
    expect(r.evidence[0].note).toMatch(/without JavaScript/);
  });

  it('markup-leak: first request traced to a non-script element', () => {
    expect(one(party('x.pixel', { sources: ['markup-leak'] })).class).toBe('markup-leak');
  });

  it('gtm: loaded by a gtm.js container', () => {
    const r = one(party('meta.pixel', { sources: ['injected'], loadedBy: ['https://connect.facebook.test/fbevents.js', GTM] }));
    expect(r.class).toBe('gtm');
    expect(r.evidence[0]).toMatchObject({ kind: 'loader', observed: true, url: GTM });
  });

  it('gtm: a tag in a parsed container mapped to the party (nothing traced)', () => {
    const r = one(party('tiktok.pixel'), { containers: [container([tag('tiktok.pixel', { tagId: 12, consent: { status: 'required', additional: ['ad_storage'], builtIn: [] } })])] });
    expect(r.class).toBe('gtm');
    expect(r.evidence[0]).toMatchObject({ kind: 'container-tag', containerId: 'GTM-XXXX01', tagId: 12 });
    expect(r.evidence[0].note).toMatch(/consent: required/);
  });

  it('gtm: paused tags, helpers and unreadable containers are not evidence', () => {
    const containers = [
      container([tag('tiktok.pixel', { paused: true }), tag('tiktok.pixel', { kind: 'helper' })]),
      container([tag('tiktok.pixel')], { id: 'GTM-XXXX02', status: 'unreadable' }),
    ];
    expect(one(party('tiktok.pixel'), { containers }).class).toBe('unknown');
  });

  it('gtm: a first-party proxied gtm.js counts as a GTM container', () => {
    expect(isGtmContainerUrl('https://www.example-shop.test/metrics/gtm.js?id=GTM-XXXX03')).toBe(true);
    expect(isGtmContainerUrl('https://www.googletagmanager.com/gtag/js?id=G-XXXX01')).toBe(false);
  });

  it.each([
    ['https://tags.tiqcdn.com/utag/acme/main/prod/utag.js', 'Tealium iQ'],
    ['https://assets.adobedtm.com/abc/launch-123.min.js', 'Adobe Experience Platform Tags (Launch)'],
    ['https://cdn.segment.com/analytics.js/v1/KEY/analytics.min.js', 'Segment'],
    ['https://nexus.ensighten.com/acme/prod/Bootstrap.js', 'Ensighten'],
  ])('other-tag-manager: loaded by %s', (url, name) => {
    expect(otherTagManagerOf(url)).toBe(name);
    const r = one(party('criteo', { sources: ['injected'], loadedBy: [url] }));
    expect(r.class).toBe('other-tag-manager');
    expect(r.evidence[0].note).toContain(name);
  });

  it('platform: injected by the platform loader', () => {
    const loader = 'https://cdn.shopify.com/shopifycloud/web-pixels-manager/0.1/sandbox/modern/';
    const r = one(party('meta.pixel', { sources: ['platform'], loadedBy: [loader] }), { platform: { name: 'shopify' } });
    expect(r.class).toBe('platform');
    expect(r.evidence[0]).toMatchObject({ observed: true, url: loader });
  });

  it('cname: a first-party host CNAMEd to the vendor', () => {
    const r = one(party('adobe.analytics', { sources: ['first-party-proxy'] }), { cnames: { 'adobe.analytics': [{ host: 'metrics.example-shop.test', target: 'example-shop.sc.omtrdc.net' }] } });
    expect(r.class).toBe('cname');
    expect(r.evidence[0]).toMatchObject({ kind: 'cname', host: 'metrics.example-shop.test', target: 'example-shop.sc.omtrdc.net' });
  });

  it('server-side-suspected: only a first-party collect endpoint explains the party', () => {
    const r = one(party('google.analytics', { sources: ['unknown'], seenIn: [{ location: 'local', scenario: 'do-nothing', requests: 0, firstMs: 0, phases: [] }] }), {
      endpoints: [{ partyId: 'google.analytics', sample: 'sgtm.example-shop.test/g/collect?v&tid', host: 'sgtm.example-shop.test', pattern: '/g/collect', via: 'request' }],
    });
    expect(r.class).toBe('server-side-suspected');
    expect(r.evidence[0].note).toMatch(/cannot be verified/);
  });

  it('unknown: seen only through a known cookie name — fail closed, with the reason', () => {
    const r = one(party('google.analytics', { sources: ['unknown'], seenIn: [{ location: 'local', scenario: 'do-nothing', requests: 0, firstMs: 0, phases: [] }] }));
    expect(r.class).toBe('unknown');
    expect(r.evidence).toEqual([expect.objectContaining({ kind: 'none', note: expect.stringMatching(/no request to trace/) })]);
    expect(r.alsoSeen).toEqual([]);
  });

  it('unknown: dns-prefetch / preconnect hints are not an implementation', () => {
    expect(one(party('meta.pixel'), { markup: markup([finding('meta.pixel', 'hint', { kind: 'link' })]) }).class).toBe('unknown');
  });

  it('unknown: injected by a script nothing else explains', () => {
    const r = one(party('unknown:tracker.test', { sources: ['injected'], loadedBy: ['https://widgets.vendor.test/app.js'] }));
    expect(r.class).toBe('unknown');
    expect(r.evidence[0].note).toMatch(/could not be traced/);
  });
});

describe('precedence', () => {
  it('a GTM-loaded pixel that also ships a <noscript> leak is markup-leak (the leak wins)', () => {
    const r = one(party('meta.pixel', { sources: ['injected'], loadedBy: [GTM] }), {
      markup: markup([finding('meta.pixel', 'leak')]),
      containers: [container([tag('meta.pixel')])],
    });
    expect(r.class).toBe('markup-leak');
    expect(r.alsoSeen).toEqual(['gtm']);
    expect(r.evidence.map((e) => e.class)).toEqual(['markup-leak', 'gtm', 'gtm']);
  });

  it('markup-leak beats direct-script: the <script> can be gated, the <img> cannot', () => {
    const r = one(party('meta.pixel', { sources: ['markup'] }), { markup: markup([finding('meta.pixel', 'gateable'), finding('meta.pixel', 'leak')]) });
    expect(r.class).toBe('markup-leak');
    expect(r.alsoSeen).toEqual(['direct-script']);
  });

  it('markup-leak beats cname', () => {
    const r = one(party('adobe.analytics', { sources: ['first-party-proxy'] }), {
      markup: markup([finding('adobe.analytics', 'leak')]),
      cnames: { 'adobe.analytics': [{ host: 'metrics.example-shop.test' }] },
    });
    expect(r.class).toBe('markup-leak');
    expect(r.alsoSeen).toEqual(['cname']);
  });

  it('cname beats gtm and direct-script: the first-party cookies survive gating', () => {
    const r = one(party('adobe.analytics', { sources: ['first-party-proxy'] }), {
      markup: markup([finding('adobe.analytics', 'gateable')]),
      containers: [container([tag('adobe.analytics')])],
      cnames: { 'adobe.analytics': [{ host: 'metrics.example-shop.test' }] },
    });
    expect(r.class).toBe('cname');
    expect(r.alsoSeen).toEqual(['gtm', 'direct-script']);
  });

  it('in the HTML AND in a container: the path the scan saw fire wins', () => {
    const containers = [container([tag('meta.pixel')])];
    const viaMarkup = one(party('meta.pixel', { sources: ['markup'], loadedBy: [PAGE] }), { markup: markup([finding('meta.pixel', 'gateable')]), containers });
    expect(viaMarkup.class).toBe('direct-script');
    expect(viaMarkup.alsoSeen).toEqual(['gtm']);
    const viaGtm = one(party('meta.pixel', { sources: ['injected'], loadedBy: [GTM] }), { markup: markup([finding('meta.pixel', 'gateable')]), containers });
    expect(viaGtm.class).toBe('gtm');
    expect(viaGtm.alsoSeen).toEqual(['direct-script']);
  });

  it('in the HTML AND in a container, neither traced: the container wins (static tie-break)', () => {
    const r = one(party('meta.pixel'), { markup: markup([finding('meta.pixel', 'gateable')]), containers: [container([tag('meta.pixel')])] });
    expect(r.class).toBe('gtm');
    expect(r.alsoSeen).toEqual(['direct-script']);
  });

  it('a GTM container the platform injected still decides through its tags: gtm over platform', () => {
    const loader = 'https://cdn.shopify.com/extensions/abc/assets/app.js';
    const r = one(party('meta.pixel', { sources: ['platform'], loadedBy: [loader, GTM] }), { platform: { name: 'shopify' } });
    expect(r.class).toBe('gtm');
    expect(r.alsoSeen).toEqual(['platform']);
  });

  it('observed platform beats a static markup tag (the rewrite would not reach the injected copy)', () => {
    const loader = 'https://cdn.shopify.com/shopifycloud/web-pixels-manager/x.js';
    const r = one(party('meta.pixel', { sources: ['platform'], loadedBy: [loader] }), { platform: { name: 'shopify' }, markup: markup([finding('meta.pixel', 'gateable')]) });
    expect(r.class).toBe('platform');
    expect(r.alsoSeen).toEqual(['direct-script']);
  });

  it('server-side-suspected yields to a direct path and is kept in alsoSeen', () => {
    const r = one(party('google.analytics', { sources: ['injected'], loadedBy: [GTM] }), {
      endpoints: [{ partyId: 'google.analytics', sample: 'www.example-shop.test/g/collect', host: 'www.example-shop.test', pattern: '/g/collect', via: 'request' }],
    });
    expect(r.class).toBe('gtm');
    expect(r.alsoSeen).toEqual(['server-side-suspected']);
  });
});

describe('inheritance through another party’s script', () => {
  it('injected by a party whose script is in the HTML → direct-script (inferred)', () => {
    const loaderUrl = 'https://static.klaviyo.test/onsite/js/klaviyo.js';
    const inv = [
      party('klaviyo', { domain: 'klaviyo.test', hosts: ['static.klaviyo.test'], sources: ['markup'], loadedBy: [PAGE] }),
      party('unknown:fonts.test', { domain: 'fonts.test', sources: ['injected'], loadedBy: [loaderUrl] }),
    ];
    const m = classifyImplementations(inv, { site });
    expect(m.get('klaviyo')!.class).toBe('direct-script');
    const r = m.get('unknown:fonts.test')!;
    expect(r.class).toBe('direct-script');
    expect(r.evidence[0]).toMatchObject({ kind: 'loader', observed: false, url: loaderUrl });
    expect(r.evidence[0].note).toMatch(/injected by klaviyo/);
  });

  it('a loader that is itself GTM-loaded passes gtm on', () => {
    const inv = [
      party('google.tag-manager', { domain: 'googletagmanager.com', hosts: ['www.googletagmanager.com'], sources: ['injected'], loadedBy: [GTM] }),
      party('google.analytics', { sources: ['injected'], loadedBy: ['https://www.googletagmanager.com/gtag/js?id=G-XXXX01'] }),
    ];
    expect(classifyImplementations(inv, { site }).get('google.analytics')!.class).toBe('gtm');
  });

  it('a static container tag beats an inherited path', () => {
    const inv = [
      party('google.tag-manager', { domain: 'googletagmanager.com', hosts: ['www.googletagmanager.com'], sources: ['markup'], loadedBy: [PAGE] }),
      party('google.analytics', { sources: ['injected'], loadedBy: ['https://www.googletagmanager.com/gtag/js?id=G-XXXX01'] }),
    ];
    const r = classifyImplementations(inv, { site, containers: [container([tag('google.analytics')])] }).get('google.analytics')!;
    expect(r.class).toBe('gtm');
    expect(r.alsoSeen).toEqual(['direct-script']);
  });

  it('injected by the site’s own script → direct-script', () => {
    const own = 'https://www.example-shop.test/assets/app.js';
    const r = classifyImplementations([party('meta.pixel', { sources: ['injected'], loadedBy: [own] })], { site }).get('meta.pixel')!;
    expect(r.class).toBe('direct-script');
    expect(r.evidence[0]).toMatchObject({ kind: 'loader', observed: true, url: own });
  });

  it('cycles between loaders end in unknown, not a loop', () => {
    const inv = [
      party('a.vendor', { domain: 'a.test', hosts: ['a.test'], sources: ['injected'], loadedBy: ['https://b.test/x.js'] }),
      party('b.vendor', { domain: 'b.test', hosts: ['b.test'], sources: ['injected'], loadedBy: ['https://a.test/y.js'] }),
    ];
    const m = classifyImplementations(inv, { site });
    expect(m.get('a.vendor')!.class).toBe('unknown');
    expect(m.get('b.vendor')!.class).toBe('unknown');
  });
});

describe('tracing loaders through script chains', () => {
  const GTAG = 'https://www.googletagmanager.com/gtag/js?id=G-XXXX01';
  const idx = (byUrl: ScriptIndex['byUrl']): ScriptIndex => ({ byUrl, pages: [PAGE] });

  it('a gtag.js that GTM injected makes the party gtm, even though loadedBy names only gtag.js', () => {
    const scripts = idx({ [GTAG]: { initiator: 'script', chain: [GTM], resourceType: 'script' }, [GTM]: { initiator: 'parser', chain: [], resourceType: 'script' } });
    const r = one(party('google.analytics', { sources: ['injected'], loadedBy: [GTAG] }), { scripts });
    expect(r.class).toBe('gtm');
    expect(r.evidence[0]).toMatchObject({ kind: 'loader', observed: true, url: GTM });
    expect(r.evidence[0].note).toContain(`which loaded ${GTAG}`);
  });

  it('a gtag.js written in the page makes the party direct-script (observed)', () => {
    const scripts = idx({ [GTAG]: { initiator: 'parser', chain: [], resourceType: 'script' } });
    const r = one(party('google.analytics', { sources: ['injected'], loadedBy: [GTAG] }), { scripts });
    expect(r.class).toBe('direct-script');
    expect(r.evidence[0]).toMatchObject({ observed: true, url: GTAG });
  });

  it('whatever loads inside an <iframe> written in the page is a markup leak', () => {
    const embed = 'https://www.youtube.test/embed/abc';
    const scripts = idx({ [embed]: { initiator: 'parser', chain: [], resourceType: 'document' } });
    const r = one(party('google.fonts', { sources: ['injected'], loadedBy: [embed] }), { scripts });
    expect(r.class).toBe('markup-leak');
    expect(r.evidence[0].note).toMatch(/<iframe> written in the page/);
  });

  it('a platform loader further up the chain makes it platform', () => {
    const app = 'https://apps.vendor.test/widget.js';
    const loader = 'https://www.example-shop.test/cdn/wpm/abc.js';
    const scripts = idx({ [app]: { initiator: 'script', chain: [loader], resourceType: 'script' } });
    const r = one(party('unknown:vendor.test', { sources: ['injected'], loadedBy: [app] }), { scripts, platform: { name: 'shopify' } });
    expect(r.class).toBe('platform');
    expect(r.evidence[0].url).toBe(loader);
  });

  it('a party’s leak is not passed on through a script it serves', () => {
    const cdnScript = 'https://cdn.leaky.test/emoji.js';
    const inv = [
      party('unknown:leaky.test', { domain: 'leaky.test', hosts: ['cdn.leaky.test'], sources: ['markup-leak'] }),
      party('unknown:emoji.test', { domain: 'emoji.test', sources: ['injected'], loadedBy: [cdnScript] }),
    ];
    const scripts = idx({ [cdnScript]: { initiator: 'script', chain: [], resourceType: 'script' } });
    expect(classifyImplementations(inv, { site, scripts }).get('unknown:emoji.test')!.class).toBe('unknown');
  });

  it('scriptIndex records how each script and frame was requested', () => {
    const tl = timeline([
      req(GTM, { resourceType: 'script', initiator: { type: 'parser', chain: [] } }),
      req(GTAG, { resourceType: 'script', initiator: { type: 'script', chain: [GTM, 'chrome-extension://x/y.js'] } }),
      req('https://px.vendor.test/p.gif', { resourceType: 'image' }),
    ]);
    const i = scriptIndex([tl]);
    expect(Object.keys(i.byUrl)).toEqual([GTM, GTAG]);
    expect(i.byUrl[GTAG].chain).toEqual([GTM]);
    expect(i.pages).toEqual([PAGE]);
  });
});

describe('the platform’s own parties', () => {
  it('Shopify cookies seen only by name on a Shopify store are platform', () => {
    const r = one(party('shopify.cookies.essential', { owner: 'Shopify Inc.', sources: ['unknown'], seenIn: [] }), { platform: { name: 'shopify' } });
    expect(r.class).toBe('platform');
    expect(r.evidence[0].note).toMatch(/shopify platform’s own cookies/);
  });

  it('a platform CDN script written in the page is platform, not direct-script (the platform writes that markup)', () => {
    const r = one(party('shopify.cdn', { owner: 'Shopify Inc.', sources: ['markup'], loadedBy: [PAGE] }), { platform: { name: 'shopify' } });
    expect(r.class).toBe('platform');
    expect(r.alsoSeen).toEqual(['direct-script']);
  });

  it('the same party on a site that is not that platform stays direct-script', () => {
    expect(one(party('shopify.cdn', { owner: 'Shopify Inc.', sources: ['markup'], loadedBy: [PAGE] })).class).toBe('direct-script');
  });
});

// --- First-party endpoints and the evaluation wiring -------------------------------

let n = 0;
function req(url: string, over: Record<string, unknown> = {}) {
  n += 1;
  return { type: 'request', t: n * 10, id: `r${n}`, url, method: 'GET', resourceType: 'fetch', origin: 'page', pageUrl: PAGE, pageIndex: 0, initiator: { type: 'script', chain: [] }, setCookies: [], ...over };
}

function timeline(events: unknown[], snap: Record<string, unknown> = {}): Timeline {
  return Timeline.parse({
    location: { id: 'local' },
    verification: { verdict: 'unknown', expected: {}, observed: {}, sources: [], checkedAt: '2026-10-06T00:00:00Z' },
    events,
    snapshot: {
      site,
      scenario: 'do-nothing',
      locationId: 'local',
      startedAt: '2026-10-06T00:00:00Z',
      durationMs: 1000,
      gpc: false,
      browser: { name: 'chromium' },
      pages: [{ url: PAGE }],
      cookies: [],
      storage: [],
      frames: [],
      ...snap,
    },
  });
}

describe('firstPartyCollectEndpoints', () => {
  it('finds GA and Meta collect shapes on the site’s own domain only', () => {
    const tl = timeline([
      req('https://sgtm.example-shop.test/g/collect?v=2&tid=G-XXXX01&cid=1.2'),
      req('https://www.example-shop.test/collect', { method: 'POST', postData: 'v=2&tid=G-XXXX01&en=page_view' }),
      req('https://www.example-shop.test/api/collect?foo=1'), // no GA parameters
      req('https://capi.example-shop.test/tr/?id=000000000000001&ev=PageView'),
      req('https://www.example-shop.test/tr?x=1'), // not a pixel event
      req('https://www.google-analytics.com/g/collect?v=2&tid=G-XXXX01'), // third party
    ]);
    const eps = firstPartyCollectEndpoints([tl]);
    expect(eps.map((e) => [e.partyId, e.host, e.pattern])).toEqual([
      ['google.analytics', 'sgtm.example-shop.test', '/g/collect'],
      ['google.analytics', 'www.example-shop.test', '/collect'],
      ['meta.pixel', 'capi.example-shop.test', '/tr'],
    ]);
    expect(eps[0].sample).toBe('sgtm.example-shop.test/g/collect?v&tid&cid'); // keys only, never values
  });

  it('reads a first-party server-container URL from GTM tag settings', () => {
    const ct = container([tag('google.analytics', { tagId: 3, settings: { server_container_url: 'https://sgtm.example-shop.test' } }), tag('google.analytics', { tagId: 4, settings: { server_container_url: 'https://elsewhere.test' } })]);
    const eps = firstPartyCollectEndpoints([timeline([])], [ct]);
    expect(eps).toEqual([expect.objectContaining({ partyId: 'google.analytics', host: 'sgtm.example-shop.test', via: 'container', containerId: 'GTM-XXXX01', tagId: 3 })]);
  });
});

describe('buildTrackingEvaluation sets implementation on every party', () => {
  const base = {
    runId: 'r1',
    property: 'example-shop',
    site,
    versions: { kb: 'test', registry: 'test', package: 'test' },
    startedAt: '2026-10-06T00:00:00Z',
    finishedAt: '2026-10-06T00:01:00Z',
    locations: [],
    notTested: [],
    redacted: true,
  };

  it('server-side GA (a _ga cookie and a first-party /g/collect, nothing sent to Google)', () => {
    const tl = timeline([req('https://sgtm.example-shop.test/g/collect?v=2&tid=G-XXXX01')], {
      cookies: [{ name: '_ga', value: 'GA1.1.123456789.1700000000', domain: '.example-shop.test', expires: -1, httpOnly: false, secure: true }],
    });
    const ev = buildTrackingEvaluation({ ...base, timelines: [tl] });
    const ga = ev.inventory.find((p) => p.partyId === 'google.analytics')!;
    expect(ga.implementation?.class).toBe('server-side-suspected');
    for (const p of ev.inventory) expect(p.implementation).toBeDefined();
  });

  it('a CNAMEd first-party host is cname, with its target', () => {
    const tl = timeline([req('https://metrics.example-shop.test/b/ss/acme/1?AQB=1')], {
      dns: [{ host: 'metrics.example-shop.test', cname: ['example-shop.sc.omtrdc.net.'] }],
    });
    const ev = buildTrackingEvaluation({ ...base, timelines: [tl] });
    const adobe = ev.inventory.find((p) => p.partyId === 'adobe.analytics')!;
    expect(adobe.implementation).toMatchObject({ class: 'cname', evidence: [expect.objectContaining({ host: 'metrics.example-shop.test', target: 'example-shop.sc.omtrdc.net' })] });
  });

  it('a GTM-loaded party is gtm', () => {
    const tl = timeline([
      req(GTM, { resourceType: 'script', initiator: { type: 'parser', chain: [PAGE] } }),
      req('https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=X', { resourceType: 'script', initiator: { type: 'script', chain: [GTM] } }),
    ]);
    const ev = buildTrackingEvaluation({ ...base, timelines: [tl] });
    expect(ev.inventory.find((p) => p.partyId === 'tiktok.pixel')!.implementation?.class).toBe('gtm');
    expect(ev.inventory.find((p) => p.partyId === 'google.tag-manager')!.implementation?.class).toBe('direct-script');
  });
});

// --- Redirect hops and third-party frames (analyze.ts explainSource → A6) ---------

describe('redirect hops are followed, never read as markup', () => {
  const base = {
    runId: 'r1',
    property: 'example-shop',
    site,
    versions: { kb: 'test', registry: 'test', package: 'test' },
    startedAt: '2026-10-06T00:00:00Z',
    finishedAt: '2026-10-06T00:01:00Z',
    locations: [],
    notTested: [],
    redacted: true,
  };
  const TAG = 'https://tag.vendor.test/tag.js';
  const SYNC = 'https://px.vendor.test/c.gif';
  const inv = (tl: Timeline) => buildTrackingEvaluation({ ...base, timelines: [tl] }).inventory;
  // The vendor's tag is a <script> in the page; it fires a cookie-sync image that
  // 302s to a partner, which 302s back (the partner hop has no initiator at all).
  const chainEvents = (hop: Record<string, unknown>) => [
    req(TAG, { id: 'tag', resourceType: 'script', initiator: { type: 'parser', chain: [PAGE] } }),
    req(SYNC, { id: 'sync', resourceType: 'image', status: 302, initiator: { type: 'script', chain: [TAG], element: 'img' } }),
    req('https://c.partner.test/c.gif?ctsa=mr&SyncId=X1', { id: 'hop', resourceType: 'image', status: 302, initiator: { type: 'other', chain: [] }, ...hop }),
  ];

  it('a hop the collector linked (redirectedFrom) is attributed to the request that started it', () => {
    const p = inv(timeline(chainEvents({ redirectedFrom: 'sync' }))).find((x) => x.partyId === 'unknown:partner.test')!;
    expect(p.sources).toEqual(['injected']);
    expect(p.loadedBy[0]).toBe(SYNC);
    expect(p.loadedBy).toContain(TAG);
    expect(p.implementation?.class).not.toBe('markup-leak');
  });

  it('on an older record, a hop that names the earlier 3xx host in its URL is followed', () => {
    const tl = timeline(chainEvents({ url: 'https://c.partner.test/c.gif?ctsa=mr&RedC=px.vendor.test&SyncId=X1' }));
    const p = inv(tl).find((x) => x.partyId === 'unknown:partner.test')!;
    expect(p.sources).toEqual(['injected']);
    expect(p.loadedBy[0]).toBe(SYNC);
  });

  it('a hop whose origin cannot be found is unknown, not a markup leak', () => {
    const p = inv(timeline(chainEvents({}))).find((x) => x.partyId === 'unknown:partner.test')!;
    expect(p.sources).toEqual(['unknown']);
    expect(p.implementation?.class).toBe('unknown');
  });

  it('an <img> the page’s own parser fetched is still a markup leak', () => {
    const tl = timeline([req('https://px.leaky.test/p.gif?id=1', { resourceType: 'image', initiator: { type: 'parser', chain: [PAGE] } })]);
    const p = inv(tl).find((x) => x.partyId === 'unknown:leaky.test')!;
    expect(p.sources).toEqual(['markup-leak']);
    expect(p.implementation?.class).toBe('markup-leak');
  });

  it('what a third-party frame’s document fetched is the frame’s doing (injected, the frame as loader)', () => {
    const embed = 'https://www.video.test/embed/abc';
    const tl = timeline(
      [
        req(embed, { resourceType: 'document', initiator: { type: 'parser', chain: [PAGE] } }),
        req('https://fonts.fontcdn.test/f.woff2', { resourceType: 'font', origin: 'frame', frameUrl: embed, initiator: { type: 'parser', chain: [embed] } }),
      ],
      { frames: [{ url: embed }] },
    );
    const p = inv(tl).find((x) => x.partyId === 'unknown:fontcdn.test')!;
    expect(p.sources).toEqual(['injected']);
    expect(p.loadedBy).toEqual([embed]);
    // …and the frame itself is in the page: the font inherits the frame's leak.
    expect(p.implementation?.class).toBe('markup-leak');
    expect(p.implementation?.evidence[0]).toMatchObject({ kind: 'loader', url: embed });
  });
});

// --- The Google tag (gtag.js) on the load chain ---------------------------------------

describe('Google tag containers (gtag.js) as evidence', () => {
  const GTAG = 'https://www.googletagmanager.com/gtag/js?id=G-XXXX01';
  const idx = (byUrl: ScriptIndex['byUrl']): ScriptIndex => ({ byUrl, pages: [PAGE] });
  const gtag = (tags: ContainerTag[], over: Partial<TagContainer> = {}): TagContainer => container(tags, { id: 'G-XXXX01', kind: 'gtag', url: GTAG, ...over });
  const dest = tag('google.analytics', { tagId: 2, template: '__dest_ga', templateLabel: 'GA4 destination', custom: false, identifiers: ['G-XXXX01'], consent: { status: 'built-in', additional: [], builtIn: ['analytics_storage'] } });
  const signals = tag('google.analytics', { tagId: 5, kind: 'setting', template: '__ogt_google_signals', templateLabel: 'Google signals', custom: false, settings: { googleSignals: 'ENABLED' } });

  it('a party a gtag.js in the page loaded: direct-script, with the destination as container-tag evidence', () => {
    const scripts = idx({ [GTAG]: { initiator: 'parser', chain: [], resourceType: 'script' } });
    const r = one(party('google.analytics', { sources: ['injected'], loadedBy: [GTAG] }), { scripts, containers: [gtag([dest, signals])] });
    expect(r.class).toBe('direct-script');
    expect(r.evidence[0]).toMatchObject({ kind: 'loader', observed: true, url: GTAG });
    expect(r.evidence).toContainEqual(expect.objectContaining({ class: 'direct-script', kind: 'container-tag', containerId: 'G-XXXX01', tagId: 2 }));
  });

  it('no destination for the party: the settings that send to it are named (Google signals → DoubleClick)', () => {
    const scripts = idx({ [GTAG]: { initiator: 'parser', chain: [], resourceType: 'script' } });
    const r = one(party('google.ads.doubleclick', { sources: ['injected'], loadedBy: [GTAG] }), { scripts, containers: [gtag([dest, signals])] });
    const ev = r.evidence.find((e) => e.kind === 'container-tag')!;
    expect(ev.note).toMatch(/no destination of its own: sent by the tag’s settings \(Google signals\)/);
  });

  it('a gtag.js that GTM injected: the Google tag evidence is gtm-class', () => {
    const scripts = idx({ [GTAG]: { initiator: 'script', chain: [GTM], resourceType: 'script' }, [GTM]: { initiator: 'parser', chain: [], resourceType: 'script' } });
    const r = one(party('google.analytics', { sources: ['injected'], loadedBy: [GTAG] }), { scripts, containers: [gtag([dest])] });
    expect(r.class).toBe('gtm');
    expect(r.evidence).toContainEqual(expect.objectContaining({ class: 'gtm', kind: 'container-tag', containerId: 'G-XXXX01' }));
  });

  it('an unparsed Google tag adds no evidence, and an untraced gtag.js decides no class', () => {
    const scripts = idx({ [GTAG]: { initiator: 'parser', chain: [], resourceType: 'script' } });
    const r = one(party('google.analytics', { sources: ['injected'], loadedBy: [GTAG] }), { scripts, containers: [gtag([], { status: 'unreadable' })] });
    expect(r.evidence.some((e) => e.kind === 'container-tag')).toBe(false);
    const untraced = one(party('google.analytics', { sources: ['injected'], loadedBy: [GTAG] }), { containers: [gtag([dest])] });
    expect(untraced.evidence.some((e) => e.kind === 'container-tag')).toBe(false);
  });
});
