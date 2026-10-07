// Shopify Customer Privacy bridge (ticket E1): a fake window.Shopify that
// records every setTrackingConsent call. No DOM, no network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REGIMES, consentCategoryDefault, type ConsentToolConfig, type Regime } from '../src/config';
import { installShopifyBridge, shopifyConsentFor, shopifyMapFor, type ShopifyStoreLike } from '../src/bridges/shopify';
import { diagnostics } from '../src/diagnostics';
import { regimeFor } from '../../src/registry/regime';

const defaults = (optIn: boolean, others: boolean) => Object.fromEntries(REGIMES.map((r) => [r, r === 'opt-in' ? optIn : others])) as Record<Regime, boolean>;
const cat = (id: string, optIn: boolean, others: boolean) => ({ id, label: id, description: '', defaultByRegime: defaults(optIn, others) });

function makeConfig(platform: string, regimeSource: unknown = { kind: 'fixed', regime: 'opt-in' }, categories = [cat('necessary', true, true), cat('analytics', false, true), cat('advertising', false, true), cat('functional', false, true)]): ConsentToolConfig {
  return {
    version: '1.0',
    generatedFrom: { runId: 'r', at: '2026-10-06T00:00:00.000Z', site: 'example-shop.test', complykit: '0.0.0' },
    hash: '0'.repeat(64),
    regimeSource,
    categories,
    vendors: [],
    gate: [],
    platform,
    theme: {},
    strings: {},
    layout: 'bar',
  } as unknown as ConsentToolConfig;
}

/** Store fake honouring the D2 default rules: opt-in ⇒ denied; GPC ⇒ non-necessary denied before a choice. */
function fakeStore(config: ConsentToolConfig, initialRegime: Regime, gpc = false) {
  const subs = new Set<() => void>();
  let choice: Record<string, boolean> | undefined;
  let regime = initialRegime;
  const s = {
    isGranted: (id: string) => id === 'necessary' || (choice ? choice[id] === true : !gpc && consentCategoryDefault(config, id, regime)),
    state: () => ({ status: (choice ? 'chosen' : 'unset') as 'chosen' | 'unset', regime, gpc }),
    subscribe: (fn: () => void) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    setRegime: vi.fn((r: Regime) => {
      regime = r;
      for (const fn of subs) fn();
    }),
    set(c: Record<string, boolean>) {
      choice = c;
      for (const fn of subs) fn();
    },
  };
  return s satisfies ShopifyStoreLike;
}

type Yn = 'yes' | 'no' | '';
const FIELDS = ['analytics', 'marketing', 'preferences', 'sale_of_data'] as const;

/**
 * Shopify's customerPrivacy: stored per-field consent ('yes'/'no'/''), a region
 * default for undeclared fields, partial sets merge, the document event fires on change.
 */
