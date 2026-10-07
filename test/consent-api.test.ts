import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright';
import { startCapture } from '../src/collect/browser/evaluation/capture.js';
import { Timeline, type ConsentApiEvent, type TimelineEvent } from '../src/record/index.js';
import { analyzeConsentApi, consentApiCalls, interpretCall } from '../src/rules/tracking/index.js';

// A3: the in-page consent-API call recorder. Two halves:
//   1. pure — interpretCall / analyzeConsentApi over hand-built timelines;
//   2. browser — the fixture page (test/fixtures/pages/consent-api.html) installs
//      every hooked API the way vendors do (stub, then the real library), then
//      the visitor rejects. The timeline must show every call with its phase,
//      the three states must be derived, and every vendor must still work.

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(path.join(here, 'fixtures/pages/consent-api.html'), 'utf8');

function timeline(events: TimelineEvent[], scenario: 'reject' | 'withdraw' | 'browse' = 'reject'): Timeline {
  return Timeline.parse({
    location: { id: 'local' },
    verification: { verdict: 'unknown', expected: {}, observed: {}, sources: [], checkedAt: '2026-10-06T00:00:00Z' },
    events,
    snapshot: {
      site: { url: 'https://example-shop.test/', host: 'example-shop.test', registrableDomain: 'example-shop.test' },
      scenario,
      locationId: 'local',
      startedAt: '2026-10-06T00:00:00Z',
      durationMs: 10000,
      gpc: false,
      browser: { name: 'chromium' },
      pages: [{ url: 'https://example-shop.test/' }],
      cookies: [],
      storage: [],
      frames: [],
    },
  });
}

const api = (t: number, a: ConsentApiEvent['api'], call: string, args: unknown[], extra: Partial<ConsentApiEvent> = {}): ConsentApiEvent => ({
  type: 'consent-api',
  t,
  api: a,
  kind: 'call',
  call,
  args,
  frameUrl: 'https://example-shop.test/',
  top: true,
  chain: [],
  pageIndex: 0,
  ...extra,
});
const banner = (t: number): TimelineEvent => ({ type: 'banner', t, state: 'shown', pageIndex: 0 });
const choice = (t: number, c: 'reject' | 'accept' | 'withdraw', pageIndex = 0): TimelineEvent => ({ type: 'choice', t, choice: c, ok: true, method: 'selector', pageIndex });

describe('interpretCall', () => {
  it('reads what each API was told', () => {
    expect(interpretCall({ api: 'google', call: 'gtag', kind: 'call', args: ['consent', 'default', { ad_storage: 'denied', analytics_storage: 'granted', wait_for_update: 500 }] })).toEqual({
      command: 'consent default',
      action: 'default',
      consent: { ad_storage: 'denied', analytics_storage: 'granted' },
      regional: false,
    });
    expect(interpretCall({ api: 'google', call: 'dataLayer.push', kind: 'call', args: [{ event: 'gtm.js', 'gtm.start': '<number>' }] }).action).toBe('measure');
    expect(interpretCall({ api: 'meta', call: 'fbq', kind: 'call', args: ['consent', 'revoke'] }).action).toBe('revoke');
    expect(interpretCall({ api: 'tiktok', call: 'ttq.holdConsent', kind: 'call', args: [] }).action).toBe('hold');
    expect(interpretCall({ api: 'clarity', call: 'clarity', kind: 'call', args: ['consent', false] }).action).toBe('revoke');
    expect(interpretCall({ api: 'clarity', call: 'clarity', kind: 'call', args: ['consentv2', { ad_Storage: 'granted' }] }).consent).toEqual({ ad_Storage: 'granted' });
    expect(interpretCall({ api: 'microsoft-uet', call: 'uetq.push', kind: 'call', args: ['consent', 'update', { ad_storage: 'denied' }] }).action).toBe('update');
    expect(interpretCall({ api: 'shopify', call: 'Shopify.customerPrivacy.setTrackingConsent', kind: 'call', args: [{ analytics: true, marketing: false }] }).consent).toEqual({
      analytics: 'granted',
      marketing: 'denied',
    });
    expect(interpretCall({ api: 'tcf', call: '__tcfapi', kind: 'call', args: ['getTCData', '<number>'] }).action).toBe('read');
    expect(interpretCall({ api: 'google', call: 'gtag', kind: 'call', args: ['consent', 'default', { ad_storage: 'granted', region: ['US'] }] }).regional).toBe(true);
  });
});

