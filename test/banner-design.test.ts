import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright';
import { getRule } from '../src/index.js';
import type { Artifact, RawFinding } from '../src/index.js';
import {
  parseCssColor,
  effectiveBackground,
  contrastRatio,
  controlTextContrast,
  looksEnglish,
  BANNER_DESIGN_LABEL,
  BANNER_SECOND_LAYER_LABEL,
  BANNER_AFTER_CHOICE_LABEL,
  type BannerControl,
} from '../src/record/banner-design.js';
import { readFirstLayer, readSecondLayer, readAfterChoice } from '../src/collect/browser/evaluation/banner-design.js';
import { ENGINE_NAMES, engineAvailability, launchEngine } from './engines.js';

// F6: consent-banner design rules. Pure rule tests over synthetic readouts,
// then the real readers over HTML fixtures (test/fixtures/banner/, pass + fail
// per rule), then our own built banner (client/dist) — which must pass every
// rule, in Chromium, Firefox and WebKit (F5). Browser parts skip without their
// engine (test/engines.ts; COMPLYKIT_ENGINES makes an engine required); the
// client part also skips when client/dist has not been built.

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, 'fixtures', 'banner');

const RULES = ['consent.equal-prominence', 'consent.no-pre-ticked', 'consent.no-cookie-wall', 'consent.required-strings', 'consent.withdrawal-control'];

const PLACES: Record<string, { id: string; country: string; region?: string; jurisdictions: string[] }> = {
  de: { id: 'de', country: 'DE', jurisdictions: ['eu', 'eu-de'] },
  uk: { id: 'uk', country: 'GB', jurisdictions: ['uk'] },
  ca: { id: 'us-ca', country: 'US', region: 'CA', jurisdictions: ['us', 'us-ca'] },
  tx: { id: 'us-tx', country: 'US', region: 'TX', jurisdictions: ['us', 'us-tx'] },
};

function timeline(place: keyof typeof PLACES, readouts: Array<[string, unknown]>, opts: { scenario?: string; verified?: boolean; extra?: unknown[] } = {}): Artifact {
  const p = PLACES[place];
  return {
    kind: 'consent-timeline',
    subject: { property: 'shop', routePattern: '*', instanceUrl: 'https://example-shop.test/' },
    capturedAt: '2026-10-06T00:00:00.000Z',
    scenario: opts.scenario ?? 'do-nothing',
    location: { id: p.id, label: p.id },
    verification: {
      verdict: opts.verified === false ? 'unknown' : 'verified',
      expected: {},
      observed: { country: p.country, region: p.region },
      sources: [],
      siteReported: [],
      jurisdictions: opts.verified === false ? [] : p.jurisdictions,
      checkedAt: '2026-10-06T00:00:00.000Z',
    },
    events: [...readouts.map(([label, data], i) => ({ type: 'consent-readout', t: i, label, data, pageIndex: 0 })), ...((opts.extra ?? []) as Record<string, unknown>[])] as Record<string, unknown>[],
    snapshot: { startedAt: '2026-10-06T00:00:00.000Z', site: { url: 'https://example-shop.test/' } },
  };
}

function run(ruleId: string, artifacts: Artifact[]): RawFinding[] {
  const rule = getRule(ruleId);
  if (!rule || rule.layer === 'llm' || !('evaluate' in rule)) throw new Error(`not a deterministic rule: ${ruleId}`);
  return rule.evaluate({ 'consent-timeline': artifacts } as never, { property: 'shop' });
}
const patterns = (fs: RawFinding[]): string[] => fs.map((f) => (f.details as { pattern: string }).pattern).sort();
const all = (artifacts: Artifact[]): Record<string, string[]> => Object.fromEntries(RULES.map((r) => [r, patterns(run(r, artifacts))]));

const control = (role: BannerControl['role'], over: Partial<BannerControl> = {}): BannerControl => ({
  role,
  tag: 'button',
  text: role === 'accept' ? 'Accept all' : role === 'reject' ? 'Reject all' : 'Manage',
  box: { x: 0, y: 700, width: 140, height: 40 },
  fontSizePx: 16,
  fontWeight: 400,
  color: 'rgb(255, 255, 255)',
  backgrounds: ['rgb(26, 74, 138)'],
  backgroundImage: false,
  bordered: true,
  inViewport: true,
  reachable: true,
  domIndex: role === 'reject' ? 0 : role === 'accept' ? 1 : 2,
  ...over,
});

