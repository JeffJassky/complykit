import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withConsentConfigHash, type ConsentToolConfig, type ConsentToolConfigInput } from '../../src/record/index.js';

// A storefront with complykit's OWN consent tool installed (D10 "done when").
// Serves the BUILT client (client/dist: core + UI file) on www.proof-shop.test and two
// vendors on *.test hosts (Chromium maps them to 127.0.0.1):
//
//   adpixel.test/ads.js   — gated correctly: <script type="text/plain"
//                           data-category="advertising" data-src=…>; the tool
//                           releases it on consent. Sets a cookie, pings back.
//   stats.test/s.js       — the DELIBERATELY ungated vendor: the config lists it
//                           under analytics with a gate rule, but its tag was
//                           never rewritten, so the browser runs it on load.
//
// Three pages, one per situation the rescan must call out:
//   /            the generated config, but the workspace holds a NEWER one (stale)
//   /refused     the same config with version "2.0": the tool refuses it
//   /after-gtm   a GTM container "already loaded" before the tool (load order)

const here = path.dirname(fileURLToPath(import.meta.url));
export const CLIENT_DIST = path.join(here, '..', '..', 'client', 'dist');
export const CLIENT_CORE = path.join(CLIENT_DIST, 'complykit-consent.js');
export const CLIENT_UI = path.join(CLIENT_DIST, 'complykit-consent-ui.js');
export const clientBuilt = (): boolean => fs.existsSync(CLIENT_CORE) && fs.existsSync(CLIENT_UI);

/** The store's host (Chromium maps *.test to 127.0.0.1); its registrable domain is proof-shop.test. */
export const SHOP_HOST = 'www.proof-shop.test';

export interface ProofSite {
  port: number;
  url: string;
  launchArgs: string[];
  hits: string[];
  /** The config the pages carry (hash stamped). */
  config: ConsentToolConfig;
  /** A newer config "in the workspace" (another run, another hash, one setting changed). */
  workspaceConfig: ConsentToolConfig;
  close(): Promise<void>;
}

/** The config a scan of this site would generate: fixed opt-in, two vendors, one gate rule each, a GTM section. */
export function proofConfigInput(site: string, port: number, at = '2026-10-06T10:00:00.000Z', runId = 'run-a'): Omit<ConsentToolConfigInput, 'hash'> {
  return {
    version: '1.0',
    generatedFrom: { runId, at, site, complykit: '0.0.0-test' },
    regimeSource: { kind: 'fixed', regime: 'opt-in' },
    categories: [
      { id: 'necessary', label: 'Necessary', description: 'Required for the site to work.', defaultByRegime: { 'opt-in': true, 'opt-out-signal': true, 'opt-out': true } },
      { id: 'analytics', label: 'Analytics', description: 'How the site is used.', defaultByRegime: { 'opt-in': false, 'opt-out-signal': true, 'opt-out': true } },
      { id: 'advertising', label: 'Advertising', description: 'Ads and measurement.', defaultByRegime: { 'opt-in': false, 'opt-out-signal': false, 'opt-out': true } },
    ],
    vendors: [
      { id: 'fixture.ads', label: 'Fixture Ads', category: 'advertising', control: 'gate', stores: [{ name: '^_fa$', kind: 'cookie' }] },
      { id: 'fixture.stats', label: 'Fixture Stats', category: 'analytics', control: 'gate', stores: [{ name: '^_fs$', kind: 'cookie' }] },
    ],
    gate: [
      { category: 'advertising', src: `adpixel\\.test:${port}/ads\\.js`, vendor: 'fixture.ads' },
      { category: 'analytics', src: `stats\\.test:${port}/s\\.js`, vendor: 'fixture.stats' },
    ],
    gtm: { containers: ['GTM-XXXX01'], dataLayer: 'dataLayer', consentMode: { analytics_storage: 'analytics', ad_storage: 'advertising', ad_user_data: 'advertising', ad_personalization: 'advertising' }, tags: [] },
    platform: 'none',
    theme: {},
    strings: {},
    consent: { lifetimeDays: 365 },
    layout: 'bar',
  };
}

