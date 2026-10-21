import fs from 'node:fs';
import path from 'node:path';
import { type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveLocation, type LocationEnv } from '../src/location';
import { createStore, holdsBeforeChoice } from '../src/store';
import { DEFAULTS } from '../src/ui/strings';
import type { ConsentToolConfig, RegimeSource } from '../src/config';
import { DIST, launchBrowser, startFixtureServer, type FixtureServer } from './harness';

// Schema 1.1 contract (plans/regime-overrides.md): complykit policy by location
// (wiretap holds in `locationDefaults`) and the owner's `overrides`, which the
// client runs in either direction. Unit tests drive resolveLocation / createStore
// in node (no document: nothing persists); the browser tests load the built IIFE.

const EXAMPLE = path.join(__dirname, '..', '..', 'test', 'fixtures', 'consent-config', 'example.json');
const ON = '2026-10-21';
const CA = { country: 'US', region: 'CA' };
const TX = { country: 'US', region: 'TX' };
const DE = { country: 'DE' };

/** The example config with both US regimes granting analytics + advertising by policy, and the wiretap hold for California. */
function cfg(over: Partial<ConsentToolConfig> = {}, regimeSource: RegimeSource = { kind: 'meta', name: 'complykit-region' }): ConsentToolConfig {
  const c = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
  for (const cat of c.categories) if (cat.id !== 'necessary') cat.defaultByRegime = { 'opt-in': false, 'opt-out-signal': true, 'opt-out': true };
  delete c.gtm;
  c.regimeSource = regimeSource;
  c.locationDefaults = { 'US-CA': { analytics: false, advertising: false } };
  return { ...c, ...over };
}

const metaDoc = (tags: Record<string, string>): LocationEnv['document'] => ({
  querySelector: ((sel: string) => {
    const m = /^meta\[name="(.+)"\]$/.exec(sel);
    const v = m ? tags[m[1]] : undefined;
    return v === undefined ? null : { getAttribute: () => v };
  }) as any,
});

describe('location: overrides.regimes', () => {
  const over = cfg({ overrides: { regimes: { 'CA-QC': 'opt-in', CA: 'opt-out', 'US-CA': 'opt-in' } } });
  const at = (region: string, c = over) => resolveLocation(c, { document: metaDoc({ 'complykit-region': region }), onDate: ON }).initial;

  it('a subdivision key beats its country key; the decision says it was overridden and carries the location', () => {
    expect(at('CA-QC')).toMatchObject({ regime: 'opt-in', source: 'meta', overridden: true, location: { country: 'CA', region: 'QC' } });
    expect(at('CA-ON')).toMatchObject({ regime: 'opt-out', overridden: true });
    expect(at('US-CA')).toMatchObject({ regime: 'opt-in', overridden: true });
  });
  it('no matching key: the built-in table decides, not overridden', () => {
    expect(at('US-TX')).toMatchObject({ regime: 'opt-out-signal', overridden: false });
    expect(at('DE')).toMatchObject({ regime: 'opt-in', overridden: false });
  });
  it("'*' covers an unknown location, and a pending header lookup starts on it", () => {
    const star = cfg({ overrides: { regimes: { '*': 'opt-out' } } });
    expect(resolveLocation(star, { document: metaDoc({}), onDate: ON }).initial).toMatchObject({ regime: 'opt-out', source: 'unknown', overridden: true });
    const header = cfg({ overrides: { regimes: { '*': 'opt-out' } } }, { kind: 'header', header: 'cf-ipcountry', endpoint: '/loc' });
    const r = resolveLocation(header, { document: metaDoc({}), pageUrl: 'https://shop.test/', fetch: () => new Promise(() => {}), onDate: ON });
    expect(r.initial).toMatchObject({ regime: 'opt-out', pending: true, overridden: true });
  });
  it('without overrides a pending lookup still starts strictest', () => {
    const header = cfg({}, { kind: 'header', header: 'cf-ipcountry', endpoint: '/loc' });
    const r = resolveLocation(header, { document: metaDoc({}), pageUrl: 'https://shop.test/', fetch: () => new Promise(() => {}), onDate: ON });
    expect(r.initial).toMatchObject({ regime: 'opt-in', pending: true, overridden: false });
  });
  it('a fixed regime ignores overrides.regimes', () => {
    const fixed = cfg({ overrides: { regimes: { '*': 'opt-out' } } }, { kind: 'fixed', regime: 'opt-in' });
    expect(resolveLocation(fixed, { document: metaDoc({ 'complykit-region': 'US-TX' }), onDate: ON }).initial).toMatchObject({ regime: 'opt-in', source: 'fixed', overridden: false });
  });
});