describe('analyzeConsentApi (pure)', () => {
  it('places each call in its consent phase', () => {
    const calls = consentApiCalls(
      timeline([banner(100), api(50, 'meta', 'fbq', ['init', '<string>']), api(200, 'meta', 'fbq', ['track', 'PageView']), choice(300, 'reject'), api(400, 'meta', 'fbq', ['consent', 'revoke'])]),
    );
    expect(calls.map((c) => c.phase)).toEqual(['before-banner', 'before-choice', 'after-reject']);
  });

  it("flags a Consent Mode default set after gtag loaded or measured — but not a container's own Consent Initialization default", () => {
    const late = analyzeConsentApi(
      timeline([api(10, 'google', 'gtag', ['config', 'G-X']), api(20, 'google', 'dataLayer.push', [], { kind: 'ready' }), api(30, 'google', 'gtag', ['consent', 'default', { ad_storage: 'denied' }])], 'browse'),
    );
    expect(late.states.map((s) => s.state)).toEqual(['default-after-load']);
    const early = analyzeConsentApi(
      timeline([api(10, 'google', 'gtag', ['consent', 'default', { ad_storage: 'denied' }]), api(20, 'google', 'gtag', ['config', 'G-X']), api(30, 'google', 'dataLayer.push', [], { kind: 'ready' })], 'browse'),
    );
    expect(early.states).toEqual([]);
    const container = analyzeConsentApi(
      timeline(
        [
          api(10, 'google', 'dataLayer.push', [{ event: 'gtm.js' }]),
          api(20, 'google', 'dataLayer.push', [], { kind: 'ready' }),
          api(30, 'google', 'gtag', ['consent', 'default', { ad_storage: 'denied' }], { chain: ['https://www.googletagmanager.com/gtm.js?id=GTM-XXXX01'] }),
        ],
        'browse',
      ),
    );
    expect(container.states).toEqual([]);
    // …unless a measurement hit had already gone out.
    const hit: TimelineEvent = {
      type: 'request',
      t: 15,
      id: 'r1',
      url: 'https://region1.google-analytics.com/g/collect?v=2',
      method: 'POST',
      resourceType: 'ping',
      origin: 'page',
      pageUrl: 'https://example-shop.test/',
      pageIndex: 0,
      initiator: { type: 'script', chain: [] },
      setCookies: [],
    };
    const sent = analyzeConsentApi(
      timeline([hit, api(30, 'google', 'gtag', ['consent', 'default', { ad_storage: 'denied' }], { chain: ['https://www.googletagmanager.com/gtm.js?id=GTM-XXXX01'] })], 'browse'),
    );
    expect(sent.states.map((s) => s.state)).toEqual(['default-after-load']);
  });

  it('says so — never passes — when Google ran with no default seen', () => {
    const r = analyzeConsentApi(timeline([api(10, 'google', 'gtag', ['config', 'G-X'])], 'browse'));
    expect(r.states).toEqual([]);
    expect(r.unknowns.join(' ')).toMatch(/no Consent Mode default seen/);
  });

  it('flags a vendor never told after reject, or told granted and never revoked', () => {
    const never = analyzeConsentApi(timeline([banner(0), api(10, 'meta', 'fbq', ['init', '<string>']), choice(100, 'reject')]));
    expect(never.states).toMatchObject([{ state: 'not-called-after-refusal', api: 'meta', phase: 'after-reject' }]);
    expect(never.states[0].reason).toMatch(/never called/);

    const notRevoked = analyzeConsentApi(
      timeline([banner(0), choice(50, 'accept'), api(60, 'meta', 'fbq', ['consent', 'grant']), choice(100, 'withdraw'), api(150, 'meta', 'fbq', ['track', 'PageView'])], 'withdraw'),
    );
    expect(notRevoked.states.map((s) => s.state)).toEqual(['not-called-after-refusal']);
    expect(notRevoked.states[0].reason).toMatch(/told 'granted'/);

    const revoked = analyzeConsentApi(timeline([banner(0), api(10, 'meta', 'fbq', ['init', '<string>']), choice(100, 'reject'), api(110, 'meta', 'fbq', ['consent', 'revoke'])]));
    expect(revoked.states).toEqual([]);
    // Denied before the choice: nothing more to say after it.
    const deniedFirst = analyzeConsentApi(timeline([banner(0), api(5, 'meta', 'fbq', ['consent', 'revoke']), choice(100, 'reject')]));
    expect(deniedFirst.states).toEqual([]);
    // A vendor gated off (never seen on the page of the choice or after) is not this state.
    const gated = analyzeConsentApi(timeline([banner(0), api(10, 'meta', 'fbq', ['init', '<string>'], { pageIndex: 0 }), choice(100, 'withdraw', 1)], 'withdraw'));
    expect(gated.states).toEqual([]);
  });

  it('flags a grant before any choice and after a refusal; ignores region-scoped defaults (as unknown)', () => {
    const r = analyzeConsentApi(timeline([banner(0), api(5, 'tiktok', 'ttq.grantConsent', [])], 'browse'));
    expect(r.states).toMatchObject([{ state: 'grant-on-load', api: 'tiktok', phase: 'before-choice' }]);
    const afterReject = analyzeConsentApi(timeline([banner(0), choice(10, 'reject'), api(20, 'google', 'gtag', ['consent', 'update', { ad_storage: 'granted' }])]));
    expect(afterReject.states.map((s) => s.state)).toContain('grant-on-load');
    const afterAccept = analyzeConsentApi(timeline([banner(0), choice(10, 'accept'), api(20, 'google', 'gtag', ['consent', 'update', { ad_storage: 'granted' }])], 'browse'));
    expect(afterAccept.states).toEqual([]);
    const regional = analyzeConsentApi(timeline([api(1, 'google', 'gtag', ['consent', 'default', { ad_storage: 'granted', region: ['US'] }])], 'browse'));
    expect(regional.states).toEqual([]);
    expect(regional.unknowns.join(' ')).toMatch(/region-scoped/);
  });
});

