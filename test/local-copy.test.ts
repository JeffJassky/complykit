import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rewriteContainerConsent, parseGtmContainer, extractContainerData } from '../src/rules/tracking/gtm.js';
import { rewriteDocument, resourceFor, newLocalCopyStats, localCopyRecord, type LocalCopy } from '../src/collect/browser/evaluation/local-copy.js';
import { parseLocalCopySpec, loadLocalCopy } from '../src/local-copy.js';
import { runConsentScan } from '../src/pipeline.js';
import { asRunId, type LocationSpec } from '../src/record/index.js';
import { buildKnowledgeBase } from '../src/registry/index.js';
import { buildConsentReportModel, renderConsentMarkdown, renderConsentHtml } from '../src/report/index.js';

// Local-copy mode (D11): the owner's change set applied inside the scanner's
// own browser. Pure halves first (container rewrite, document rewrite, spec
// validation), then a fixture site scanned through the full pipeline with a
// local copy (the site on localhost, so the route's re-fetch — Node-side, no
// host-resolver rules — reaches it): the head snippet is served from a local file and runs, the
// vendor tag is rewritten to text/plain (never requested), the "container" is
// rewritten in flight so its tag reads as consent-required, and the record +
// report say LOCAL COPY before anything else.

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(path.join(here, 'fixtures', 'gtm', 'GTM-XXXX01.js'), 'utf8');

const capture = (source: string) => ({ id: 'GTM-XXXX01', kind: 'gtm' as const, url: 'https://www.googletagmanager.com/gtm.js?id=GTM-XXXX01', locationId: 'local', seenOn: [], fetchedAt: '2026-10-07T00:00:00Z', status: 'ok' as const, source });

describe('rewriteContainerConsent (simulated GTM consent settings)', () => {
  it('adds "consent": ["list", …] to the named tags, and the parser then reads them as required', () => {
    const r = rewriteContainerConsent(FIXTURE, { tags: { '4': ['analytics_storage'], '9999': ['ad_storage'] } });
    expect(r.rewritten).toEqual([4]);
    expect(r.missing).toEqual(['9999']);
    expect(r.source).toBeDefined();
    const before = parseGtmContainer(capture(FIXTURE));
    const after = parseGtmContainer(capture(r.source!));
    expect(after.status).toBe('parsed');
    expect(after.tags.length).toBe(before.tags.length);
    const t4 = after.tags.find((t) => t.tagId === 4)!;
    expect(t4.consent.status).toBe('required');
    expect(t4.consent.additional).toContain('analytics_storage');
    expect(before.tags.find((t) => t.tagId === 4)!.consent.status).not.toBe('required');
    // Every other tag is as it was.
    for (const t of before.tags) if (t.tagId !== 4) expect(after.tags.find((a) => a.tagId === t.tagId)!.consent).toEqual(t.consent);
  });

  it('requires by template too, merges with an existing list, and reports no change the second time', () => {
    const first = rewriteContainerConsent(FIXTURE, { templates: { __gaawe: ['analytics_storage'] } });
    expect(first.rewritten.length).toBeGreaterThan(0);
    const again = rewriteContainerConsent(first.source!, { templates: { __gaawe: ['analytics_storage'] } });
    expect(again.source).toBeUndefined();
    expect(again.unchanged).toEqual(first.rewritten);
    expect(again.reason).toMatch(/no tag needed a change/);
    const more = rewriteContainerConsent(first.source!, { tags: { [String(first.rewritten[0])]: ['analytics_storage', 'ad_storage'] } });
    expect(more.rewritten).toEqual([first.rewritten[0]]);
    const t = parseGtmContainer(capture(more.source!)).tags.find((x) => x.tagId === first.rewritten[0])!;
    expect(t.consent.additional).toEqual(['analytics_storage', 'ad_storage']);
  });

  it('fails closed: not a container, bad consent type, nothing asked', () => {
    expect(rewriteContainerConsent('<!doctype html><html></html>', { tags: { '1': ['ad_storage'] } }).reason).toMatch(/HTML page/);
    expect(rewriteContainerConsent(FIXTURE, { tags: { '4': ['Ad Storage'] } }).reason).toMatch(/not a consent type/);
    expect(rewriteContainerConsent(FIXTURE, {}).reason).toMatch(/nothing to require/);
    expect(extractContainerData(FIXTURE).data?.resource.tags.length).toBeGreaterThan(0);
  });
});

