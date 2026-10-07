import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Browser } from 'playwright';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runBrowserScan } from '../src/pipeline.js';
import { asRunId } from '../src/record/ids.js';
import { runAxe } from '../src/collect/browser/axe.js';
import { ENGINE_NAMES, engineAvailability, launchEngine } from './engines.js';

// D9 "Done when": the consent client's banner and settings layer pass
// complykit's OWN accessibility checker. This drives the real browser pass
// (runBrowserScan: axe-core through the registry mapping, the keyboard walk,
// contrast measurement, every deterministic rule) over a local fixture page
// that loads the BUILT client (client/dist: the core IIFE, which loads the UI file) — so it
// checks what a site would ship, not the source.
//
// Three states: the bar banner (non-modal region), the modal banner (<dialog>),
// and the settings layer open (opened on load through ComplyKit.open()).
// Zero findings at confidence 'violation' in any of them. needs-review findings
// are printed for a human, not failed (axe's `incomplete` is a shrug, not a
// verdict).
//
// Skips without Chromium, or when client/dist has not been built
// (`npm --prefix client run build`); the skip is visible in the test output.
//
// Engines (F5). The full complykit pass (runBrowserScan) is Chromium-only by
// construction: the collector launches Chromium and its snapshot / network
// capture use CDP sessions. So per engine:
//   Chromium        — runBrowserScan (axe via the registry mapping, keyboard
//                     walk, contrast, every deterministic rule) + axe directly
//   Firefox, WebKit — axe-core directly on the mounted banner / settings layer
//                     (complykit's runAxe: same axe build, same rule set)
// The keyboard behaviour in Firefox and WebKit is covered by the client's own
// fixture suite (client/test/banner.test.ts, run per engine with CK_BROWSER).

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.join(here, '..', 'client', 'dist');
const CLIENT_IIFE = path.join(CLIENT_DIST, 'complykit-consent.js');
const CLIENT_UI = path.join(CLIENT_DIST, 'complykit-consent-ui.js');
const EXAMPLE = path.join(here, 'fixtures', 'consent-config', 'example.json');

let chromiumAvailable = false;
try {
  const { chromium } = await import('playwright');
  chromiumAvailable = fs.existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}
const clientBuilt = fs.existsSync(CLIENT_IIFE) && fs.existsSync(CLIENT_UI);
const suite = chromiumAvailable && clientBuilt ? describe : describe.skip;
const engines = await engineAvailability();

const config = (layout: string): unknown => {
  const c = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
  c.regimeSource = { kind: 'fixed', regime: 'opt-in' };
  c.consent = { lifetimeDays: 365 };
  delete c.record;
  c.layout = layout;
  return c;
};

const page = (layout: string, openSettings: boolean): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Banner accessibility fixture</title>
<script type="application/json" id="complykit-config">${JSON.stringify(config(layout))}</script>
<script src="/complykit-consent.js"></script>
</head><body>
<header><a href="/">Example shop</a></header>
<main><h1>Example shop</h1><p>Plain page content for the banner to sit over.</p></main>
<footer><p>Footer</p></footer>
${openSettings ? '<script>addEventListener("load", function () { ComplyKit.open(); });</script>' : ''}
</body></html>`;

const PAGES: Record<string, string> = {
  '/bar': page('bar', false),
  '/modal': page('modal', false),
  '/settings': page('bar', true),
};

/** Serve the fixture pages and the built client; returns the origin. */
function serveFixtures(): { base: () => string } {
  let server: http.Server;
  let base = '';
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
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });
  return { base: () => base };
}

suite('client banner passes complykit accessibility checks (Chromium: full browser pass)', () => {
  const srv = serveFixtures();

  for (const route of Object.keys(PAGES)) {
    it(`${route}: zero violations`, async () => {
      const res = await runBrowserScan({
        runId: asRunId(`d9-a11y${route.replace('/', '-')}`),
        property: 'client-banner',
        targetUrl: `${srv.base()}${route}`,
        packageVersion: '0.0.0',
        routes: { sitemap: false, crawl: { maxPages: 1, sameOrigin: true }, cap: 1 },
      });
      expect(res.scanned).toHaveLength(1);
      // Accessibility findings only: the consent evidence pass also runs and
      // judges the (tracker-free) page's consent behaviour, which is not D9's.
      const a11y = res.findings.filter((f) => String(f.requirementId).startsWith('wcag') || String(f.requirementId).startsWith('en301549') || String(f.ruleId).startsWith('axe.'));
      const violations = a11y.filter((f) => f.confidence === 'violation');
      for (const f of a11y.filter((x) => x.confidence !== 'violation')) {
        console.log(`[needs-review] ${route} ${f.ruleId} (${f.requirementId}): ${f.message}`);
      }
      expect(violations.map((f) => `${f.ruleId} ${f.requirementId}: ${f.message}`)).toEqual([]);
    }, 120_000);
  }
});

// Per engine: axe-core on the mounted UI. Also guards against a vacuous pass
// above: the UI file loads async, so prove axe ran with the banner (or the
// settings layer) actually on screen.
for (const engine of ENGINE_NAMES) {
  const engineSuite = engines[engine] && clientBuilt ? describe : describe.skip;
  engineSuite(`client banner: axe in ${engine}`, () => {
    const srv = serveFixtures();
    let browser: Browser;
    beforeAll(async () => {
      browser = await launchEngine(engine);
    });
    afterAll(async () => browser?.close());

    for (const route of Object.keys(PAGES)) {
      it(`${route}: axe sees the mounted UI and reports no violations`, async () => {
        const p = await browser.newPage();
        try {
          await p.goto(`${srv.base()}${route}`);
          await p.waitForSelector(route === '/settings' ? 'dialog.ck-settings[open]' : '.ck-banner [data-ck-action=accept]', { state: 'visible' });
          const art = await runAxe(p, { property: 'client-banner', routePattern: route, instanceUrl: `${srv.base()}${route}` }, new Date().toISOString());
          if (art.kind !== 'axe-result') throw new Error('expected an axe-result artifact');
          const v = (art.results as { violations: Array<{ id: string; nodes: unknown[] }> }).violations;
          expect(v.map((r) => `${r.id} (${r.nodes.length})`)).toEqual([]);
        } finally {
          await p.close();
        }
      }, 60_000);
    }
  });
}
