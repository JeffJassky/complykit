import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseGtmContainer, parseContainers, extractContainerData, buildTrackingEvaluation, matchVendorSignatures, entriesForText, DEFAULT_KB } from '../src/index.js';
import type { ContainerCapture, TagContainer, Timeline } from '../src/index.js';
import { discoverContainers } from '../src/collect/browser/evaluation/containers.js';

// GTM container parser (ticket A2), from redacted real containers + one
// synthetic. No network: every input is a fixture. The shape pinned here is
// what the record carries and what the report will render — a change in a
// pinned count means the parser reads a container differently than before.

const FIXTURES = path.join(__dirname, 'fixtures', 'gtm');

function capture(id: string, over: Partial<ContainerCapture> = {}): ContainerCapture {
  const gtm = id.startsWith('GTM-');
  return {
    id,
    kind: gtm ? 'gtm' : 'gtag',
    url: `https://www.googletagmanager.com/${gtm ? 'gtm.js' : 'gtag/js'}?id=${id}`,
    locationId: 'local',
    seenOn: ['https://example-1.test/'],
    fetchedAt: '2026-10-06T00:00:00.000Z',
    status: 'ok',
    source: fs.readFileSync(path.join(FIXTURES, `${id}.js`), 'utf8'),
    ...over,
  };
}

const byTemplate = (c: TagContainer, fn: string) => c.tags.filter((t) => t.template === fn);
const byTagId = (c: TagContainer, id: number) => {
  const t = c.tags.find((x) => x.tagId === id);
  if (!t) throw new Error(`tag ${id} not in container`);
  return t;
};

describe('extractContainerData', () => {
  it('reads the data literal out of a served gtm.js, braces inside HTML strings included', () => {
    const { data, reason } = extractContainerData(capture('GTM-XXXX01').source!);
    expect(reason).toBeUndefined();
    expect(data?.resource.tags).toHaveLength(105);
    expect(data?.resource.predicates).toHaveLength(54);
    expect(data?.resource.rules).toHaveLength(50);
    expect(data?.resource.macros).toHaveLength(11);
    expect(String(data?.resource.version)).toBe('23');
  });

  it('fails closed on anything that is not a container', () => {
    expect(extractContainerData('').reason).toBe('empty response');
    expect(extractContainerData('<!doctype html><html><body>blocked</body></html>').reason).toMatch(/HTML page/);
    expect(extractContainerData('(function(){ var x = 1; })();').reason).toMatch(/no container data literal/);
    expect(extractContainerData('var data = {"resource": {"tags": [').reason).toMatch(/unterminated/);
    expect(extractContainerData('var data = {"resource": {"tags": [,]}};').reason).toMatch(/not JSON/);
    expect(extractContainerData('var data = {"runtime": []};').reason).toMatch(/no resource block/);
    expect(extractContainerData('var data = {"resource": {"tags": [], "predicates": []}};').reason).toMatch(/resource\.rules/);
  });
});

