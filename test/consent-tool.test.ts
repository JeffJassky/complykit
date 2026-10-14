import { describe, it, expect } from 'vitest';
import { consentToolOfScript, detectConsentTool } from '../src/record/consent-tool.js';

// Fixture values are synthetic, in each tool's documented stored format.
const ck = (name: string, value: string) => ({ name, value });
const detect = (cookies: Array<{ name: string; value: string }> = [], storage: Array<{ key: string; value: string }> = [], bannerVendor?: string) =>
  detectConsentTool({ cookies, storage, bannerVendor });

describe('detectConsentTool', () => {
  it('OneTrust: decodes groups; interactionCount 0 and no AlertBoxClosed = no choice', () => {
    const v = 'isGpcEnabled=0&datestamp=Mon+Oct+06+2026&version=202403.1.0&isIABGlobal=false&hosts=&consentId=00000000-0000-0000-0000-000000000000&interactionCount=0&landingPath=NotLandingPage&groups=C0001%3A1%2CC0002%3A1%2CC0003%3A0%2CC0004%3A1%2CC0005%3A0&AwaitingReconsent=false';
    const r = detect([ck('OptanonConsent', v)]);
    expect(r).toMatchObject({ vendor: 'OneTrust', decoded: true, choiceRecorded: false, source: 'cookie:OptanonConsent' });
    expect(r.defaultGrants).toEqual({ necessary: true, analytics: true, preferences: false, marketing: true, social: false });
  });
  it('OneTrust: AlertBoxClosed marks a recorded choice', () => {
    const r = detect([ck('OptanonConsent', 'interactionCount=1&groups=C0001%3A1%2CC0004%3A0'), ck('OptanonAlertBoxClosed', '2026-10-06T00:00:00.000Z')]);
    expect(r.choiceRecorded).toBe(true);
    expect(r.defaultGrants.marketing).toBe(false);
  });
  it('Cookiebot: decodes the object cookie; implied vs explicit', () => {
    const v = encodeURIComponent("{stamp:'AbC123',necessary:true,preferences:false,statistics:false,marketing:true,method:'implied',ver:1,utc:1790000000000,region:'us'}");
    const r = detect([ck('CookieConsent', v)]);
    expect(r.vendor).toBe('Cookiebot');
    expect(r.defaultGrants).toEqual({ necessary: true, preferences: false, analytics: false, marketing: true });
    expect(r.choiceRecorded).toBe(false);
    expect(detect([ck('CookieConsent', v.replace('implied', 'explicit'))]).choiceRecorded).toBe(true);
  });
  it('Cookiebot: "-1" means the region needs no consent, everything allowed', () => {
    const r = detect([ck('CookieConsent', '-1')]);
    expect(r.defaultGrants).toEqual({ necessary: true, preferences: true, analytics: true, marketing: true });
    expect(r.choiceRecorded).toBe(false);
  });
  it('CookieYes: decodes cookieyes-consent', () => {
    const r = detect([ck('cookieyes-consent', 'consentid:YWJj,consent:no,action:,necessary:yes,functional:no,analytics:no,performance:no,advertisement:yes,other:no')]);
    expect(r).toMatchObject({ vendor: 'CookieYes', decoded: true });
    expect(r.defaultGrants).toMatchObject({ necessary: true, preferences: false, analytics: false, marketing: true });
    expect(r.choiceRecorded).toBeUndefined();
  });
  it('CookieYes legacy per-category cookies', () => {
    const r = detect([ck('cookielawinfo-checkbox-analytics', 'no'), ck('cookielawinfo-checkbox-advertisement', 'yes'), ck('cookielawinfo-checkbox-necessary', 'yes')]);
    expect(r.vendor).toBe('CookieYes');
    expect(r.defaultGrants).toEqual({ analytics: false, marketing: true, necessary: true });
  });
  it('Complianz: decodes cmplz_* cookies', () => {
    const r = detect([ck('cmplz_functional', 'allow'), ck('cmplz_statistics', 'deny'), ck('cmplz_marketing', 'allow'), ck('cmplz_consent_status', 'allow')]);
    expect(r).toMatchObject({ vendor: 'Complianz', decoded: true, choiceRecorded: true });
    expect(r.defaultGrants).toEqual({ necessary: true, analytics: false, marketing: true });
  });
  it('Complianz: a bare "dismiss" status is vendor-named, not decoded', () => {
    const r = detect([ck('cmplz_consent_status', 'dismiss')]);
    expect(r).toMatchObject({ vendor: 'Complianz', decoded: false, defaultGrants: {} });
  });
  it('vanilla-cookieconsent v3: decodes cc_cookie; categories absent from the accepted list were refused (storyfolder.com, 2026-10-08)', () => {
    const json = '{"categories":["necessary","analytics"],"revision":1,"data":null,"consentTimestamp":"2026-10-08T22:33:41.313Z","consentId":"x","services":{"necessary":[],"functional":[],"analytics":[],"advertising":[]}}';
    const c = detect([ck('cc_cookie', encodeURIComponent(json))]);
    expect(c).toMatchObject({ vendor: 'CookieConsent (orestbida)', decoded: true, choiceRecorded: true, source: 'cookie:cc_cookie' });
    expect(c.defaultGrants).toEqual({ necessary: true, preferences: false, analytics: true, marketing: false });
    expect(detect([ck('cc_cookie', 'not json')]).decoded).toBe(false);
  });
  it('Klaro: decodes the per-service cookie and localStorage forms', () => {
    const json = '{"google-analytics":true,"matomo":false}';
    const c = detect([ck('klaro', encodeURIComponent(json))]);
    expect(c).toMatchObject({ vendor: 'Klaro', decoded: true, source: 'cookie:klaro' });
    expect(c.defaultGrants).toEqual({ 'google-analytics': true, matomo: false });
    expect(detect([], [{ key: 'klaro', value: json }]).source).toBe('localStorage:klaro');
  });
  it('Osano: decodes osano_consentmanager from localStorage; legacy cookieconsent_status', () => {
    const r = detect([], [{ key: 'osano_consentmanager', value: '{"ESSENTIAL":"ACCEPT","ANALYTICS":"DENY","MARKETING":"ACCEPT","PERSONALIZATION":"DENY"}' }]);
    expect(r.vendor).toBe('Osano');
    expect(r.defaultGrants).toEqual({ necessary: true, analytics: false, marketing: true, preferences: false });
    expect(detect([ck('cookieconsent_status', 'deny')]).defaultGrants.marketing).toBe(false);
    expect(detect([ck('cookieconsent_status', 'dismiss')])).toMatchObject({ vendor: 'Osano', decoded: false });
  });
  it('Termly: vendor named, grants not guessed', () => {
    const r = detect([ck('consentUUID', 'x_1_2_3')]);
    expect(r).toMatchObject({ vendor: 'Termly', decoded: false, defaultGrants: {} });
    expect(detect([], [{ key: 'TERMLY_API_CACHE', value: '{}' }]).vendor).toBe('Termly');
  });
  it('Shopify _tracking_consent v2.1 purposes', () => {
    const v = encodeURIComponent('{"v":"2.1","region":"USCA","reg":"ENF","purposes":{"a":true,"p":true,"m":false,"t":false},"sale_of_data_region":true,"display_banner":true,"consent_id":"x"}');
    const r = detect([ck('_tracking_consent', v)]);
    expect(r.vendor).toBe('Shopify customer privacy');
    expect(r.defaultGrants).toEqual({ analytics: true, preferences: true, marketing: false, 'sale-of-data': false });
  });
  it('Shopify v2.0 CMP: empty means not chosen, not granted or denied', () => {
    const v = encodeURIComponent('{"v":"2.0","region":"DE","con":{"CMP":{"a":"","m":"0","p":"","s":""}}}');
    expect(detect([ck('_tracking_consent', v)]).defaultGrants).toEqual({ marketing: false });
  });
  it('complykit cookie (client store format 1)', () => {
    const v = { v: 1, id: 'a'.repeat(32), at: '2026-10-06T00:00:00.000Z', configHash: 'h'.repeat(64), regime: 'opt-in', gpc: true, categories: { necessary: true, analytics: false, advertising: true } };
    const r = detect([ck('complykit_consent', encodeURIComponent(JSON.stringify(v)))]);
    expect(r).toMatchObject({ vendor: 'complykit', decoded: true, choiceRecorded: true, defaultGrants: { necessary: true, analytics: false, advertising: true } });
    expect(r.note).toContain('opt-in');
    // another format version is named, never guessed at
    expect(detect([ck('complykit_consent', encodeURIComponent(JSON.stringify({ ...v, v: 2 })))])).toMatchObject({ vendor: 'complykit', decoded: false, defaultGrants: {} });
  });
  it('undecodable garbage names the vendor and never guesses grants', () => {
    const r = detect([ck('OptanonConsent', 'not-a-real-value')]);
    expect(r).toMatchObject({ vendor: 'OneTrust', decoded: false, defaultGrants: {} });
  });
  it('banner-only fallback, then none detected', () => {
    expect(detect([], [], 'Didomi')).toMatchObject({ vendor: 'Didomi', decoded: false, source: 'banner:detected' });
    expect(detect([ck('session', 'abc')])).toMatchObject({ vendor: null, decoded: false, source: 'none' });
  });
});

