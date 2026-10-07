import { describe, it, expect } from 'vitest';
import { classifyPlatform, platformLoaderOf, type PlatformSignalsInput } from '../src/registry/index.js';
import { tracking } from '../src/rules/index.js';
import { Timeline } from '../src/record/index.js';

// Fixture signal sets: generic hosts only, no captured client markup.
const sig = (s: Partial<PlatformSignalsInput>): PlatformSignalsInput => ({ globals: [], assetUrls: [], ...s });

describe('classifyPlatform', () => {
  it('Shopify: window.Shopify + cdn asset; customerPrivacy names the consent plugin', () => {
    const p = classifyPlatform(sig({ globals: ['Shopify', 'Shopify.customerPrivacy'], assetUrls: ['https://cdn.shopify.com/s/files/1/0000/theme.js'] }))!;
    expect(p.name).toBe('shopify');
    expect(p.consentPlugin).toBe('shopify-customer-privacy');
    expect(p.evidence.join(' ')).toContain('window.Shopify');
  });

  it('Shopify without the privacy API has no consent plugin', () => {
    const p = classifyPlatform(sig({ globals: ['Shopify'] }))!;
    expect(p.name).toBe('shopify');
    expect(p.consentPlugin).toBeUndefined();
  });

  it('Wix: wixBiSession or parastorage assets', () => {
    expect(classifyPlatform(sig({ globals: ['wixBiSession'] }))?.name).toBe('wix');
    expect(classifyPlatform(sig({ assetUrls: ['https://static.parastorage.com/services/x/y.js'] }))?.name).toBe('wix');
  });

  it('Squarespace: static1 asset and template version', () => {
    const p = classifyPlatform(sig({ assetUrls: ['https://static1.squarespace.com/static/vta/x/scripts/site.js'], globals: ['Static.SQUARESPACE_CONTEXT'], templateVersion: '7.1' }))!;
    expect(p).toMatchObject({ name: 'squarespace', version: '7.1' });
  });

  it('WordPress: a WebToffee cookie-consent plugin path names the consent plugin', () => {
    const p = classifyPlatform(sig({ generator: 'WordPress 6.5.2', assetUrls: ['https://example-shop.test/wp-content/plugins/webtoffee-cookie-consent/lite/frontend/js/script.min.js?ver=3'] }))!;
    expect(p).toMatchObject({ name: 'wordpress', consentPlugin: 'webtoffee-cookie-consent' });
  });

  it('WordPress: generator version, plugin path, WP Consent API', () => {
    const p = classifyPlatform(
      sig({
        generator: 'WordPress 6.5.2',
        globals: ['wp_has_consent', 'wp_consent_type'],
        assetUrls: ['https://example-shop.test/wp-content/plugins/complianz-gdpr/assets/js/cmplz.min.js?ver=1'],
      }),
    )!;
    expect(p).toMatchObject({ name: 'wordpress', version: '6.5.2', consentPlugin: 'complianz', wpConsentApi: true });
  });

  it('WordPress: CookieYes by plugin directory and by global', () => {
    expect(classifyPlatform(sig({ assetUrls: ['https://a.test/wp-content/plugins/cookie-law-info/lite/frontend/js/script.min.js'] }))?.consentPlugin).toBe('cookieyes');
    expect(classifyPlatform(sig({ generator: 'WordPress 6.4', globals: ['ckySettings'] }))?.consentPlugin).toBe('cookieyes');
  });

  it('WordPress: no consent plugin is reported as none, not guessed', () => {
    const p = classifyPlatform(sig({ generator: 'WordPress 6.5', assetUrls: ['https://a.test/wp-includes/js/jquery/jquery.min.js'] }))!;
    expect(p.consentPlugin).toBeUndefined();
    expect(p.wpConsentApi).toBeUndefined();
  });

  it('a bare `wp` global is not enough, and no signals means no platform', () => {
    expect(classifyPlatform(sig({ globals: ['wp'] }))).toBeUndefined();
    expect(classifyPlatform(sig({}))).toBeUndefined();
    expect(classifyPlatform(undefined)).toBeUndefined();
  });

  it('the generator tag breaks a tie when a WordPress page embeds Shopify', () => {
    const p = classifyPlatform(sig({ generator: 'WordPress 6.5', globals: ['Shopify'], assetUrls: ['https://cdn.shopify.com/buy-button.js', 'https://a.test/wp-content/themes/t/s.js'] }))!;
    expect(p.name).toBe('wordpress');
  });

  it('keeps query strings out of the evidence', () => {
    const p = classifyPlatform(sig({ assetUrls: ['https://static.parastorage.com/a.js?token=SECRET'] }))!;
    expect(p.evidence.join(' ')).not.toContain('SECRET');
  });
});