describe('parseGtmContainer — fail closed', () => {
  it('a failed fetch is not-fetched with no tags and no consent claim', () => {
    const c = parseGtmContainer(capture('GTM-XXXX02', { status: 'error', httpStatus: 403, source: undefined, error: 'HTTP 403' }));
    expect(c.status).toBe('not-fetched');
    expect(c.reason).toBe('HTTP 403');
    expect(c.tags).toEqual([]);
    expect(c.counts).toBeUndefined();
    expect(c.consentMode).toBeUndefined();
  });

  it('an unreadable body is unreadable with the reason, never an empty "all gated" container', () => {
    const c = parseGtmContainer(capture('GTM-XXXX02', { source: '<!doctype html><html></html>' }));
    expect(c.status).toBe('unreadable');
    expect(c.reason).toMatch(/HTML page/);
    expect(c.tags).toEqual([]);
    expect(c.counts).toBeUndefined();
  });

  it('a parser crash on one container is that container’s reason only', () => {
    const bad = capture('GTM-XXXX02', { source: 'var data = {"resource": {"tags": [1], "predicates": [], "rules": [[["add", 0]]]}};' });
    const out = parseContainers([bad, capture('GTM-XXXX02')]);
    expect(out[0].status).toBe('parsed'); // an unreadable tag is listed as such, the container still parses
    expect(out[0].tags[0].consent.status).toBe('unknown');
    expect(out[0].warnings).toContain('tag 0 is unreadable');
    expect(out[1].status).toBe('parsed');
    expect(out[1].tags).toHaveLength(3);
  });

  it('a consent setting that is not a plain list is unknown, not none', () => {
    const c = parseGtmContainer(capture('GTM-SYNTH01'));
    const awct = byTagId(c, 10);
    expect(awct.consent.status).toBe('unknown');
    expect(awct.consent.additional).toEqual([]);
    expect(awct.consent.note).toMatch(/not in a form this parser can read/);
  });

  it('an unknown template is unknown, not none, and listed as unmapped', () => {
    const c = parseGtmContainer(capture('GTM-SYNTH01'));
    const t = byTagId(c, 12);
    expect(t.template).toBe('__frobnicate');
    expect(t.consent.status).toBe('unknown');
    expect(t.partyId).toBeUndefined();
    expect(c.unmappedTemplates).toContain('__frobnicate');
  });

  it('an empty consent list ("no additional consent") is never "required"; built-in never reads as gated; paused is paused', () => {
    const src = 'var data = {"resource": {"version": "1", "macros": [{"function":"__e"}], "tags": [{"function":"__gaawe","vtp_measurementIdOverride":"G-XXXXXXXX01","consent":["list"],"tag_id":1},{"function":"__html","vtp_html":"<script>x()</script>","consent":["list"],"tag_id":2},{"function":"__paused","vtp_originalTagType":"html","tag_id":3}], "predicates": [{"function":"_eq","arg0":["macro",0],"arg1":"gtm.js"}], "rules": [[["if",0],["add",0,1,2]]]}};';
    const c = parseGtmContainer(capture('GTM-XXXX02', { source: src }));
    expect(byTagId(c, 1).consent).toMatchObject({ status: 'built-in', additional: [] });
    expect(byTagId(c, 1).consent.note).toMatch(/fires regardless of consent/);
    expect(byTagId(c, 1).consent.note).not.toMatch(/held|gated|blocked/);
    expect(byTagId(c, 2).consent).toMatchObject({ status: 'none', additional: [] });
    expect(byTagId(c, 3)).toMatchObject({ paused: true, kind: 'helper', consent: { status: 'none', note: expect.stringMatching(/paused/) } });
    expect(c.counts?.required).toBe(0);
  });

  it('a trigger that pins no event (regex / negated event match) counts as firing on page load', () => {
    const src = 'var data = {"resource": {"version": "1", "macros": [{"function":"__e"}], "tags": [{"function":"__html","vtp_html":"<script>x()</script>","tag_id":1},{"function":"__html","vtp_html":"<script>y()</script>","tag_id":2}], "predicates": [{"function":"_re","arg0":["macro",0],"arg1":".*"},{"function":"_eq","arg0":["macro",0],"arg1":"gtm.click","negate":true}], "rules": [[["if",0],["add",0]],[["if",1],["add",1]]]}};';
    const c = parseGtmContainer(capture('GTM-XXXX02', { source: src }));
    expect(byTagId(c, 1)).toMatchObject({ events: ['*'], firesOnPageLoad: true });
    expect(byTagId(c, 2)).toMatchObject({ events: ['*'], firesOnPageLoad: true });
  });

  it('out-of-range rule references become warnings, not silent gaps', () => {
    const src = 'var data = {"resource": {"version": "1", "macros": [{"function":"__e"}], "tags": [{"function":"__html","vtp_html":"<script>x()</script>","tag_id":1}], "predicates": [{"function":"_eq","arg0":["macro",0],"arg1":"gtm.js"}], "rules": [[["if",0,9],["add",0,5]],[["frob",0]]]}};';
    const c = parseGtmContainer(capture('GTM-XXXX02', { source: src }));
    expect(c.status).toBe('parsed');
    expect(c.warnings).toEqual(expect.arrayContaining(['rule 0: predicate 9 out of range', 'a rule adds tag 5, which does not exist', 'rule 1: unknown clause "frob"', 'tag 1: a firing rule could not be fully read']));
    expect(c.tags[0].triggers).toEqual(['event is Page View (gtm.js)']);
  });
});

