import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyChange, verifySpecOf, containerUrlOf } from '../src/remediation-verify.js';
import { openVerifyBrowser, type VerifyBrowser } from '../src/collect/browser/evaluation/verify-change.js';
import { cmdVerifyChange } from '../src/cli/commands/verify-change.js';
import { renderHeadSnippet } from '../src/remediation.js';
import { rewriteContainerConsent } from '../src/rules/tracking/gtm.js';
import { withConsentConfigHash, type ConsentToolConfig, type RemediationVerifySpec } from '../src/record/index.js';
import { proofConfigInput, clientBuilt, CLIENT_CORE, CLIENT_UI } from './fixtures/proof-site.js';

// R4: `complykit verify-change` — fetch ONE thing (a page's served HTML, a
// published container, or a one-page reject-then-accept visit) and run the pure
// checker on it. Against a fixture site served locally (*.test mapped to
// 127.0.0.1); the spot check runs the BUILT client (client/dist).
//
// Skips without a browser (Playwright's Chromium, or COMPLYKIT_BROWSER_CHANNEL).

const here = path.dirname(fileURLToPath(import.meta.url));
const GTM_SOURCE = fs.readFileSync(path.join(here, 'fixtures/gtm/GTM-XXXX01.js'), 'utf8');

let chromiumAvailable = false;
try {
  const { chromium } = await import('playwright');
  chromiumAvailable = fs.existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}
const hasBrowser = chromiumAvailable || !!process.env.COMPLYKIT_BROWSER_CHANNEL;
const suite = hasBrowser ? describe : describe.skip;
const spotSuite = hasBrowser && clientBuilt() ? describe : describe.skip;

const SHOP = 'www.verify-shop.test';
const LAUNCH_ARGS = ['--host-resolver-rules=MAP *.test 127.0.0.1'];

interface Site {
  port: number;
  base: string;
  routes: Map<string, { type: string; body: string; status?: number; headers?: Record<string, string> }>;
  config: ConsentToolConfig;
  close(): Promise<void>;
}

const doc = (head: string[], body: string[] = []): string =>
  `<!doctype html>\n<html lang="en"><head>\n<meta charset="utf-8">\n${head.join('\n')}\n<title>Verify shop</title>\n</head><body>\n<main><h1>Verify shop</h1><p>Content.</p></main>\n${body.join('\n')}\n</body></html>`;

const vendorScript = (host: string, cookie: string, port: number): string =>
  `(function(){ document.cookie='${cookie}=1; path=/'; new Image().src='http://${host}:${port}/p?u='+encodeURIComponent(location.href); })();`;

