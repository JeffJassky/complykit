import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { parseMarkup, inspectMarkup, scanInlineBody, redactMarkupPages, redactTimeline, decodeDataUrl, DATA_URL_DECODE_LIMIT, Timeline, TrackingEvaluation } from '../src/record/index.js';
import { buildMarkupSection, matchMarkupElement, buildTrackingEvaluation } from '../src/rules/tracking/index.js';
import { DEFAULT_KB } from '../src/registry/index.js';
import { rewriteSnippet, rewriteNotes } from '../src/report/index.js';

// Static markup inspection (A1): the parser over a fixture page with every
// element kind, the KB matching, the record section, and redaction. No network.

const here = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(here, 'fixtures/pages/markup-trackers.html'), 'utf8');
const PAGE = 'https://www.example-shop.test/';
const lineOf = (needle: string): number => HTML.slice(0, HTML.indexOf(needle)).split('\n').length;

const site = { url: PAGE, host: 'www.example-shop.test', registrableDomain: 'example-shop.test' };

function timeline(markup = [inspectMarkup(HTML, PAGE, 0, 'navigation')], locationId = 'local'): Timeline {
  return Timeline.parse({
    location: { id: locationId },
    verification: { verdict: 'unknown', expected: {}, observed: {}, sources: [], checkedAt: '2026-10-06T00:00:00Z' },
    events: [],
    snapshot: {
      site,
      scenario: 'do-nothing',
      locationId,
      startedAt: '2026-10-06T00:00:00Z',
      durationMs: 1000,
      gpc: false,
      browser: { name: 'chromium' },
      pages: [{ url: PAGE }],
      cookies: [],
      storage: [],
      frames: [],
      markup,
    },
  });
}