describe('parseGtmContainer — GTM-XXXX01 (GA4-heavy container, 105 tags)', () => {
  const c = parseGtmContainer(capture('GTM-XXXX01'));

  it('pins the parsed shape', () => {
    expect(c.status).toBe('parsed');
    expect(c.version).toBe('23');
    expect(c.kind).toBe('gtm');
    expect(c.counts).toEqual({ tags: 55, helpers: 50, settings: 0, required: 0, builtIn: 53, templateChecks: 0, none: 2, unknown: 0, unmapped: 1 });
    expect(c.tags).toHaveLength(105);
    expect(c.warnings).toEqual([]);
    const fns = Object.fromEntries([...new Set(c.tags.map((t) => t.template))].map((fn) => [fn, byTemplate(c, fn).length]));
    expect(fns).toEqual({ __gaawe: 48, __googtag: 3, __gclidw: 1, __sp: 1, __lcl: 3, __cl: 47, __html: 2 });
  });

  it('reads GA4 event tags: measurement id, click trigger with its URL condition, built-in consent only', () => {
    const t = byTagId(c, 4);
    expect(t).toMatchObject({
      template: '__gaawe',
      templateLabel: 'GA4 event',
      kind: 'tag',
      custom: false,
      partyId: 'google.analytics',
      partyLabel: 'Google Analytics 4',
      mappedBy: 'template',
      identifiers: ['G-XXXXXXXX01'],
      events: ['gtm.click'],
      firesOnPageLoad: false,
    });
    expect(t.triggers).toEqual(['page url contains example-1.test/path-1/ and event is Click (gtm.click)']);
    expect(t.consent).toEqual({ status: 'built-in', additional: [], builtIn: ['analytics_storage'], note: expect.stringMatching(/fires regardless/) });
  });

  it('maps Google tags by their id prefix', () => {
    expect(byTagId(c, 107)).toMatchObject({ template: '__googtag', partyId: 'google.analytics', mappedBy: 'parameter', identifiers: ['G-XXXXXXXX01'], events: ['gtm.init'], firesOnPageLoad: true });
    expect(byTagId(c, 111)).toMatchObject({ template: '__googtag', partyId: 'google.ads.ccm', identifiers: ['AW-XXXXXXXX02'], events: ['gtm.js'] });
    expect(byTagId(c, 114)).toMatchObject({ template: '__sp', templateLabel: 'Google Ads remarketing', partyId: 'google.ads.ccm', identifiers: ['AW-XXXXXXXX02'] });
    expect(byTagId(c, 114).consent.builtIn).toEqual(['ad_storage', 'ad_user_data', 'ad_personalization']);
    expect(byTagId(c, 112)).toMatchObject({ template: '__gclidw', templateLabel: 'Conversion linker', partyId: 'google.ads.ccm' });
  });

  it('reads Custom HTML tags: signature match, loaded hosts, no consent requirement', () => {
    const clarity = byTagId(c, 110);
    expect(clarity).toMatchObject({ template: '__html', partyId: 'microsoft.clarity', mappedBy: 'signature', loads: ['www.clarity.ms'], firesOnPageLoad: true });
    expect(clarity.consent).toMatchObject({ status: 'none', additional: [], builtIn: [] });
    const chat = byTagId(c, 108);
    expect(chat.partyId).toBeUndefined();
    expect(chat.loads).toEqual(['example-18.test']);
    expect(chat.consent.status).toBe('none');
    expect(c.unmappedTemplates).toEqual(['__html (tag 108)']);
  });

  it('listeners are helpers with no party and no consent claim about data', () => {
    const lcl = byTagId(c, 115);
    expect(lcl).toMatchObject({ template: '__lcl', kind: 'helper', consent: { status: 'none' } });
    expect(lcl.partyId).toBeUndefined();
    expect(lcl.identifiers).toEqual([]); // the hidden trigger id is not an account id
    expect(c.tags.filter((t) => t.kind === 'helper').every((t) => !t.partyId)).toBe(true);
  });

  it('resolves the hidden trigger-id predicate to the trigger number', () => {
    const withTrigger = c.tags.find((t) => t.triggers.some((x) => /trigger #\d+ fired/.test(x)));
    expect(withTrigger).toBeDefined();
  });

  it('no consent mode defaults are set from inside this container', () => {
    expect(c.consentMode).toEqual({ initTrigger: false, defaultsSetBy: [], updatedBy: [] });
  });
});

describe('parseGtmContainer — GTM-XXXX02 (Google tags + a gallery template)', () => {
  const c = parseGtmContainer(capture('GTM-XXXX02'));

  it('pins the parsed shape', () => {
    expect(c.version).toBe('4');
    expect(c.counts).toEqual({ tags: 3, helpers: 0, settings: 0, required: 0, builtIn: 2, templateChecks: 0, none: 1, unknown: 0, unmapped: 0 });
    expect(c.tags.map((t) => [t.tagId, t.template, t.partyId, t.consent.status])).toEqual([
      [4, '__googtag', 'google.ads.ccm', 'built-in'],
      [5, '__googtag', 'google.analytics', 'built-in'],
      [7, '__cvt_XXXX1', 'microsoft.clarity', 'none'],
    ]);
  });

  it('maps a sandboxed template through its inject_script permission and shows variable parameters', () => {
    const t = byTagId(c, 7);
    expect(t).toMatchObject({ custom: true, templateLabel: 'Custom template', mappedBy: 'permission', loads: ['www.clarity.ms'], events: ['gtm.js'], firesOnPageLoad: true });
    expect(t.identifiers).toEqual(['id-redacted-01', '{{GA session_id}}', '{{GA client_id}}']);
    expect(t.consent.note).toMatch(/no consent requirement/);
  });
});

describe('parseGtmContainer — GTM-XXXX03 (Google Ads conversions on link clicks)', () => {
  const c = parseGtmContainer(capture('GTM-XXXX03'));

  it('pins the parsed shape', () => {
    expect(c.version).toBe('3');
    expect(c.counts).toEqual({ tags: 5, helpers: 4, settings: 0, required: 0, builtIn: 5, templateChecks: 0, none: 0, unknown: 0, unmapped: 0 });
    const awct = byTemplate(c, '__awct');
    expect(awct).toHaveLength(4);
    for (const t of awct) {
      expect(t.partyId).toBe('google.ads.ccm');
      expect(t.consent.status).toBe('built-in');
      expect(t.events).toEqual(['gtm.linkClick']);
      expect(t.firesOnPageLoad).toBe(false);
      // Predicate order follows the container; the three conditions are what matter.
      expect(t.triggers).toHaveLength(1);
      expect(t.triggers[0]).toMatch(/event is Link Click \(gtm\.linkClick\)/);
      expect(t.triggers[0]).toMatch(/click url contains https:\/\/example-\d\.test\/path-\d+\//);
      expect(t.triggers[0]).toMatch(/trigger #\d+ fired/);
    }
    expect(byTemplate(c, '__gclidw')[0].firesOnPageLoad).toBe(true);
  });
});

describe('parseGtmContainer — G-XXXXXXXX01 (gtag.js destination config)', () => {
  const c = parseGtmContainer(capture('G-XXXXXXXX01'));

  it('reads the Google tag’s settings as settings, not vendor tags', () => {
    expect(c.kind).toBe('gtag');
    expect(c.version).toBe('2');
    expect(c.counts).toEqual({ tags: 2, helpers: 0, settings: 24, required: 0, builtIn: 2, templateChecks: 0, none: 0, unknown: 0, unmapped: 0 });
    expect(c.unmappedTemplates).toEqual([]);
    const signals = c.tags.find((t) => t.template === '__ogt_google_signals');
    expect(signals).toMatchObject({ kind: 'setting', templateLabel: 'Google signals', partyId: 'google.analytics', settings: { googleSignals: 'ENABLED' }, consent: { status: 'none' } });
    const pii = c.tags.find((t) => t.template === '__ogt_1p_data_v2');
    expect(pii?.templateLabel).toBe('User-provided data collection (automatic)');
    expect(pii?.settings).toMatchObject({ isEnabled: true, autoEmailEnabled: true, autoPhoneEnabled: true, autoAddressEnabled: true });
    expect(c.tags.filter((t) => t.kind === 'tag').map((t) => [t.template, t.partyId])).toEqual([
      ['__dest_ga', 'google.analytics'],
      ['__dest_aw', 'google.ads.ccm'],
    ]);
  });
});

describe('parseGtmContainer — GTM-SYNTH01 (consent settings, blocking, sequencing)', () => {
  const c = parseGtmContainer(capture('GTM-SYNTH01'));

  it('pins the parsed shape', () => {
    expect(c.version).toBe('7');
    expect(c.counts).toEqual({ tags: 11, helpers: 1, settings: 0, required: 2, builtIn: 1, templateChecks: 2, none: 4, unknown: 2, unmapped: 3 });
    expect(c.unmappedTemplates).toEqual(['__cvt_SYN01', '__cvt_SYN03', '__frobnicate']);
    expect(c.consentMode).toEqual({ initTrigger: true, defaultsSetBy: ['Custom template (tag 9)'], updatedBy: ['Custom template (tag 9)'] });
  });

  it('an explicit additional-consent list is "required" with the listed types', () => {
    expect(byTagId(c, 2).consent).toEqual({ status: 'required', additional: ['analytics_storage'], builtIn: ['analytics_storage'], note: expect.stringMatching(/^held until analytics_storage granted — only effective where a Consent Mode default of denied is set/) });
    expect(byTagId(c, 3).consent).toEqual({ status: 'required', additional: ['ad_storage', 'ad_user_data'], builtIn: [], note: expect.stringMatching(/^held until ad_storage \+ ad_user_data granted — .*unset type counts as granted/) });
  });

  it('a Meta Pixel in Custom HTML maps by signature; Hotjar too; the Pinterest image by host', () => {
    expect(byTagId(c, 3)).toMatchObject({ partyId: 'meta.pixel', mappedBy: 'signature', loads: ['connect.facebook.net'] });
    expect(byTagId(c, 4)).toMatchObject({ partyId: 'hotjar', mappedBy: 'signature', consent: { status: 'none' } });
    expect(byTagId(c, 5)).toMatchObject({ template: '__img', partyId: 'pinterest.tag', mappedBy: 'host', loads: ['ct.pinterest.com'], consent: { status: 'none' } });
  });

  it('a constant variable resolves to its value, so a Google tag configured through one still maps', () => {
    expect(byTagId(c, 1)).toMatchObject({ partyId: 'google.analytics', identifiers: ['G-XXXXXXXX01'], consent: { status: 'built-in' } });
  });

  it('blocking rules and unless clauses are exceptions / negated conditions', () => {
    expect(byTagId(c, 3).exceptions).toEqual(['page url matches regex ^https://example-1\\.test/(admin|preview)/']);
    expect(byTagId(c, 4).exceptions).toHaveLength(1);
    expect(byTagId(c, 7).triggers).toEqual(['event is DOM Ready (gtm.dom) and not (page path contains /checkout/)']);
    expect(byTagId(c, 8).triggers).toEqual(['event is Page View (gtm.js) and page path contains /checkout/']);
  });

  it('a sandboxed template that reads consent is "template-checks", one that only sends a pixel is "none"', () => {
    expect(byTagId(c, 6)).toMatchObject({ custom: true, consent: { status: 'template-checks' }, loads: ['cdn.example-vendor.test'], events: ['gtm.click'], firesOnPageLoad: false });
    expect(byTagId(c, 6).partyId).toBeUndefined();
    expect(byTagId(c, 7)).toMatchObject({ custom: true, partyId: 'linkedin.insight', mappedBy: 'permission', consent: { status: 'none' } });
    expect(byTagId(c, 9)).toMatchObject({ consent: { status: 'template-checks' } });
  });

  it('reads sequencing, consent-initialization triggers and GTM’s own vendor templates', () => {
    expect(byTagId(c, 10)).toMatchObject({ template: '__awct', partyId: 'google.ads.ccm', identifiers: ['AW-XXXXXXXX02'], events: ['gtm.init_consent'], sequencing: { setup: [0], teardown: [] } });
    expect(byTagId(c, 8)).toMatchObject({ template: '__baut', templateLabel: 'Microsoft Advertising UET', partyId: 'microsoft.uet', mappedBy: 'template', identifiers: ['00000001'] });
    expect(byTagId(c, 11)).toMatchObject({ template: '__cl', kind: 'helper' });
  });
});

describe('vendor signatures', () => {
  it('identify install snippets and loader URLs by KB id', () => {
    expect(matchVendorSignatures("!function(f,b,e,v,n,t,s){...}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','1');")).toEqual(['meta.pixel']);
    expect(matchVendorSignatures('ttq.load("ABC");ttq.page();')).toEqual(['tiktok.pixel']);
    expect(matchVendorSignatures('(function(c,l,a,r,i,t,y){})(window, document, "clarity", "script", "abc");')).toEqual(['microsoft.clarity']);
    expect(matchVendorSignatures('var x = 1;')).toEqual([]);
  });

  it('entriesForText puts the signature hit before host hits and honours KB inline patterns', () => {
    const ids = entriesForText(DEFAULT_KB, "gtag('config', 'AW-1'); var s='https://www.googletagmanager.com/gtag/js?id=AW-1'").map((e) => e.id);
    expect(ids[0]).toBe('google.ads.ccm');
    expect(ids).toContain('google.tag-manager');
  });
});

describe('buildTrackingEvaluation carries containers', () => {
  const site = { url: 'https://example-1.test/', host: 'example-1.test', registrableDomain: 'example-1.test' };
  const base = {
    runId: 'r1',
    property: 'p',
    site,
    versions: { kb: '0', registry: '0', package: '0' },
    startedAt: '2026-10-06T00:00:00.000Z',
    finishedAt: '2026-10-06T00:01:00.000Z',
    locations: [],
    timelines: [] as Timeline[],
    notTested: [],
    redacted: true,
  };

  it('parses captures into the record and drops the source', () => {
    const ev = buildTrackingEvaluation({ ...base, containers: [capture('GTM-XXXX02'), capture('GTM-XXXX03', { status: 'error', source: undefined, error: 'timeout' })] });
    expect(ev.containers).toHaveLength(2);
    expect(ev.containers?.[0]).toMatchObject({ id: 'GTM-XXXX02', status: 'parsed', seenOn: ['https://example-1.test/'] });
    expect(ev.containers?.[1]).toMatchObject({ id: 'GTM-XXXX03', status: 'not-fetched', reason: 'timeout', tags: [] });
    expect(JSON.stringify(ev)).not.toContain('var data');
  });

  it('absent captures leave the section absent (not looked for ≠ none found)', () => {
    expect(buildTrackingEvaluation(base).containers).toBeUndefined();
    expect(buildTrackingEvaluation({ ...base, containers: [] }).containers).toEqual([]);
  });
});

describe('discoverContainers', () => {
  const req = (url: string, pageUrl = 'https://example-1.test/') => ({ type: 'request' as const, t: 1, id: 'x', url, method: 'GET', resourceType: 'script', origin: 'page' as const, pageUrl, pageIndex: 0, initiator: { type: 'parser', chain: [] }, setCookies: [] });
  const tl = (locationId: string, urls: string[]) => ({ location: { id: locationId }, events: urls.map((u) => req(u)) }) as unknown as Timeline;

  it('finds gtm.js and gtag.js loaders, one per id, canonical URL, first location wins', () => {
    const out = discoverContainers([
      tl('de', ['https://www.googletagmanager.com/gtm.js?id=GTM-XXXX01&l=dataLayer', 'https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXX01&cx=c', 'https://example-1.test/app.js']),
      tl('us', ['https://www.googletagmanager.com/gtm.js?id=gtm-xxxx01', 'https://sgtm.example-1.test/gtm.js?id=GTM-XXXX02', 'https://www.googletagmanager.com/gtm.js?id=bogus']),
    ]);
    expect(out).toEqual([
      { id: 'GTM-XXXX01', kind: 'gtm', url: 'https://www.googletagmanager.com/gtm.js?id=GTM-XXXX01', locationId: 'de', seenOn: ['https://example-1.test/'] },
      { id: 'G-XXXXXXXX01', kind: 'gtag', url: 'https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXX01', locationId: 'de', seenOn: ['https://example-1.test/'] },
      { id: 'GTM-XXXX02', kind: 'gtm', url: 'https://sgtm.example-1.test/gtm.js?id=GTM-XXXX02', locationId: 'us', seenOn: ['https://example-1.test/'] },
    ]);
  });
});