const goodFirst = (over: Record<string, unknown> = {}) => ({
  found: true,
  source: 'known-selector',
  cmp: 'Example',
  bannerBackgrounds: ['rgb(255, 255, 255)'],
  controls: [control('reject'), control('accept'), control('manage')],
  text: 'We use cookies and similar technologies for analytics and advertising. You can change your choice at any time.',
  links: [{ text: 'Privacy policy', href: 'https://example-shop.test/privacy' }],
  blocking: { covered: 0, inert: false, scrollLocked: false, scrollable: true },
  optOutLinks: [],
  unmeasured: [],
  ...over,
});

describe('color math', () => {
  it('parses computed colors and composites translucent stacks', () => {
    expect(parseCssColor('rgb(255, 0, 0)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseCssColor('rgba(0, 0, 0, 0.5)')?.a).toBe(0.5);
    expect(parseCssColor('color(srgb 1 1 1)')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCssColor('oklch(0.5 0.1 120)')).toBeUndefined(); // unparseable → not measurable, never a pass
    const bg = effectiveBackground(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0.5)', 'rgb(255, 255, 255)']);
    expect(bg?.assumed).toBe(false);
    expect(Math.round(bg!.color.r)).toBe(128);
    expect(effectiveBackground(['rgba(0, 0, 0, 0)'])?.assumed).toBe(true);
    expect(contrastRatio({ r: 0, g: 0, b: 0, a: 1 }, { r: 255, g: 255, b: 255, a: 1 })).toBeCloseTo(21, 0);
  });
  it('reports contrast as unmeasurable over a background image', () => {
    expect(controlTextContrast(control('accept', { backgroundImage: true }))).toBeUndefined();
    expect(controlTextContrast(control('accept'))).toBeGreaterThan(4.5);
  });
  it('tells English banner text from other languages', () => {
    expect(looksEnglish('We use cookies to improve your experience on our site.')).toBe(true);
    expect(looksEnglish('Wir verwenden Cookies, um unsere Website zu verbessern.')).toBe(false);
  });
});

describe('banner rules over readouts', () => {
  it('a symmetrical, complete banner yields no findings', () => {
    const tl = timeline('de', [
      [BANNER_DESIGN_LABEL, goodFirst()],
      [BANNER_SECOND_LAYER_LABEL, { via: 'dom', toggles: [{ label: 'Necessary', checked: true, disabled: true, kind: 'checkbox' }, { label: 'Analytics', checked: false, disabled: false, kind: 'checkbox' }] }],
      [BANNER_AFTER_CHOICE_LABEL, { choice: 'accept', bannerVisible: false, controls: [{ text: 'Cookie settings', via: 'link', inFooter: true }] }],
    ]);
    expect(all([tl])).toEqual(Object.fromEntries(RULES.map((r) => [r, []])));
  });

  it('equal prominence: size, surface, contrast and scroll asymmetries', () => {
    const first = goodFirst({
      controls: [
        control('accept', { box: { x: 0, y: 700, width: 300, height: 60 }, fontSizePx: 20, fontWeight: 700, backgrounds: ['rgb(10, 125, 44)'], bordered: false }),
        control('reject', { tag: 'a', box: { x: 0, y: 900, width: 60, height: 14 }, fontSizePx: 12, color: 'rgb(187, 187, 187)', backgrounds: ['rgba(0, 0, 0, 0)', 'rgb(255, 255, 255)'], bordered: false, inViewport: false, reachable: false }),
      ],
    });
    const f = run('consent.equal-prominence', [timeline('de', [[BANNER_DESIGN_LABEL, first]])]);
    expect(patterns(f)).toEqual(['emphasis', 'reject-low-contrast', 'reject-needs-scroll', 'size']);
    expect(f.every((x) => x.confidence === 'needs-review')).toBe(true);
    expect(String(f[0].requirementId)).toBe('gdpr.art4.11');
    expect(f[0].subject.locator?.landmark).toBe('eu');
    // The same banner in California cites CCPA §7004; in Texas nothing applies.
    expect(run('consent.equal-prominence', [timeline('ca', [[BANNER_DESIGN_LABEL, first]])]).map((x) => String(x.requirementId))).toContain('ccpa.regs.7004');
    expect(run('consent.equal-prominence', [timeline('tx', [[BANNER_DESIGN_LABEL, first]])])).toEqual([]);
  });

  it('no reject on the first layer: violation with exact selectors, needs-review from the heuristic', () => {
    const noReject = (source: string) => goodFirst({ source, controls: [control('accept'), control('manage', { text: 'Settings' })] });
    const exact = run('consent.equal-prominence', [timeline('uk', [[BANNER_DESIGN_LABEL, noReject('known-selector')]])]);
    expect(patterns(exact)).toEqual(['no-reject-first-layer']);
    expect(exact[0].confidence).toBe('violation');
    expect(String(exact[0].requirementId)).toBe('uk-gdpr.art4.11');
    expect(run('consent.equal-prominence', [timeline('uk', [[BANNER_DESIGN_LABEL, noReject('heuristic')]])])[0].confidence).toBe('needs-review');
    // California: "Accept All" + "More information" alone (§7004(a)(2)(C)).
    expect(patterns(run('consent.equal-prominence', [timeline('ca', [[BANNER_DESIGN_LABEL, noReject('known-selector')]])]))).toEqual(['accept-and-more-info-only']);
  });

  it('unmeasurable values and unverified locations produce no findings (not a pass: the collector records not-tested)', () => {
    const first = goodFirst({ controls: [control('accept', { backgroundImage: true }), control('reject', { backgroundImage: true })] });
    expect(run('consent.equal-prominence', [timeline('de', [[BANNER_DESIGN_LABEL, first]])])).toEqual([]);
    const bad = goodFirst({ controls: [control('accept')] });
    expect(run('consent.equal-prominence', [timeline('de', [[BANNER_DESIGN_LABEL, bad]], { verified: false })])).toEqual([]);
  });

  it('pre-ticked optional categories, opt-in only', () => {
    const second = { via: 'opened', toggles: [{ label: 'Strictly necessary', checked: true, disabled: false, kind: 'checkbox' }, { label: 'Marketing', checked: true, disabled: false, kind: 'checkbox' }, { label: 'Vendor 17', checked: true, disabled: false, kind: 'switch' }] };
    const f = run('consent.no-pre-ticked', [timeline('de', [[BANNER_SECOND_LAYER_LABEL, second]])]);
    expect(patterns(f)).toEqual(['pre-ticked']);
    expect(f[0].confidence).toBe('violation');
    expect((f[0].details as { toggles: Array<{ label: string }> }).toggles.map((t) => t.label)).toEqual(['Marketing', 'Vendor 17']);
    expect(run('consent.no-pre-ticked', [timeline('ca', [[BANNER_SECOND_LAYER_LABEL, second]])])).toEqual([]); // opt-out regime: defaults on are lawful
    const unclear = { via: 'dom', toggles: [{ label: 'Vendor 17', checked: true, disabled: false, kind: 'switch' }] };
    expect(run('consent.no-pre-ticked', [timeline('de', [[BANNER_SECOND_LAYER_LABEL, unclear]])])[0].confidence).toBe('needs-review');
  });

  it('cookie wall: blocking without reject, blocked after reject, wall wording; a modal with reject passes', () => {
    const blockingNoReject = goodFirst({ blocking: { covered: 1, inert: false, scrollLocked: true, scrollable: true }, controls: [control('accept')] });
    expect(patterns(run('consent.no-cookie-wall', [timeline('de', [[BANNER_DESIGN_LABEL, blockingNoReject]])]))).toEqual(['blocking-without-reject']);
    const modal = goodFirst({ modal: true, blocking: { covered: 1, inert: true, scrollLocked: true, scrollable: true } });
    expect(run('consent.no-cookie-wall', [timeline('de', [[BANNER_DESIGN_LABEL, modal]])])).toEqual([]);
    const after = { choice: 'reject', bannerVisible: false, blocking: { covered: 1, inert: false, scrollLocked: true, scrollable: true }, controls: [] };
    const wall = run('consent.no-cookie-wall', [timeline('de', [[BANNER_DESIGN_LABEL, modal]]), timeline('de', [[BANNER_AFTER_CHOICE_LABEL, after]], { scenario: 'reject' })]);
    expect(patterns(wall)).toEqual(['blocked-after-reject']);
    expect(wall[0].confidence).toBe('violation');
    const wording = goodFirst({ text: 'We use cookies for analytics. You must accept cookies to continue reading. Change your choice at any time.' });
    expect(patterns(run('consent.no-cookie-wall', [timeline('de', [[BANNER_DESIGN_LABEL, wording]])]))).toEqual(['wall-wording']);
    expect(run('consent.no-cookie-wall', [timeline('ca', [[BANNER_DESIGN_LABEL, blockingNoReject]])])).toEqual([]); // opt-in only
  });

  it('required strings per regime', () => {
    const thin = goodFirst({ text: 'This website uses cookies to give you the best experience on our site.', links: [], controls: [control('reject'), control('accept')] });
    const eu = run('consent.required-strings', [timeline('de', [[BANNER_DESIGN_LABEL, thin]])]);
    expect(patterns(eu)).toEqual(['missing-further-information', 'missing-purposes', 'missing-withdrawal']);
    expect(eu.find((f) => (f.details as { pattern: string }).pattern === 'missing-withdrawal')?.requirementId).toBe('gdpr.art7.3');
    expect(eu.find((f) => (f.details as { pattern: string }).pattern === 'missing-purposes')?.requirementId).toBe('eprivacy.art5.3');
    expect(patterns(run('consent.required-strings', [timeline('uk', [[BANNER_DESIGN_LABEL, thin]])]))).toContain('missing-withdrawal');
    // Non-English text: not judged (the collector notes it as not tested).
    expect(run('consent.required-strings', [timeline('de', [[BANNER_DESIGN_LABEL, goodFirst({ text: 'Wir verwenden Cookies.', links: [] })]])])).toEqual([]);
    // California: the opt-out link's label.
    const ca = (text: string) => run('consent.required-strings', [timeline('ca', [[BANNER_DESIGN_LABEL, goodFirst({ found: false, controls: [], optOutLinks: [{ text, inFooter: true }] })]])]);
    expect(patterns(ca('Do Not Sell My Info'))).toEqual(['non-statutory-opt-out-label']);
    expect(ca('Do Not Sell or Share My Personal Information')).toEqual([]);
    expect(ca('Your Privacy Choices')).toEqual([]);
  });

  it('withdrawal control after a choice', () => {
    const none = { choice: 'accept', bannerVisible: false, controls: [] };
    expect(patterns(run('consent.withdrawal-control', [timeline('de', [[BANNER_AFTER_CHOICE_LABEL, none]], { scenario: 'accept' })]))).toEqual(['no-control']);
    expect(patterns(run('consent.withdrawal-control', [timeline('de', [[BANNER_AFTER_CHOICE_LABEL, { ...none, api: 'OneTrust.ToggleInfoDisplay' }]], { scenario: 'accept' })]))).toEqual(['api-only']);
    // The withdraw scenario already reported "no entry point" (tracking.withdrawal): not repeated.
    const withdrawTl = timeline('de', [], { scenario: 'withdraw', extra: [{ type: 'choice', t: 5, choice: 'withdraw', ok: false, method: 'reopen:none', note: 'no way to reopen the consent settings was found', pageIndex: 0 }] });
    expect(run('consent.withdrawal-control', [timeline('de', [[BANNER_AFTER_CHOICE_LABEL, none]], { scenario: 'accept' }), withdrawTl])).toEqual([]);
    expect(run('consent.withdrawal-control', [timeline('ca', [[BANNER_AFTER_CHOICE_LABEL, none]], { scenario: 'reject' })])).toEqual([]);
  });
});

// --- Browser: the readers over fixture pages -------------------------------------

let chromiumAvailable = false;
try {
  const { chromium } = await import('playwright');
  chromiumAvailable = fs.existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}
const browserSuite = chromiumAvailable ? describe : describe.skip;

async function readFixture(page: Page, html: string, opts: { click?: 'accept' | 'reject' } = {}): Promise<Array<[string, unknown]>> {
  await page.setContent(html, { waitUntil: 'load' });
  const first = await readFirstLayer(page);
  const out: Array<[string, unknown]> = [[BANNER_DESIGN_LABEL, first]];
  const second = await readSecondLayer(page, false);
  if (second.toggles.length) out.push([BANNER_SECOND_LAYER_LABEL, second]);
  if (opts.click) {
    await page.click(`[data-complykit-banner="${opts.click}"]`);
    await page.waitForTimeout(100);
    out.push([BANNER_AFTER_CHOICE_LABEL, await readAfterChoice(page, opts.click)]);
  }
  return out;
}
const fixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

browserSuite('banner readers over fixture pages', () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  });
  afterAll(async () => browser?.close());

  it('equal-pass: symmetrical banner with footer settings link — no findings', async () => {
    const r = await readFixture(page, fixture('equal-pass.html'), { click: 'accept' });
    const first = r[0][1] as { found: boolean; source: string; controls: unknown[] };
    expect(first.found).toBe(true);
    expect(first.source).toBe('heuristic');
    expect(first.controls).toHaveLength(3);
    expect(all([timeline('de', r)])).toEqual(Object.fromEntries(RULES.map((x) => [x, []])));
  });

  it('equal-fail: big filled accept, small pale reject link', async () => {
    const r = await readFixture(page, fixture('equal-fail.html'));
    expect(patterns(run('consent.equal-prominence', [timeline('de', r)]))).toEqual(['emphasis', 'reject-low-contrast', 'size']);
  });

  it('wall-no-reject: blocking veil, accept + settings only, "must accept" wording', async () => {
    const r = await readFixture(page, fixture('wall-no-reject.html'));
    const first = r[0][1] as { blocking: { covered: number; scrollLocked: boolean } };
    expect(first.blocking.covered).toBeGreaterThan(0.8);
    expect(first.blocking.scrollLocked).toBe(true);
    const tl = timeline('de', r);
    expect(patterns(run('consent.no-cookie-wall', [tl]))).toEqual(['blocking-without-reject']);
    expect(patterns(run('consent.equal-prominence', [tl]))).toEqual(['no-reject-first-layer']);
  });

  it('modal-with-reject: blocking until a choice, equal reject, page usable after reject — no cookie-wall finding', async () => {
    const r = await readFixture(page, fixture('modal-with-reject.html'), { click: 'reject' });
    expect(run('consent.no-cookie-wall', [timeline('de', r)])).toEqual([]);
  });

  it('wall-after-reject: still blocked after rejecting', async () => {
    const r = await readFixture(page, fixture('wall-after-reject.html'), { click: 'reject' });
    const f = run('consent.no-cookie-wall', [timeline('de', r)]);
    expect(patterns(f)).toEqual(['blocked-after-reject']);
    expect(f[0].confidence).toBe('violation');
  });

  it('preticked: hidden settings read from the DOM — fail and pass', async () => {
    const fail = await readFixture(page, fixture('preticked-fail.html'));
    const f = run('consent.no-pre-ticked', [timeline('de', fail)]);
    expect(patterns(f)).toEqual(['pre-ticked']);
    expect((f[0].details as { toggles: Array<{ label: string }> }).toggles.map((t) => t.label)).toEqual(['Analytics', 'Marketing']);
    expect(run('consent.no-pre-ticked', [timeline('de', await readFixture(page, fixture('preticked-pass.html')))])).toEqual([]);
  });

  it('strings-fail: missing purposes, withdrawal and further information (EU); non-statutory link label (CA)', async () => {
    const r = await readFixture(page, fixture('strings-fail.html'));
    expect(patterns(run('consent.required-strings', [timeline('de', r)]))).toEqual(['missing-further-information', 'missing-purposes', 'missing-withdrawal']);
    expect(patterns(run('consent.required-strings', [timeline('ca', r)]))).toEqual(['non-statutory-opt-out-label']);
  });

  it('withdrawal: none after accepting vs a footer "Cookie settings" link', async () => {
    const none = await readFixture(page, fixture('withdrawal-none.html'), { click: 'accept' });
    expect(patterns(run('consent.withdrawal-control', [timeline('de', none, { scenario: 'accept' })]))).toEqual(['no-control']);
    const footer = await readFixture(page, fixture('withdrawal-footer.html'), { click: 'accept' });
    expect(run('consent.withdrawal-control', [timeline('de', footer, { scenario: 'accept' })])).toEqual([]);
  });

  it('a page with no banner: found=false, no findings', async () => {
    const r = await readFixture(page, '<main><h1>Plain page</h1></main>');
    expect((r[0][1] as { found: boolean }).found).toBe(false);
    expect(all([timeline('de', r)])).toEqual(Object.fromEntries(RULES.map((x) => [x, []])));
  });
});