describe('store: pre-choice defaults by location', () => {
  it('policy: California holds the wiretap categories under opt-out-signal; Texas runs them', () => {
    expect(createStore(cfg(), 'opt-out-signal', { gpc: false, location: CA }).state().categories).toEqual({ necessary: true, analytics: false, advertising: false });
    expect(createStore(cfg(), 'opt-out-signal', { gpc: false, location: TX }).state().categories).toEqual({ necessary: true, analytics: true, advertising: true });
  });
  it('the state carries the location and whether GPC was honored', () => {
    const s = createStore(cfg(), 'opt-out', { gpc: true, location: TX }).state();
    expect(s).toMatchObject({ location: TX, gpc: true, gpcHonored: true });
    expect(s.categories).toEqual({ necessary: true, analytics: false, advertising: false });
  });
  it('overrides beat policy in either direction', () => {
    const looser = cfg({ overrides: { defaults: { 'US-CA': { analytics: true }, 'opt-in': { advertising: true } } } });
    expect(createStore(looser, 'opt-out-signal', { gpc: false, location: CA }).state().categories).toEqual({ necessary: true, analytics: true, advertising: false });
    expect(createStore(looser, 'opt-in', { gpc: false, location: DE }).state().categories).toEqual({ necessary: true, analytics: false, advertising: true });
    const stricter = cfg({ overrides: { defaults: { US: { advertising: false } } } });
    expect(createStore(stricter, 'opt-out', { gpc: false, location: TX }).state().categories).toEqual({ necessary: true, analytics: true, advertising: false });
  });
  it('honorGpc false: the signal is reported, not applied', () => {
    const s = createStore(cfg({ overrides: { honorGpc: false } }), 'opt-out', { gpc: true, location: TX }).state();
    expect(s).toMatchObject({ gpc: true, gpcHonored: false });
    expect(s.categories).toEqual({ necessary: true, analytics: true, advertising: true });
  });
  it('setRegime with a location moves the defaults before a choice', () => {
    const st = createStore(cfg(), 'opt-in', { gpc: false });
    st.setRegime('opt-out-signal', CA);
    expect(st.state()).toMatchObject({ regime: 'opt-out-signal', location: CA, categories: { analytics: false, advertising: false } });
    st.setRegime('opt-out-signal', TX);
    expect(st.state().categories).toMatchObject({ analytics: true, advertising: true });
    st.setRegime('opt-out'); // no location given: the last one stands
    expect(st.state().location).toEqual(TX);
  });
});

describe('banner copy when an opt-out regime still holds something', () => {
  it('holdsBeforeChoice: an opt-out regime where a listed non-necessary category defaults off (GPC aside)', () => {
    expect(holdsBeforeChoice(cfg(), 'opt-out-signal', CA)).toBe(true);
    expect(holdsBeforeChoice(cfg(), 'opt-out-signal', TX)).toBe(false);
    expect(holdsBeforeChoice(cfg(), 'opt-in', DE)).toBe(false); // opt-in has its own copy
    expect(holdsBeforeChoice(cfg({ overrides: { defaults: { 'US-CA': { analytics: true, advertising: true } } } }), 'opt-out-signal', CA)).toBe(false);
  });
  it('the English defaults carry a held variant of both bodies that says some things stay off until accepted', () => {
    const held = DEFAULTS.en.held;
    expect(held).toBeDefined();
    for (const k of ['banner.body', 'settings.body'] as const) {
      expect(held![k]).toMatch(/until you (accept|switch)/i);
      expect(held![k]).not.toMatch(/^Optional categories are on unless you opt out/);
    }
  });
});

// --- the built tool in a browser -------------------------------------------------

let browser: Browser;
let server: FixtureServer;

beforeAll(async () => {
  if (!fs.existsSync(path.join(DIST, 'complykit-consent.js'))) throw new Error('dist/complykit-consent.js missing: run `npm run build` first');
  server = await startFixtureServer();
  browser = await launchBrowser();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function open(config: unknown, meta: string, gpc = false): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  if (gpc) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true }));
  await page.route('**/overrides-page', (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><head><meta name="complykit-region" content="${meta}">
<script type="application/json" id="complykit-config">${JSON.stringify(config)}</script>
<script src="/complykit-consent.js"></script>
<script type="text/plain" data-category="analytics">window.__ran = (window.__ran || []).concat('analytics')</script>
<script type="text/plain" data-category="advertising">window.__ran = (window.__ran || []).concat('advertising')</script>
</head><body></body></html>`,
    }),
  );
  await page.goto(`${server.origin}/overrides-page`);
  return page;
}
const ran = (page: Page) => page.evaluate(() => ((window as any).__ran ?? []).slice().sort());

describe('overrides in the browser', () => {
  it('California: the wiretap categories are held before a choice; Texas runs them', async () => {
    const ca = await open(cfg(), 'US-CA');
    expect(await ran(ca)).toEqual([]);
    expect(await ca.evaluate(() => (window as any).ComplyKit.diagnostics.location)).toMatchObject({ source: 'meta', regime: 'opt-out-signal', location: CA, overridden: false });
    await ca.context().close();
    const tx = await open(cfg(), 'US-TX');
    expect(await ran(tx)).toEqual(['advertising', 'analytics']);
    await tx.context().close();
  });
  it('a looser override runs what policy holds, even in the EU', async () => {
    const page = await open(cfg({ overrides: { defaults: { 'opt-in': { analytics: true } } } }), 'DE');
    expect(await ran(page)).toEqual(['analytics']);
    await page.context().close();
  });
  it('a regime override moves Canada outside Quebec to opt-out', async () => {
    const c = cfg({ overrides: { regimes: { 'CA-QC': 'opt-in', CA: 'opt-out' } } });
    const on = await open(c, 'CA-ON');
    expect(await ran(on)).toEqual(['advertising', 'analytics']);
    expect(await on.evaluate(() => (window as any).ComplyKit.diagnostics.location)).toMatchObject({ regime: 'opt-out', overridden: true });
    await on.context().close();
    const qc = await open(c, 'CA-QC');
    expect(await ran(qc)).toEqual([]);
    await qc.context().close();
  });
  it('honorGpc false keeps an opt-out visitor with GPC on the defaults', async () => {
    const page = await open(cfg({ overrides: { honorGpc: false } }), 'US-TX', true);
    expect(await ran(page)).toEqual(['advertising', 'analytics']);
    await page.context().close();
  });
});