describe('rewriteDocument', () => {
  const lc = {
    head: '<script id="ck"></script>',
    replace: [
      { label: 'vendor', from: '<script src="https://v.test/v.js"></script>', to: '<script type="text/plain" data-category="advertising" data-src="https://v.test/v.js"></script>' },
      { label: 'noscript', pattern: { source: '<noscript>\\s*<img[^>]*></noscript>', flags: 'g' }, to: '' },
      { label: 'never', from: '<script src="https://none.test/x.js"></script>', to: '' },
    ],
  };

  it('inserts the head content after <head> (after a leading <meta charset>), applies exact and regex replacements, counts them', () => {
    const html = '<!doctype html><html><head>\n<meta charset="utf-8"><title>t</title><script src="https://v.test/v.js"></script></head><body><noscript> <img src="https://px.test/1"></noscript><noscript><img src="https://px.test/2"></noscript></body></html>';
    const applied = new Map<string, number>();
    const out = rewriteDocument(html, lc, applied);
    expect(out.headInserted).toBe(true);
    expect(out.html.indexOf('<meta charset="utf-8">')).toBeLessThan(out.html.indexOf('<script id="ck">'));
    expect(out.html.indexOf('<script id="ck">')).toBeLessThan(out.html.indexOf('<title>'));
    expect(out.html).toContain('type="text/plain" data-category="advertising" data-src="https://v.test/v.js"');
    expect(out.html).not.toContain('px.test');
    expect(applied.get('vendor')).toBe(1);
    expect(applied.get('noscript')).toBe(1); // one document, however many matches
    expect(applied.get('never')).toBeUndefined();
  });

  it('with no <head> the head content is not inserted, and says so', () => {
    const out = rewriteDocument('<p>fragment</p>', lc);
    expect(out.headInserted).toBe(false);
    expect(out.html).toBe('<p>fragment</p>');
  });

  it('matches resources on origin + path + the named query parameters only', () => {
    const r = { resources: [{ url: 'https://www.googletagmanager.com/gtm.js?id=GTM-XXXX01', transform: () => ({}) }] };
    expect(resourceFor(r, 'https://www.googletagmanager.com/gtm.js?id=GTM-XXXX01&l=dataLayer')).toBeDefined();
    expect(resourceFor(r, 'https://www.googletagmanager.com/gtm.js?id=GTM-XXXX02')).toBeUndefined();
    expect(resourceFor(r, 'https://www.googletagmanager.com/gtag/js?id=GTM-XXXX01')).toBeUndefined();
  });
});