function fakePrivacy(opts: { regionRequiresConsent: boolean; region?: string; stored?: Partial<Record<(typeof FIELDS)[number], Yn>> }) {
  const stored: Record<string, Yn> = { analytics: '', marketing: '', preferences: '', sale_of_data: '', ...opts.stored };
  const listeners: ((e: unknown) => void)[] = [];
  const allowed = (f: string) => (stored[f] === '' ? !opts.regionRequiresConsent : stored[f] === 'yes');
  const fire = () => {
    const detail = { analyticsAllowed: allowed('analytics'), marketingAllowed: allowed('marketing'), preferencesAllowed: allowed('preferences'), saleOfDataAllowed: allowed('sale_of_data') };
    for (const l of [...listeners]) l({ detail });
  };
  const calls: Record<string, boolean>[] = [];
  const cp = {
    calls,
    setTrackingConsent: vi.fn((c: Record<string, boolean>, cb?: (r?: unknown) => void) => {
      calls.push({ ...c });
      for (const [k, v] of Object.entries(c)) stored[k] = v ? 'yes' : 'no';
      cb?.();
      fire();
    }),
    currentVisitorConsent: () => ({ ...stored }),
    analyticsProcessingAllowed: () => allowed('analytics'),
    marketingAllowed: () => allowed('marketing'),
    preferencesProcessingAllowed: () => allowed('preferences'),
    saleOfDataAllowed: () => allowed('sale_of_data'),
    shouldShowBanner: () => opts.regionRequiresConsent && Object.values(stored).every((v) => v === ''),
    saleOfDataRegion: () => (opts.region ?? '').startsWith('US'),
    getRegion: () => opts.region ?? '',
    /** Shopify's own banner (or another app) records consent. */
    external(c: Record<string, Yn>) {
      Object.assign(stored, c);
      fire();
    },
    stored: () => ({ ...stored }),
  };
  const doc = {
    addEventListener: (n: string, fn: (e: unknown) => void) => n === 'visitorConsentCollected' && listeners.push(fn),
    removeEventListener: (n: string, fn: (e: unknown) => void) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  return { cp, doc };
}

let win: Record<string, any>;
beforeEach(() => {
  win = {};
  delete diagnostics.location;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

const ALL_NO = { analytics: false, marketing: false, preferences: false, sale_of_data: false };
const ALL_YES = { analytics: true, marketing: true, preferences: true, sale_of_data: true };

describe('activation', () => {
  it('does nothing when the platform is not shopify and window.Shopify is absent', () => {
    const c = makeConfig('none');
    expect(installShopifyBridge(c, fakeStore(c, 'opt-in'), { win })).toBeUndefined();
  });
  it('activates on window.Shopify even when the config says platform none', () => {
    const c = makeConfig('none');
    const { cp, doc } = fakePrivacy({ regionRequiresConsent: false });
    win.Shopify = { customerPrivacy: cp };
    const b = installShopifyBridge(c, fakeStore(c, 'opt-in'), { win, doc })!;
    expect(b.diagnostics.activatedBy).toBe('api');
    expect(b.diagnostics.apiSeen).toBe(true);
  });
});

describe('mapping', () => {
  it('narrows the default candidates to the ids the config lists', () => {
    const m = shopifyMapFor(makeConfig('shopify'));
    expect(m).toEqual({ analytics: ['analytics'], marketing: ['advertising'], preferences: ['functional'], sale_of_data: ['advertising'] });
    const m2 = shopifyMapFor(makeConfig('shopify', undefined, [cat('necessary', true, true), cat('marketing', false, true)]));
    expect(m2).toEqual({ analytics: [], marketing: ['marketing'], preferences: [], sale_of_data: ['marketing'] });
  });
  it('sale_of_data is false whenever marketing is denied or GPC is on', () => {
    const map = { analytics: ['a'], marketing: ['m'], preferences: [], sale_of_data: ['a'] };
    expect(shopifyConsentFor({ isGranted: (id) => id === 'a' }, map, false)).toEqual({ analytics: true, marketing: false, preferences: false, sale_of_data: false });
    expect(shopifyConsentFor({ isGranted: () => true }, map, true).sale_of_data).toBe(false);
    expect(shopifyConsentFor({ isGranted: () => true }, map, false).sale_of_data).toBe(true);
  });
});

describe('opt-in, no choice', () => {
  it('banner regions cover the visitor: Shopify already denies, so nothing is recorded', () => {
    const c = makeConfig('shopify');
    const { cp, doc } = fakePrivacy({ regionRequiresConsent: true, region: 'DE' });
    win.Shopify = { customerPrivacy: cp };
    installShopifyBridge(c, fakeStore(c, 'opt-in'), { win, doc });
    expect(cp.calls).toEqual([]);
  });

  it("Shopify's banner off (allow-by-default): denials are pushed, never a grant", () => {
    const c = makeConfig('shopify');
    const { cp, doc } = fakePrivacy({ regionRequiresConsent: false, region: 'DE' });
    win.Shopify = { customerPrivacy: cp };
    installShopifyBridge(c, fakeStore(c, 'opt-in'), { win, doc });
    expect(cp.calls).toEqual([ALL_NO]);
    expect(cp.calls.flatMap((x) => Object.values(x))).not.toContain(true);
  });

  it('Shopify stored yes but our store says no: ours is pushed', () => {
    const c = makeConfig('shopify');
    const { cp, doc } = fakePrivacy({ regionRequiresConsent: true, stored: { analytics: 'yes', marketing: 'yes', preferences: '', sale_of_data: '' } });
    win.Shopify = { customerPrivacy: cp };
    installShopifyBridge(c, fakeStore(c, 'opt-in'), { win, doc });
    expect(cp.calls).toEqual([{ analytics: false, marketing: false }]);
    expect(cp.stored()).toMatchObject({ analytics: 'no', marketing: 'no' });
  });
});

describe('visitor choice', () => {
  it('sets all four fields explicitly on a choice and on every change', () => {
    const c = makeConfig('shopify');
    const store = fakeStore(c, 'opt-in');
    const { cp, doc } = fakePrivacy({ regionRequiresConsent: true });
    win.Shopify = { customerPrivacy: cp };
    installShopifyBridge(c, store, { win, doc });
    store.set({ analytics: true, advertising: false, functional: true });
    store.set({ analytics: true, advertising: true, functional: true });
    store.set({});
    expect(cp.calls).toEqual([
      { analytics: true, marketing: false, preferences: true, sale_of_data: false },
      ALL_YES,
      ALL_NO,
    ]);
  });

  it('skips the call when Shopify already holds exactly the choice', () => {
    const c = makeConfig('shopify');
    const store = fakeStore(c, 'opt-in');
    const { cp, doc } = fakePrivacy({ regionRequiresConsent: true, stored: { analytics: 'yes', marketing: 'yes', preferences: 'yes', sale_of_data: 'yes' } });
    win.Shopify = { customerPrivacy: cp };
    store.set({ analytics: true, advertising: true, functional: true }); // returning visitor
    installShopifyBridge(c, store, { win, doc });
    store.set({ analytics: true, advertising: true, functional: true });
    expect(cp.calls).toEqual([]);
  });

  it('GPC: sale_of_data stays false even when the visitor grants advertising', () => {
    const c = makeConfig('shopify');
    const store = fakeStore(c, 'opt-out-signal', true);
    const { cp, doc } = fakePrivacy({ regionRequiresConsent: false, region: 'USCA' });
    win.Shopify = { customerPrivacy: cp };
    installShopifyBridge(c, store, { win, doc });
    // before a choice, GPC denies the defaults: denials only
    expect(cp.calls[0]).toEqual(ALL_NO);
    store.set({ analytics: true, advertising: true, functional: true });
    expect(cp.calls.at(-1)).toEqual({ analytics: true, marketing: true, preferences: true, sale_of_data: false });
  });
});

describe('opt-out regimes, no choice', () => {
  it('leaves Shopify alone when it already allows what the defaults grant', () => {
    const c = makeConfig('shopify');
    const { cp, doc } = fakePrivacy({ regionRequiresConsent: false, region: 'USTX' });
    win.Shopify = { customerPrivacy: cp };
    installShopifyBridge(c, fakeStore(c, 'opt-out'), { win, doc });
    expect(cp.calls).toEqual([]);
  });
  it('pushOptOutDefaults: grants the defaults, but never under opt-in', () => {
    const c = makeConfig('shopify');
    const a = fakePrivacy({ regionRequiresConsent: true, region: 'USTX' });
    win.Shopify = { customerPrivacy: a.cp };
    installShopifyBridge(c, fakeStore(c, 'opt-out'), { win, doc: a.doc, pushOptOutDefaults: true });
    expect(a.cp.calls).toEqual([ALL_YES]);

    const b = fakePrivacy({ regionRequiresConsent: false, region: 'DE' });
    win = { Shopify: { customerPrivacy: b.cp } };
    installShopifyBridge(c, fakeStore(c, 'opt-in'), { win, doc: b.doc, pushOptOutDefaults: true });
    expect(b.cp.calls).toEqual([ALL_NO]);
  });
});

describe("Shopify's stored consent never grants for us", () => {
  it('pushes ours back after visitorConsentCollected grants (bounded)', () => {
    const c = makeConfig('shopify');
    const store = fakeStore(c, 'opt-in');
    const { cp, doc } = fakePrivacy({ regionRequiresConsent: true });
    win.Shopify = { customerPrivacy: cp };
    const b = installShopifyBridge(c, store, { win, doc, maxReasserts: 2 })!;
    store.set({ analytics: false, advertising: false, functional: false });
    expect(cp.calls).toEqual([ALL_NO]);
    cp.external({ analytics: 'yes', marketing: 'yes', preferences: 'yes', sale_of_data: 'yes' });
    expect(cp.calls).toEqual([ALL_NO, ALL_NO]);
    expect(b.diagnostics.reasserted).toBe(1);
    cp.external({ marketing: 'yes' });
    cp.external({ marketing: 'yes' });
    expect(b.diagnostics.reasserted).toBe(2);
    expect(cp.stored().marketing).toBe('yes');
    expect(b.diagnostics.notes.join(' ')).toMatch(/gave up/);
  });
  it('a change that only denies more is left alone', () => {
    const c = makeConfig('shopify');
    const store = fakeStore(c, 'opt-in');
    const { cp, doc } = fakePrivacy({ regionRequiresConsent: true });
    win.Shopify = { customerPrivacy: cp };
    const b = installShopifyBridge(c, store, { win, doc })!;
    cp.external({ analytics: 'no' }); // no choice yet, a denial: nothing over-granted
    expect(cp.calls).toEqual([]);
    expect(b.diagnostics.reasserted).toBe(0);
  });
});

describe('loading the API', () => {
  it('calls loadFeatures with the consent-tracking-api feature and applies when it loads', () => {
    const c = makeConfig('shopify');
    const { cp, doc } = fakePrivacy({ regionRequiresConsent: false });
    const loadFeatures = vi.fn((features: unknown, cb: (e?: unknown) => void) => {
      setTimeout(() => {
        win.Shopify.customerPrivacy = cp;
        cb();
      }, 50);
    });
    win.Shopify = { loadFeatures };
    const b = installShopifyBridge(c, fakeStore(c, 'opt-in'), { win, doc })!;
    expect(loadFeatures).toHaveBeenCalledTimes(1);
    expect(loadFeatures.mock.calls[0][0]).toEqual([{ name: 'consent-tracking-api', version: '0.1' }]);
    expect(cp.calls).toEqual([]);
    vi.advanceTimersByTime(60);
    expect(b.diagnostics.apiSeen).toBe(true);
    expect(cp.calls).toEqual([ALL_NO]);
  });

  it('waits for window.Shopify to appear (our script runs before content_for_header), applying the newest state', () => {
    const c = makeConfig('shopify');
    const store = fakeStore(c, 'opt-in');
    const { cp, doc } = fakePrivacy({ regionRequiresConsent: true });
    installShopifyBridge(c, store, { win, doc, pollMs: 100 });
    store.set({ analytics: true, advertising: false, functional: false });
    store.set({ analytics: true, advertising: true, functional: false });
    win.Shopify = { loadFeatures: (_f: unknown, cb: () => void) => ((win.Shopify.customerPrivacy = cp), cb()) };
    vi.advanceTimersByTime(100);
    expect(cp.calls).toEqual([{ analytics: true, marketing: true, preferences: false, sale_of_data: true }]);
  });

  it('gives up after waitMs and says the choice was not sent', () => {
    const c = makeConfig('shopify');
    const b = installShopifyBridge(c, fakeStore(c, 'opt-in'), { win, pollMs: 100, waitMs: 500 })!;
    vi.advanceTimersByTime(600);
    expect(b.diagnostics.gaveUp).toBe(true);
    expect(b.diagnostics.notes.join(' ')).toMatch(/NOT sent/);
  });

  it('retries a failed set (callback error), bounded', () => {
    const c = makeConfig('shopify');
    const { cp, doc } = fakePrivacy({ regionRequiresConsent: false });
    cp.setTrackingConsent.mockImplementation((x: Record<string, boolean>, cb?: (r?: unknown) => void) => {
      cp.calls.push({ ...x });
      cb?.({ error: 'nope' });
    });
    win.Shopify = { customerPrivacy: cp };
    const b = installShopifyBridge(c, fakeStore(c, 'opt-in'), { win, doc, maxRetries: 3, pollMs: 10 })!;
    vi.advanceTimersByTime(100);
    expect(cp.calls.length).toBe(3);
    expect(b.diagnostics.failures).toBe(3);
  });
});

describe('region (coordination with D7)', () => {
  it("regimeSource 'platform' with no region at start: moves the store's regime once the API loads", () => {
    const c = makeConfig('shopify', { kind: 'platform' });
    const store = fakeStore(c, 'opt-in');
    diagnostics.location = { source: 'unknown', regime: 'opt-in', pending: false, gpc: false };
    const { cp, doc } = fakePrivacy({ regionRequiresConsent: false, region: 'USTX' });
    win.Shopify = { loadFeatures: (_f: unknown, cb: () => void) => ((win.Shopify.customerPrivacy = cp), cb()) };
    const b = installShopifyBridge(c, store, { win, doc })!;
    expect(b.diagnostics.region).toBe('USTX');
    expect(store.setRegime).toHaveBeenCalledWith(regimeFor({ country: 'US', region: 'TX' }));
    expect(regimeFor({ country: 'US', region: 'TX' })).not.toBe('opt-in');
    expect(diagnostics.location?.source).toBe('platform');
    // opt-out defaults granted, Shopify allows (US, outside banner regions): nothing to record
    expect(cp.calls).toEqual([]);
  });
  it('does not touch the regime when D7 already decided it', () => {
    const c = makeConfig('shopify', { kind: 'platform' });
    const store = fakeStore(c, 'opt-in');
    diagnostics.location = { source: 'platform', regime: 'opt-in', pending: false, gpc: false };
    const { cp, doc } = fakePrivacy({ regionRequiresConsent: true, region: 'DE' });
    win.Shopify = { customerPrivacy: cp };
    installShopifyBridge(c, store, { win, doc });
    expect(store.setRegime).not.toHaveBeenCalled();
  });
});