describe('platformLoaderOf', () => {
  it('host loaders match anywhere; first-party paths need the fingerprint', () => {
    expect(platformLoaderOf('https://cdn.shopify.com/extensions/x.js', undefined)).toBe('shopify');
    expect(platformLoaderOf('https://static.parastorage.com/x.js', undefined)).toBe('wix');
    expect(platformLoaderOf('https://static1.squarespace.com/x.js', undefined)).toBe('squarespace');
    expect(platformLoaderOf('https://example-shop.test/wp-content/plugins/p/a.js', undefined)).toBeUndefined();
    expect(platformLoaderOf('https://example-shop.test/wp-content/plugins/p/a.js', { name: 'wordpress' })).toBe('wordpress');
    expect(platformLoaderOf('https://example-shop.test/cdn/wpm/b1.js', { name: 'shopify' })).toBe('shopify');
    expect(platformLoaderOf('https://example-shop.test/cdn/wpm/b1.js', { name: 'wordpress' })).toBeUndefined();
    // A consent plugin releasing a tag it held is not the platform injecting one (E4).
    expect(platformLoaderOf('https://example-shop.test/wp-content/plugins/webtoffee-cookie-consent/lite/frontend/js/script.min.js', { name: 'wordpress' })).toBeUndefined();
    expect(platformLoaderOf('https://example-shop.test/wp-content/plugins/complianz-gdpr/assets/js/complianz.min.js', { name: 'wordpress' })).toBeUndefined();
    expect(platformLoaderOf('https://example-shop.test/wp-content/plugins/some-pixel-plugin/a.js', { name: 'wordpress' })).toBe('wordpress');
    expect(platformLoaderOf('https://www.googletagmanager.com/gtm.js', { name: 'shopify' })).toBeUndefined();
  });
});

describe('attribution to the platform loader', () => {
  const timeline = (signals: PlatformSignalsInput | undefined, chain: string[]) =>
    Timeline.parse({
      location: { id: 'us' },
      verification: { verdict: 'verified', expected: {}, observed: {}, sources: [], checkedAt: 'x', jurisdictions: [] },
      events: [
        { type: 'request', t: 1, id: 'r1', url: 'https://px.tracker-example.test/collect?v=1', method: 'GET', resourceType: 'script', origin: 'page', pageUrl: 'https://example-shop.test/', pageIndex: 0, initiator: { type: 'script', chain } },
      ],
      snapshot: {
        site: { url: 'https://example-shop.test/', host: 'example-shop.test', registrableDomain: 'example-shop.test' },
        scenario: 'browse', locationId: 'us', startedAt: '2026-10-06T00:00:00Z', durationMs: 1, gpc: false,
        browser: { name: 'chromium' }, pages: [{ url: 'https://example-shop.test/' }], cookies: [], storage: [], frames: [],
        platformSignals: signals,
      },
    });
  const source = (t: ReturnType<typeof timeline>) => {
    const a = tracking.analyzeTimeline(t);
    const p = [...a.parties.values()].find((x) => x.domain === 'tracker-example.test')!;
    return { source: p.source, loadedBy: p.loadedBy };
  };

  it('Shopify web-pixels loader on the store domain: source platform, loadedBy the loader', () => {
    const loader = 'https://example-shop.test/cdn/wpm/b123.js';
    const r = source(timeline(sig({ globals: ['Shopify'] }), [loader]));
    expect(r).toEqual({ source: 'platform', loadedBy: [loader] });
  });

  it('the platform loader moves to the front even when a tag manager is nearer', () => {
    const gtm = 'https://cdn.tagmgr-example.test/gtm.js';
    const loader = 'https://cdn.shopify.com/extensions/app.js';
    const r = source(timeline(sig({ globals: ['Shopify'] }), [gtm, loader]));
    expect(r.source).toBe('platform');
    expect(r.loadedBy).toEqual([loader, gtm]);
  });

  it('WordPress plugin script: platform only when WordPress was fingerprinted', () => {
    const plugin = 'https://example-shop.test/wp-content/plugins/ads-helper/a.js';
    expect(source(timeline(sig({ generator: 'WordPress 6.5' }), [plugin])).source).toBe('platform');
    expect(source(timeline(undefined, [plugin])).source).toBe('injected');
  });

  it('a tag-manager injection stays injected', () => {
    const gtm = 'https://cdn.tagmgr-example.test/gtm.js';
    expect(source(timeline(sig({ globals: ['Shopify'] }), [gtm])).source).toBe('injected');
  });
});

describe('platformOf (record field)', () => {
  it('pools signals across timelines and stays undefined without any', () => {
    const base = (platformSignals: PlatformSignalsInput | undefined) =>
      Timeline.parse({
        location: { id: 'us' },
        verification: { verdict: 'verified', expected: {}, observed: {}, sources: [], checkedAt: 'x', jurisdictions: [] },
        events: [],
        snapshot: { site: { url: 'https://a.test/', host: 'a.test', registrableDomain: 'a.test' }, scenario: 'browse', locationId: 'us', startedAt: 'x', durationMs: 1, gpc: false, browser: { name: 'chromium' }, pages: [], cookies: [], storage: [], frames: [], platformSignals },
      });
    expect(tracking.platformOf([base(undefined)])).toBeUndefined();
    expect(tracking.platformOf([base(sig({ generator: 'WordPress 6.5' })), base(sig({ globals: ['wp_has_consent'] }))])).toMatchObject({ name: 'wordpress', wpConsentApi: true });
  });
});