describe('local-copy spec', () => {
  it('validates the shape and refuses a spec that applies nothing', () => {
    expect(() => parseLocalCopySpec({})).toThrow(/nothing to apply/);
    expect(() => parseLocalCopySpec({ replace: [{ to: 'x' }] })).toThrow(/exactly one of/);
    expect(() => parseLocalCopySpec({ replace: [{ from: 'a', pattern: 'b', to: 'x' }] })).toThrow(/exactly one of/);
    expect(() => parseLocalCopySpec({ replace: [{ pattern: '(', to: '' }] })).toThrow(/pattern/);
    expect(() => parseLocalCopySpec({ serve: { 'no-slash': 'f.js' } })).toThrow(/absolute path/);
    expect(() => parseLocalCopySpec({ containers: [{ url: 'https://x.test/gtm.js' }] })).toThrow(/tags or templates/);
    expect(() => parseLocalCopySpec({ containers: [{ url: 'not a url', tags: {} }] })).toThrow(/not a URL/);
    expect(parseLocalCopySpec({ replace: [{ from: 'a', to: 'b' }] }).replace![0].label).toBe('replace[0]');
  });

  it('loads files relative to the spec and refuses a missing one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-lc-'));
    fs.writeFileSync(path.join(dir, 'head.html'), '<script id="ck"></script>\n');
    fs.writeFileSync(path.join(dir, 'core.js'), 'window.ck=1');
    fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({ head: 'head.html', serve: { '/ck/core.js': 'core.js' }, containers: [{ url: 'https://www.googletagmanager.com/gtm.js?id=GTM-XXXX01', tags: { '4': ['analytics_storage'] } }] }));
    const lc = loadLocalCopy('spec.json', 'https://example-shop.test/page', dir);
    expect(lc.origin).toBe('https://example-shop.test');
    expect(lc.head).toBe('<script id="ck"></script>');
    expect(lc.serve['/ck/core.js']).toMatchObject({ contentType: expect.stringContaining('javascript') });
    const t = lc.resources[0].transform(FIXTURE);
    expect(t.source).toBeDefined();
    expect(t.note).toMatch(/required consent on 1 tag/);
    fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ serve: { '/x.js': 'missing.js' } }));
    expect(() => loadLocalCopy('bad.json', 'https://example-shop.test/', dir)).toThrow(/file not found/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// --- the browser half ----------------------------------------------------------

let chromiumAvailable = false;
try {
  const { chromium } = await import('playwright');
  chromiumAvailable = fs.existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}
// COMPLYKIT_BROWSER_CHANNEL (an installed Chrome / Edge) counts as a browser too.
const suite = chromiumAvailable || process.env.COMPLYKIT_BROWSER_CHANNEL ? describe : describe.skip;

const STUB = { name: 'stub', lookup: async (_f: unknown, spec: LocationSpec) => ({ ip: '198.51.100.1', country: spec.country, region: spec.region }) };
const KB = buildKnowledgeBase({
  extra: [
    { id: 'fixture.vendor', vendor: 'Fixture Vendor', match: { hosts: ['vendor.test'] }, categories: ['advertising'], provenance: { proposedBy: 'test', proposedAt: '2026-10-02', confirmedBy: 'test', confirmedAt: '2026-10-02', sources: [] } },
    { id: 'fixture.marker', vendor: 'Fixture Marker', match: { hosts: ['marker.test'] }, categories: ['necessary'], provenance: { proposedBy: 'test', proposedAt: '2026-10-02', confirmedBy: 'test', confirmedAt: '2026-10-02', sources: [] } },
  ],
});

suite('a fixture site scanned as a local copy', () => {
  let server: http.Server;
  let port = 0;
  let cwd: string;
  let dir: string;
  const hits: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const host = (req.headers.host ?? '').split(':')[0];
      const p = (req.url ?? '/').split('?')[0];
      hits.push(`${host}${req.url}`);
      const ok = (type: string, body: string) => {
        res.writeHead(200, { 'content-type': type, 'access-control-allow-origin': '*' });
        res.end(body);
      };
      if (host === 'localhost' && (p === '/' || p === '/about')) {
        return ok(
          'text/html; charset=utf-8',
          `<!doctype html><html><head><meta charset="utf-8"><title>LC shop</title>
<script src="http://vendor.test:${port}/v.js"></script>
<script async src="http://127.0.0.1:${port}/gtm.js?id=GTM-XXXX01&l=dataLayer"></script>
</head><body><a href="/about">About</a><noscript><img src="http://vendor.test:${port}/ns.gif"></noscript><main><p>Copy.</p></main></body></html>`,
        );
      }
      if (host === 'vendor.test' && p === '/v.js') return ok('application/javascript', `new Image().src='http://vendor.test:${port}/px?u='+encodeURIComponent(location.href);`);
      if (host === '127.0.0.1' && p === '/gtm.js') return ok('application/javascript', FIXTURE);
      res.writeHead(204, { 'access-control-allow-origin': '*' });
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, () => r()));
    port = (server.address() as { port: number }).port;
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-lc-run-'));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-lc-spec-'));
    // The "tool": a local file that pings marker.test when it runs — proof the served file executed, from the timeline alone.
    fs.writeFileSync(path.join(dir, 'core.js'), `new Image().src='http://marker.test:${port}/ran';`);
    fs.writeFileSync(path.join(dir, 'head.html'), '<script src="/lc/v1/core.js"></script>');
    fs.writeFileSync(
      path.join(dir, 'spec.json'),
      JSON.stringify({
        head: 'head.html',
        replace: [
          { label: 'vendor tag', from: `<script src="http://vendor.test:${port}/v.js"></script>`, to: `<script type="text/plain" data-category="advertising" data-src="http://vendor.test:${port}/v.js"></script>` },
          { label: 'noscript leak', pattern: '<noscript>\\s*<img[^>]*></noscript>', flags: 'g', to: '' },
          { label: 'never matches', from: '<script src="https://none.test/x.js"></script>', to: '' },
        ],
        serve: { '/lc/v1/core.js': 'core.js' },
        containers: [{ url: `http://127.0.0.1:${port}/gtm.js?id=GTM-XXXX01`, tags: { '4': ['analytics_storage'] } }],
      }),
    );
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    for (const d of [cwd, dir]) if (d) fs.rmSync(d, { recursive: true, force: true });
  });

  it('rewrites the documents in the browser, serves the local file, holds the rewritten tag, rewrites the container, and says LOCAL COPY', async () => {
    const lc: LocalCopy = loadLocalCopy('spec.json', `http://localhost:${port}/`, dir);
    const res = await runConsentScan({
      runId: asRunId('lc-main'),
      property: 'fixture',
      targetUrl: `http://localhost:${port}/`,
      cwd,
      packageVersion: '0.0.0-test',
      locations: [{ id: 'de', country: 'DE', scenarios: ['browse'] }],
      journey: { dwellMs: 1200, pageDwellMs: 500, scrollSteps: 1, maxPages: 1 },
      bannerWaitMs: 1500,
      geoSources: [STUB, { ...STUB, name: 'stub-b' }],
      launchArgs: ['--host-resolver-rules=MAP *.test 127.0.0.1'],
      knowledgeBase: KB,
      localCopy: lc,
      har: false,
    });
    const ev = res.evaluation;
    expect(ev.locations[0].scenarios[0].status).toBe('tested');
    // The served file ran (its ping is in the timeline); the rewritten vendor tag never loaded.
    const requested = new Set(ev.inventory.map((p) => p.partyId));
    expect(requested.has('fixture.marker')).toBe(true);
    expect(requested.has('fixture.vendor')).toBe(false);
    expect(hits.some((h) => h.startsWith('vendor.test/'))).toBe(false);
    // The markup inspection saw the rewritten HTML: the vendor tag is held, the noscript leak is gone, the tool is first.
    const page = ev.markup!.pages.find((p) => p.url.endsWith('/'))!;
    expect(page.status).toBe('inspected');
    const vendor = ev.markup!.findings.find((f) => f.partyId === 'fixture.vendor' && f.url?.includes('/v.js'))!;
    expect(vendor.verdict).toBe('held');
    expect(vendor.attributes.type).toBe('text/plain');
    expect(ev.markup!.findings.some((f) => f.context === 'noscript')).toBe(false);
    // The container the scenario loaded was fetched and parsed with the simulated setting.
    const c = ev.containers!.find((x) => x.id === 'GTM-XXXX01')!;
    expect(c.status).toBe('parsed');
    expect(c.tags.find((t) => t.tagId === 4)!.consent.status).toBe('required');
    // The record and both reports lead with the local copy.
    expect(ev.localCopy).toMatchObject({ head: true, origin: `http://localhost:${port}`, documents: { unreadable: 0 }, errors: [] });
    const docs = ev.localCopy!.documents.rewritten; // every navigation of the journey (/, /about, back)
    expect(docs).toBeGreaterThanOrEqual(1);
    expect(ev.localCopy!.replacements).toEqual(expect.arrayContaining([{ label: 'vendor tag', applied: docs }, { label: 'noscript leak', applied: docs }, { label: 'never matches', applied: 0 }]));
    expect(ev.localCopy!.served).toEqual([{ path: '/lc/v1/core.js', requests: docs }]);
    expect(ev.localCopy!.resources[0]).toMatchObject({ status: 'rewritten', note: expect.stringContaining('required consent on 1 tag') });
    expect(ev.notTested.some((n) => n.id === 'local-copy' && /LOCAL COPY/.test(n.reason))).toBe(true);
    const model = buildConsentReportModel(ev, res.findings);
    const md = renderConsentMarkdown(model);
    expect(md.indexOf('LOCAL COPY — not the live site')).toBeGreaterThan(0);
    expect(md.indexOf('LOCAL COPY')).toBeLessThan(md.indexOf('working as expected'));
    expect(md).toContain('never matched: never matches');
    const html = renderConsentHtml(model, { runDir: cwd });
    expect(html.indexOf('id="local-copy"')).toBeLessThan(html.indexOf('id="scan-scope"'));
    expect(localCopyRecord(lc).documents.rewritten).toBe(docs);
    expect(newLocalCopyStats(lc).documents.rewritten).toBe(0);
  }, 120000);
});