// --- Our own banner (client/dist) ---------------------------------------------------

const CLIENT_DIST = path.join(here, '..', 'client', 'dist');
const CLIENT_IIFE = path.join(CLIENT_DIST, 'complykit-consent.js');
const CLIENT_UI = path.join(CLIENT_DIST, 'complykit-consent-ui.js');
const clientBuilt = fs.existsSync(CLIENT_IIFE) && fs.existsSync(CLIENT_UI);
// F5: our banner is read and judged in every engine (the readers are plain
// page.evaluate / click, no CDP), so a layout or <dialog> quirk in Firefox or
// WebKit that breaks a rule fails here. The fixture-page readers above stay
// Chromium: they test the readers, which run in Chromium in a scan.
const engines = await engineAvailability();

const clientConfig = (layout: string, regime: string): unknown => {
  const c = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'consent-config', 'example.json'), 'utf8'));
  c.regimeSource = { kind: 'fixed', regime };
  c.consent = { lifetimeDays: 365 };
  delete c.record;
  c.layout = layout;
  return c;
};
const clientPage = (layout: string, regime: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Banner design fixture</title>
<script type="application/json" id="complykit-config">${JSON.stringify(clientConfig(layout, regime))}</script>
<script src="/complykit-consent.js"></script>
</head><body>
<header><a href="/">Example shop</a></header>
<main><h1>Example shop</h1><p style="min-height:1400px">Plain page content for the banner to sit over.</p></main>
<footer><p>Footer</p></footer>
</body></html>`;

for (const engine of ENGINE_NAMES) {
  const clientSuite = engines[engine] && clientBuilt ? describe : describe.skip;
  clientSuite(`our own banner passes every banner rule (${engine})`, () => {
    let server: http.Server;
    let base: string;
    let browser: Browser;
    const PAGES: Record<string, string> = {
      '/bar': clientPage('bar', 'opt-in'),
      '/modal': clientPage('modal', 'opt-in'),
      '/box-ca': clientPage('box', 'opt-out-signal'),
    };
    beforeAll(async () => {
      server = http.createServer((req, res) => {
        const p = new URL(req.url ?? '/', 'http://x').pathname;
        if (p === '/complykit-consent.js' || p === '/complykit-consent-ui.js') {
          res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
          res.end(fs.readFileSync(p === '/complykit-consent.js' ? CLIENT_IIFE : CLIENT_UI));
        } else if (PAGES[p]) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(PAGES[p]);
        } else {
          res.writeHead(404).end();
        }
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      browser = await launchEngine(engine);
    });
    afterAll(async () => {
      await browser?.close();
      await new Promise<void>((r) => server.close(() => r()));
    });

    for (const [route, place] of [['/bar', 'de'], ['/modal', 'uk'], ['/box-ca', 'ca']] as const) {
      it(`${route} (${place}): read by exact selectors, zero findings`, async () => {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        try {
          await page.goto(`${base}${route}`);
          await page.waitForSelector('.ck-banner [data-ck-action=accept]', { state: 'visible' });
          const first = await readFirstLayer(page);
          expect(first.source).toBe('complykit');
          expect(first.complykit).toBe(true);
          expect(first.controls.map((c) => c.role).sort()).toEqual(['accept', 'manage', 'reject']);
          if (route === '/modal') expect(first.blocking?.inert).toBe(true);
          const second = await readSecondLayer(page, true);
          expect(second.source).toBe('complykit');
          expect(second.toggles.length).toBeGreaterThan(0);
          // Close the settings layer again, then accept on the first layer.
          await page.evaluate(() => (document.querySelector('.ck-settings [data-ck-action=close]') as HTMLElement | null)?.click());
          await page.click('.ck-banner [data-ck-action=accept]');
          await page.waitForSelector('.ck-choices', { state: 'visible' });
          const after = await readAfterChoice(page, 'accept');
          expect(after.controls.some((c) => c.via === 'complykit')).toBe(true);
          const tl = timeline(place, [
            [BANNER_DESIGN_LABEL, first],
            [BANNER_SECOND_LAYER_LABEL, second],
            [BANNER_AFTER_CHOICE_LABEL, after],
          ]);
          const findings = all([tl]);
          expect(findings).toEqual(Object.fromEntries(RULES.map((x) => [x, []])));
        } finally {
          await page.close();
        }
      }, 60_000);
    }
  });
}
