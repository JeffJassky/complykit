// Wix consent policy bridge (ticket E3): a fake consentPolicyManager, no DOM.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REGIMES, consentCategoryDefault, type ConsentToolConfig, type Regime } from '../src/config';
import { installWixBridge, wixPolicyFor, type WixStoreLike } from '../src/bridges/wix';

const defaults = (optIn: boolean, others: boolean) => Object.fromEntries(REGIMES.map((r) => [r, r === 'opt-in' ? optIn : others])) as Record<Regime, boolean>;
const cat = (id: string, optIn: boolean, others: boolean) => ({ id, label: id, description: '', defaultByRegime: defaults(optIn, others) });

function makeConfig(platform: string, categories = [cat('necessary', true, true), cat('analytics', false, true), cat('advertising', false, true)]): ConsentToolConfig {
  return {
    version: '1.0',
    generatedFrom: { runId: 'r', at: '2026-10-06T00:00:00.000Z', site: 'example-shop.test', complykit: '0.0.0' },
    hash: '0'.repeat(64),
    regimeSource: { kind: 'fixed', regime: 'opt-in' },
    categories,
    vendors: [],
    gate: [],
    platform,
    theme: {},
    strings: {},
    layout: 'bar',
  } as unknown as ConsentToolConfig;
}

function fakeStore(config: ConsentToolConfig, regime: Regime) {
  const subs = new Set<() => void>();
  let choice: Record<string, boolean> | undefined;
  return {
    isGranted: (id: string) => id === 'necessary' || (choice ? choice[id] === true : consentCategoryDefault(config, id, regime)),
    subscribe: (fn: () => void) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    set(c: Record<string, boolean>) {
      choice = c;
      for (const fn of subs) fn();
    },
  } satisfies WixStoreLike & { set(c: Record<string, boolean>): void };
}

/** Wix's manager: set merges per field, forces essential, fires change handlers. */
function fakeManager(initial = { functional: true, analytics: true, advertising: true, dataToThirdParty: true }) {
  let policy: Record<string, boolean> = { essential: true, ...initial };
  let isDefault = true;
  const handlers: ((e: any) => void)[] = [];
  const sets: Record<string, boolean>[] = [];
  const m = {
    sets,
    getCurrentConsentPolicy: () => ({ defaultPolicy: isDefault, policy: { ...policy } }),
    setConsentPolicy: vi.fn((p: Record<string, boolean>, ok?: (d: unknown) => void) => {
      sets.push({ ...p });
      policy = { ...policy, ...p, essential: true };
      isDefault = false;
      ok?.({});
      for (const h of handlers) h({ policy: { ...policy } });
    }),
    onConsentPolicyChanged: (h: (e: any) => void) => void handlers.push(h),
    /** someone else (Wix's own banner) changes the policy */
    external(p: Record<string, boolean>) {
      policy = { ...policy, ...p };
      for (const h of handlers) h({ policy: { ...policy } });
    },
    current: () => policy,
  };
  return m;
}

