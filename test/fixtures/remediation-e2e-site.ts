import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

// The storefront the remediation e2e (test/remediation-e2e.test.ts) scans,
// fixes step by step, and rescans. Generic, invented ids only.
//
//   http://shop.example-e2e.test/   the store (plain HTTP server on 127.0.0.1)
//   https://<anything else>/         one TLS server (a throwaway self-signed
//                                    certificate; Chrome runs with
//                                    --ignore-certificate-errors) plays every
//                                    third party AND the two geolocation
//                                    sources, which answer "Germany" — so the
//                                    scan's one location verifies as EU
//                                    without the network.
//
// Chrome reaches both through --host-resolver-rules (see launchArgs): the
// store's host maps to the HTTP port, everything else to the TLS port.
//
// What the home page carries before any fix, each one a checklist item:
//   - a GTM-less gtag.js snippet (Google Analytics 4, G-E2ETEST001)
//   - a Meta-pixel-like script (connect.facebook.net/…/fbevents.js) and its
//     <noscript><img> leak (www.facebook.com/tr …&noscript=1)
//   - a YouTube iframe embed
//   - an existing consent tool's script (OneTrust-like, cdn.cookielaw.org)
//   - an unrecognized widget (cdn.e2e-widgets.test) that stores an id and
//     sends it with the page address — classified by the test via the workspace
//
// `state` is the site owner's hands: the test flips it as it follows the
// checklist (install the snippet + serve the client files at /complykit/v1/,
// remove the old tool, rewrite the tags, remove the leak), and every request
// is served from the current state.

export const SHOP_HOST = 'shop.example-e2e.test';
export const SITE = 'example-e2e.test';
export const GA_ID = 'G-E2ETEST001';
const PIXEL_ID = '100000000000001';

export const GTAG_SRC = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
export const PIXEL_SRC = 'https://connect.facebook.net/en_US/fbevents.js';
export const LEAK_SRC = `https://www.facebook.com/tr?id=${PIXEL_ID}&ev=PageView&noscript=1`;
export const WIDGET_SRC = 'https://cdn.e2e-widgets.test/w.js';
export const OLD_TOOL_SRC = 'https://cdn.cookielaw.org/scripttemplates/otSDKStub.js';
export const EMBED_SRC = 'https://www.youtube.com/embed/e2evideo001';

export interface SiteState {
  /** Part 1 of the generated snippet, pasted first in <head>. */
  head?: string;
  /** The client files from the install zip, served at /complykit/v1/. */
  clientFiles: Record<string, string>;
  oldToolRemoved: boolean;
  /** Held (rewritten) tags: script src (or 'inline:gtag' for the inline gtag config) → the data-category the checklist asks for. */
  held: Record<string, string>;
  leakRemoved: boolean;
}

export interface E2eSite {
  url: string;
  state: SiteState;
  /** Chromium flags for the scanner and verify-change (COMPLYKIT_BROWSER_ARGS). */
  launchArgs: string[];
  /** Every request seen: `host path`. */
  hits: string[];
  html(): string;
  close(): Promise<void>;
}

const vendorJs = (cookie: string, ping: string): string =>
  `(function(){var m=document.cookie.match(/(?:^|; )${cookie}=([^;]+)/);var id=m?m[1]:Math.random().toString(36).slice(2);document.cookie='${cookie}='+id+'; max-age='+(390*86400)+'; path=/';new Image().src='${ping}'+(('${ping}'.indexOf('?')<0)?'?':'&')+'cid='+id+'&dl='+encodeURIComponent(location.href);})();`;

/** A script tag as the site has it, or held (type="text/plain", the tool releases it). */
function scriptTag(src: string, state: SiteState, attrs = ''): string {
  const cat = state.held[src];
  return cat ? `<script type="text/plain" data-category="${cat}" data-src="${src}"${attrs}></script>` : `<script${attrs} src="${src}"></script>`;
}

