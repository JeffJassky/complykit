import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { tracking } from '../src/rules/index.js';
import {
  registrableDomain,
  domainLabel,
  hostedOn,
  lookupEntry,
  lookupStore,
  DEFAULT_KB,
  buildKnowledgeBase,
  jurisdictionsFor,
  requirementScopeFor,
  getRequirement,
  normalizeRegion,
  verifyRegistry,
} from '../src/registry/index.js';
import { redactTimeline, Timeline } from '../src/record/index.js';
import { redactHar } from '../src/collect/browser/evaluation/har.js';

const { parseFields, classifyFields, findMarkers, decodeConsent, allDenied, adsRestricted, decideVerification, defaultScenarios, quickScenarios, locationPreset } = tracking;

describe('vendor consent decoders', () => {
  it('Google gcs/gcd: denied, granted, restricted', () => {
    const denied = decodeConsent('google', parseFields('https://region1.google-analytics.com/g/collect?v=2&gcs=G100&gcd=13p3p3p2p5l1'))!;
    expect(denied.adStorage).toBe('denied');
    expect(denied.analyticsStorage).toBe('denied');
    expect(denied.adUserData).toBe('denied');
    expect(allDenied(denied)).toBe(true);
    const granted = decodeConsent('google', parseFields('https://www.google-analytics.com/g/collect?gcs=G111&gcd=13v3v3v3v5'))!;
    expect(granted.adStorage).toBe('granted');
    expect(granted.adPersonalization).toBe('granted');
    expect(allDenied(granted)).toBe(false);
    const rdp = decodeConsent('google', parseFields('https://googleads.g.doubleclick.net/pagead/viewthroughconversion/1/?rdp=1&npa=1'))!;
    expect(rdp.restricted).toBe(true);
    expect(adsRestricted(rdp)).toBe(true);
  });

  it('Meta Limited Data Use and IAB us_privacy opt-out', () => {
    expect(decodeConsent('meta', parseFields('https://www.facebook.com/tr/?id=1&ev=PageView&dpo=LDU&dpoco=1&dpost=1000'))?.restricted).toBe(true);
    expect(decodeConsent('meta', parseFields('https://www.facebook.com/tr/?id=1&ev=PageView'))).toBeUndefined();
    const usp = decodeConsent('none', parseFields('https://ads.example/x?us_privacy=1YYN'))!;
    expect(usp.restricted).toBe(true);
    expect(usp.iab?.usPrivacy).toBe('1YYN');
  });
});

describe('field classification', () => {
  const ctx = {
    pageUrl: 'https://shop.example.com/products/red-shoe?variant=2',
    pageTitle: 'Red Shoe – Shop',
    deviceValues: new Map([['GA1.1.123456789.1700000000', 'cookie _ga'], ['abcd1234efgh5678', 'local uid']]),
    markers: { email: 'ck.marker.abc@example.com', text: 'ckmarkerabc', clickIds: { gclid: 'CK_GCLID_abc' } },
  };

  it('recognizes page address, title, stored IDs, events — by value, not by parameter name', () => {
    const f = parseFields(`https://t.example/collect?dl=${encodeURIComponent(ctx.pageUrl)}&dt=${encodeURIComponent(ctx.pageTitle)}&cid=123456789.1700000000&en=page_view`);
    const { kinds, ids } = classifyFields(f, ctx);
    expect([...kinds]).toEqual(expect.arrayContaining(['page-address', 'page-title', 'browser-id', 'event-name']));
    expect(ids[0].storedAs).toBe('cookie _ga');
  });

  it('finds markers plain, encoded, base64 and as the normalized-email hash ad platforms send', () => {
    const sha = createHash('sha256').update('ck.marker.abc@example.com').digest('hex');
    expect(findMarkers([`https://px.example/k?v=${encodeURIComponent('ck.marker.abc@example.com')}`], ctx.markers)[0]?.marker).toBe('email');
    expect(findMarkers([`https://px.example/k?em=${sha}`], ctx.markers).some((h) => h.form === 'sha256')).toBe(true);
    expect(findMarkers([undefined, JSON.stringify({ q: Buffer.from('ckmarkerabc').toString('base64') })], ctx.markers).some((h) => h.marker === 'search-text' && h.form === 'base64')).toBe(true);
    expect(findMarkers(['https://x.example/?gclid=CK_GCLID_abc'], ctx.markers)[0]).toMatchObject({ marker: 'click-id', name: 'gclid' });
  });

  it('parses JSON and urlencoded bodies', () => {
    expect(parseFields('https://x.example/e', '{"a":{"b":"c"},"list":[1,2]}').map((f) => f.key)).toEqual(expect.arrayContaining(['a.b', 'list[0]']));
    expect(parseFields('https://x.example/e', 'u=hello&id=42').find((f) => f.key === 'id')?.value).toBe('42');
  });
});