describe('parseMarkup', () => {
  const els = parseMarkup(HTML, PAGE);

  it('finds the Meta <noscript><img> as a fetching element in noscript context, with its line', () => {
    const img = els.find((e) => e.kind === 'img' && e.url?.includes('facebook.com/tr'));
    expect(img).toBeDefined();
    expect(img!.context).toBe('noscript');
    expect(img!.loads).toBe('fetches');
    expect(img!.line).toBe(lineOf('<noscript><img'));
    expect(img!.url).toBe('https://www.facebook.com/tr?id=000000000000001&ev=PageView&noscript=1');
  });

  it('records inline script bodies with hosts of loader URLs and tag ids from the whole body', () => {
    const gtm = els.find((e) => e.kind === 'script' && e.ids.includes('GTM-XXXX01'));
    expect(gtm).toBeDefined();
    expect(gtm!.loads).toBe('executes');
    expect(gtm!.hosts).toContain('www.googletagmanager.com');
    expect(gtm!.line).toBe(lineOf("<script>(function(w,d,s,l,i)"));
    const meta = els.find((e) => e.body?.includes("fbq('init'"));
    expect(meta!.hosts).toEqual(['connect.facebook.net']);
    const clarity = els.find((e) => e.body?.includes('"clarity"'));
    expect(clarity!.hosts).toEqual(['www.clarity.ms']);
    expect(meta!.bodyDigest).toMatch(/^sha256:/);
    expect(meta!.bodyLength).toBeGreaterThan(100);
  });

  it('does not treat a plain social link in a script as a loader', () => {
    const theme = els.find((e) => e.body?.startsWith('window.theme'));
    expect(theme).toBeDefined();
    expect(theme!.hosts).toEqual([]);
  });

  it('classifies script types: held (text/plain), inert (ld+json), executes (src)', () => {
    const held = els.find((e) => e.url?.includes('analytics.tiktok.com'));
    expect(held!.loads).toBe('held');
    expect(held!.attributes['data-category']).toBe('marketing');
    expect(els.find((e) => e.attributes.type === 'application/ld+json')!.loads).toBe('inert');
    const gtag = els.find((e) => e.url?.includes('gtag/js'));
    expect(gtag!.loads).toBe('executes');
    expect(gtag!.attributes.async).toBe('');
  });

  it('ignores comments and raw-text content; marks <template> content inert', () => {
    expect(els.some((e) => e.url?.includes('hotjar'))).toBe(false); // commented out
    expect(els.some((e) => e.url?.includes('bat.bing.com'))).toBe(false); // inside <textarea>
    const tpl = els.find((e) => e.url?.includes('snap.licdn.com'));
    expect(tpl!.context).toBe('template');
    expect(tpl!.loads).toBe('inert');
  });

  it('keeps links that fetch or connect, cross-host only; resolves protocol-relative hrefs', () => {
    const links = els.filter((e) => e.kind === 'link');
    expect(links.map((l) => [l.attributes.rel, l.loads])).toEqual([
      ['dns-prefetch', 'connects'],
      ['preconnect', 'connects'],
      ['preload', 'fetches'],
      ['stylesheet', 'fetches'],
    ]);
    expect(links[0].url).toBe('https://connect.facebook.net/');
  });

  it('skips same-host images; keeps iframes, lazy (data-src) iframes as held', () => {
    expect(els.some((e) => e.url?.endsWith('/images/logo.png'))).toBe(false);
    expect(els.find((e) => e.url?.includes('youtube.com'))!.loads).toBe('fetches');
    expect(els.find((e) => e.url?.includes('vimeo.com'))!.loads).toBe('held');
    const ns = els.find((e) => e.url?.includes('googletagmanager.com/ns.html'));
    expect(ns!.kind).toBe('iframe');
    expect(ns!.context).toBe('noscript');
  });

  it('handles <base href>, unquoted attributes, entities and case', () => {
    const html = '<HTML><head>\n<base href="https://cdn.other.test/sub/">\n<SCRIPT SRC=lib.js?a=1&amp;b=2 async></SCRIPT>\n<img src=//px.vendor.test/p.gif></head></HTML>';
    const out = parseMarkup(html, 'https://shop.test/');
    expect(out[0]).toMatchObject({ kind: 'script', line: 3, url: 'https://cdn.other.test/sub/lib.js?a=1&b=2', loads: 'executes' });
    expect(out[1]).toMatchObject({ kind: 'img', line: 4, url: 'https://px.vendor.test/p.gif' });
  });

  it('survives unterminated markup without throwing', () => {
    expect(() => parseMarkup('<script>fbq("init"', PAGE)).not.toThrow();
    expect(parseMarkup('<img src="https://x.test/a', PAGE)).toHaveLength(1);
    expect(parseMarkup('<!-- never closed <script src="https://x.test/a.js"></script>', PAGE)).toHaveLength(0);
  });

  it('extracts JSON-escaped loader URLs and google ids', () => {
    const s = scanInlineBody('var urls=["https:\\/\\/static.klaviyo.com\\/onsite\\/js\\/klaviyo.js?company_id=X"]; gtag("config","AW-123456789"); var sku="G-SHOCK";');
    expect(s.hosts).toEqual(['static.klaviyo.com']);
    expect(s.ids).toEqual(['AW-123456789']);
  });
});