let win: Record<string, any>;
beforeEach(() => {
  win = {};
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

const DENIED = { essential: true, functional: false, analytics: false, advertising: false, dataToThirdParty: false };

describe('activation', () => {
  it('does nothing when the platform is not wix and the API is absent', () => {
    const c = makeConfig('none');
    expect(installWixBridge(c, fakeStore(c, 'opt-in'), { win })).toBeUndefined();
  });
  it('activates on the Wix API even when the config says platform none', () => {
    const c = makeConfig('none');
    win.consentPolicyManager = fakeManager();
    const b = installWixBridge(c, fakeStore(c, 'opt-in'), { win })!;
    expect(b.diagnostics.activatedBy).toBe('api');
    expect(win.consentPolicyManager.sets).toEqual([DENIED]);
  });
});

describe('mapping and the initial decision', () => {
  it('opt-in: everything denied, all four fields sent explicitly (Wix default was all granted)', () => {
    const c = makeConfig('wix');
    win.consentPolicyManager = fakeManager();
    installWixBridge(c, fakeStore(c, 'opt-in'), { win });
    expect(win.consentPolicyManager.sets).toEqual([DENIED]);
    expect(win.consentPolicyManager.current()).toMatchObject(DENIED);
  });

  it('opt-out: granted by the store default; dataToThirdParty follows advertising', () => {
    const c = makeConfig('wix');
    win.consentPolicyManager = fakeManager({ functional: false, analytics: false, advertising: false, dataToThirdParty: false });
    installWixBridge(c, fakeStore(c, 'opt-out'), { win });
    // 'functional' is not a listed category: denied even though the regime is permissive.
    expect(win.consentPolicyManager.sets).toEqual([{ essential: true, functional: false, analytics: true, advertising: true, dataToThirdParty: true }]);
  });

  it('sets again on every change, never granting what the store has not', () => {
    const c = makeConfig('wix');
    const store = fakeStore(c, 'opt-in');
    win.consentPolicyManager = fakeManager();
    installWixBridge(c, store, { win });
    store.set({ analytics: true, advertising: false });
    store.set({ analytics: true, advertising: true });
    store.set({});
    expect(win.consentPolicyManager.sets).toEqual([
      DENIED,
      { ...DENIED, analytics: true },
      { ...DENIED, analytics: true, advertising: true, dataToThirdParty: true },
      DENIED,
    ]);
  });

  it('honours a custom map; an empty mapping is always false; unknown category is false', () => {
    const c = makeConfig('wix');
    const store = fakeStore(c, 'opt-in');
    win.consentPolicyManager = fakeManager();
    installWixBridge(c, store, { win, map: { dataToThirdParty: ['advertising', 'analytics'], functional: [], advertising: ['nope'] } });
    store.set({ analytics: true, advertising: true });
    expect(win.consentPolicyManager.sets.at(-1)).toEqual({ essential: true, functional: false, analytics: true, advertising: false, dataToThirdParty: true });
    expect(wixPolicyFor({ isGranted: () => true }, { functional: [], analytics: ['a'], advertising: ['a'], dataToThirdParty: ['a'] }).functional).toBe(false);
  });

  it('skips the call when Wix already holds the explicit same policy', () => {
    const c = makeConfig('wix');
    const store = fakeStore(c, 'opt-in');
    const m = fakeManager();
    win.consentPolicyManager = m;
    installWixBridge(c, store, { win });
    store.set({}); // same as the initial
    expect(m.setConsentPolicy).toHaveBeenCalledTimes(1);
  });
});

describe('queueing until the API exists', () => {
  it('waits for consentPolicyManagerReady and sends only the newest policy', () => {
    const c = makeConfig('wix');
    const store = fakeStore(c, 'opt-in');
    const listeners: Record<string, () => void> = {};
    win.addEventListener = (n: string, fn: () => void) => (listeners[n] = fn);
    win.removeEventListener = (n: string) => delete listeners[n];
    const b = installWixBridge(c, store, { win })!;
    store.set({ analytics: true });
    store.set({ analytics: true, advertising: true });
    expect(b.diagnostics.managerSeen).toBe(false);
    const m = fakeManager();
    win.consentPolicyManager = m;
    listeners.consentPolicyManagerReady();
    expect(m.sets).toEqual([{ ...DENIED, analytics: true, advertising: true, dataToThirdParty: true }]);
    expect(Object.keys(listeners)).toEqual([]);
  });

  it('falls back to polling', () => {
    const c = makeConfig('wix');
    const b = installWixBridge(c, fakeStore(c, 'opt-in'), { win })!;
    vi.advanceTimersByTime(1000);
    const m = fakeManager();
    win.consentPolicyManager = m;
    vi.advanceTimersByTime(300);
    expect(m.sets).toEqual([DENIED]);
    expect(b.diagnostics.gaveUp).toBe(false);
  });

  it('gives up after the bounded wait, says so, and stops polling', () => {
    const c = makeConfig('wix');
    const b = installWixBridge(c, fakeStore(c, 'opt-in'), { win, waitMs: 2000 })!;
    vi.advanceTimersByTime(5000);
    expect(b.diagnostics.gaveUp).toBe(true);
    expect(b.diagnostics.notes.join()).toMatch(/NOT sent to Wix/);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('failures and external changes', () => {
  it('retries a throwing set a bounded number of times', () => {
    const c = makeConfig('wix');
    const m = fakeManager();
    m.setConsentPolicy.mockImplementation(() => {
      throw new Error('boom');
    });
    win.consentPolicyManager = m;
    const b = installWixBridge(c, fakeStore(c, 'opt-in'), { win, maxRetries: 3 })!;
    vi.advanceTimersByTime(5000);
    expect(m.setConsentPolicy).toHaveBeenCalledTimes(3);
    expect(b.diagnostics.failures).toBe(3);
    expect(b.diagnostics.notes.join()).toMatch(/gave up after 3/);
  });

  it("sets back a field Wix's own banner granted against the store, bounded", () => {
    const c = makeConfig('wix');
    const m = fakeManager();
    win.consentPolicyManager = m;
    const b = installWixBridge(c, fakeStore(c, 'opt-in'), { win, maxReasserts: 2 })!;
    m.external({ advertising: true });
    expect(m.current().advertising).toBe(false);
    m.external({ analytics: true });
    expect(m.current().analytics).toBe(false);
    m.external({ analytics: true });
    expect(m.current().analytics).toBe(true); // gave up, and said so
    expect(b.diagnostics.reasserted).toBe(2);
    expect(b.diagnostics.notes.join()).toMatch(/gave up setting it back/);
  });

  it('stop() unsubscribes', () => {
    const c = makeConfig('wix');
    const store = fakeStore(c, 'opt-in');
    const m = fakeManager();
    win.consentPolicyManager = m;
    const b = installWixBridge(c, store, { win })!;
    b.stop();
    store.set({ analytics: true });
    expect(m.sets).toHaveLength(1);
  });
});
