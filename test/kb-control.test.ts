import { describe, it, expect } from 'vitest';
import { KB_ENTRIES } from '../src/registry/index.js';
import { CONTROL_VENDOR_IDS } from '../src/registry/kb/entries.js';
import { TagControl } from '../src/registry/kb/schema.js';

// A8 (plans/client-consent-design.md §2): the vendors the client adapters and
// the compatibility verdict depend on carry control facts as data, each with
// the vendor documentation it rests on.

const byId = new Map(KB_ENTRIES.map((e) => [e.id, e]));

describe('KB control facts', () => {
  it('covers the top-40 vendor list', () => {
    expect(CONTROL_VENDOR_IDS.length).toBeGreaterThanOrEqual(40);
    expect(new Set(CONTROL_VENDOR_IDS).size).toBe(CONTROL_VENDOR_IDS.length);
  });

  it.each(CONTROL_VENDOR_IDS)('%s has an entry with control filled', (id) => {
    const e = byId.get(id);
    expect(e, `no seed entry ${id}`).toBeDefined();
    expect(e!.control, `${id} has no control`).toBeDefined();
    expect(() => TagControl.parse(e!.control)).not.toThrow();
    expect(e!.control!.sources.length).toBeGreaterThan(0);
  });

  it('every documented consent API carries grant, revoke and a source', () => {
    for (const e of KB_ENTRIES) {
      const api = e.control?.api;
      if (!api) continue;
      expect(api.grant, e.id).toBeTruthy();
      expect(api.revoke, e.id).toBeTruthy();
      expect(api.sources.length, e.id).toBeGreaterThan(0);
    }
  });

  it('records the absence of an API instead of inventing one', () => {
    // Vendors whose docs show no consent call: gate the load.
    for (const id of ['hotjar', 'linkedin.insight', 'snap.pixel', 'google.youtube', 'google.maps']) {
      expect(byId.get(id)?.control?.api, id).toBeUndefined();
    }
  });

  it('flags install snippets that fire without script', () => {
    expect(byId.get('meta.pixel')?.control?.snippetLeak).toBe('noscript-img');
    expect(byId.get('google.tag-manager')?.control?.snippetLeak).toBe('iframe');
    expect(byId.get('google.tag-manager')?.control?.loadsOthers).toBe(true);
  });

  it('ad-tech exchanges are TCF-only', () => {
    for (const id of ['criteo', 'amazon.ads', 'tradedesk', 'magnite', 'pubmatic', 'indexexchange', 'openx']) {
      const c = byId.get(id)?.control;
      expect(c?.tcf?.vendorId, id).toBeGreaterThan(0);
      expect(c?.api, id).toBeUndefined();
    }
  });
});