let chromiumAvailable = false;
try {
  const { chromium } = await import('playwright');
  chromiumAvailable = fs.existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}
const suite = chromiumAvailable ? describe : describe.skip;

suite('consent-API recorder (fixture page, browser)', () => {
  let browser: Browser;
  let page: Page;
  let tl: Timeline;
  const pageErrors: string[] = [];
  let vendorState: Record<string, unknown>;

  beforeAll(async () => {
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
    const context = await browser.newContext();
    const cap = await startCapture(context);
    page = await context.newPage();
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await cap.watchPage(page, true);
    await context.route('**/*', (route) => {
      const u = route.request().url();
      if (u.startsWith('https://example-shop.test/')) return route.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE });
      return route.fulfill({ status: 204, body: '' });
    });
    await page.goto('https://example-shop.test/');
    await page.waitForFunction(() => (window as unknown as { __shopReady?: boolean }).__shopReady === true);
    cap.push({ type: 'banner', t: 0, state: 'shown', pageIndex: 0 });
    const tClick = cap.now();
    await page.click('#reject');
    cap.push({ type: 'choice', t: tClick, choice: 'reject', ok: true, method: 'selector', pageIndex: cap.pageIndex() });
    vendorState = await page.evaluate(() => {
      const w = window as unknown as Record<string, any>;
      return {
        fbCalls: w.__fbCalls.map((c: unknown[]) => c[0]),
        fbLoaded: w.fbq.loaded,
        fbPushIsSelf: w.fbq.push === w.fbq,
        fbAlias: typeof w._fbq,
        ttqCalls: w.ttq._calls,
        clarityCalls: w.__clarityCalls,
        uetCalls: w.__uetCalls,
        tcfPending: w.__tcfPending,
        gtmSeen: w.__gtmSeen,
        dataLayerLength: w.dataLayer.length,
        dataLayerKeys: Object.keys(w.dataLayer).filter((k) => !/^\d+$/.test(k)),
        shopConsent: w.__shopConsent,
        shopPrivacyOk: w.Shopify.customerPrivacy.userCanBeTracked() === false,
      };
    });
    // The scanner's own calls (readouts, reopening the CMP) are not the page's:
    await page.evaluate(() => (window as unknown as { __tcfapi: (...a: unknown[]) => void }).__tcfapi('displayConsentUi', 2, () => {}));
    const stopped = await cap.stop([page]);
    tl = timeline(stopped.events);
  }, 60000);

  afterAll(async () => {
    await browser?.close();
  });

  it("doesn't break the page or any vendor's own code", () => {
    expect(pageErrors).toEqual([]);
    expect(vendorState).toMatchObject({
      fbCalls: ['init', 'track', 'track'], // queued init + PageView drained, then ViewContent through callMethod
      fbLoaded: true,
      fbPushIsSelf: true,
      fbAlias: 'function',
      clarityCalls: 1,
      uetCalls: 3, // the stub queue (push('consent','default',{…}) = 3 items) handed to bat.js
      tcfPending: 1,
      shopConsent: { analytics: false, marketing: false, preferences: false, sale_of_data: false },
      shopPrivacyOk: true,
      dataLayerKeys: [], // no visible own 'push' key from the hook
    });
    expect(vendorState.ttqCalls).toEqual(['page', 'grantConsent', 'revokeConsent']);
    // GTM-style takeover saw every later push exactly once.
    expect(vendorState.gtmSeen).toBe(vendorState.dataLayerLength);
  });

  it('records each API call with its phase, and the library-ready moments', () => {
    const calls = consentApiCalls(tl);
    const seen = calls.map((c) => `${c.api} ${c.kind === 'ready' ? 'READY' : c.command ?? c.call} @${c.phase}`);
    // Order-sensitive core, all before the choice.
    expect(seen).toEqual(
      expect.arrayContaining([
        'google js @before-choice',
        'google config @before-choice',
        'google READY @before-choice',
        'google consent default @before-choice',
        'meta init @before-choice',
        'meta track @before-choice',
        'meta READY @before-choice',
        'tiktok grantConsent @before-choice',
        'tiktok READY @before-choice',
        'clarity consentv2 @before-choice',
        'clarity READY @before-choice',
        'microsoft-uet consent default @before-choice',
        'microsoft-uet READY @before-choice',
        'tcf ping @before-choice',
        'tcf READY @before-choice',
        'gpp ping @before-choice',
        'shopify READY @before-choice',
        'shopify userCanBeTracked @before-choice',
        // the reject handler
        'google consent update @after-reject',
        'tiktok revokeConsent @after-reject',
        'shopify setTrackingConsent @after-reject',
        'meta track @after-reject',
      ]),
    );
    const idx = (s: string): number => seen.indexOf(s);
    expect(idx('google config @before-choice')).toBeLessThan(idx('google READY @before-choice'));
    expect(idx('google READY @before-choice')).toBeLessThan(idx('google consent default @before-choice'));
    // gtag(...) through a GTM-replaced dataLayer.push is recorded once, as gtag.
    expect(seen.filter((s) => s === 'google consent update @after-reject')).toHaveLength(1);
    expect(calls.filter((c) => c.call === 'dataLayer.push' && c.kind === 'call')).toEqual([]);
    // Scanner-made calls are skipped; the page's reaction inside one is not.
    expect(seen).not.toContain('shopify userCanBeTracked @after-reject');
    expect(seen).not.toContain('tcf displayConsentUi @after-reject');
    expect(seen).toContain('clarity set @after-reject');
  });

  it('keeps only the shape of arguments — no identifiers or personal data', () => {
    const ev = tl.events.filter((e): e is ConsentApiEvent => e.type === 'consent-api');
    const blob = JSON.stringify(ev.map((e) => e.args));
    expect(blob).not.toContain('person@example.com');
    expect(blob).not.toContain('123456789');
    expect(blob).not.toContain('visitor-42');
    const init = ev.find((e) => e.api === 'meta' && (e.args as unknown[])[0] === 'init')!;
    expect(init.args).toEqual(['init', '<string>', { em: '<string>' }]);
    const def = ev.find((e) => e.api === 'google' && (e.args as unknown[])[1] === 'default')!;
    expect(def.args).toEqual(['consent', 'default', { ad_storage: 'denied', analytics_storage: 'denied', wait_for_update: 500 }]);
    expect(def.top).toBe(true);
  });

  it('derives the three states from the fixture', () => {
    const r = analyzeConsentApi(tl);
    const states = r.states.map((s) => `${s.state}:${s.api}`).sort();
    expect(states).toEqual(['default-after-load:google', 'grant-on-load:tiktok', 'not-called-after-refusal:meta']);
  });
});