export function pageHtml(state: SiteState, title = 'E2E shop'): string {
  const gtagInline = `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${GA_ID}');`;
  const gaCat = state.held['inline:gtag'];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
${state.head ?? ''}
${state.oldToolRemoved ? '' : `<script src="${OLD_TOOL_SRC}" data-domain-script="00000000-0000-0000-0000-000000000000"></script>`}
${scriptTag(GTAG_SRC, state, ' async')}
${gaCat ? `<script type="text/plain" data-category="${gaCat}">${gtagInline}</script>` : `<script>${gtagInline}</script>`}
${scriptTag(PIXEL_SRC, state, ' async')}
${scriptTag(WIDGET_SRC, state, ' async')}
</head><body>
<header><a href="/">Home</a> <a href="/products/thing">A thing</a></header>
<main><h1>${title}</h1><p>Plain page content for a banner to sit over.</p>
<iframe src="${EMBED_SRC}" width="320" height="180" title="Product video"></iframe>
</main>
${state.leakRemoved ? '' : `<noscript><img height="1" width="1" style="display:none" alt="" src="${LEAK_SRC}"></noscript>`}
<footer><p>Footer</p></footer>
</body></html>`;
}

function selfSigned(): { key: Buffer; cert: Buffer; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'complykit-e2e-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '2', '-subj', '/CN=complykit-e2e'], { stdio: 'ignore' });
  return { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')), dir };
}

/** True when openssl can make the throwaway certificate. */
export function opensslAvailable(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export async function startE2eSite(): Promise<E2eSite> {
  const hits: string[] = [];
  const state: SiteState = { clientFiles: {}, oldToolRemoved: false, held: {}, leakRemoved: false };
  const js = 'application/javascript';

  const shop = http.createServer((req, res) => {
    const p = (req.url ?? '/').split('?')[0];
    hits.push(`${req.headers.host} ${req.url}`);
    if (p === '/' || p === '/products/thing') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(pageHtml(state, p === '/' ? 'E2E shop' : 'A thing'));
      return;
    }
    const file = p.startsWith('/complykit/v1/') ? state.clientFiles[p.slice('/complykit/v1/'.length)] : undefined;
    if (file !== undefined) {
      res.writeHead(200, { 'content-type': js, 'cache-control': 'no-store' });
      res.end(file);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  const tls = selfSigned();
  const vendors = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    const host = (req.headers.host ?? '').split(':')[0];
    const p = (req.url ?? '/').split('?')[0];
    hits.push(`${host} ${req.url}`);
    const send = (type: string, body: string) => {
      res.writeHead(200, { 'content-type': type, 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
      res.end(body);
    };
    if (host === 'ipinfo.io') return send('application/json', JSON.stringify({ ip: '198.51.100.7', city: 'Berlin', region: 'Berlin', country: 'DE', org: 'AS64500 Example' }));
    if (host === 'ipwho.is') return send('application/json', JSON.stringify({ success: true, ip: '198.51.100.7', country_code: 'DE', region_code: 'BE', region: 'Berlin', city: 'Berlin', connection: { org: 'Example' } }));
    if (host === 'www.googletagmanager.com' && p === '/gtag/js') return send(js, vendorJs('_ga', `https://www.google-analytics.com/g/collect?v=2&tid=${GA_ID}&en=page_view`));
    if (host === 'connect.facebook.net') return send(js, vendorJs('_fbp', `https://www.facebook.com/tr?id=${PIXEL_ID}&ev=PageView`));
    if (host === 'cdn.e2e-widgets.test') return send(js, vendorJs('_e2ew', 'https://collect.e2e-widgets.test/c'));
    if (host === 'cdn.cookielaw.org') return send(js, '/* an existing consent tool: shows nothing in this fixture */');
    if (host === 'www.youtube.com') return send('text/html', '<!doctype html><title>video</title><p>video</p>');
    // Pixels, collect endpoints, anything else: an empty answer.
    res.writeHead(204, { 'access-control-allow-origin': '*' });
    res.end();
  });

  await new Promise<void>((r) => shop.listen(0, '127.0.0.1', () => r()));
  await new Promise<void>((r) => vendors.listen(0, '127.0.0.1', () => r()));
  const shopPort = (shop.address() as { port: number }).port;
  const tlsPort = (vendors.address() as { port: number }).port;
  return {
    url: `http://${SHOP_HOST}/`,
    state,
    launchArgs: [
      `--host-resolver-rules=MAP ${SHOP_HOST} 127.0.0.1:${shopPort}, MAP * 127.0.0.1:${tlsPort}, EXCLUDE localhost, EXCLUDE 127.0.0.1`,
      '--ignore-certificate-errors',
      // The geolocation lookups run from about:blank to "public" hosts that resolve to 127.0.0.1.
      '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessChecks',
    ],
    hits,
    html: () => pageHtml(state),
    close: async () => {
      const closing = Promise.all([new Promise<void>((r) => shop.close(() => r())), new Promise<void>((r) => vendors.close(() => r()))]);
      shop.closeAllConnections();
      vendors.closeAllConnections();
      await closing;
      fs.rmSync(tls.dir, { recursive: true, force: true });
    },
  };
}
