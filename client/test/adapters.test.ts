// Vendor consent-API adapters (ticket D5): exact call sequences against fake
// vendor globals, per regime and per transition. Node environment, no DOM — the
// adapters never touch the document (they cannot release a gated script).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REGIMES, consentCategoryDefault, type ConsentToolConfig, type ConsentVendor, type Regime } from '../src/config';
import { startAdapters, type AdapterStore } from '../src/adapters/index';
import { consentDefault, consentHold, signalsFromMap } from '../src/adapters/google';

type Call = unknown[];
let log: Call[];
let win: Record<string, any>;

const defaults = (optIn: boolean, others: boolean) => Object.fromEntries(REGIMES.map((r) => [r, r === 'opt-in' ? optIn : others])) as Record<Regime, boolean>;

function makeConfig(vendors: ConsentVendor[], extra: Partial<ConsentToolConfig> = {}): ConsentToolConfig {
  return {
    version: '1.0',
    generatedFrom: { runId: 'r', at: '2026-10-06T00:00:00.000Z', complykit: '0.0.0' },
    hash: '0'.repeat(64),
    regimeSource: { kind: 'fixed', regime: 'opt-in' },
    categories: [
      { id: 'necessary', label: 'N', description: '', defaultByRegime: defaults(true, true) },
      { id: 'analytics', label: 'A', description: '', defaultByRegime: defaults(false, true) },
      { id: 'advertising', label: 'Ad', description: '', defaultByRegime: defaults(false, true) },
    ],
    vendors,
    gate: vendors.map((v) => ({ category: v.category, src: `^https://${v.id}\\.test/`, vendor: v.id })),
    platform: 'none',
    theme: {},
    strings: {},
    layout: 'bar',
    ...extra,
  } as ConsentToolConfig;
}

const api = (id: string, category: string, adapter: string): ConsentVendor => ({ id, label: id, category, control: 'api', adapter, stores: [] });

const ALL = [
  api('google.analytics', 'analytics', 'google-consent-mode'),
  api('google.ads.ccm', 'advertising', 'google-consent-mode'),
  api('meta.pixel', 'advertising', 'meta'),
  api('tiktok.pixel', 'advertising', 'tiktok'),
  api('microsoft.uet', 'advertising', 'microsoft-uet'),
  api('microsoft.clarity', 'analytics', 'microsoft-clarity'),
  api('pinterest.tag', 'advertising', 'pinterest'),
];

