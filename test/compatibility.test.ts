import { describe, it, expect } from 'vitest';
import {
  Timeline,
  TrackingEvaluation,
  type ConsentApiObservation,
  type ContainerTag,
  type ImplementationClass,
  type LocationSummary,
  type MarkupFinding,
  type MarkupSection,
  type PartyInventoryItem,
  type TagContainer,
  type TimelineEvent,
} from '../src/record/index.js';
import {
  compatibilityFor,
  evaluateCompatibility,
  behaviorCellsFrom,
  consentToolDefaultFinding,
  consentTypesFor,
  verdictRank,
  buildTrackingEvaluation,
  summarizeConsentApi,
  type BehaviorCell,
  type CompatibilityInput,
} from '../src/rules/tracking/index.js';
import { DEFAULT_KB } from '../src/registry/index.js';

// B1: the compatibility verdict per tool (client-consent design §5), with the
// decision table documented in src/rules/tracking/compatibility.ts. Fixtures
// only. The property sweep at the end is the contract: no evidence combination
// yields 'gateable' without a gateable markup finding and no leak, and taking
// an input away never strengthens a verdict.

const PAGE = 'https://www.example-shop.test/';
const GTM = 'https://www.googletagmanager.com/gtm.js?id=GTM-XXXX01';

function party(partyId: string, impl: ImplementationClass | undefined, over: Partial<PartyInventoryItem> = {}, evidence: Partial<PartyInventoryItem['implementation'] & object>['evidence'] = []): PartyInventoryItem {
  return {
    partyId,
    label: partyId,
    domain: `${partyId.split('.')[0]}.test`,
    hosts: [`${partyId.split('.')[0]}.test`],
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
    seenIn: [{ location: 'local', scenario: 'reject', requests: 1, firstMs: 10, phases: ['after-reject'] }],
    ...(impl ? { implementation: { class: impl, evidence: evidence.length ? evidence : [{ class: impl, kind: 'none', observed: false, note: `fixture: ${impl}` }], alsoSeen: [] } } : {}),
    ...over,
  };
}