describe('location verification', () => {
  const at = '2026-10-02T00:00:00Z';
  const src = (country: string, region?: string, error?: string) => ({ name: 'x', ip: '1.2.3.4', country, region, error });

  it('verified needs two agreeing sources and maps the place to jurisdictions', () => {
    const v = decideVerification({ id: 'us-ca', country: 'US', region: 'CA' }, [src('US', 'California'), src('US', 'CA')], at);
    expect(v.verdict).toBe('verified');
    expect(v.jurisdictions).toEqual(['us', 'us-ca']);
  });

  it('one source is not enough; a disagreeing source is a mismatch; country agreement without region drops to country level', () => {
    expect(decideVerification({ id: 'de', country: 'DE' }, [src('DE'), { name: 'y', error: 'timeout' }], at).verdict).toBe('unknown');
    expect(decideVerification({ id: 'de', country: 'DE' }, [src('NL'), src('NL')], at).verdict).toBe('mismatch');
    expect(decideVerification({ id: 'us-ca', country: 'US', region: 'CA' }, [src('US', 'NV'), src('US', 'CA')], at).verdict).toBe('mismatch');
    const v = decideVerification({ id: 'us-ca', country: 'US', region: 'CA' }, [src('US'), src('US', 'CA')], at);
    expect(v.verdict).toBe('verified');
    expect(v.regionUnverified).toBe(true);
    expect(v.jurisdictions).toEqual(['us']);
  });

  it('local takes whatever two sources agree on', () => {
    const v = decideVerification({ id: 'local' }, [src('US', 'Florida'), src('US', 'FL')], at);
    expect(v.jurisdictions).toEqual(['us', 'us-fl']);
    expect(normalizeRegion('US', 'Florida')).toBe('FL');
  });
});