describe('markup section (KB matching)', () => {
  const built = buildMarkupSection([timeline()], DEFAULT_KB)!;
  const f = built.section.findings;
  const find = (partyId: string, kind: string) => f.filter((x) => x.partyId === partyId && x.kind === kind);

  it('reports the Meta <noscript><img> as a leak that fires with JavaScript disabled, with page and line', () => {
    const leak = find('meta.pixel', 'img');
    expect(leak).toHaveLength(1);
    expect(leak[0]).toMatchObject({
      verdict: 'leak',
      trigger: 'javascript-disabled',
      context: 'noscript',
      page: PAGE,
      line: lineOf('<noscript><img'),
      matchedBy: 'host',
      recognized: true,
    });
  });

  it('reports the inline Meta snippet as a gateable script matched by its install pattern', () => {
    const s = find('meta.pixel', 'script');
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ verdict: 'gateable', inline: true, matchedBy: 'inline-pattern', match: 'fbq(' });
    // and the preload hint for fbevents.js is a leak; the dns-prefetch a hint
    expect(find('meta.pixel', 'link').map((l) => l.verdict).sort()).toEqual(['hint', 'leak']);
  });

  it('matches GTM, gtag config, Clarity and an image pixel; held tags are held', () => {
    expect(find('google.tag-manager', 'script').map((x) => x.matchedBy).sort()).toEqual(['host', 'inline-pattern']);
    expect(find('google.tag-manager', 'iframe')[0]).toMatchObject({ verdict: 'leak', trigger: 'javascript-disabled' });
    expect(find('google.analytics', 'script')[0]).toMatchObject({ verdict: 'gateable', matchedBy: 'inline-pattern' });
    expect(find('microsoft.clarity', 'script')[0]).toMatchObject({ verdict: 'gateable', inline: true });
    expect(find('pinterest.tag', 'img')[0]).toMatchObject({ verdict: 'leak', trigger: 'page-load', context: 'document' });
    expect(find('tiktok.pixel', 'script')[0]).toMatchObject({ verdict: 'held' });
    expect(find('google.youtube', 'iframe')[0]).toMatchObject({ verdict: 'leak', trigger: 'page-load' });
    expect(find('google.fonts', 'link')[0]).toMatchObject({ verdict: 'leak' });
    expect(find('vimeo', 'iframe')[0]).toMatchObject({ verdict: 'held' });
  });

  it('reports nothing for inert, commented, first-party, or social-link content', () => {
    expect(f.some((x) => x.partyId === 'hotjar')).toBe(false);
    expect(f.some((x) => x.partyId === 'linkedin.insight')).toBe(false); // in <template>
    expect(f.some((x) => x.partyId === 'microsoft.uet')).toBe(false); // in <textarea>
    expect(f.some((x) => x.partyId.includes('example-shop'))).toBe(false);
    expect(f.filter((x) => x.partyId === 'meta.pixel').every((x) => x.matchedBy !== 'inline-host' || x.match === 'connect.facebook.net')).toBe(true);
    expect(f.some((x) => x.partyId === 'pinterest.tag' && x.kind === 'script')).toBe(false);
  });

  it('never carries an inline body into the section', () => {
    const json = JSON.stringify(built.section);
    expect(json).not.toContain('callMethod');
    expect(json).not.toContain("fbq('init'"); // the match is the pattern hit, not the snippet
    for (const x of f) expect(x.match.length).toBeLessThanOrEqual(81);
  });

  it('dedupes the same tag across pages and locations', () => {
    const p2 = inspectMarkup(HTML, `${PAGE}collections/all`, 1, 'navigation');
    const b = buildMarkupSection([timeline(), timeline([inspectMarkup(HTML, PAGE, 0, 'navigation'), p2], 'de')], DEFAULT_KB)!;
    const leak = b.section.findings.filter((x) => x.partyId === 'meta.pixel' && x.kind === 'img');
    expect(leak).toHaveLength(1);
    expect(leak[0].locations).toEqual(['local', 'de']);
    expect(leak[0].alsoOn).toEqual([`${PAGE}collections/all`]);
    expect(b.section.pages.map((p) => p.url)).toEqual([PAGE, `${PAGE}collections/all`]);
  });

  it('lists pages not inspected as not-tested, and absent capture as not run', () => {
    const b = buildMarkupSection([timeline([{ url: PAGE, pageIndex: 0, status: 'not-inspected', reason: 're-fetch timed out', elements: [] }])], DEFAULT_KB)!;
    expect(b.section.findings).toEqual([]);
    expect(b.notTested).toEqual([{ scope: 'page', id: PAGE, reason: 'served HTML not inspected for markup trackers: re-fetch timed out' }]);
    const legacy = timeline();
    delete legacy.snapshot.markup;
    expect(buildMarkupSection([legacy], DEFAULT_KB)).toBeUndefined();
  });

  it('flags inventory parties attributed to markup with no tag found', () => {
    const b = buildMarkupSection([timeline()], DEFAULT_KB, [
      { partyId: 'meta.pixel', sources: ['markup-leak'] },
      { partyId: 'unknown:pixel.vendor.test', sources: ['markup'] },
      { partyId: 'snap.pixel', sources: ['injected'] },
    ] as never)!;
    expect(b.section.unexplained.map((u) => u.partyId)).toEqual(['unknown:pixel.vendor.test']);
  });

  it('matches an unrecognized third-party src as unknown:<domain>, and a CNAME-cloaked first-party host', () => {
    const el = parseMarkup('<script src="https://cdn.pixelvendor.test/p.js"></script><img src="https://metrics.example-shop.test/tr?id=1">', PAGE);
    expect(matchMarkupElement(el[0], DEFAULT_KB, site)[0]).toMatchObject({ partyId: 'unknown:pixelvendor.test', matchedBy: 'host' });
    expect(matchMarkupElement(el[1], DEFAULT_KB, site)).toEqual([]);
    const cloaked = matchMarkupElement(el[1], DEFAULT_KB, site, new Map([['metrics.example-shop.test', 'www.facebook.com']]));
    expect(cloaked[0]).toMatchObject({ partyId: 'meta.pixel', match: 'metrics.example-shop.test → www.facebook.com' });
  });
});

