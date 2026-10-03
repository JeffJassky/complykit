import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectConsentEvaluation, type ConsentEvaluationCollection } from '../src/collect/browser/index.js';
import { decideVerification } from '../src/rules/tracking/plan.js';
import { asRunId } from '../src/record/index.js';
import { registrableDomain } from '../src/registry/index.js';
import { startTrackingSite, startProxy, type TrackingSite } from './fixtures/tracking-site.js';

// M7: a location's proxy carries BOTH the geolocation lookups and the visit,
// so the place that gets verified is the place the evidence came from.

let chromiumAvailable = false;
try {
  const { chromium } = await import('playwright');
  chromiumAvailable = fs.existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}
const suite = chromiumAvailable ? describe : describe.skip;

suite('locations through a proxy', () => {
  let site: TrackingSite;
  let proxy: Awaited<ReturnType<typeof startProxy>>;
  let cwd: string;
  let col: ConsentEvaluationCollection;

  beforeAll(async () => {
    site = await startTrackingSite();
    proxy = await startProxy(site.port);
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'complykit-proxy-'));
    const geo = (host: string) => ({
      name: host,
      lookup: async (fetchJson: (u: string) => Promise<unknown>) => {
        const j = (await fetchJson(`http://${host}:${site.port}/json`)) as { ip: string; country: string; region: string };
        return { ip: j.ip, country: j.country, region: j.region };
      },
    });
    col = await collectConsentEvaluation({
      property: 'fixture',
      targetUrl: site.url,
      runId: asRunId('proxy'),
      cwd,
      locations: [
        { id: 'de', label: 'Germany', country: 'DE', proxy: { server: proxy.url } },
        // Same proxy, claimed to be in France: the lookups say Germany → mismatch → not tested.
        { id: 'fr', label: 'France', country: 'FR', proxy: { server: proxy.url } },
      ],
      scenarios: ['do-nothing'],
      journey: { dwellMs: 1200, pageDwellMs: 500, scrollSteps: 1, maxPages: 0 },
      bannerWaitMs: 1000,
      geoSources: [geo('geo-a.test'), geo('geo-b.test')],
      launchArgs: site.launchArgs,
      policy: { registrableDomain, verify: (spec, sources) => decideVerification(spec, sources), scenariosFor: () => ['do-nothing'] },
    });
  }, 120000);

  afterAll(async () => {
    await proxy?.close();
    await site?.close();
    if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('verifies through the proxy and visits through it', () => {
    expect(col.locations[0].verification.verdict).toBe('verified');
    expect(col.locations[0].verification.observed.region).toBe('BE');
    expect(proxy.seen.some((u) => u.includes('geo-a.test'))).toBe(true);
    expect(proxy.seen.some((u) => u.includes('cdn.tagmgr.test'))).toBe(true);
  });

  it('a mislabeled exit produces a not-tested entry, not evidence', () => {
    expect(col.locations[1].verification.verdict).toBe('mismatch');
    expect(col.locations[1].scenarios).toEqual([]);
    expect(col.timelines.every((t) => t.location.id === 'de')).toBe(true);
    expect(col.notTested.some((n) => n.scope === 'location' && n.id === 'fr')).toBe(true);
  });
});