const page = (config: unknown, port: number, title: string, opts: { beforeTool?: string } = {}): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
${opts.beforeTool ?? ''}
<script type="application/json" id="complykit-config">${JSON.stringify(config)}</script>
<script src="/complykit-consent.js"></script>
<script type="text/plain" data-category="advertising" data-src="http://adpixel.test:${port}/ads.js"></script>
<script src="http://stats.test:${port}/s.js"></script>
</head><body>
<header><a href="/">Home</a> <a href="/products/thing">A thing</a></header>
<main><h1>${title}</h1><p>Plain page content for the banner to sit over.</p></main>
<footer><p>Footer</p></footer>
</body></html>`;

const vendorScript = (host: string, cookie: string, port: number): string =>
  `(function(){ var m=document.cookie.match(/(?:^|; )${cookie}=([^;]+)/); var id=m?m[1]:Math.random().toString(36).slice(2); document.cookie='${cookie}='+id+'; max-age='+(400*86400)+'; path=/'; new Image().src='http://${host}:${port}/p?id='+id+'&u='+encodeURIComponent(location.href); })();`;

export async function startProofSite(registrableDomain: string): Promise<ProofSite> {
  const hits: string[] = [];
  let port = 0;
  let routes: Record<string, { type: string; body: string }> = {};
  let config!: ConsentToolConfig;
  let workspaceConfig!: ConsentToolConfig;
  const server = http.createServer((req, res) => {
    const hostHeader = (req.headers.host ?? '').split(':')[0];
    const host = hostHeader === SHOP_HOST ? 'shop' : hostHeader;
    const pathOnly = (req.url ?? '/').split('?')[0];
    hits.push(`${hostHeader}${req.url}`);
    const route = routes[`${host}${pathOnly}`];
    if (!route) {
      res.writeHead(host === 'shop' ? 404 : 204, { 'access-control-allow-origin': '*' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': route.type, 'access-control-allow-origin': '*' });
    res.end(route.body);
  });
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  port = (server.address() as { port: number }).port;
  config = withConsentConfigHash(proofConfigInput(registrableDomain, port));
  // Another run that also changed a setting: a regeneration with identical settings is not 'behind'.
  workspaceConfig = withConsentConfigHash({ ...proofConfigInput(registrableDomain, port, '2026-10-07T10:00:00.000Z', 'run-b'), layout: 'box' });
  const refused = { ...config, version: '2.0' };
  const js = 'application/javascript';
  const main = page(config, port, 'Proof shop');
  routes = {
    'shop/': { type: 'text/html', body: main },
    'shop/products/thing': { type: 'text/html', body: page(config, port, 'A thing') },
    'shop/refused': { type: 'text/html', body: page(refused, port, 'Refused config') },
    // GTM "already running" above the tool: the container object and the gtm.js event are there before the defaults.
    'shop/after-gtm': { type: 'text/html', body: page(config, port, 'Tool after GTM', { beforeTool: `<script>window.dataLayer=[{event:'gtm.js','gtm.start':1}];window.google_tag_manager={'GTM-XXXX01':{}};</script>` }) },
    'shop/complykit-consent.js': { type: js, body: fs.readFileSync(CLIENT_CORE, 'utf8') },
    'shop/complykit-consent-ui.js': { type: js, body: fs.readFileSync(CLIENT_UI, 'utf8') },
    'adpixel.test/ads.js': { type: js, body: vendorScript('adpixel.test', '_fa', port) },
    'stats.test/s.js': { type: js, body: vendorScript('stats.test', '_fs', port) },
  };
  return {
    port,
    url: `http://${SHOP_HOST}:${port}/`,
    launchArgs: ['--host-resolver-rules=MAP *.test 127.0.0.1'],
    hits,
    config,
    workspaceConfig,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