describe('record + redaction', () => {
  it('redactTimeline drops inline bodies but keeps digests, hosts, ids and lines', () => {
    const red = redactTimeline(timeline());
    const els = red.snapshot.markup![0].elements;
    expect(els.some((e) => e.body !== undefined)).toBe(false);
    const gtm = els.find((e) => e.ids.includes('GTM-XXXX01'))!;
    expect(gtm.bodyDigest).toMatch(/^sha256:/);
    expect(gtm.line).toBeGreaterThan(1);
    expect(redactMarkupPages([])).toEqual([]);
  });

  it('nonce values never enter the record', () => {
    const els = parseMarkup('<script nonce="s3cr3t">fbq("init","1")</script>', PAGE);
    expect(JSON.stringify(els)).not.toContain('s3cr3t');
    expect(els[0].attributes['nonce-present']).toBe('true');
  });

  it('the evaluation carries a schema-valid markup section', () => {
    const ev = buildTrackingEvaluation({
      runId: 'r1',
      property: 'example',
      site,
      versions: { kb: 'x', registry: 'x', package: 'x' },
      startedAt: '2026-10-06T00:00:00Z',
      finishedAt: '2026-10-06T00:01:00Z',
      locations: [],
      timelines: [timeline()],
      notTested: [],
      redacted: true,
    });
    const parsed = TrackingEvaluation.parse(JSON.parse(JSON.stringify(ev)));
    expect(parsed.markup?.findings.some((x) => x.partyId === 'meta.pixel' && x.verdict === 'leak' && x.context === 'noscript')).toBe(true);
  });
});

describe('unrecognized hosts', () => {
  it('fold into one row per kind with an occurrence count, not one per tag', () => {
    const html = '<img src="https://cdn.unknownhost.test/a.jpg">\n<img src="https://cdn.unknownhost.test/b.jpg">\n<img src="https://cdn.unknownhost.test/c.jpg">\n<script src="https://cdn.unknownhost.test/x.js"></script>';
    const tl = timeline([inspectMarkup(html, PAGE, 0, 'navigation')]);
    const b = buildMarkupSection([tl, tl], DEFAULT_KB)!;
    const rows = b.section.findings.filter((x) => x.partyId === 'unknown:unknownhost.test');
    expect(rows.map((r) => [r.kind, r.verdict, r.occurrences, r.line, r.recognized])).toEqual([
      ['img', 'leak', 3, 1, false],
      ['script', 'gateable', 1, 4, false],
    ]);
  });
});