describe('consentToolOfScript', () => {
  it('names a WordPress consent plugin by its directory on any host (a CDN mirror of /wp-content/ included)', () => {
    expect(consentToolOfScript('https://eadn-wc01-3990025.nxedge.io/wp-content/plugins/webtoffee-cookie-consent/lite/frontend/js/script.min.js?ver=3.5.5')).toBe('webtoffee-cookie-consent');
    expect(consentToolOfScript('https://shop.example/wp-content/plugins/cookie-law-info/lite/frontend/js/script.min.js')).toBe('cookieyes');
    expect(consentToolOfScript('https://shop.example/wp-content/plugins/complianz-gdpr/assets/js/complianz.min.js')).toBe('complianz');
  });

  it('names a hosted consent tool by its script host', () => {
    expect(consentToolOfScript('https://cdn.cookielaw.org/scripttemplates/otSDKStub.js')).toBe('onetrust');
    expect(consentToolOfScript('https://consent.cookiebot.com/uc.js')).toBe('cookiebot');
    expect(consentToolOfScript('https://app.termly.io/resource-blocker/abc')).toBe('termly');
  });

  it('anything else is not a consent tool', () => {
    expect(consentToolOfScript('https://www.googletagmanager.com/gtag/js?id=G-1')).toBeUndefined();
    expect(consentToolOfScript('https://shop.example/wp-content/plugins/woocommerce/assets/js/frontend.js')).toBeUndefined();
    expect(consentToolOfScript('not a url')).toBeUndefined();
    expect(consentToolOfScript('https://evilcookielaw.org/x.js')).toBeUndefined();
  });
});
