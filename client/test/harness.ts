import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit, type Browser, type BrowserType } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, 'fixtures');
export const DIST = path.join(here, '..', 'dist');

// Engine under test (F5). The suite runs once per engine: CK_BROWSER=chromium
// (default) | firefox | webkit. `npm run test:engines` loops all three.
const ENGINES: Record<string, BrowserType> = { chromium, firefox, webkit };
export const ENGINE = process.env.CK_BROWSER ?? 'chromium';
if (!ENGINES[ENGINE]) throw new Error(`CK_BROWSER must be chromium, firefox or webkit (got ${ENGINE})`);

/** Launch the engine under test. COMPLYKIT_BROWSER_CHANNEL=chrome|msedge drives an installed browser for chromium (no Playwright download). */
export function launchBrowser(): Promise<Browser> {
  const channel = ENGINE === 'chromium' ? process.env.COMPLYKIT_BROWSER_CHANNEL || undefined : undefined;
  return ENGINES[ENGINE].launch(channel ? { channel } : {});
}

// The key that walks the tab order. WebKit on macOS follows Safari's default
// ("Press Tab to highlight each item" off): plain Tab skips buttons and links,
// Option+Tab visits them. WebKit on Linux (CI) and the other engines use Tab.
const ALT_TAB = ENGINE === 'webkit' && process.platform === 'darwin';
export const TAB = ALT_TAB ? 'Alt+Tab' : 'Tab';
export const SHIFT_TAB = ALT_TAB ? 'Alt+Shift+Tab' : 'Shift+Tab';

// URL path -> file. Fixture pages and fake third parties are served from
// test/fixtures; the built IIFE is served from dist/ at /complykit-consent.js.
const ROUTES: Record<string, string> = {
  '/vendor/fake-vendor.js': path.join(FIXTURES, 'fake-vendor.js'),
  '/vendor/analytics.js': path.join(FIXTURES, 'analytics.js'),
  '/gtm/gtm.js': path.join(FIXTURES, 'fake-gtm.js'),
  '/complykit-consent.js': path.join(DIST, 'complykit-consent.js'),
  '/complykit-consent-ui.js': path.join(DIST, 'complykit-consent-ui.js'),
};

// Extra response headers per path (e.g. a CSP header for the nonce fixture).
const HEADERS: Record<string, Record<string, string>> = {
  '/csp.html': { 'content-security-policy': "script-src 'nonce-ck-test-nonce'" },
};

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.gif': 'image/gif',
};

export interface FixtureServer {
  origin: string;
  /** Request paths seen, in order (query stripped). */
  requests: string[];
  /** Full request URLs (path + query) seen, in order. */
  urls: string[];
  close(): Promise<void>;
}

/** Tiny static server for fixture pages. Listens on 127.0.0.1, ephemeral port. */
export async function startFixtureServer(): Promise<FixtureServer> {
  const requests: string[] = [];
  const urls: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const pathname = url.pathname;
    requests.push(pathname);
    urls.push(pathname + url.search);
    // /slow/<fixture>?ms=N answers after N ms (default 200): ordering tests.
    const delay = pathname.startsWith('/slow/') ? Number(url.searchParams.get('ms') ?? 200) : 0;
    const file = ROUTES[pathname] ?? path.join(FIXTURES, path.basename(pathname));
    if (!file.startsWith(FIXTURES) && !file.startsWith(DIST)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      const send = () => {
        res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', ...(HEADERS[pathname] ?? {}) });
        res.end(data);
      };
      if (delay > 0) setTimeout(send, delay);
      else send();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    urls,
    close: () => new Promise((r) => {
      server.close(() => r());
      server.closeAllConnections(); // keep-alive sockets would stall close by ~10s
    }),
  };
}