describe('document.write in an inline snippet (D10 follow-up)', () => {
  it('carries from the element to the finding, gated (held) or not', () => {
    const html = `<script>fbq('init','1');document.write('<img src="https://www.facebook.com/tr?id=1">');</script>\n<script type="text/plain" data-category="advertising">fbq('init','1');document.writeln('x');</script>\n<script>gtag('config','G-ABC1234567')</script>`;
    const b = buildMarkupSection([timeline([inspectMarkup(html, PAGE, 0, 'navigation')])], DEFAULT_KB)!;
    const meta = b.section.findings.filter((x) => x.partyId === 'meta.pixel');
    expect(meta.map((f) => [f.verdict, f.documentWrite])).toEqual([
      ['gateable', true],
      ['held', true],
    ]);
    expect(b.section.findings.filter((x) => x.partyId !== 'meta.pixel').every((f) => f.documentWrite === undefined)).toBe(true);
  });
});

// complykit#47: a "delay / defer JavaScript" optimizer serves inline vendor
// snippets as <script src="data:text/javascript;base64,…">. The decoded code is
// inspected like an inline body; the URL itself never enters the record.
describe('data: URL scripts and optimizer-delayed scripts (#47)', () => {
  const DATA_HTML = fs.readFileSync(path.join(here, 'fixtures/pages/markup-data-url.html'), 'utf8');
  const els = parseMarkup(DATA_HTML, PAGE);
  const page = inspectMarkup(DATA_HTML, PAGE, 0, 'navigation');
  const built = buildMarkupSection([timeline([page])], DEFAULT_KB)!;
  const find = (partyId: string) => built.section.findings.filter((x) => x.partyId === partyId && x.kind === 'script');
  const payloads = [...DATA_HTML.matchAll(/data:text\/javascript(?:;base64)?,([^"]+)"/g)].map((m) => m[1]);

  it('decodeDataUrl: base64 (forgiving: whitespace, missing padding), percent-encoded, capped', () => {
    expect(decodeDataUrl('data:text/javascript;base64,ZmJxKCdpbml0Jyk7')).toMatchObject({ mediaType: 'text/javascript', encoding: 'base64', body: "fbq('init');", truncated: false });
    expect(decodeDataUrl(' data:text/javascript;base64,ZmJx KCdp\nbml0Jyk ')?.body).toBe("fbq('init')");
    expect(decodeDataUrl('data:text/javascript,fbq(%27init%27)%3B%20%E2%9C%93')?.body).toBe("fbq('init'); ✓");
    expect(decodeDataUrl('data:,x')).toMatchObject({ mediaType: '', encoding: 'percent', body: 'x' });
    expect(decodeDataUrl('https://x.test/a.js')).toBeUndefined();
    const big = decodeDataUrl(`data:text/javascript,${'a'.repeat(DATA_URL_DECODE_LIMIT + 10)}`)!;
    expect(big.truncated).toBe(true);
    expect(big.body.length).toBe(DATA_URL_DECODE_LIMIT);
    expect(big.encodedLength).toBe(DATA_URL_DECODE_LIMIT + 10);
  });

  it('a data: URL script is inspected like an inline body: no url, decoded hosts / ids, the payload kept out of the attributes', () => {
    const meta = els.find((e) => e.body?.includes("fbq('init'"))!;
    expect(meta).toMatchObject({ kind: 'script', loads: 'executes', line: 11, dataUrl: { attribute: 'src', mediaType: 'text/javascript', encoding: 'base64' } });
    expect(meta.url).toBeUndefined();
    expect(meta.hosts).toEqual(['connect.facebook.net']);
    expect(meta.attributes.src).toBe('data:text/javascript;base64,…');
    expect(meta.bodyDigest).toMatch(/^sha256:/);
    const gtm = els.find((e) => e.ids.includes('GTM-XXXX01'))!;
    expect(gtm.dataUrl?.encoding).toBe('base64');
    const tiktok = els.find((e) => e.body?.includes('ttq.load'))!;
    expect(tiktok).toMatchObject({ loads: 'executes', dataUrl: { attribute: 'src', encoding: 'percent' } });
    expect(tiktok.hosts).toEqual(['analytics.tiktok.com']);
    // A held rewrite of one keeps its data: URL in data-src: held, still matched.
    const pin = els.find((e) => e.body?.includes('pintrk'))!;
    expect(pin).toMatchObject({ loads: 'held', dataUrl: { attribute: 'data-src' } });
    expect(pin.attributes['data-src']).toBe('data:text/javascript;base64,…');
  });

  it('matches Meta, GTM, the gtag config and TikTok as gateable scripts (and the held one as held), with their lines', () => {
    expect(find('meta.pixel')).toEqual([expect.objectContaining({ verdict: 'gateable', inline: true, matchedBy: 'inline-pattern', dataUrl: { attribute: 'src', mediaType: 'text/javascript', encoding: 'base64' } })]);
    expect(find('meta.pixel')[0].line).toBe(11);
    expect(find('google.tag-manager').find((x) => x.inline)).toMatchObject({ verdict: 'gateable', line: 8, ids: ['GTM-XXXX01'] });
    expect(find('google.analytics').find((x) => x.inline)).toMatchObject({ verdict: 'gateable', line: 10, ids: ['G-TEST0001X'], matchedBy: 'inline-pattern' });
    expect(find('tiktok.pixel')).toEqual([expect.objectContaining({ verdict: 'gateable', line: 13, dataUrl: expect.objectContaining({ encoding: 'percent' }) })]);
    expect(find('pinterest.tag')).toEqual([expect.objectContaining({ verdict: 'held', line: 15 })]);
  });

  it('never records a data: URL payload: not in the elements, the findings, or the redacted timeline', () => {
    expect(payloads.length).toBe(5);
    const recorded = JSON.stringify({ redacted: redactMarkupPages([page]), section: built.section });
    for (const p of payloads) expect(recorded).not.toContain(p.slice(0, 40));
    expect(JSON.stringify(redactMarkupPages([page]))).not.toContain("fbq('init'");
  });

  it('optimizer-delayed scripts (WP Rocket, LiteSpeed) execute for every visitor: gateable, with the optimizer named', () => {
    expect(find('microsoft.clarity')).toEqual([expect.objectContaining({ verdict: 'gateable', inline: true, optimizer: expect.stringMatching(/WP Rocket/) })]);
    expect(find('hotjar')).toEqual([expect.objectContaining({ verdict: 'gateable', inline: false, url: 'https://static.hotjar.com/c/hotjar-0000001.js?sv=6', optimizer: expect.stringMatching(/LiteSpeed/) })]);
    expect(find('microsoft.uet')).toEqual([expect.objectContaining({ verdict: 'gateable', url: 'https://bat.bing.com/bat.js', optimizer: expect.stringMatching(/WP Rocket/) })]);
    expect(parseMarkup('<script type="0123456789abcdef0123-text/javascript" src="https://x.test/a.js"></script>', PAGE)[0]).toMatchObject({ loads: 'executes', optimizer: 'Cloudflare Rocket Loader' });
    // A consent tool's own held tag is not an optimizer's.
    expect(parseMarkup('<script type="text/plain" data-rocket-src="https://x.test/a.js"></script>', PAGE)[0].optimizer).toBeUndefined();
  });

  it('the rewrite keeps the data: URL (moved to data-src) and drops an optimizer’s own type and attributes', () => {
    const meta = find('meta.pixel')[0];
    expect(rewriteSnippet(meta, undefined, 'advertising')).toEqual({
      before: '<script defer src="data:text/javascript;base64,…"></script>',
      after: '<script type="text/plain" data-category="advertising" data-src="data:text/javascript;base64,…" defer></script>',
    });
    expect(rewriteNotes(meta, 'advertising').join(' ')).toMatch(/“…” stands for the existing value — move it unchanged to data-src/);
    const uet = find('microsoft.uet')[0];
    expect(rewriteSnippet(uet, uet.url, 'advertising')).toEqual({
      before: '<script type="rocketlazyloadscript" data-rocket-src="https://bat.bing.com/bat.js" defer></script>',
      after: '<script type="text/plain" data-category="advertising" data-src="https://bat.bing.com/bat.js" defer></script>',
    });
    expect(rewriteNotes(uet, 'advertising').join(' ')).toMatch(/that delay is not consent gating/);
  });
});