async function startSite(): Promise<Site> {
  const routes = new Map<string, { type: string; body: string; status?: number; headers?: Record<string, string> }>();
  const server = http.createServer((req, res) => {
    const hostHeader = (req.headers.host ?? '').split(':')[0];
    const host = hostHeader === SHOP ? 'shop' : hostHeader;
    const route = routes.get(`${host}${(req.url ?? '/').split('?')[0]}`);
    if (!route) {
      res.writeHead(host === 'shop' || host === '127.0.0.1' ? 404 : 204, { 'access-control-allow-origin': '*' });
      res.end();
      return;
    }
    res.writeHead(route.status ?? 200, { 'content-type': route.type, 'access-control-allow-origin': '*', ...(route.headers ?? {}) });
    res.end(route.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const config = withConsentConfigHash(proofConfigInput('verify-shop.test', port));
  const head = renderHeadSnippet(config, '/complykit-consent.js');
  const GTAG = `<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXX01"></script>`;
  const stats = `<script src="http://stats.test:${port}/s.js"></script>`;
  const statsHeld = `<script type="text/plain" data-category="analytics" data-src="http://stats.test:${port}/s.js"></script>`;
  const adsHeld = `<script type="text/plain" data-category="advertising" data-src="http://adpixel.test:${port}/ads.js"></script>`;
  const js = 'application/javascript';
  const html = (head: string[], body: string[] = []) => ({ type: 'text/html', body: doc(head, body) });
  routes.set('shop/install', html([head, GTAG]));
  routes.set('shop/no-install', html([GTAG]));
  routes.set('shop/after-gtm', html([GTAG, head]));
  routes.set('shop/not-rewritten', html([stats]));
  routes.set('shop/rewritten', html([statsHeld]));
  routes.set('shop/leak', html([], [`<noscript><img height="1" width="1" src="http://px.test:${port}/tr?id=1&ev=PageView"></noscript>`]));
  routes.set('shop/no-leak', html([]));
  // A bot manager's interstitial instead of the page (synthetic): 403, its header, its title.
  const challenge = { type: 'text/html', status: 403, headers: { 'cf-mitigated': 'challenge' }, body: '<!doctype html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={};</script></body></html>' };
  routes.set('shop/challenge', challenge);
  // The same interstitial with a 200 and no header (the markup alone decides).
  routes.set('shop/challenge-200', { type: 'text/html', body: challenge.body });
  routes.set('shop/gone', { type: 'text/html', body: '<!doctype html><title>gone</title>', status: 404 });
  // The tool installed; one vendor gated (adpixel), one deliberately not (stats).
  routes.set('shop/tool', html([head, adsHeld, stats]));
  routes.set('shop/complykit-consent.js', { type: js, body: clientBuilt() ? fs.readFileSync(CLIENT_CORE, 'utf8') : '' });
  routes.set('shop/complykit-consent-ui.js', { type: js, body: clientBuilt() ? fs.readFileSync(CLIENT_UI, 'utf8') : '' });
  routes.set('adpixel.test/ads.js', { type: js, body: vendorScript('adpixel.test', '_fa', port) });
  routes.set('stats.test/s.js', { type: js, body: vendorScript('stats.test', '_fs', port) });
  // The container is fetched outside the page (Node's resolver, not Chromium's): served on 127.0.0.1.
  routes.set('127.0.0.1/gtm.js', { type: js, body: GTM_SOURCE });
  return {
    port,
    base: `http://${SHOP}:${port}/`,
    routes,
    config,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('verify-change input and budgets (no browser)', () => {
  const spec: RemediationVerifySpec = { check: 'remove-leak', method: 'static', page: 'https://example.com/', element: { kind: 'img', context: 'noscript', host: 'px.example', path: '/tr', ids: [] } };

  it('takes a task (its verify) or a bare spec; refuses anything else', () => {
    expect(verifySpecOf(spec)).toEqual({ spec });
    expect(verifySpecOf({ id: 'remove-leak:abc', verify: spec })).toEqual({ spec, id: 'remove-leak:abc' });
    expect(verifySpecOf({ verify: { check: 'nope' } })).toMatchObject({ error: expect.stringContaining('not a usable verify spec') });
    expect(verifySpecOf('x')).toMatchObject({ error: expect.any(String) });
  });

  it('names the published container when the spec has no URL', () => {
    expect(containerUrlOf({ check: 'gtm-tag-consent', method: 'static', containerId: 'GTM-XXXX01', tagId: 4, consentTypes: [] })).toBe('https://www.googletagmanager.com/gtm.js?id=GTM-XXXX01');
  });

  it('manual: never fetches, always cannot-verify', async () => {
    const out = await verifyChange({ check: 'manual', method: 'manual', reason: 'a DNS change' }, { now: () => new Date('2026-10-07T12:00:00Z') });
    expect(out).toEqual({ result: 'cannot-verify', message: 'cannot be checked from outside: a DNS change', evidence: [], at: '2026-10-07T12:00:00.000Z', check: 'manual' });
  });

  it('a fetch that outlives the budget is cannot-verify, never a pass', async () => {
    const slow: VerifyBrowser = {
      version: 'fake',
      fetchHtml: () => new Promise(() => {}),
      fetchContainer: () => new Promise(() => {}),
      spotCheck: () => new Promise(() => {}),
      close: async () => {},
    };
    const out = await verifyChange(spec, { browser: slow, staticBudgetMs: 50 });
    expect(out).toMatchObject({ result: 'cannot-verify', message: expect.stringContaining('ran out of time after 0 s') });
  });
});

suite('verify-change against a fixture site (static checks)', () => {
  let site: Site;
  let browser: VerifyBrowser;
  const run = (spec: RemediationVerifySpec) => verifyChange(spec, { browser });
  const page = (p: string) => `${site.base}${p}`;
  const installSpec = (p: string, configHash = site.config.hash): RemediationVerifySpec => ({ check: 'install', method: 'static', page: page(p), configHash, scriptSrc: '/complykit-consent.js', elementId: 'complykit-config' });

  beforeAll(async () => {
    site = await startSite();
    browser = await openVerifyBrowser({ launchArgs: LAUNCH_ARGS });
  }, 60000);

  afterAll(async () => {
    await browser?.close();
    await site?.close();
  });

  it('install: present and first passes, from the served HTML', async () => {
    const out = await run(installSpec('install'));
    expect(out.result, out.message).toBe('pass');
    expect(out.evidence[0]).toBe(`served HTML of ${page('install')} (HTTP 200)`);
    expect(out.evidence).toContain(`config hash ${site.config.hash.slice(0, 12)} = latest`);
    expect(out.fetched).toMatchObject({ url: page('install'), status: 200, via: 'navigation' });
    expect(Date.parse(out.at)).not.toBeNaN();
  });

  it('install: absent, after GTM, or a stale hash fails', async () => {
    expect(await run(installSpec('no-install'))).toMatchObject({ result: 'fail', message: expect.stringContaining('no <script id="complykit-config">') });
    expect(await run(installSpec('after-gtm'))).toMatchObject({ result: 'fail', message: expect.stringContaining('loads before the consent tool') });
    expect(await run(installSpec('install', 'f'.repeat(64)))).toMatchObject({ result: 'fail', message: expect.stringContaining('not the latest generated') });
  });

  it('rewrite-tag: the held twin passes, the executable original fails', async () => {
    const element = { kind: 'script' as const, context: 'document' as const, host: 'stats.test', path: '/s.js', ids: [] };
    expect(await run({ check: 'rewrite-tag', method: 'static', page: page('rewritten'), element, category: 'analytics' })).toMatchObject({ result: 'pass' });
    expect(await run({ check: 'rewrite-tag', method: 'static', page: page('not-rewritten'), element, category: 'analytics' })).toMatchObject({ result: 'fail', message: expect.stringContaining('still executes') });
  });

  it('remove-leak: removed passes, still there fails', async () => {
    const element = { kind: 'img' as const, context: 'noscript' as const, host: 'px.test', path: '/tr', ids: [] };
    expect(await run({ check: 'remove-leak', method: 'static', page: page('no-leak'), element })).toMatchObject({ result: 'pass' });
    expect(await run({ check: 'remove-leak', method: 'static', page: page('leak'), element })).toMatchObject({ result: 'fail', message: expect.stringContaining('still in the HTML') });
  });

  it('a bot challenge instead of the page is cannot-verify, never judged — 403 with the header, or 200 by its markup', async () => {
    const out = await run(installSpec('challenge'));
    expect(out).toMatchObject({ result: 'cannot-verify', message: 'the site served a bot challenge instead of the page', fetched: { status: 403 } });
    expect(out.evidence).toEqual(['Cloudflare: cf-mitigated: challenge', `${page('challenge')} (HTTP 403)`]);
    const element = { kind: 'img' as const, context: 'noscript' as const, host: 'px.test', path: '/tr', ids: [] };
    // remove-leak would PASS on the challenge's markup (no leak in it): it must not.
    const leak = await run({ check: 'remove-leak', method: 'static', page: page('challenge-200'), element });
    expect(leak).toMatchObject({ result: 'cannot-verify', message: 'the site served a bot challenge instead of the page' });
    expect(leak.evidence[0]).toBe('Cloudflare: <title>Just a moment...</title>');
  });

  it('a page that answers 404 is cannot-verify with the status', async () => {
    const out = await run(installSpec('gone'));
    expect(out).toMatchObject({ result: 'cannot-verify', fetched: { status: 404, error: 'HTTP 404' } });
    expect(out.message).toContain('could not be fetched (HTTP 404)');
  });

  it('gtm-tag-consent: the served container with and without the requirement; unreadable is cannot-verify', async () => {
    const spec: RemediationVerifySpec = { check: 'gtm-tag-consent', method: 'static', containerId: 'GTM-XXXX01', containerUrl: `http://127.0.0.1:${site.port}/gtm.js?id=GTM-XXXX01`, tagId: 4, consentTypes: ['analytics_storage'] };
    site.routes.set('127.0.0.1/gtm.js', { type: 'application/javascript', body: GTM_SOURCE });
    expect(await run(spec)).toMatchObject({ result: 'fail', message: expect.stringContaining('no consent requirement') });
    const published = rewriteContainerConsent(GTM_SOURCE, { tags: { '4': ['analytics_storage'] } });
    site.routes.set('127.0.0.1/gtm.js', { type: 'application/javascript', body: published.source! });
    const pass = await run(spec);
    expect(pass).toMatchObject({ result: 'pass', fetched: { status: 200 } });
    expect(pass.evidence[0]).toBe(`fetched ${spec.containerUrl} (HTTP 200)`);
    expect(await run({ ...spec, containerUrl: `http://127.0.0.1:${site.port}/missing.js?id=GTM-XXXX01` })).toMatchObject({ result: 'cannot-verify', message: expect.stringContaining('could not be fetched (HTTP 404)') });
  });

  it('the CLI command: --task file, --json prints { result, message, evidence, at }', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'complykit-verify-cli-'));
    const file = path.join(dir, 'task.json');
    fs.writeFileSync(file, JSON.stringify({ id: 'install', verify: installSpec('install') }));
    const prev = process.env.COMPLYKIT_BROWSER_ARGS;
    process.env.COMPLYKIT_BROWSER_ARGS = LAUNCH_ARGS.join(' ');
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      expect(await cmdVerifyChange(['--task', file, '--json'])).toBe(0);
    } finally {
      spy.mockRestore();
      if (prev === undefined) delete process.env.COMPLYKIT_BROWSER_ARGS;
      else process.env.COMPLYKIT_BROWSER_ARGS = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const printed = JSON.parse(writes.join(''));
    expect(printed).toMatchObject({ id: 'install', check: 'install', result: 'pass', evidence: expect.any(Array), at: expect.any(String) });
  }, 30000);

  it('the CLI command refuses bad input with exit 2', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await cmdVerifyChange([])).toBe(2);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'complykit-verify-cli-'));
      const file = path.join(dir, 'task.json');
      fs.writeFileSync(file, JSON.stringify({ verify: { check: 'install' } }));
      expect(await cmdVerifyChange(['--task', file])).toBe(2);
      fs.writeFileSync(file, JSON.stringify({ config: { value: { tasks: [] } } }));
      expect(await cmdVerifyChange(['--workspace', file, '--id', 'install'])).toBe(2);
      fs.rmSync(dir, { recursive: true, force: true });
    } finally {
      err.mockRestore();
    }
  });
});

