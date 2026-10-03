import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectConsentEvaluation, type ConsentEvaluationCollection } from '../src/collect/browser/index.js';
import { decideVerification } from '../src/rules/tracking/plan.js';
import { asRunId, type RequestEvent, type Timeline } from '../src/record/index.js';
import { registrableDomain } from '../src/registry/index.js';
import { startTrackingSite, type TrackingSite } from './fixtures/tracking-site.js';

// M6 "done when": against a fixture with frame, worker, service-worker,
// exit-beacon and srcdoc traffic, everything observable is recorded. Skips
// without Chromium. Geolocation is stubbed (two sources agreeing on DE) — the
// verification logic itself is unit-tested in consent-location.test.ts.

let chromiumAvailable = false;
try {
  const { chromium } = await import('playwright');
  chromiumAvailable = fs.existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}
const suite = chromiumAvailable ? describe : describe.skip;

const DE = [
  { name: 'stub-a', lookup: async () => ({ ip: '203.0.113.7', country: 'DE', region: 'HE', city: 'Frankfurt' }) },
  { name: 'stub-b', lookup: async () => ({ ip: '203.0.113.7', country: 'DE', region: 'Hesse' }) },
];

suite('consent evaluation capture (fixture storefront)', () => {
  let site: TrackingSite;
  let cwd: string;
  let col: ConsentEvaluationCollection;
  const tl = (s: string): Timeline => col.timelines.find((t) => t.snapshot.scenario === s)!;
  const reqs = (s: string): RequestEvent[] => tl(s).events.filter((e): e is RequestEvent => e.type === 'request');

  beforeAll(async () => {
    site = await startTrackingSite();
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'complykit-consent-'));
    col = await collectConsentEvaluation({
      property: 'fixture',
      targetUrl: site.url,
      runId: asRunId('consent-test'),
      cwd,
      locations: [{ id: 'de', country: 'DE' }],
      scenarios: ['browse', 'reject', 'accept', 'markers', 'gpc', 'opt-out-link'],
      journey: { dwellMs: 1500, pageDwellMs: 600, scrollSteps: 1, maxPages: 2 },
      bannerWaitMs: 1500,
      geoSources: DE,
      launchArgs: site.launchArgs,
      policy: {
        registrableDomain,
        verify: (spec, sources) => decideVerification(spec, sources),
        scenariosFor: () => ['browse'],
      },
      trace: process.env.CK_TRACE ? (l) => console.log(l) : undefined,
    });
  }, 240000);

  afterAll(async () => {
    await site?.close();
    if (cwd && !process.env.CK_KEEP) fs.rmSync(cwd, { recursive: true, force: true });
    else if (cwd) console.log('kept', cwd);
  });

  it('verifies the location from two agreeing sources and maps it to the EU', () => {
    const loc = col.locations[0];
    expect(loc.verification.verdict).toBe('verified');
    expect(loc.verification.jurisdictions).toEqual(['eu', 'eu-de']);
  });

  it('records page, cross-site frame, srcdoc frame, worker and service-worker requests', () => {
    const r = reqs('browse');
    const by = (host: string): RequestEvent | undefined => r.find((e) => e.url.includes(host));
    expect(by('px.frame.test')?.origin).toBe('frame');
    expect(by('px.srcdoc.test')?.origin).toBe('frame');
    expect(by('px.worker.test')?.origin).toBe('worker');
    expect(by('px.sw.test')?.origin).toBe('service-worker');
    expect(by('adpixel.test')?.origin).toBe('page');
  });

  it('recovers the page-exit beacon the browser events miss', () => {
    const beacon = reqs('browse').filter((e) => e.url.includes('px.beacon.test'));
    expect(beacon.length).toBeGreaterThan(0);
    expect(beacon.some((e) => e.origin === 'exit-beacon')).toBe(true);
  });

  it('attributes the injected widget pixel through the tag manager', () => {
    const px = reqs('browse').find((e) => /px\.widget\.test:\d+\/p\?/.test(e.url));
    expect(px).toBeDefined();
    expect(px!.initiator.chain.some((u) => /px\.widget\.test:\d+\/w\.js/.test(u))).toBe(true);
    expect(px!.initiator.chain.some((u) => /cdn\.tagmgr\.test:\d+\/tm\.js/.test(u))).toBe(true);
  });

  it('captures HttpOnly cookies, script-written cookies with their writer, and frame storage', () => {
    const b = tl('browse');
    const sid = b.snapshot.cookies.find((c) => c.name === 'sid');
    expect(sid?.httpOnly).toBe(true);
    const write = b.events.find((e) => e.type === 'cookie-write' && e.name === '_uw');
    expect(write && write.type === 'cookie-write' && write.chain.some((u) => /px\.widget\.test:\d+\/w\.js/.test(u))).toBe(true);
    expect(b.snapshot.storage.some((s) => s.key === 'uw_id' && s.area === 'local')).toBe(true);
    expect(b.snapshot.frames.some((f) => f.sandboxed)).toBe(true);
  });

  it('drives the banner: reject records a successful choice and keeps the gated script out', () => {
    const r = tl('reject');
    const choice = r.events.find((e) => e.type === 'choice');
    expect(choice && choice.type === 'choice' && choice.ok).toBe(true);
    expect(r.events.some((e) => e.type === 'banner' && e.state === 'shown')).toBe(true);
    expect(reqs('reject').some((e) => e.url.includes('cdn.consented.test'))).toBe(false);
    expect(reqs('accept').some((e) => e.url.includes('cdn.consented.test'))).toBe(true);
  });

  it('types markers without submitting and sees them leave in a request', () => {
    const m = tl('markers');
    const email = m.snapshot.markers!.email;
    const leak = reqs('markers').find((e) => e.url.includes('px.capture.test') && decodeURIComponent(e.url).includes(email));
    expect(leak).toBeDefined();
    expect(reqs('markers').some((e) => e.url.includes(m.snapshot.markers!.clickIds.gclid))).toBe(true);
  });

  it('sends GPC (header + navigator) and the site reacts', () => {
    expect(tl('gpc').snapshot.gpc).toBe(true);
    expect(reqs('gpc').some((e) => e.url.includes('adpixel.test'))).toBe(false);
    expect(reqs('browse').some((e) => e.url.includes('adpixel.test'))).toBe(true);
  });

  it('walks the opt-out link', () => {
    const walk = tl('opt-out-link').events.find((e) => e.type === 'opt-out-walk');
    expect(walk && walk.type === 'opt-out-walk' && walk.found).toBe(true);
    if (walk?.type === 'opt-out-walk') {
      expect(walk.linkText).toMatch(/Do Not Sell/);
      expect(walk.hasIcon).toBe(false);
    }
  });

  it('writes redacted HAR and timeline evidence', () => {
    const b = tl('browse');
    const har = JSON.parse(fs.readFileSync(path.join(cwd, '.comply/runs/consent-test', b.snapshot.evidence.har!), 'utf8'));
    expect(har.log.entries.length).toBeGreaterThan(5);
    const withCookie = har.log.entries.flatMap((e: { request: { headers: Array<{ name: string; value: string }> } }) => e.request.headers).filter((h: { name: string }) => h.name.toLowerCase() === 'cookie');
    expect(withCookie.every((h: { value: string }) => h.value.startsWith('[redacted'))).toBe(true);
    const timeline = JSON.parse(fs.readFileSync(path.join(cwd, '.comply/runs/consent-test', b.snapshot.evidence.timeline!), 'utf8'));
    const uw = timeline.snapshot.cookies.find((c: { name: string }) => c.name === '_uw');
    expect(uw.value).toMatch(/^sha256:/);
  });
});