describe('jurisdictions and scenario plans', () => {
  it('scopes requirements by place and per-state effective date', () => {
    const st = getRequirement('us-states.opt-out-signal')!;
    expect(requirementScopeFor(st, jurisdictionsFor({ country: 'US', region: 'OR' }), '2025-06-01')).toBeUndefined();
    expect(requirementScopeFor(st, jurisdictionsFor({ country: 'US', region: 'OR' }), '2026-02-01')).toBe('us-or');
    expect(requirementScopeFor(getRequirement('eprivacy.art5.3')!, jurisdictionsFor({ country: 'NO' }), '2026-10-02')).toBe('eu');
    expect(requirementScopeFor(getRequirement('eprivacy.art5.3')!, jurisdictionsFor({ country: 'GB' }), '2026-10-02')).toBeUndefined();
    expect(requirementScopeFor(getRequirement('ccpa.regs.7025c6')!, ['us', 'us-ca'], '2025-12-31')).toBeUndefined();
  });

  it('default scenario sets per jurisdiction', () => {
    expect(defaultScenarios(['eu', 'eu-de'])).toContain('withdraw');
    expect(defaultScenarios(['us', 'us-ca'])).toContain('opt-out-link');
    expect(defaultScenarios(['us', 'us-fl'])).toEqual(['do-nothing', 'browse', 'reject', 'accept', 'gpc', 'markers']);
    expect(locationPreset('us-ca')).toMatchObject({ country: 'US', region: 'CA' });
    expect(locationPreset('uk')).toMatchObject({ country: 'GB' });
    expect(() => locationPreset('mars')).toThrow();
  });

  // A banner under US opt-out rules can hold the main trackers until accepted
  // (Shopify, California): without an accept visit they are never observed there.
  it('US opt-out and opt-out-signal locations plan an accept visit (banner-gated in the runner)', () => {
    expect(defaultScenarios(['us', 'us-ca'])).toEqual(['do-nothing', 'browse', 'reject', 'accept', 'gpc', 'opt-out-all', 'opt-out-link', 'markers']);
    expect(defaultScenarios(['us', 'us-co'])).toContain('accept');
    expect(defaultScenarios(['us', 'us-tx'])).toContain('accept');
    expect(defaultScenarios(['us'])).toContain('accept');
    // Accept follows reject, so the refusal is still the earlier visit.
    for (const j of [['us', 'us-ca'], ['us', 'us-fl']]) {
      const s = defaultScenarios(j);
      expect(s.indexOf('accept')).toBe(s.indexOf('reject') + 1);
    }
    // Unchanged elsewhere.
    expect(defaultScenarios(['eu', 'eu-de'])).toEqual(['do-nothing', 'browse', 'dismiss', 'reject', 'accept', 'partial', 'withdraw', 'return-visit', 'markers']);
    expect(defaultScenarios(['br'])).toEqual(['do-nothing', 'browse', 'reject', 'accept']);
  });

  it('quick mode adds accept for US locations only', () => {
    expect(quickScenarios(['us', 'us-ca'])).toEqual(['do-nothing', 'reject', 'accept', 'gpc', 'markers']);
    expect(quickScenarios(['us', 'us-fl'])).toEqual(['do-nothing', 'reject', 'accept', 'gpc', 'markers']);
    expect(quickScenarios(['eu', 'eu-de'])).toEqual(['do-nothing', 'reject', 'accept']);
    expect(quickScenarios(['br'])).toEqual(['do-nothing', 'reject']);
  });

  it('the registry still verifies clean with the tracking requirements', () => {
    expect(verifyRegistry().errors).toEqual([]);
  });
});