spotSuite('verify-change spot check with the built tool (client/dist)', () => {
  let site: Site;
  let browser: VerifyBrowser;
  const spot = (p: string, hosts: string[], partyId: string): RemediationVerifySpec => ({ check: 'spot-check', method: 'browser', page: `${site.base}${p}`, partyId, hosts, scenario: 'reject-then-accept' });
  const run = (spec: RemediationVerifySpec) => verifyChange(spec, { browser, bannerWaitMs: 5000, settleMs: 1200 });

  beforeAll(async () => {
    site = await startSite();
    browser = await openVerifyBrowser({ launchArgs: LAUNCH_ARGS });
  }, 60000);

  afterAll(async () => {
    await browser?.close();
    await site?.close();
  });

  it('the gated vendor passes: held after reject, ran after accept', async () => {
    const out = await run(spot('tool', ['adpixel.test'], 'fixture.ads'));
    expect(out.result, `${out.message} | ${out.evidence.join(' | ')}`).toBe('pass');
    expect(out.observation).toMatchObject({ toolPresent: true, phases: [{ scenario: 'reject', choiceMade: true }, { scenario: 'accept', choiceMade: true }] });
    expect(out.evidence).toContain('reject: complykit:click(banner reject)');
    expect(out.evidence).toContain('accept: complykit:click(banner accept)');
    const reject = out.observation!.phases[0];
    expect(reject.requests.some((r) => r.url.includes('adpixel.test'))).toBe(false);
    expect(reject.stores.some((s) => s.name === 'complykit_consent')).toBe(true);
  }, 60000);

  it('the ungated vendor fails: it ran after the reject', async () => {
    const out = await run(spot('tool', ['stats.test'], 'fixture.stats'));
    expect(out).toMatchObject({ result: 'fail', message: expect.stringContaining('after the reject') });
    expect(out.evidence.some((e) => e.includes('stats.test'))).toBe(true);
  }, 60000);

  it('a bot challenge at the landing: nothing is driven, cannot-verify', async () => {
    const out = await run(spot('challenge', ['stats.test'], 'fixture.stats'));
    expect(out).toMatchObject({ result: 'cannot-verify', message: 'the site served a bot challenge instead of the page' });
    expect(out.evidence[0]).toBe('Cloudflare: cf-mitigated: challenge');
    expect(out.observation!.phases).toEqual([expect.objectContaining({ scenario: 'reject', choiceMade: false })]);
  }, 60000);

  it('without complykit’s tool on the page nothing is clicked: cannot-verify', async () => {
    const out = await run(spot('not-rewritten', ['stats.test'], 'fixture.stats'));
    expect(out).toMatchObject({ result: 'cannot-verify', message: expect.stringContaining('not on the page'), observation: { toolPresent: false } });
    expect(out.observation!.phases).toHaveLength(1);
  }, 60000);
});
