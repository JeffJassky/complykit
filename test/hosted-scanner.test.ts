import { describe, it, expect } from 'vitest';
import { generateConsentConfig } from '../src/consent-generator.js';
import { removeExistingToolTasks } from '../src/remediation.js';
import { COMPLYKIT_HOSTS, COMPLYKIT_PARTY_ID, DEFAULT_KB, lookupEntry } from '../src/registry/index.js';
import { compatibilityEvaluation, PAGE } from './fixtures/compatibility-report.js';

// T1b (plans/hosted-script.md, B4): the complykit host is the site's own
// consent tool — a recognized `consent` party, never a tracker, never an
// "existing consent tool" to remove.

const NOW = '2026-10-06T12:00:00.000Z';

describe('the complykit KB entry', () => {
  it('every complykit host resolves to consent.complykit, category consent', () => {
    expect(COMPLYKIT_HOSTS.length).toBeGreaterThan(0);
    for (const h of COMPLYKIT_HOSTS) {
      for (const p of ['/s/example-shop.test.js', '/e', '/api/consent-records']) {
        const e = lookupEntry(DEFAULT_KB, h, p);
        expect(e?.id, `${h}${p}`).toBe(COMPLYKIT_PARTY_ID);
        expect(e?.categories).toEqual(['consent']);
      }
    }
  });
});

describe('complykit is never an existing consent tool to remove', () => {
  const withComplykit = () => {
    const ev = compatibilityEvaluation();
    const host = COMPLYKIT_HOSTS[0];
    ev.inventory.push({ ...ev.inventory[1], partyId: COMPLYKIT_PARTY_ID, label: 'ComplyKit', domain: host, hosts: [host], recognized: true, categories: ['consent'], implementation: { class: 'direct-script', evidence: [], alsoSeen: [] } });
    return ev;
  };

  it('no existing-consent-tool note, no remove task', () => {
    const ev = withComplykit();
    const r = generateConsentConfig(ev, { complykitVersion: '0.0.0-test', now: NOW, hostedScriptUrl: `https://${COMPLYKIT_HOSTS[0]}/s/example-shop.test.js` });
    expect(r.notes.filter((n) => n.code === 'existing-consent-tool')).toEqual([]);
    expect(r.tasks.filter((t) => t.kind === 'remove-existing-tool')).toEqual([]);
  });

  it('removeExistingToolTasks skips it even when a note names it', () => {
    expect(removeExistingToolTasks(withComplykit(), [{ code: 'existing-consent-tool', message: 'x', partyIds: [COMPLYKIT_PARTY_ID] }], PAGE)).toEqual([]);
  });

  it('it is not listed as a vendor to gate', () => {
    const r = generateConsentConfig(withComplykit(), { complykitVersion: '0.0.0-test', now: NOW });
    expect(r.config.vendors.map((v) => v.id)).not.toContain(COMPLYKIT_PARTY_ID);
  });
});