describe('knowledge base', () => {
  it('registrable domains handle multi-label suffixes and hosting platforms', () => {
    expect(registrableDomain('px.ads.linkedin.com')).toBe('linkedin.com');
    expect(registrableDomain('shop.example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('store-a.myshopify.com')).toBe('store-a.myshopify.com');
  });

  it('a bucket or app on shared cloud hosting is its own party, named by its tenant', () => {
    expect(registrableDomain('storyfolder-releases.s3.amazonaws.com')).toBe('storyfolder-releases.s3.amazonaws.com');
    expect(registrableDomain('assets.s3.us-west-2.amazonaws.com')).toBe('assets.s3.us-west-2.amazonaws.com');
    expect(registrableDomain('s3-assets.s3.amazonaws.com')).toBe('s3-assets.s3.amazonaws.com');
    expect(registrableDomain('s3.amazonaws.com')).toBe('s3.amazonaws.com');
    expect(registrableDomain('acct.blob.core.windows.net')).toBe('acct.blob.core.windows.net');
    expect(registrableDomain('media.nyc3.digitaloceanspaces.com')).toBe('media.nyc3.digitaloceanspaces.com');
    expect(registrableDomain('fonts.googleapis.com')).toBe('googleapis.com');
    expect(registrableDomain('my-bucket.storage.googleapis.com')).toBe('my-bucket.storage.googleapis.com');
    expect(registrableDomain('x.y.elb.amazonaws.com')).toBe('amazonaws.com');
    expect(hostedOn('storyfolder-releases.s3.amazonaws.com')).toEqual({ provider: 'Amazon S3', name: 'storyfolder-releases' });
    expect(hostedOn('d111.cloudfront.net')).toEqual({ provider: 'Amazon CloudFront', name: 'd111' });
    expect(hostedOn('googleapis.com')).toBeUndefined();
    expect(domainLabel('storyfolder-releases.s3.amazonaws.com')).toBe('storyfolder-releases (Amazon S3)');
    expect(domainLabel('widgets.test')).toBe('widgets.test');
  });

  it('path-specific entries win on shared hosts; stores are looked up by name', () => {
    expect(lookupEntry(DEFAULT_KB, 'www.google.com', '/recaptcha/api.js')?.id).toBe('google.recaptcha');
    expect(lookupEntry(DEFAULT_KB, 'www.google.com', '/ccm/collect')?.id).toBe('google.ads.ccm');
    expect(lookupEntry(DEFAULT_KB, 'connect.facebook.net', '/en_US/fbevents.js')?.id).toBe('meta.pixel');
    expect(lookupStore(DEFAULT_KB, '_fbp')?.id).toBe('meta.pixel');
    expect(DEFAULT_KB.entries.every((e) => !e.provenance.confirmedBy)).toBe(true); // seed = proposals
  });

  it('local entries come first and overrides change a category', () => {
    const kb = buildKnowledgeBase({ overrides: [{ id: 'intercom', categories: ['functional'], note: 'support portal' }] });
    expect(lookupEntry(kb, 'widget.intercom.io')?.categories).toEqual(['functional']);
    expect(kb.version).toMatch(/\+local/);
  });
});

describe('redaction', () => {
  it('timelines keep URLs but not values', () => {
    const t = Timeline.parse({
      location: { id: 'de', proxy: { server: 'socks5://x', password: 'secret' } },
      verification: { verdict: 'verified', expected: {}, observed: {}, sources: [], checkedAt: 'x' },
      events: [{ type: 'request', t: 1, id: 'r1', url: 'https://x/p?id=1', method: 'POST', resourceType: 'fetch', origin: 'page', pageUrl: 'https://s/', pageIndex: 0, initiator: { type: 'script' }, postData: 'token=abc' }],
      snapshot: { site: { url: 'https://s/', host: 's', registrableDomain: 's' }, scenario: 'browse', locationId: 'de', startedAt: 'x', durationMs: 1, gpc: false, browser: { name: 'chromium' }, pages: [], cookies: [{ name: 'sid', value: 'supersecretvalue', domain: 's', expires: -1, httpOnly: true, secure: true }], storage: [], frames: [] },
    });
    const r = redactTimeline(t);
    expect(r.snapshot.cookies[0].value).toMatch(/^sha256:/);
    expect(r.events[0].type === 'request' && r.events[0].postData).toMatch(/^\[redacted/);
    expect(r.events[0].type === 'request' && r.events[0].url).toBe('https://x/p?id=1');
    expect(r.location.proxy).toEqual({ server: 'socks5://x' });
  });

  it('HARs lose cookie values, auth headers and bodies', () => {
    const har = { log: { entries: [{ request: { headers: [{ name: 'Cookie', value: 'a=b' }, { name: 'Accept', value: '*/*' }], cookies: [{ name: 'a', value: 'b' }], postData: { text: 'x=1' } }, response: { headers: [{ name: 'set-cookie', value: 'c=d' }], cookies: [{ name: 'c', value: 'd' }] } }] } };
    redactHar(har);
    const e = har.log.entries[0];
    expect(e.request.headers[0].value).toMatch(/redacted/);
    expect(e.request.headers[1].value).toBe('*/*');
    expect(e.response.cookies[0].value).toMatch(/redacted/);
    expect(e.request.postData.text).toMatch(/redacted/);
  });
});