function finding(partyId: string, verdict: MarkupFinding['verdict'], over: Partial<MarkupFinding> = {}): MarkupFinding {
  return {
    partyId,
    label: partyId,
    recognized: true,
    verdict,
    trigger: verdict === 'leak' ? 'javascript-disabled' : 'page-load',
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

function markup(findings: MarkupFinding[], inspected = true): MarkupSection {
  return { pages: [{ url: PAGE, status: inspected ? 'inspected' : 'not-inspected', locations: ['local'], elements: findings.length }], findings, unexplained: [] };
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

function observation(over: Partial<ConsentApiObservation> = {}): ConsentApiObservation {
  return { location: 'local', scenario: 'reject', apis: [], calls: 0, consentCalls: [], states: [], unknowns: [], ...over };
}

/** A denied Consent Mode default observed before anything fired. */
const DENIED_DEFAULT = observation({
  apis: ['google'],
  calls: 3,
  consentCalls: [{ t: 5, api: 'google', call: 'gtag', command: 'consent default', action: 'default', phase: 'before-banner', consent: { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'denied' }, grants: false, denies: true, regional: false, pageIndex: 0 }],
});
const LATE_DEFAULT = observation({
  apis: ['google'],
  calls: 3,
  consentCalls: DENIED_DEFAULT.consentCalls,
  states: [{ state: 'default-after-load', api: 'google', t: 5, phase: 'before-banner', reason: 'Google tag (Consent Mode): the consent default was set 5 ms into the visit, after the Google tag had already loaded and taken over its queue; whatever ran before it was not governed by the default.' }],
});

const cell = (partyId: string, status: BehaviorCell['status'], scenario = 'reject'): BehaviorCell => ({ partyId, location: 'local', scenario, status, reason: `fixture ${status}`, ref: '/behaviorObservations/0' });

const kinds = (r: { changes: Array<{ kind: string }> }): string[] => r.changes.map((c) => c.kind);

describe('each verdict', () => {
  it('gateable: a direct <script> in the inspected HTML, no leak', () => {
    const r = compatibilityFor(party('meta.pixel', 'direct-script'), { markup: markup([finding('meta.pixel', 'gateable')]) });
    expect(r.verdict).toBe('gateable');
    expect(r.changes[0]).toMatchObject({ kind: 'rewrite-tag', page: PAGE, line: 12, element: 'inline <script>' });
    // Meta documents a consent call: additive, alongside gating.
    expect(r.changes[1]).toMatchObject({ kind: 'call-consent-api', api: 'Meta Pixel consent' });
    expect(r.changes[1].note).toMatch(/alongside gating/);
    expect(r.reasons.some((x) => x.source === 'markup' && x.ref === '/markup/findings/0')).toBe(true);
    expect(r.behaviorMismatch).toBe(false);
    expect(r.behaviorChecked).toBe(false);
    expect(r.reasons.at(-1)?.note).toMatch(/behavior not established/);
  });

  it('gateable → unknown when the HTML was not inspected, even with the implementation class set', () => {
    const r = compatibilityFor(party('meta.pixel', 'direct-script'), {});
    expect(r.verdict).toBe('unknown');
    expect(r.reasons.some((x) => /not inspected/.test(x.note))).toBe(true);
    expect(kinds(r)).toEqual(['needs-a-look']);
  });

  it('gateable → unknown when only a held-back tag was found (the live copy was not located)', () => {
    const r = compatibilityFor(party('meta.pixel', 'direct-script'), { markup: markup([finding('meta.pixel', 'held')]) });
    expect(r.verdict).toBe('unknown');
    expect(r.reasons.some((x) => /already held back/.test(x.note))).toBe(true);
  });

  it('gateable → unknown when traced at runtime but no tag found in the HTML', () => {
    const r = compatibilityFor(party('meta.pixel', 'direct-script', {}, [{ class: 'direct-script', kind: 'loader', observed: true, url: `${PAGE}bundle.js`, note: 'injected by the site’s own script' }]), { markup: markup([]) });
    expect(r.verdict).toBe('unknown');
    expect(r.changes[0].note).toContain('bundle.js');
  });

  it('uncontrollable: a markup leak, with the script copy still listed for gating', () => {
    const p = party('meta.pixel', 'markup-leak', {}, [{ class: 'markup-leak', kind: 'markup', observed: false, verdict: 'leak', page: PAGE, line: 40, note: '<img> in <noscript> in the served HTML (line 40)' }]);
    const r = compatibilityFor(p, { markup: markup([finding('meta.pixel', 'leak', { line: 40 }), finding('meta.pixel', 'gateable')]) });
    expect(r.verdict).toBe('uncontrollable');
    expect(kinds(r)).toEqual(['remove-leak', 'rewrite-tag']);
    expect(r.changes[0]).toMatchObject({ page: PAGE, line: 40, element: '<img> in <noscript>' });
    expect(r.changes[0].note).toMatch(/without JavaScript/);
  });

  it('uncontrollable: a leak traced at runtime to the page, without a located element', () => {
    const r = compatibilityFor(party('x.pixel', 'markup-leak', { sources: ['markup-leak'] }, [{ class: 'markup-leak', kind: 'source', observed: true, url: PAGE, note: 'first request traced to a non-script element in the page (image / iframe / preload)' }]), { markup: markup([]) });
    expect(r.verdict).toBe('uncontrollable');
    expect(r.changes[0]).toMatchObject({ kind: 'remove-leak' });
    expect(r.changes[0].note).toMatch(/not located in the inspected HTML/);
  });

  it('unknown, not uncontrollable: a non-script request with no initiator at all (a redirect hop looks the same)', () => {
    // e.g. a partner cookie-sync image reached through another tool's 302: no chain, no URL, nothing in the HTML.
    const p = party('x.pixel', 'markup-leak', { sources: ['markup-leak'] }, [{ class: 'markup-leak', kind: 'source', observed: true, note: 'first request traced to a non-script element in the page (image / iframe / preload)' }]);
    for (const m of [markup([]), undefined]) {
      const r = compatibilityFor(p, { markup: m });
      expect(r.verdict).toBe('unknown');
      expect(kinds(r)).toEqual(['needs-a-look']);
      expect(r.changes[0].note).toMatch(/redirect/);
    }
    // A located leak still decides it.
    expect(compatibilityFor(p, { markup: markup([finding('x.pixel', 'leak')]) }).verdict).toBe('uncontrollable');
  });

  it('uncontrollable: a CNAME — the DNS is the fix; the script can still be gated', () => {
    const p = party('adobe.analytics', 'cname', {}, [{ class: 'cname', kind: 'cname', observed: true, host: 'metrics.example-shop.test', target: 'example-shop.sc.omtrdc.net', note: 'metrics.example-shop.test is a CNAME to example-shop.sc.omtrdc.net — cookies it sets are first-party' }]);
    const r = compatibilityFor(p, { markup: markup([finding('adobe.analytics', 'gateable')]) });
    expect(r.verdict).toBe('uncontrollable');
    expect(r.changes[0]).toMatchObject({ kind: 'change-dns', host: 'metrics.example-shop.test', target: 'example-shop.sc.omtrdc.net' });
    expect(r.changes[1].kind).toBe('rewrite-tag');
  });

  it('uncontrollable: server-side suspected — cannot be verified from the browser', () => {
    const p = party('google.analytics', 'server-side-suspected', { categories: ['analytics'] }, [{ class: 'server-side-suspected', kind: 'endpoint', observed: false, url: 'sgtm.example-shop.test/g/collect?v&tid', note: 'first-party collect endpoint sgtm.example-shop.test/g/collect?v&tid — server-side forwarding is possible and cannot be verified from the browser' }]);
    const r = compatibilityFor(p, { markup: markup([]) });
    expect(r.verdict).toBe('uncontrollable');
    expect(r.changes).toEqual([expect.objectContaining({ kind: 'accepted-exposure', url: 'sgtm.example-shop.test/g/collect?v&tid' })]);
  });

  it('platform: the named platform’s consent API', () => {
    const r = compatibilityFor(party('meta.pixel', 'platform'), { platform: { name: 'shopify' }, markup: markup([]) });
    expect(r.verdict).toBe('platform');
    expect(r.changes[0]).toMatchObject({ kind: 'use-platform-api', platform: 'shopify' });
    expect(r.changes[0].api).toMatch(/customerPrivacy/);
  });

  it('platform → unknown when the platform was not identified', () => {
    const r = compatibilityFor(party('meta.pixel', 'platform'), { markup: markup([]) });
    expect(r.verdict).toBe('unknown');
    expect(r.changes[0].kind).toBe('needs-a-look');
  });

  it('platform: WordPress without the Consent API gets a warning reason', () => {
    const r = compatibilityFor(party('meta.pixel', 'platform'), { platform: { name: 'wordpress', consentPlugin: 'Complianz', wpConsentApi: false } });
    expect(r.verdict).toBe('platform');
    expect(r.reasons.some((x) => /WP Consent API was not detected/.test(x.note))).toBe(true);
  });

  it('tag-manager: another tag manager — configure it, internals unread', () => {
    const url = 'https://tags.tiqcdn.com/utag/acme/main/prod/utag.js';
    const r = compatibilityFor(party('criteo', 'other-tag-manager', {}, [{ class: 'other-tag-manager', kind: 'loader', observed: true, url, note: `loaded by Tealium iQ (${url})` }]), {});
    expect(r.verdict).toBe('tag-manager');
    expect(r.changes[0]).toMatchObject({ kind: 'configure-tag-manager', manager: 'Tealium iQ', url });
  });

  it('unknown: nothing traced', () => {
    const r = compatibilityFor(party('unknown:tracker.test', 'unknown'), { markup: markup([]) });
    expect(r.verdict).toBe('unknown');
    expect(kinds(r)).toEqual(['needs-a-look']);
  });

  it('unknown: a record without an implementation classification (older build)', () => {
    const r = compatibilityFor(party('meta.pixel', undefined), { markup: markup([finding('meta.pixel', 'gateable')]) });
    expect(r.verdict).toBe('unknown');
    expect(r.reasons[0].note).toMatch(/older build/);
  });
});

describe('tag-manager (GTM): a tag is gated only when the container, the requirement and a denied default all line up', () => {
  const required = tag('tiktok.pixel', { tagId: 12, consent: { status: 'required', additional: ['ad_storage'], builtIn: [] } });
  const gtm = (over: Partial<PartyInventoryItem> = {}) => party('tiktok.pixel', 'gtm', over, [{ class: 'gtm', kind: 'loader', observed: true, url: GTM, note: `loaded by the GTM container ${GTM}` }]);

  it('proven gated: parsed container + required + denied default observed, nothing undone', () => {
    const r = compatibilityFor(gtm(), { containers: [container([required])], consentApi: [DENIED_DEFAULT] });
    expect(r.verdict).toBe('tag-manager');
    expect(kinds(r)).not.toContain('gate-gtm-tag');
    expect(kinds(r)).not.toContain('set-consent-default');
    expect(r.reasons.some((x) => /— gated$/.test(x.note) && x.ref === '/containers/0/tags/0')).toBe(true);
    // TikTok's own API is still additive.
    expect(kinds(r)).toContain('call-consent-api');
  });

  it('required but no consent-API record at all → not proven; default + gate changes', () => {
    const r = compatibilityFor(gtm(), { containers: [container([required])] });
    expect(r.verdict).toBe('tag-manager');
    expect(kinds(r)).toContain('set-consent-default');
    expect(r.reasons.some((x) => /not proven to hold the tag/.test(x.note))).toBe(true);
  });

  it('required but no denied default observed → GTM treats the type as granted', () => {
    const r = compatibilityFor(gtm(), { containers: [container([required])], consentApi: [observation({ apis: ['google'], calls: 2 })] });
    expect(kinds(r)).toContain('set-consent-default');
    expect(r.reasons.some((x) => /no denied Consent Mode default was observed/.test(x.note))).toBe(true);
  });

  it('required, default observed but set after the tag loaded → not proven', () => {
    const r = compatibilityFor(gtm(), { containers: [container([required])], consentApi: [LATE_DEFAULT] });
    expect(kinds(r)).toContain('set-consent-default');
    expect(r.changes.find((c) => c.kind === 'set-consent-default')?.note).toMatch(/move the Consent Mode default/);
    expect(r.reasons.some((x) => x.ref === '/consentApi/0/states/0')).toBe(true);
  });

  it('required for a type the observed default did not deny → not proven', () => {
    const only = observation({ apis: ['google'], calls: 1, consentCalls: [{ ...DENIED_DEFAULT.consentCalls[0], consent: { analytics_storage: 'denied' } }] });
    const r = compatibilityFor(gtm(), { containers: [container([required])], consentApi: [only] });
    expect(r.reasons.some((x) => /did not deny ad_storage/.test(x.note))).toBe(true);
    expect(r.changes.find((c) => c.kind === 'set-consent-default')?.consentTypes).toContain('ad_storage');
  });

  it('a regional default proves nothing', () => {
    const regional = observation({ apis: ['google'], calls: 1, consentCalls: [{ ...DENIED_DEFAULT.consentCalls[0], regional: true }] });
    const r = compatibilityFor(gtm(), { containers: [container([required])], consentApi: [regional] });
    expect(kinds(r)).toContain('set-consent-default');
  });

  it.each([
    ['none', /no consent requirement/],
    ['built-in', /cookieless pings/],
    ['template-checks', /unverified/],
    ['unknown', /could not be characterised/],
  ] as const)('consent status %s → gate-gtm-tag with the consent types for the category', (status, why) => {
    const r = compatibilityFor(gtm(), { containers: [container([tag('tiktok.pixel', { tagId: 3, consent: { status, additional: [], builtIn: [] } })])], consentApi: [DENIED_DEFAULT] });
    expect(r.verdict).toBe('tag-manager');
    expect(r.changes.find((c) => c.kind === 'gate-gtm-tag')).toMatchObject({ containerId: 'GTM-XXXX01', tagId: 3, consentTypes: ['ad_storage', 'ad_user_data', 'ad_personalization'] });
    expect(r.reasons.some((x) => why.test(x.note))).toBe(true);
    // The observed default already denies the ad types: no default change needed.
    expect(kinds(r)).not.toContain('set-consent-default');
  });

  it('container unreadable → gate-gtm-tag without a tag id; never gated', () => {
    const r = compatibilityFor(gtm(), { containers: [container([], { status: 'unreadable', reason: 'no runtime data literal' })], consentApi: [DENIED_DEFAULT] });
    expect(r.verdict).toBe('tag-manager');
    const g = r.changes.find((c) => c.kind === 'gate-gtm-tag');
    expect(g).toMatchObject({ containerId: 'GTM-XXXX01' });
    expect(g?.tagId).toBeUndefined();
    expect(g?.note).toMatch(/could not be read/);
  });

  it('container not fetched at all → gate-gtm-tag naming the container from the loader URL', () => {
    const r = compatibilityFor(gtm(), {});
    expect(r.changes.find((c) => c.kind === 'gate-gtm-tag')).toMatchObject({ containerId: 'GTM-XXXX01' });
    expect(r.changes.find((c) => c.kind === 'gate-gtm-tag')?.note).toMatch(/not fetched/);
    expect(kinds(r)).toContain('set-consent-default');
  });

  it('container parsed but no tag mapped to the party → says so', () => {
    const r = compatibilityFor(gtm(), { containers: [container([tag('meta.pixel')])], consentApi: [DENIED_DEFAULT] });
    expect(r.changes.find((c) => c.kind === 'gate-gtm-tag')?.note).toMatch(/no tag in GTM-XXXX01 was mapped/);
  });

  it('paused tags and helpers are not evidence', () => {
    const r = compatibilityFor(gtm(), { containers: [container([tag('tiktok.pixel', { paused: true }), tag('tiktok.pixel', { kind: 'helper' })])], consentApi: [DENIED_DEFAULT] });
    expect(r.changes.find((c) => c.kind === 'gate-gtm-tag')?.tagId).toBeUndefined();
  });

  it('consentTypesFor maps categories to Consent Mode types, conservatively', () => {
    expect(consentTypesFor(['analytics'])).toEqual(['analytics_storage']);
    expect(consentTypesFor(['advertising', 'analytics'])).toEqual(['ad_storage', 'ad_user_data', 'ad_personalization', 'analytics_storage']);
    expect(consentTypesFor(['unknown'])).toEqual(['analytics_storage', 'ad_storage']);
  });
});

describe('the vendor consent API (A3 states → changes)', () => {
  it('not-called-after-refusal → call-consent-api with the revoke call', () => {
    const states: ConsentApiObservation['states'] = [{ state: 'not-called-after-refusal', api: 'meta', t: 900, phase: 'after-reject', reason: "Meta Pixel: running when the visitor chose 'reject' at 900 ms, and its consent API was never called — not before, not after." }];
    const r = compatibilityFor(party('meta.pixel', 'direct-script'), { markup: markup([finding('meta.pixel', 'gateable')]), consentApi: [observation({ apis: ['meta'], calls: 2, states })] });
    const calls = r.changes.filter((c) => c.kind === 'call-consent-api');
    expect(calls.some((c) => /fbq\('consent', 'revoke'\) was never made/.test(c.note))).toBe(true);
    expect(r.reasons.some((x) => x.ref === '/consentApi/0/states/0')).toBe(true);
  });

  it('grant-on-load → stop granting; states for another vendor’s API are ignored', () => {
    const states: ConsentApiObservation['states'] = [
      { state: 'grant-on-load', api: 'google', t: 10, phase: 'before-banner', reason: "Google tag (Consent Mode): a default of 'granted' (ad_storage) at 10 ms (gtag), before the banner appeared." },
      { state: 'grant-on-load', api: 'tiktok', t: 10, phase: 'before-banner', reason: 'TikTok Pixel: a grant: at 10 ms' },
    ];
    const r = compatibilityFor(party('google.ads.ccm', 'direct-script'), { markup: markup([finding('google.ads.ccm', 'gateable')]), consentApi: [observation({ apis: ['google', 'tiktok'], calls: 2, states })] });
    expect(r.changes.filter((c) => c.kind === 'call-consent-api' && /stop granting/.test(c.note))).toHaveLength(1);
    expect(r.reasons.filter((x) => x.source === 'consent-api')).toHaveLength(1);
  });

  it('a vendor with no documented API gets no call-consent-api change', () => {
    const r = compatibilityFor(party('hotjar', 'direct-script', { categories: ['session-recording'] }), { markup: markup([finding('hotjar', 'gateable', { match: 'hj(' })]) });
    expect(r.verdict).toBe('gateable');
    expect(kinds(r)).toEqual(['rewrite-tag']);
  });

  it('control facts add reasons: snippet leak not found, loads others, TCF-only', () => {
    const r = compatibilityFor(party('meta.pixel', 'direct-script'), { markup: markup([finding('meta.pixel', 'gateable')]) });
    expect(r.reasons.some((x) => x.source === 'control' && /none was found on the inspected pages/.test(x.note))).toBe(true);
    const c = compatibilityFor(party('criteo', 'direct-script'), { markup: markup([finding('criteo', 'gateable', { match: 'criteo' })]) });
    expect(c.reasons.some((x) => /IAB TCF string only/.test(x.note))).toBe(true);
    const g = compatibilityFor(party('google.tag-manager', 'direct-script', { categories: ['tag-manager'] }), { markup: markup([finding('google.tag-manager', 'gateable', { match: 'gtm.js' })]) });
    expect(g.reasons.some((x) => /loads other vendors/.test(x.note))).toBe(true);
  });
});

describe('purpose scope: no change for what needs no consent, conditions stated for the rest', () => {
  it('infrastructure (CMP, captcha, CDN, payments, necessary) keeps its verdict but lists no change', () => {
    const cmp = compatibilityFor(party('kb.cmp', 'direct-script', { categories: ['consent'] }), { markup: markup([finding('kb.cmp', 'gateable', { match: 'cmp.test' })]) });
    expect(cmp).toMatchObject({ verdict: 'gateable', purpose: 'not-required', changes: [] });
    expect(cmp.reasons.some((x) => /needs no consent/.test(x.note))).toBe(true);
    const cdn = compatibilityFor(party('kb.cdn', 'markup-leak', { categories: ['cdn'] }, [{ class: 'markup-leak', kind: 'markup', observed: false, verdict: 'leak', page: PAGE, line: 3, note: '<link> in the served HTML' }]), { markup: markup([finding('kb.cdn', 'leak', { kind: 'link', context: 'document' })]) });
    expect(cdn).toMatchObject({ verdict: 'uncontrollable', purpose: 'not-required', changes: [] });
    const unk = compatibilityFor(party('cloudflare', 'unknown', { categories: ['cdn', 'necessary'] }), { markup: markup([]) });
    expect(unk).toMatchObject({ verdict: 'unknown', changes: [] });
  });

  it('a behavior mismatch is never dropped, whatever the purpose', () => {
    const r = compatibilityFor(party('kb.cmp', 'direct-script', { categories: ['captcha'] }), { markup: markup([finding('kb.cmp', 'gateable')]), behavior: [cell('kb.cmp', 'mismatch')] });
    expect(kinds(r)).toEqual(['behavior-mismatch']);
  });

  it('a mixed purpose that includes a consent use is not exempt; unclassified and context say so', () => {
    expect(compatibilityFor(party('x', 'direct-script', { categories: ['cdn', 'analytics'] }), { markup: markup([finding('x', 'gateable')]) })).toMatchObject({ purpose: 'needs-consent', verdict: 'gateable' });
    const u = compatibilityFor(party('unknown:x.test', 'direct-script', { categories: ['unknown'] }), { markup: markup([finding('unknown:x.test', 'gateable')]) });
    expect(u.purpose).toBe('unclassified');
    expect(kinds(u)).toEqual(['rewrite-tag']);
    expect(u.reasons.some((x) => /classify it first/.test(x.note))).toBe(true);
    const c = compatibilityFor(party('x', 'direct-script', { categories: ['embed'] }), { markup: markup([finding('x', 'gateable')]) });
    expect(c.purpose).toBe('context');
    expect(c.reasons.some((x) => /strictly necessary/.test(x.note))).toBe(true);
  });
});

describe('actionability and wording', () => {
  it('a party injected by another party’s located tag points at that tag (page:line), not "a bundled script"', () => {
    const loader = 'https://cdn.widget.test/loader.js';
    const p = party('unknown:pixel.test', 'direct-script', { categories: ['advertising'] }, [{ class: 'direct-script', kind: 'loader', observed: true, url: loader, note: `injected by ${loader}, a <script> written in the page` }]);
    const r = compatibilityFor(p, { markup: markup([finding('unknown:widget.test', 'gateable', { inline: false, url: loader, line: 20, label: 'widget.test' })]) });
    expect(r.verdict).toBe('unknown');
    expect(r.changes[0]).toMatchObject({ kind: 'needs-a-look', page: PAGE, line: 20, url: loader });
    expect(r.changes[0].note).not.toMatch(/bundled/);
  });

  it('…also when the loader’s own tag is an inline snippet (matched by the loader’s party)', () => {
    const tagUrl = 'https://www.clarity.ms/tag/abc123';
    const p = party('microsoft.uet', 'direct-script', {}, [{ class: 'direct-script', kind: 'loader', observed: true, url: tagUrl, note: `injected by https://c.clarity.ms/c.gif, which traces back to ${tagUrl}, a <script> written in the page` }]);
    const r = compatibilityFor(p, { markup: markup([finding('microsoft.clarity', 'gateable', { line: 44, label: 'Microsoft Clarity', match: 'clarity(' })]) });
    expect(r.verdict).toBe('unknown');
    expect(r.changes[0]).toMatchObject({ kind: 'needs-a-look', page: PAGE, line: 44 });
    expect(r.changes[0].note).toMatch(/see Microsoft Clarity/);
  });

  it('A3 states: one change per state kind naming every visit, not one per visit', () => {
    const st = (scenario: string) => observation({ scenario: scenario as ConsentApiObservation['scenario'], apis: ['google'], states: [{ state: 'grant-on-load', api: 'google', t: 10, phase: 'before-banner', reason: "Google tag (Consent Mode): a default of 'granted' (ad_storage) at 10 ms (gtag), before the banner appeared." }] });
    const r = compatibilityFor(party('google.ads.ccm', 'direct-script'), { markup: markup([finding('google.ads.ccm', 'gateable')]), consentApi: [st('browse'), st('do-nothing'), st('gpc')] });
    const grants = r.changes.filter((c) => /granted|granting/.test(c.note));
    expect(grants).toHaveLength(1);
    expect(grants[0].note).toMatch(/3 visit\(s\): local:browse, local:do-nothing, local:gpc/);
    expect(r.reasons.filter((x) => x.source === 'consent-api')).toHaveLength(3);
    // Observed under US opt-out only: the change says where it is (and is not) a problem.
    const us = compatibilityFor(party('google.ads.ccm', 'direct-script'), { markup: markup([finding('google.ads.ccm', 'gateable')]), consentApi: [st('browse')], regimes: { local: 'opt-out' } });
    expect(us.changes.find((c) => /granted/.test(c.note))?.note).toMatch(/US opt-out rules only.*location-aware/);
    // …but a GPC visit in a state that must honor the signal stays strict.
    const ca = compatibilityFor(party('google.ads.ccm', 'direct-script'), { markup: markup([finding('google.ads.ccm', 'gateable')]), consentApi: [st('gpc')], regimes: { local: 'opt-out-signal' } });
    expect(ca.changes.find((c) => /grant/.test(c.note))?.note).toMatch(/^stop granting on load/);
  });

  it('platform: no vendor-API change the owner cannot make; the server-side gap is stated', () => {
    const r = compatibilityFor(party('meta.pixel', 'platform'), { platform: { name: 'shopify' }, markup: markup([]) });
    expect(kinds(r)).toEqual(['use-platform-api']);
    expect(r.reasons.some((x) => /server-side/.test(x.note) && /cannot be verified/.test(x.note))).toBe(true);
    expect(r.reasons.some((x) => /platform \(or the vendor's app\) that must call it/.test(x.note))).toBe(true);
  });
});

describe('summarizeConsentApi: necessary Consent Mode types are not a grant', () => {
  const tl = (consent: Record<string, string>) =>
    Timeline.parse({
      location: { id: 'local' },
      verification: { verdict: 'unknown', expected: {}, observed: {}, sources: [], checkedAt: '2026-10-06T00:00:00Z' },
      events: [{ type: 'consent-api', t: 5, api: 'google', kind: 'call', call: 'gtag', args: ['consent', 'default', consent], frameUrl: PAGE, top: true, chain: [], pageIndex: 0 }],
      snapshot: { site: { url: PAGE, host: 'www.example-shop.test', registrableDomain: 'example-shop.test' }, scenario: 'browse', locationId: 'local', startedAt: '2026-10-06T00:00:00Z', durationMs: 1000, gpc: false, browser: { name: 'chromium' }, pages: [{ url: PAGE }], cookies: [], storage: [], frames: [] },
    });

  it("a default granting only security_storage is not 'grant-on-load' (and cannot break a GTM proof)", () => {
    const o = summarizeConsentApi(tl({ security_storage: 'granted', ad_storage: 'denied', analytics_storage: 'denied' }));
    expect(o.states).toEqual([]);
    expect(o.consentCalls[0]).toMatchObject({ grants: false, denies: true });
  });

  it('a default granting a consent type still is', () => {
    const o = summarizeConsentApi(tl({ security_storage: 'granted', analytics_storage: 'granted' }));
    expect(o.states.map((s) => s.state)).toEqual(['grant-on-load']);
    expect(o.states[0].reason).toMatch(/\(analytics_storage\)/);
  });
});

describe('behavior outranks implementation', () => {
  it('a mismatch anywhere sets behaviorMismatch and puts it first in the change list', () => {
    const r = compatibilityFor(party('meta.pixel', 'direct-script'), { markup: markup([finding('meta.pixel', 'gateable')]), behavior: [cell('meta.pixel', 'no-mismatch-observed', 'accept'), cell('meta.pixel', 'mismatch'), cell('other', 'mismatch')] });
    expect(r.verdict).toBe('gateable');
    expect(r.behaviorMismatch).toBe(true);
    expect(r.behaviorChecked).toBe(true);
    expect(r.changes[0].kind).toBe('behavior-mismatch');
    expect(r.changes[0].note).toMatch(/local:reject/);
    expect(r.changes[0].note).toMatch(/does not hold meta.pixel back/);
    expect(r.reasons[0]).toMatchObject({ source: 'behavior', ref: '/behaviorObservations/0' });
  });

  it('a mismatch on a proven-gated GTM tag still says so first', () => {
    const required = tag('tiktok.pixel', { tagId: 12, consent: { status: 'required', additional: ['ad_storage'], builtIn: [] } });
    const r = compatibilityFor(party('tiktok.pixel', 'gtm'), { containers: [container([required])], consentApi: [DENIED_DEFAULT], behavior: [cell('tiktok.pixel', 'mismatch')] });
    expect(r.behaviorMismatch).toBe(true);
    expect(r.changes[0].kind).toBe('behavior-mismatch');
  });

  it('no comparable cell → behaviorChecked false, with the reason, never a pass', () => {
    const r = compatibilityFor(party('meta.pixel', 'direct-script'), { markup: markup([finding('meta.pixel', 'gateable')]), behavior: [{ ...cell('meta.pixel', 'not-established'), reason: 'the test location was not verified' }] });
    expect(r.behaviorMismatch).toBe(false);
    expect(r.behaviorChecked).toBe(false);
    expect(r.reasons.at(-1)?.note).toMatch(/not established \(the test location was not verified\)/);
  });
});

describe('behaviorCellsFrom: the matrix expectation, narrowed', () => {
  const loc = (over: Partial<LocationSummary> = {}, jurisdictions = ['eu'], scenarios: LocationSummary['scenarios'] = [{ scenario: 'reject', status: 'tested', choice: { kind: 'reject', ok: true, method: 'selector' }, evidence: { screenshots: [] } }]): LocationSummary => ({
    spec: { id: 'local', proxied: false },
    verification: { verdict: 'verified', expected: {}, observed: {}, sources: [], siteReported: [], jurisdictions, checkedAt: '2026-10-06T00:00:00Z' },
    scenarios,
    ...over,
  });
  const obs = (dataRequestPhases: Record<string, number>, limited: Record<string, number> = {}, stores: Array<{ name: string; presentAtEnd: boolean; writePhases: string[] }> = []) => [
    { location: 'local', scenario: 'reject' as const, durationMs: 1000, knownPartyIds: ['meta.pixel'], parties: [{ partyId: 'meta.pixel', dataRequests: 1, requestPhases: Object.keys(dataRequestPhases), dataRequestPhases, limitedRequestsByPhase: limited, stores: stores.map((s) => ({ ...s, kind: 'cookie', attribution: 'observed' as const })) }] },
  ];
  const inv = [party('meta.pixel', 'direct-script')];

  it('active after rejection under opt-in rules → mismatch', () => {
    const cells = behaviorCellsFrom({ locations: [loc()], inventory: inv, behaviorObservations: obs({ 'after-reject': 2 }) });
    expect(cells).toEqual([expect.objectContaining({ partyId: 'meta.pixel', scenario: 'reject', status: 'mismatch', ref: '/behaviorObservations/0' })]);
    expect(cells[0].reason).toMatch(/2 data request\(s\) after rejecting, where opt-in rules expect it off/);
  });

  it('a surviving cookie alone is activity', () => {
    const cells = behaviorCellsFrom({ locations: [loc()], inventory: inv, behaviorObservations: obs({}, {}, [{ name: '_fbp', presentAtEnd: true, writePhases: [] }]) });
    expect(cells[0].status).toBe('mismatch');
  });

  it('nothing after rejection → no mismatch observed (not "clean")', () => {
    const cells = behaviorCellsFrom({ locations: [loc()], inventory: inv, behaviorObservations: obs({ 'before-choice': 3 }) });
    expect(cells[0].status).toBe('no-mismatch-observed');
  });

  it('limited-only pings: contested under opt-in (not established), expected under US opt-out', () => {
    const eu = behaviorCellsFrom({ locations: [loc()], inventory: inv, behaviorObservations: obs({ 'after-reject': 2 }, { 'after-reject': 2 }) });
    expect(eu[0].status).toBe('not-established');
    const us = behaviorCellsFrom({ locations: [loc({}, ['us', 'us-ca'])], inventory: inv, behaviorObservations: obs({ 'after-reject': 2 }, { 'after-reject': 2 }) });
    expect(us[0].status).toBe('no-mismatch-observed');
  });

  it('US opt-out: a refusal must be honored; a plain do-nothing may run', () => {
    const scenarios: LocationSummary['scenarios'] = [{ scenario: 'do-nothing', status: 'tested', evidence: { screenshots: [] } }];
    const o = [{ ...obs({ 'no-banner': 2 })[0], scenario: 'do-nothing' as const }];
    const cells = behaviorCellsFrom({ locations: [loc({}, ['us', 'us-tx'], scenarios)], inventory: inv, behaviorObservations: o });
    expect(cells[0].status).toBe('no-mismatch-observed');
    expect(cells[0].reason).toMatch(/may run/);
  });

  // The accept visit planned for US opt-out locations (a banner there can hold vendors until accepted):
  // an advertising vendor running after acceptance is expected, never a mismatch.
  it.each([
    ['opt-out-signal (us-ca)', ['us', 'us-ca']],
    ['opt-out-signal (us-tx)', ['us', 'us-tx']],
  ])('US %s: active after acceptance → may run, not a mismatch', (_name, jurisdictions) => {
    const scenarios: LocationSummary['scenarios'] = [{ scenario: 'accept', status: 'tested', choice: { kind: 'accept', ok: true, method: 'autoconsent' }, evidence: { screenshots: [] } }];
    const o = [{ ...obs({ 'after-accept': 4 }, {}, [{ name: '_fbp', presentAtEnd: true, writePhases: ['after-accept'] }])[0], scenario: 'accept' as const }];
    const cells = behaviorCellsFrom({ locations: [loc({}, jurisdictions, scenarios)], inventory: inv, behaviorObservations: o });
    expect(cells).toEqual([expect.objectContaining({ partyId: 'meta.pixel', scenario: 'accept', status: 'no-mismatch-observed', ref: '/behaviorObservations/0' })]);
    expect(cells[0].reason).toMatch(/may run in this scenario under opt-out/);
  });

  it.each([
    ['unverified location', loc({ verification: { verdict: 'unknown', expected: {}, observed: {}, sources: [], siteReported: [], jurisdictions: [], checkedAt: '' } }), /not verified/],
    ['unknown regime', loc({}, ['br']), /no automatic expectation/],
    ['choice not confirmed', loc({}, ['eu'], [{ scenario: 'reject', status: 'tested', choice: { kind: 'reject', ok: false, method: 'selector' }, evidence: { screenshots: [] } }]), /choice was not confirmed/],
    ['scenario not run', loc({}, ['eu'], [{ scenario: 'reject', status: 'not-tested', reason: 'no banner', evidence: { screenshots: [] } }]), /no banner/],
  ])('%s → not established', (_name, location, why) => {
    const cells = behaviorCellsFrom({ locations: [location], inventory: inv, behaviorObservations: obs({ 'after-reject': 2 }) });
    expect(cells[0].status).toBe('not-established');
    expect(cells[0].reason).toMatch(why);
  });

  it('a context use (chat, embed, …) active before a choice under opt-in is a review, not "may run" (the matrix agrees)', () => {
    const scenarios: LocationSummary['scenarios'] = [{ scenario: 'do-nothing', status: 'tested', evidence: { screenshots: [] } }];
    const o = [{ ...obs({ 'no-banner': 2 })[0], scenario: 'do-nothing' as const }];
    const chat = [party('meta.pixel', 'direct-script', { categories: ['chat'] })];
    expect(behaviorCellsFrom({ locations: [loc({}, ['eu'], scenarios)], inventory: chat, behaviorObservations: o })[0].status).toBe('not-established');
    expect(behaviorCellsFrom({ locations: [loc({}, ['us', 'us-tx'], scenarios)], inventory: chat, behaviorObservations: o })[0].status).toBe('no-mismatch-observed');
  });

  it('an unclassified purpose cannot be compared', () => {
    const cells = behaviorCellsFrom({ locations: [loc()], inventory: [party('meta.pixel', 'direct-script', { categories: ['unknown'] })], behaviorObservations: obs({ 'after-reject': 2 }) });
    expect(cells[0]).toMatchObject({ status: 'not-established', reason: 'the purpose is not classified' });
  });

  it('repeat runs produce one cell each', () => {
    const o = [{ ...obs({ 'after-reject': 0 })[0], run: 1 }, { ...obs({ 'after-reject': 1 })[0], run: 2, throttled: true }];
    const cells = behaviorCellsFrom({ locations: [loc()], inventory: inv, behaviorObservations: o });
    expect(cells.map((c) => [c.run, c.status])).toEqual([[1, 'no-mismatch-observed'], [2, 'mismatch']]);
  });
});

describe('the consent tool’s default (A4 → finding)', () => {
  const loc = (scenarios: LocationSummary['scenarios']): LocationSummary => ({ spec: { id: 'local', proxied: false }, verification: { verdict: 'verified', expected: {}, observed: {}, sources: [], siteReported: [], jurisdictions: ['eu'], checkedAt: '' }, scenarios });
  const sc = (scenario: LocationSummary['scenarios'][number]['scenario'], consentTool: LocationSummary['scenarios'][number]['consentTool']): LocationSummary['scenarios'][number] => ({ scenario, status: 'tested', consentTool, evidence: { screenshots: [] } });

  it('a decoded default granting a non-necessary category without a recorded choice', () => {
    const f = consentToolDefaultFinding([loc([sc('do-nothing', { vendor: 'Cookiebot', defaultGrants: { necessary: true, marketing: true, analytics: false }, decoded: true, choiceRecorded: false, source: 'cookie:CookieConsent' })])]);
    expect(f.status).toBe('grants-by-default');
    expect(f.grants).toEqual(['marketing']);
    expect(f.observed).toEqual([{ location: 'local', scenario: 'do-nothing', source: 'cookie:CookieConsent', grants: ['marketing'] }]);
    expect(f.note).toMatch(/Cookiebot .* grants marketing before any choice/);
  });

  it('a recorded choice is not a default; necessary-only is no grant', () => {
    const f = consentToolDefaultFinding([
      loc([sc('return-visit', { vendor: 'OneTrust', defaultGrants: { marketing: true }, decoded: true, choiceRecorded: true, source: 'cookie:OptanonConsent' }), sc('do-nothing', { vendor: 'OneTrust', defaultGrants: { necessary: true }, decoded: true, choiceRecorded: false, source: 'cookie:OptanonConsent' })]),
    ]);
    expect(f.status).toBe('no-grants-decoded');
  });

  it('decoded:false is "not observed", never "nothing granted"', () => {
    const f = consentToolDefaultFinding([loc([sc('do-nothing', { vendor: 'Termly', defaultGrants: {}, decoded: false, source: 'cookie:consentUUID' })])]);
    expect(f).toMatchObject({ status: 'not-observed', vendor: 'Termly' });
    expect(f.note).toMatch(/not observed/);
    expect(consentToolDefaultFinding([loc([sc('do-nothing', undefined)])])).toMatchObject({ status: 'not-observed', vendor: null });
  });
});

// --- The Google tag (gtag.js), iframes, duplicates ------------------------------------

describe('the Google tag path: a party loaded by a gtag.js snippet in the HTML', () => {
  const GTAG = 'https://www.googletagmanager.com/gtag/js?id=G-XXXX01';
  const snippet = finding('google.tag-manager', 'gateable', { inline: false, url: GTAG, line: 20, label: 'Google Tag Manager / gtag.js', matchedBy: 'host', match: 'www.googletagmanager.com' });
  const loaderEv = { class: 'direct-script' as const, kind: 'loader' as const, observed: true, url: GTAG, note: `injected by ${GTAG}, a <script> written in the page` };
  const destEv = { class: 'direct-script' as const, kind: 'container-tag' as const, observed: false, containerId: 'G-XXXX01', tagId: 2, url: GTAG, note: 'Google tag G-XXXX01 destination G-XXXX01 (GA4 destination), consent: built-in' };
  const ga = () => party('google.analytics', 'direct-script', { categories: ['analytics'], sources: ['injected'], loadedBy: [GTAG] }, [loaderEv, destEv]);
  const gtagContainer = (over: Partial<TagContainer> = {}): TagContainer =>
    container(
      [
        tag('google.analytics', { tagId: 2, template: '__dest_ga', templateLabel: 'GA4 destination', custom: false, identifiers: ['G-XXXX01'], consent: { status: 'built-in', additional: [], builtIn: ['analytics_storage'] } }),
        tag('google.analytics', { tagId: 5, kind: 'setting', template: '__ogt_google_signals', templateLabel: 'Google signals', custom: false, settings: { googleSignals: 'ENABLED' } }),
        tag('google.analytics', { tagId: 6, kind: 'setting', template: '__ogt_1p_data_v2', templateLabel: 'User-provided data collection (automatic)', custom: false, settings: { isAutoEnabled: true, isEnabled: true } }),
      ],
      { id: 'G-XXXX01', kind: 'gtag', url: GTAG, ...over },
    );

  it('tag-manager (never gateable): a Consent Mode default in the snippet, anchored at its page:line, and the settings that matter', () => {
    const r = compatibilityFor(ga(), { markup: markup([snippet]), containers: [gtagContainer()], consentApi: [observation()] });
    expect(r.verdict).toBe('tag-manager');
    expect(kinds(r)).toEqual(['configure-tag-manager', 'set-consent-default', 'call-consent-api']);
    const def = r.changes.find((c) => c.kind === 'set-consent-default')!;
    expect(def).toMatchObject({ page: PAGE, line: 20, containerId: 'G-XXXX01', consentTypes: ['analytics_storage'] });
    expect(def.note).toMatch(/before gtag\('config', 'G-XXXX01'\)/);
    const cfg = r.changes.find((c) => c.kind === 'configure-tag-manager')!;
    expect(cfg).toMatchObject({ manager: 'Google tag', containerId: 'G-XXXX01' });
    expect(cfg.note).toMatch(/Google signals/);
    expect(cfg.note).toMatch(/user-provided data/);
    expect(r.reasons.some((x) => /no "require consent" setting/.test(x.note))).toBe(true);
  });

  it('a denied default observed: no default change, and the reason says pings continue', () => {
    const r = compatibilityFor(ga(), { markup: markup([snippet]), containers: [gtagContainer()], consentApi: [DENIED_DEFAULT] });
    expect(r.verdict).toBe('tag-manager');
    expect(kinds(r)).not.toContain('set-consent-default');
    expect(r.reasons.some((x) => /cookieless pings while denied — requests continue/.test(x.note))).toBe(true);
  });

  it('settings switched off are not listed; a party with no destination gets only the settings that send to it', () => {
    const off = gtagContainer({ tags: gtagContainer().tags.map((t) => (t.template === '__ogt_google_signals' ? { ...t, settings: { googleSignals: 'DISABLED' } } : t)) });
    const r = compatibilityFor(ga(), { markup: markup([snippet]), containers: [off], consentApi: [DENIED_DEFAULT] });
    expect(r.changes.find((c) => c.kind === 'configure-tag-manager')!.note).not.toMatch(/Google signals/);
    const dc = party('google.ads.doubleclick', 'direct-script', { sources: ['injected'], loadedBy: [GTAG] }, [loaderEv]);
    const d = compatibilityFor(dc, { markup: markup([snippet]), containers: [gtagContainer()], consentApi: [DENIED_DEFAULT] });
    const cfg = d.changes.find((c) => c.kind === 'configure-tag-manager')!;
    expect(cfg.note).toMatch(/Google signals/);
    expect(cfg.note).not.toMatch(/user-provided data/); // not this party's destination
  });

  it('the snippet not located → unknown, with needs-a-look and the same Google tag changes', () => {
    const r = compatibilityFor(ga(), { markup: markup([]), containers: [gtagContainer()], consentApi: [observation()] });
    expect(r.verdict).toBe('unknown');
    expect(kinds(r)).toEqual(expect.arrayContaining(['needs-a-look', 'configure-tag-manager', 'set-consent-default']));
  });

  it('the Google tag not fetched: says so, still lists the default', () => {
    const r = compatibilityFor(ga(), { markup: markup([snippet]), containers: [], consentApi: [observation()] });
    expect(r.verdict).toBe('tag-manager');
    expect(r.reasons.some((x) => /Google tag G-XXXX01 was not fetched/.test(x.note))).toBe(true);
    expect(kinds(r)).toContain('set-consent-default');
  });

  it('a GTM-loaded party whose gtag.js GTM injected gets the Google tag settings too, with one default', () => {
    const p = party('google.analytics', 'gtm', { categories: ['analytics'], sources: ['injected'], loadedBy: [GTAG] }, [{ class: 'gtm', kind: 'loader', observed: true, url: GTM, note: `loaded by the GTM container ${GTM}` }]);
    const r = compatibilityFor(p, { containers: [container([tag('google.analytics', { template: '__googtag', templateLabel: 'Google tag', consent: { status: 'built-in', additional: [], builtIn: ['analytics_storage'] } })]), gtagContainer()], consentApi: [observation()] });
    expect(r.verdict).toBe('tag-manager');
    expect(r.changes.filter((c) => c.kind === 'set-consent-default')).toHaveLength(1);
    expect(kinds(r)).toEqual(expect.arrayContaining(['gate-gtm-tag', 'configure-tag-manager']));
  });

  it('property: across markup / containers / consent-API inputs, never gateable, and less evidence never strengthens it', () => {
    const markups = [undefined, markup([], false), markup([]), markup([snippet])];
    const containersSet = [undefined, [], [gtagContainer()], [gtagContainer({ status: 'unreadable', tags: [] })]];
    const apis = [undefined, [observation()], [DENIED_DEFAULT], [LATE_DEFAULT]];
    for (const m of markups)
      for (const c of containersSet)
        for (const a of apis) {
          const input: CompatibilityInput = { markup: m, containers: c, consentApi: a };
          const r = compatibilityFor(ga(), input);
          expect(r.verdict).not.toBe('gateable');
          if (r.verdict === 'unknown') expect(kinds(r)).toContain('needs-a-look');
          for (const key of ['markup', 'containers', 'consentApi'] as const) {
            const reduced = compatibilityFor(ga(), { ...input, [key]: undefined });
            expect(verdictRank(reduced.verdict) <= verdictRank(r.verdict)).toBe(true);
          }
        }
  });
});

// complykit#48: the page pushes gtag('config', 'G-…') into the dataLayer; a GTM
// container sees it and loads gtag/js?id=G-…&cx=c for that destination itself.
// No container tag carries the id, so "require consent on tag N" is not a change
// the owner can make: the config snippet must be held (plus the consent default).
describe("a Google tag destination GTM loads from a gtag('config') command in the page (#48)", () => {
  const ID = 'G-TEST0001X';
  const CX = `https://www.googletagmanager.com/gtag/js?id=${ID}&l=dataLayer&cx=c&gtm=45x0`;
  const DATA = { attribute: 'src', mediaType: 'text/javascript', encoding: 'base64' as const };
  const dataSnippet = finding('google.analytics', 'gateable', { line: 10, ids: [ID], match: "gtag('config', 'G-", dataUrl: DATA, attributes: { defer: '', src: 'data:text/javascript;base64,…' } });
  const plainSnippet = finding('google.analytics', 'gateable', { line: 10, ids: [ID], match: "gtag('config', 'G-" });
  // The same snippet matched only under another party (its body also names a GTM id).
  const otherParty = finding('google.tag-manager', 'gateable', { line: 10, ids: ['GTM-XXXX01', ID], match: 'GTM-XXXX01', matchedBy: 'inline-id' });
  const gtmEv = { class: 'gtm' as const, kind: 'loader' as const, observed: true, url: GTM, note: `loaded by the GTM container ${GTM}, which loaded ${CX}` };
  const ga = () => party('google.analytics', 'gtm', { categories: ['analytics'], sources: ['injected'], loadedBy: [CX] }, [gtmEv]);
  // Parsed, with tags — none of them for the destination.
  const unrelated = container([tag('tiktok.pixel', { identifiers: ['TESTPIXEL0001'] })]);
  const naming = container([tag('google.analytics', { tagId: 31, template: '__gaawe', templateLabel: 'GA4 event', custom: false, identifiers: [ID], consent: { status: 'built-in', additional: [], builtIn: ['analytics_storage'] } })]);
  const unresolved = container([tag('tiktok.pixel'), tag('', { tagId: 32, partyId: undefined, template: '__googtag', templateLabel: 'Google tag', custom: false, identifiers: ['{{GA4 id}}'] })]);
  const customHtml = container([tag('google.analytics', { tagId: 33, template: '__html', templateLabel: 'Custom HTML', custom: false })]);

  it('lists a rewrite of the config snippet at its page:line and a consent default — no "require consent on tag N"', () => {
    const r = compatibilityFor(ga(), { markup: markup([dataSnippet]), containers: [unrelated], consentApi: [observation()] });
    expect(r.verdict).toBe('tag-manager');
    expect(kinds(r)).not.toContain('gate-gtm-tag');
    expect(kinds(r)).toEqual(expect.arrayContaining(['rewrite-tag', 'set-consent-default']));
    const rw = r.changes.find((c) => c.kind === 'rewrite-tag')!;
    expect(rw).toMatchObject({ page: PAGE, line: 10, destinationId: ID, element: '<script src="data:…">' });
    expect(rw.note).toMatch(/move the data: URL from src to data-src unchanged/);
    expect(rw.why).toMatch(/no tag in the container carries G-TEST0001X/);
    expect(rw.why).toMatch(/holding the gtag\.js loader alone does not/);
    expect(r.reasons.some((x) => x.note.includes(`destination ${ID} is loaded by GTM from a gtag('config') command`) && x.note.includes('cx=c'))).toBe(true);
  });

  it('a plain inline snippet, or one matched under another party, is the snippet too', () => {
    for (const s of [plainSnippet, otherParty]) {
      const r = compatibilityFor(ga(), { markup: markup([s]), containers: [unrelated], consentApi: [observation()] });
      expect(r.changes.find((c) => c.kind === 'rewrite-tag'), s.partyId).toMatchObject({ line: 10, destinationId: ID, element: 'inline <script>' });
      expect(kinds(r)).not.toContain('gate-gtm-tag');
    }
  });

  it('the snippet not located: needs-a-look for the gtag(config) call — still no GTM tag claim', () => {
    const r = compatibilityFor(ga(), { markup: markup([]), containers: [unrelated], consentApi: [observation()] });
    expect(kinds(r)).not.toContain('gate-gtm-tag');
    const look = r.changes.find((c) => c.kind === 'needs-a-look')!;
    expect(look).toMatchObject({ destinationId: ID });
    expect(look.note).toMatch(/find the gtag\('config', 'G-TEST0001X'\) call/);
    expect(kinds(r)).toContain('set-consent-default');
  });

  it('fail closed: an unread container, a tag naming the id, an unresolved Google tag, or a Custom HTML tag for the party → no destination claim', () => {
    const cases: Array<[string, TagContainer[] | undefined]> = [
      ['not fetched', undefined],
      ['none', []],
      ['unreadable', [container([], { status: 'unreadable' })]],
      ['a second container unreadable', [unrelated, container([], { id: 'GTM-XXXX02', status: 'unreadable' })]],
      ['a tag names the id', [naming]],
      ['a Google tag with an unresolved id', [unresolved]],
      ['a Custom HTML tag mapped to the party', [customHtml]],
    ];
    for (const [name, containers] of cases) {
      const r = compatibilityFor(ga(), { markup: markup([dataSnippet]), containers, consentApi: [observation()] });
      expect(r.changes.some((c) => c.destinationId), name).toBe(false);
      expect(kinds(r), name).toContain('gate-gtm-tag');
    }
    // A tag naming the id is the tag to gate, by its id.
    const named = compatibilityFor(ga(), { markup: markup([dataSnippet]), containers: [naming], consentApi: [observation()] });
    expect(named.changes.find((c) => c.kind === 'gate-gtm-tag')).toMatchObject({ containerId: 'GTM-XXXX01', tagId: 31 });
  });

  it('no GTM on the load chain (the page’s own gtag.js loaded it): not this path', () => {
    const direct = party('google.analytics', 'gtm', { categories: ['analytics'], loadedBy: [CX] }, [{ class: 'gtm', kind: 'container-tag', observed: false, containerId: 'GTM-XXXX01', note: 'fixture' }]);
    const r = compatibilityFor(direct, { markup: markup([dataSnippet]), containers: [unrelated], consentApi: [observation()] });
    expect(r.changes.some((c) => c.destinationId)).toBe(false);
  });

  it('a direct-script party with GTM also on its chain: its own rewrite carries the why, once', () => {
    const p = party('google.analytics', 'direct-script', { categories: ['analytics'], sources: ['injected'], loadedBy: [CX] }, [{ class: 'direct-script', kind: 'markup', observed: false, page: PAGE, line: 10, note: 'fixture' }, gtmEv]);
    p.implementation!.alsoSeen = ['gtm'];
    const r = compatibilityFor(p, { markup: markup([dataSnippet]), containers: [unrelated], consentApi: [observation()] });
    const rw = r.changes.filter((c) => c.kind === 'rewrite-tag');
    expect(rw).toHaveLength(1);
    expect(rw[0]).toMatchObject({ line: 10, destinationId: ID });
    expect(rw[0].why).toMatch(/pushes gtag\('config', 'G-TEST0001X'\)/);
    expect(r.verdict).toBe('gateable'); // the snippet is in the HTML and no container tag fires it
  });

  it('property: a destination claim only when it cannot be a container tag; never a tag-less GTM claim with it; less evidence never strengthens the verdict', () => {
    const markups = [undefined, markup([], false), markup([]), markup([dataSnippet]), markup([plainSnippet]), markup([otherParty])];
    const containersSet = [undefined, [], [unrelated], [container([], { status: 'unreadable' })], [naming], [unresolved], [customHtml], [unrelated, container([], { id: 'GTM-XXXX02', status: 'unreadable' })]];
    const apis = [undefined, [observation()], [DENIED_DEFAULT], [LATE_DEFAULT]];
    let claimed = 0;
    for (const m of markups)
      for (const c of containersSet)
        for (const a of apis) {
          const input: CompatibilityInput = { markup: m, containers: c, consentApi: a };
          const r = compatibilityFor(ga(), input);
          const dest = r.changes.filter((x) => x.destinationId);
          expect(r.verdict).not.toBe('gateable');
          if (dest.length) {
            claimed++;
            const gtm = (c ?? []).filter((x) => x.kind === 'gtm');
            expect(gtm.length > 0 && gtm.every((x) => x.status === 'parsed')).toBe(true);
            expect(gtm.some((x) => x.tags.some((t) => t.identifiers.includes(ID)))).toBe(false);
            // No "find every tag that loads it": there is no tag.
            expect(r.changes.some((x) => x.kind === 'gate-gtm-tag' && x.tagId === undefined)).toBe(false);
            if (a !== undefined && a[0] !== DENIED_DEFAULT) expect(kinds(r)).toContain('set-consent-default');
            for (const x of dest) {
              if (x.kind === 'rewrite-tag') expect(m?.findings.some((f) => f.page === x.page && f.line === x.line && f.verdict === 'gateable' && f.ids?.includes(ID))).toBe(true);
              else expect(x.kind).toBe('needs-a-look');
            }
          }
          for (const key of ['markup', 'containers', 'consentApi'] as const) {
            const reduced = compatibilityFor(ga(), { ...input, [key]: undefined });
            expect(verdictRank(reduced.verdict) <= verdictRank(r.verdict)).toBe(true);
          }
        }
    expect(claimed).toBeGreaterThan(0);
  });
});

describe('a direct script that ALSO has GTM tags', () => {
  it('lists the GTM tags and claims no more than tag-manager', () => {
    const p = party('meta.pixel', 'direct-script');
    p.implementation!.alsoSeen = ['gtm'];
    const r = compatibilityFor(p, { markup: markup([finding('meta.pixel', 'gateable')]), containers: [container([tag('meta.pixel')])], consentApi: [observation()] });
    expect(r.verdict).toBe('tag-manager');
    expect(kinds(r)).toEqual(expect.arrayContaining(['rewrite-tag', 'gate-gtm-tag', 'set-consent-default']));
    expect(r.reasons.some((x) => /fire besides the tag in the HTML/.test(x.note))).toBe(true);
  });

  it('many tags for one party in one container are one change naming them', () => {
    const p = party('google.analytics', 'gtm', { categories: ['analytics'] });
    const tags = Array.from({ length: 12 }, (_, i) => tag('google.analytics', { tagId: 100 + i, index: i, templateLabel: 'GA4 event', consent: { status: 'built-in', additional: [], builtIn: ['analytics_storage'] } }));
    const r = compatibilityFor(p, { containers: [container(tags)], consentApi: [observation()] });
    const gates = r.changes.filter((c) => c.kind === 'gate-gtm-tag');
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({ containerId: 'GTM-XXXX01', consentTypes: ['analytics_storage'] });
    expect(gates[0].tagId).toBeUndefined();
    expect(gates[0].note).toMatch(/12 tags \(GA4 event\) — tag 100, 101/);
  });
});

describe('resources inside a third-party iframe fold under the iframe’s party', () => {
  const EMBED = 'https://www.youtube.com/embed/abc?autoplay=1';
  const frameLeak = finding('google.youtube', 'leak', { kind: 'iframe', context: 'document', trigger: 'page-load', inline: false, url: 'https://www.youtube.com/embed/abc', line: 88, label: 'YouTube embed' });
  const font = () => party('google.fonts', 'markup-leak', { categories: ['fonts'], sources: ['injected'], loadedBy: [EMBED] }, [{ class: 'markup-leak', kind: 'loader', observed: true, url: EMBED, note: `loaded inside ${EMBED}, an <iframe> written in the page — fetched before any script runs` }]);

  it('no change of its own: a reason pointing at the iframe’s page:line', () => {
    const r = compatibilityFor(font(), { markup: markup([frameLeak]) });
    expect(r.verdict).toBe('uncontrollable');
    expect(r.changes).toEqual([]);
    expect(r.reasons.some((x) => /loaded inside the <iframe> at .*:88 \(YouTube embed\)/.test(x.note) && x.ref === '/markup/findings/0')).toBe(true);
  });

  it('iframe not located in the HTML → the runtime remove-leak stays', () => {
    const r = compatibilityFor(font(), { markup: markup([]) });
    expect(kinds(r)).toEqual(['remove-leak']);
  });

  it('an iframe whose own purpose needs no consent does not absorb a tracker’s change', () => {
    const pay = finding('kb.pay', 'leak', { kind: 'iframe', context: 'document', inline: false, url: 'https://www.youtube.com/embed/abc', line: 90, label: 'Pay' });
    const kb = { ...DEFAULT_KB, entries: [...DEFAULT_KB.entries, { ...DEFAULT_KB.entries[0], id: 'kb.pay', categories: ['payments'] }] } as typeof DEFAULT_KB;
    const r = compatibilityFor(font(), { markup: markup([pay]), kb });
    expect(kinds(r)).toEqual(['remove-leak']);
  });
});

describe('identical changes are listed once', () => {
  it('two leak elements on one page:line become one change that counts them', () => {
    const a = finding('google.fonts', 'leak', { kind: 'link', context: 'document', trigger: 'page-load', inline: false, url: 'https://fonts.googleapis.com/css2?family=A', line: 8 });
    const b = { ...a, url: 'https://fonts.googleapis.com/css2?family=B' };
    const p = party('google.fonts', 'markup-leak', { categories: ['fonts'] }, [{ class: 'markup-leak', kind: 'markup', observed: false, verdict: 'leak', page: PAGE, line: 8, note: '<link>' }]);
    const r = compatibilityFor(p, { markup: markup([a, b, { ...a }]) });
    expect(kinds(r)).toEqual(['remove-leak']);
    expect(r.changes[0].note).toMatch(/\(2 such elements on this line\)$/);
  });
});

// --- The contract: fail closed, whatever the combination ------------------------------

describe('property: no evidence combination yields gateable without a gateable markup entry, and less evidence never means more', () => {
  const CLASSES: Array<ImplementationClass | undefined> = ['direct-script', 'markup-leak', 'gtm', 'other-tag-manager', 'platform', 'cname', 'server-side-suspected', 'unknown', undefined];
  const MARKUPS: Array<{ name: string; markup?: MarkupSection }> = [
    { name: 'absent' },
    { name: 'not-inspected', markup: markup([], false) },
    { name: 'empty', markup: markup([]) },
    { name: 'gateable', markup: markup([finding('p', 'gateable')]) },
    { name: 'held', markup: markup([finding('p', 'held')]) },
    { name: 'leak', markup: markup([finding('p', 'leak')]) },
    { name: 'gateable+leak', markup: markup([finding('p', 'gateable'), finding('p', 'leak')]) },
    { name: 'hint', markup: markup([finding('p', 'hint', { kind: 'link' })]) },
  ];
  const CONTAINERS: Array<{ name: string; containers?: TagContainer[] }> = [
    { name: 'absent' },
    { name: 'unreadable', containers: [container([], { status: 'unreadable' })] },
    { name: 'parsed-none', containers: [container([tag('p', { consent: { status: 'none', additional: [], builtIn: [] } })])] },
    { name: 'parsed-built-in', containers: [container([tag('p', { consent: { status: 'built-in', additional: [], builtIn: ['ad_storage'] } })])] },
    { name: 'parsed-required', containers: [container([tag('p', { consent: { status: 'required', additional: ['ad_storage'], builtIn: [] } })])] },
  ];
  const APIS: Array<{ name: string; consentApi?: ConsentApiObservation[] }> = [{ name: 'absent' }, { name: 'none', consentApi: [observation()] }, { name: 'denied', consentApi: [DENIED_DEFAULT] }, { name: 'late', consentApi: [LATE_DEFAULT] }];
  const PLATFORMS: Array<CompatibilityInput['platform']> = [undefined, { name: 'shopify' }];
  const BEHAVIORS: Array<{ name: string; behavior?: BehaviorCell[] }> = [{ name: 'absent' }, { name: 'none', behavior: [cell('p', 'no-mismatch-observed')] }, { name: 'mismatch', behavior: [cell('p', 'mismatch')] }, { name: 'unchecked', behavior: [cell('p', 'not-established')] }];
  const PARTIES = ['p', 'meta.pixel', 'google.analytics', 'tiktok.pixel'];

  const combos: Array<{ label: string; party: PartyInventoryItem; input: CompatibilityInput }> = [];
  for (const partyId of PARTIES)
    for (const cls of CLASSES)
      for (const m of MARKUPS)
        for (const c of CONTAINERS)
          for (const a of APIS)
            for (const pl of PLATFORMS)
              for (const b of BEHAVIORS) {
                const rename = (f: MarkupFinding): MarkupFinding => ({ ...f, partyId });
                const ctags = c.containers?.map((ct) => ({ ...ct, tags: ct.tags.map((t) => ({ ...t, partyId })) }));
                combos.push({
                  label: `${partyId}/${cls}/${m.name}/${c.name}/${a.name}/${pl?.name ?? '-'}/${b.name}`,
                  party: party(partyId, cls),
                  input: { markup: m.markup ? { ...m.markup, findings: m.markup.findings.map(rename) } : undefined, containers: ctags, consentApi: a.consentApi, platform: pl, behavior: b.behavior?.map((x) => ({ ...x, partyId })) },
                });
              }

  it(`sweeps ${combos.length} combinations`, () => {
    expect(combos.length).toBeGreaterThan(3000);
    for (const { label, party: p, input } of combos) {
      const r = compatibilityFor(p, input);
      const mine = (input.markup?.findings ?? []).filter((f) => f.partyId === p.partyId);
      const hasGateable = mine.some((f) => f.verdict === 'gateable');
      const hasLeak = mine.some((f) => f.verdict === 'leak');
      const inspected = !!input.markup?.pages.some((pg) => pg.status === 'inspected');
      // 1. gateable ⇒ a gateable finding, no leak, HTML inspected, class direct-script.
      if (r.verdict === 'gateable') {
        expect(hasGateable, label).toBe(true);
        expect(hasLeak, label).toBe(false);
        expect(inspected, label).toBe(true);
        expect(p.implementation?.class, label).toBe('direct-script');
      }
      // 2. A leak in the HTML is uncontrollable whatever else is true.
      if (hasLeak) expect(r.verdict, label).toBe('uncontrollable');
      // 3. Behavior outranks implementation: a mismatch is flagged and comes first.
      const mismatch = (input.behavior ?? []).some((x) => x.partyId === p.partyId && x.status === 'mismatch');
      expect(r.behaviorMismatch, label).toBe(mismatch);
      if (mismatch) expect(r.changes[0].kind, label).toBe('behavior-mismatch');
      else expect(r.changes.some((x) => x.kind === 'behavior-mismatch'), label).toBe(false);
      // 4. A GTM tag is proven gated only with a parsed 'required' tag and a denied default that was not undone.
      const proven = r.implementation === 'gtm' && !r.changes.some((x) => x.kind === 'gate-gtm-tag' || x.kind === 'set-consent-default');
      if (proven) {
        expect(input.containers?.some((ct) => ct.status === 'parsed' && ct.tags.some((t) => t.partyId === p.partyId && t.consent.status === 'required')), label).toBe(true);
        expect(input.consentApi?.some((o) => o.consentCalls.some((x) => x.action === 'default' && x.denies && !x.regional)), label).toBe(true);
        expect(input.consentApi?.some((o) => o.states.some((s) => s.api === 'google')), label).toBe(false);
      }
      // 5. No implementation record ⇒ unknown (a leak in the HTML still wins: invariant 2). Every verdict carries reasons.
      if (!p.implementation && !hasLeak) expect(r.verdict, label).toBe('unknown');
      expect(r.reasons.length, label).toBeGreaterThan(0);
      if (r.verdict === 'unknown') expect(r.changes.some((x) => x.kind === 'needs-a-look'), label).toBe(true);
      // 6. Monotonic: removing any one input leaves the verdict the same or a weaker one, never a stronger one.
      //    (A leak finding with a non-leak class is a combination A6 never produces — the leak decides the
      //    class — so taking that markup away is not "less evidence" for the class given; it is skipped.)
      for (const key of ['markup', 'containers', 'consentApi', 'platform', 'behavior'] as const) {
        if (input[key] === undefined) continue;
        if (key === 'markup' && hasLeak && p.implementation?.class !== 'markup-leak') continue;
        const reduced = compatibilityFor(p, { ...input, [key]: undefined });
        expect(verdictRank(reduced.verdict) <= verdictRank(r.verdict) || reduced.verdict === r.verdict, `${label} without ${key}: ${r.verdict} → ${reduced.verdict}`).toBe(true);
        if (key === 'markup') expect(reduced.verdict, label).not.toBe('gateable');
        if (key === 'consentApi' && r.implementation === 'gtm') expect(reduced.changes.some((x) => x.kind === 'set-consent-default' || x.kind === 'gate-gtm-tag'), label).toBe(true);
      }
    }
  });
});

// --- End to end: buildTrackingEvaluation carries consentApi + compatibility ----------

describe('buildTrackingEvaluation', () => {
  const site = { url: PAGE, host: 'www.example-shop.test', registrableDomain: 'example-shop.test' };
  function timeline(events: TimelineEvent[], extra: Partial<Timeline['snapshot']> = {}): Timeline {
    return Timeline.parse({
      location: { id: 'local', country: 'DE' },
      verification: { verdict: 'verified', expected: { country: 'DE' }, observed: { country: 'DE' }, sources: [], jurisdictions: ['eu'], checkedAt: '2026-10-06T00:00:00Z' },
      events,
      snapshot: { site, scenario: 'reject', locationId: 'local', startedAt: '2026-10-06T00:00:00Z', durationMs: 5000, gpc: false, browser: { name: 'chromium' }, pages: [{ url: PAGE }], cookies: [], storage: [], frames: [], ...extra },
    });
  }
  const FBEVENTS = 'https://connect.facebook.net/en_US/fbevents.js';
  const req = (t: number, url: string, resourceType: string, initiator: { type: string; chain: string[] }): TimelineEvent => ({ type: 'request', t, id: `r${t}`, url, method: 'GET', resourceType, origin: 'page', pageUrl: PAGE, pageIndex: 0, initiator, setCookies: [] });

  it('carries the A3 summary and a verdict for every party, and the record parses', () => {
    const events: TimelineEvent[] = [
      { type: 'consent-api', t: 5, api: 'meta', kind: 'call', call: 'fbq', args: ['init', '<string>'], frameUrl: PAGE, top: true, chain: [], pageIndex: 0 },
      // The inline snippet in the HTML inserts fbevents.js (parser-attributed), which sends the hit.
      req(20, FBEVENTS, 'script', { type: 'parser', chain: [] }),
      { type: 'banner', t: 100, state: 'shown', pageIndex: 0 },
      { type: 'choice', t: 500, choice: 'reject', ok: true, method: 'selector', pageIndex: 0 },
      req(600, 'https://www.facebook.com/tr?id=1&ev=PageView&dl=' + encodeURIComponent(PAGE), 'image', { type: 'script', chain: [FBEVENTS] }),
    ];
    const markupPages: NonNullable<Timeline['snapshot']['markup']> = [
      { url: PAGE, pageIndex: 0, status: 'inspected', elements: [{ kind: 'script', line: 12, context: 'document', loads: 'executes', attributes: {}, body: "fbq('init','1');fbq('track','PageView');", hosts: [], ids: [] }] },
    ];
    const ev = buildTrackingEvaluation({
      runId: 'r1',
      property: 'p',
      site,
      versions: { kb: '1', registry: '1', package: '0' },
      startedAt: '2026-10-06T00:00:00Z',
      finishedAt: '2026-10-06T00:01:00Z',
      locations: [{ spec: { id: 'local', country: 'DE' }, verification: { verdict: 'verified', expected: { country: 'DE' }, observed: { country: 'DE' }, sources: [], siteReported: [], jurisdictions: ['eu'], checkedAt: '' }, scenarios: [{ scenario: 'reject', status: 'tested', choice: { kind: 'reject', ok: true, method: 'selector' }, consentTool: { vendor: 'Cookiebot', defaultGrants: { marketing: true }, decoded: true, choiceRecorded: false, source: 'cookie:CookieConsent' }, evidence: { screenshots: [] } }] }],
      timelines: [timeline(events, { markup: markupPages })],
      notTested: [],
      redacted: true,
    });
    expect(ev.consentApi).toHaveLength(1);
    expect(ev.consentApi![0]).toMatchObject({ location: 'local', scenario: 'reject', apis: ['meta'], calls: 1 });
    expect(ev.consentApi![0].states.map((s) => s.state)).toEqual(['not-called-after-refusal']);
    const meta = ev.compatibility!.parties.find((p) => p.partyId === 'meta.pixel')!;
    expect(meta.implementation).toBe('direct-script');
    expect(meta.verdict).toBe('gateable');
    expect(meta.behaviorMismatch).toBe(true); // a hit after rejection under opt-in rules
    expect(meta.changes[0].kind).toBe('behavior-mismatch');
    expect(meta.changes.map((c) => c.kind)).toEqual(expect.arrayContaining(['rewrite-tag', 'call-consent-api']));
    expect(meta.reasons.some((x) => x.ref === '/consentApi/0/states/0')).toBe(true);
    expect(ev.compatibility!.consentTool.status).toBe('grants-by-default');
    expect(ev.compatibility!.inputs).toEqual({ markup: true, containers: false, consentApi: true, consentTool: true, behavior: true });
    // Persisted shape round-trips through the schema.
    expect(() => TrackingEvaluation.parse(JSON.parse(JSON.stringify(ev)))).not.toThrow();
    expect(TrackingEvaluation.parse(JSON.parse(JSON.stringify(ev))).compatibility).toEqual(ev.compatibility);
  });

  it('evaluateCompatibility on a record without observations: nothing checked, nothing passed', () => {
    const section = evaluateCompatibility({ inventory: [party('meta.pixel', 'direct-script')], locations: [] });
    expect(section.parties[0].verdict).toBe('unknown');
    expect(section.parties[0].behaviorChecked).toBe(false);
    expect(section.inputs).toEqual({ markup: false, containers: false, consentApi: false, consentTool: false, behavior: false });
    expect(section.consentTool.status).toBe('not-observed');
  });
});