/** A store like D3's: defaults through consentCategoryDefault, then explicit choices. */
function fakeStore(config: ConsentToolConfig, regime: Regime) {
  const subs = new Set<() => void>();
  let choice: Record<string, boolean> | undefined;
  const store: AdapterStore & { set(c: Record<string, boolean>): void; subs: Set<() => void> } = {
    isGranted: (id) => id === 'necessary' || (choice ? choice[id] === true : consentCategoryDefault(config, id, regime)),
    subscribe: (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    set(c) {
      choice = c;
      for (const fn of subs) fn();
    },
    subs,
  };
  return store;
}

/** Fake vendor globals that log every call. */
function installVendors(w: Record<string, any>) {
  w.fbq = (...a: unknown[]) => log.push(['fbq', ...a]);
  w.ttq = {
    holdConsent: () => log.push(['ttq.holdConsent']),
    grantConsent: () => log.push(['ttq.grantConsent']),
    revokeConsent: () => log.push(['ttq.revokeConsent']),
  };
  w.clarity = (...a: unknown[]) => log.push(['clarity', ...a]);
  w.pintrk = (...a: unknown[]) => log.push(['pintrk', ...a]);
}

const isArgs = (e: unknown) => Object.prototype.toString.call(e) === '[object Arguments]';
const gtagCalls = (name = 'dataLayer') => (win[name] as unknown[]).map((e) => (isArgs(e) ? Array.from(e as ArrayLike<unknown>) : e));
const uetCalls = () => (win.uetq as unknown[]) ?? [];
const of = (prefix: string) => log.filter((c) => String(c[0]).startsWith(prefix));

const DENIED = { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'denied', functionality_storage: 'denied', personalization_storage: 'denied', security_storage: 'denied' };
const GRANTED_BOTH = { ...DENIED, ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted', analytics_storage: 'granted' };

beforeEach(() => {
  log = [];
  win = {};
  (globalThis as any).window = win;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as any).window;
});

describe('initial decision, per regime', () => {
  it('opt-in: every vendor is held / denied; Consent Mode default only', () => {
    installVendors(win);
    const config = makeConfig(ALL);
    const a = startAdapters(config, 'opt-in', fakeStore(config, 'opt-in'));
    expect(log).toEqual([['fbq', 'consent', 'revoke'], ['ttq.holdConsent'], ['clarity', 'consentv2', { ad_Storage: 'denied', analytics_Storage: 'denied' }], ['pintrk', 'setconsent', false]]);
    expect(uetCalls()).toEqual(['consent', 'default', { ad_storage: 'denied' }]);
    expect(gtagCalls()).toEqual([['consent', 'default', DENIED]]);
    expect(isArgs(win.dataLayer[0])).toBe(true);
    expect(a.diagnostics.waiting).toEqual([]);
    expect(a.diagnostics.notes).toEqual([]);
    expect(typeof document).toBe('undefined'); // nothing here can touch the gate
  });

  it('opt-out (defaults granted): hold first, then grant', () => {
    installVendors(win);
    const config = makeConfig(ALL);
    startAdapters(config, 'opt-out', fakeStore(config, 'opt-out'));
    expect(log).toEqual([
      ['fbq', 'consent', 'revoke'],
      ['fbq', 'consent', 'grant'],
      ['ttq.holdConsent'],
      ['ttq.grantConsent'],
      ['clarity', 'consentv2', { ad_Storage: 'granted', analytics_Storage: 'granted' }],
      ['pintrk', 'setconsent', true],
    ]);
    expect(uetCalls()).toEqual(['consent', 'default', { ad_storage: 'denied' }, 'consent', 'update', { ad_storage: 'granted' }]);
    expect(gtagCalls()).toEqual([
      ['consent', 'default', DENIED],
      ['consent', 'update', GRANTED_BOTH],
    ]);
  });

  it('every regime: each vendor ends in the state consentCategoryDefault gives its category', () => {
    for (const regime of REGIMES) {
      log = [];
      win = {};
      (globalThis as any).window = win;
      installVendors(win);
      const config = makeConfig(ALL);
      startAdapters(config, regime, fakeStore(config, regime));
      const ad = consentCategoryDefault(config, 'advertising', regime);
      expect(of('fbq').at(-1), regime).toEqual(['fbq', 'consent', ad ? 'grant' : 'revoke']);
      expect(of('pintrk').at(-1), regime).toEqual(['pintrk', 'setconsent', ad]);
    }
  });
});

describe('transitions', () => {
  it('opt-in: grant, then revoke (withdraw), each told once', () => {
    installVendors(win);
    const config = makeConfig(ALL);
    const store = fakeStore(config, 'opt-in');
    const a = startAdapters(config, 'opt-in', store);
    log = [];
    win.uetq.length = 0;
    win.dataLayer.length = 0;

    store.set({ analytics: true, advertising: true });
    expect(log).toEqual([['fbq', 'consent', 'grant'], ['ttq.grantConsent'], ['clarity', 'consentv2', { ad_Storage: 'granted', analytics_Storage: 'granted' }], ['pintrk', 'setconsent', true]]);
    expect(uetCalls()).toEqual(['consent', 'update', { ad_storage: 'granted' }]);
    expect(gtagCalls()).toEqual([['consent', 'update', GRANTED_BOTH]]);

    // idempotent: the same state again (another change event, an explicit sync) says nothing
    log = [];
    store.set({ analytics: true, advertising: true });
    a.sync();
    expect(log).toEqual([]);
    expect(uetCalls()).toHaveLength(3);
    expect(gtagCalls()).toHaveLength(1);

    store.set({}); // withdraw: every non-necessary category denied
    expect(log).toEqual([['fbq', 'consent', 'revoke'], ['ttq.revokeConsent'], ['clarity', 'consentv2', { ad_Storage: 'denied', analytics_Storage: 'denied' }], ['pintrk', 'setconsent', false]]);
    expect(uetCalls().slice(3)).toEqual(['consent', 'update', { ad_storage: 'denied' }]);
    expect(gtagCalls().slice(1)).toEqual([['consent', 'update', DENIED]]);
  });

  it('partial grant: only the vendors in the granted category are told', () => {
    installVendors(win);
    const config = makeConfig(ALL);
    const store = fakeStore(config, 'opt-in');
    startAdapters(config, 'opt-in', store);
    log = [];
    win.dataLayer.length = 0;
    store.set({ analytics: true });
    expect(log).toEqual([['clarity', 'consentv2', { ad_Storage: 'granted', analytics_Storage: 'granted' }]]);
    expect(gtagCalls()).toEqual([['consent', 'update', { ...DENIED, analytics_storage: 'granted' }]]);
  });

  it('one adapter, vendors in two categories: granted only when both are (fail closed)', () => {
    installVendors(win);
    const config = makeConfig([api('meta.pixel', 'advertising', 'meta'), api('meta.pixel.capi', 'analytics', 'meta')]);
    const store = fakeStore(config, 'opt-in');
    startAdapters(config, 'opt-in', store);
    store.set({ analytics: true });
    expect(log).toEqual([['fbq', 'consent', 'revoke']]);
    store.set({ analytics: true, advertising: true });
    expect(log.at(-1)).toEqual(['fbq', 'consent', 'grant']);
  });

  it('stop() detaches from the store', () => {
    installVendors(win);
    const config = makeConfig(ALL);
    const store = fakeStore(config, 'opt-in');
    startAdapters(config, 'opt-in', store).stop();
    log = [];
    store.set({ advertising: true });
    expect(log).toEqual([]);
  });
});

describe('late-defined globals', () => {
  it('owes the steps until the global appears, then runs them in order', () => {
    const config = makeConfig(ALL);
    const store = fakeStore(config, 'opt-in');
    const a = startAdapters(config, 'opt-in', store, { pollMs: 100, pollFor: 10_000 });
    // documented pre-create: UET queue and the data layer exist at once
    expect(uetCalls()).toEqual(['consent', 'default', { ad_storage: 'denied' }]);
    expect(gtagCalls()).toEqual([['consent', 'default', DENIED]]);
    // nothing else is defined by us (Meta skips loading if fbq already exists)
    expect(win.fbq).toBeUndefined();
    expect(win.ttq).toBeUndefined();
    expect(a.diagnostics.waiting).toEqual(['meta', 'tiktok', 'microsoft-clarity', 'pinterest']);

    store.set({ advertising: true, analytics: true }); // gate releases the scripts
    vi.advanceTimersByTime(300);
    expect(log).toEqual([]);
    installVendors(win);
    vi.advanceTimersByTime(100);
    expect(log).toEqual([
      ['fbq', 'consent', 'revoke'],
      ['fbq', 'consent', 'grant'],
      ['ttq.holdConsent'],
      ['ttq.grantConsent'],
      ['clarity', 'consentv2', { ad_Storage: 'granted', analytics_Storage: 'granted' }],
      ['pintrk', 'setconsent', true],
    ]);
    expect(a.diagnostics.waiting).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(log).toHaveLength(6); // polling stopped
  });

  it('polling is bounded; flush() or the next change retries', () => {
    const config = makeConfig([api('meta.pixel', 'advertising', 'meta')]);
    const store = fakeStore(config, 'opt-in');
    const a = startAdapters(config, 'opt-in', store, { pollMs: 100, pollFor: 1000 });
    vi.advanceTimersByTime(1500);
    expect(vi.getTimerCount()).toBe(0);
    installVendors(win);
    vi.advanceTimersByTime(500);
    expect(log).toEqual([]);
    a.flush();
    expect(log).toEqual([['fbq', 'consent', 'revoke']]);
  });

  it('TikTok: ttq without the consent methods (not in ttq.methods) is not ready', () => {
    const config = makeConfig([api('tiktok.pixel', 'advertising', 'tiktok')]);
    win.ttq = [];
    const a = startAdapters(config, 'opt-in', fakeStore(config, 'opt-in'));
    expect(a.diagnostics.waiting).toEqual(['tiktok']);
    expect(win.ttq).toEqual([]); // nothing pushed onto the stub queue
    installVendors(win);
    vi.advanceTimersByTime(100);
    expect(log).toEqual([['ttq.holdConsent']]);
  });
});

describe('Google Consent Mode: one default per page, shared with the GTM bridge', () => {
  it('with a gtm section the bridge owns Consent Mode: the adapter pushes nothing', () => {
    const config = makeConfig(ALL.slice(0, 2), {
      gtm: { containers: ['GTM-XXXX01'], dataLayer: 'dataLayer', consentMode: { analytics_storage: 'analytics' }, tags: [] },
    });
    const store = fakeStore(config, 'opt-out');
    const a = startAdapters(config, 'opt-out', store);
    expect(win.dataLayer).toBeUndefined();
    expect(a.diagnostics.notes.map((n) => [n.kind, n.vendor])).toEqual([
      ['consent-mode-unmapped', 'google.ads.ccm'],
      ['consent-mode-unmapped', 'google.ads.ccm'],
      ['consent-mode-unmapped', 'google.ads.ccm'],
    ]);
  });

  it('a default already pushed (by the bridge) is not pushed again', () => {
    consentDefault({ analytics_storage: 'denied' }, { waitForUpdate: 500 });
    expect(consentHold({ analytics_storage: 'denied' })).toBe(false);
    const config = makeConfig(ALL.slice(0, 1));
    startAdapters(config, 'opt-in', fakeStore(config, 'opt-in'));
    expect(gtagCalls()).toHaveLength(2); // the bridge's default + our update (the full signal set differs)
    expect(gtagCalls().filter((c) => (c as unknown[])[1] === 'default')).toHaveLength(1);
  });

  it('a tracking signal mapped to necessary is denied', () => {
    expect(signalsFromMap({ analytics_storage: ['necessary'], security_storage: ['necessary'] }, () => true)).toMatchObject({ analytics_storage: 'denied', security_storage: 'granted' });
    const config = makeConfig([api('google.analytics', 'necessary', 'google-consent-mode')]);
    startAdapters(config, 'opt-out', fakeStore(config, 'opt-out'));
    expect(gtagCalls()).toEqual([['consent', 'default', DENIED]]);
  });

  it('reports a default that lands after gtag("js") / gtag("config")', () => {
    win.dataLayer = [];
    (function (..._a: unknown[]) {
      // eslint-disable-next-line prefer-rest-params
      win.dataLayer.push(arguments);
    })('config', 'G-XXXX01');
    const config = makeConfig(ALL.slice(0, 1));
    const a = startAdapters(config, 'opt-in', fakeStore(config, 'opt-in'));
    expect(a.diagnostics.notes.map((n) => n.kind)).toEqual(['consent-mode-late']);
  });
});

describe('vocabulary and regime notes', () => {
  it('an unknown adapter id is a no-op with a note; none is a no-op', () => {
    installVendors(win);
    const config = makeConfig([api('meta.pixel', 'advertising', 'meta-v9'), api('x.pixel', 'advertising', 'none')]);
    const a = startAdapters(config, 'opt-out', fakeStore(config, 'opt-out'));
    expect(log).toEqual([]);
    expect(a.diagnostics.active).toEqual([{ adapter: 'none', vendors: ['x.pixel'] }]);
    expect(a.diagnostics.notes.map((n) => [n.kind, n.vendor])).toEqual([['unknown-adapter', 'meta.pixel']]);
  });

  it('control other than api ignores the adapter field', () => {
    installVendors(win);
    const config = makeConfig([{ ...api('meta.pixel', 'advertising', 'meta'), control: 'gate' }]);
    startAdapters(config, 'opt-out', fakeStore(config, 'opt-out'));
    expect(log).toEqual([]);
  });

  it('opt-in: an api vendor with no gate rule is reported — the API never replaces the gate', () => {
    installVendors(win);
    const config = makeConfig([api('meta.pixel', 'advertising', 'meta')], { gate: [] });
    expect(startAdapters(config, 'opt-in', fakeStore(config, 'opt-in')).diagnostics.notes.map((n) => n.kind)).toEqual(['not-gated']);
    expect(startAdapters(config, 'opt-out', fakeStore(config, 'opt-out')).diagnostics.notes).toEqual([]);
  });
});
