import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  generateConsentConfig,
  refuseNecessaryTrackers,
  knownTrackerReason,
  scriptJson,
  srcRule,
  DEFAULT_SCRIPT_SRC,
  type GenerateConsentConfigOptions,
} from '../src/consent-generator.js';
import { parseConsentToolConfig, guardConsentToolConfig, CONSENT_CONFIG_ELEMENT_ID, writeTrackingEvaluation, parseMarkup, redactMarkupPages, type TrackingEvaluation, type PartyInventoryItem } from '../src/record/index.js';
import { DEFAULT_KB } from '../src/registry/index.js';
import { containsBannedVocabulary, buildConsentReportModel } from '../src/report/index.js';
import { classificationKey, type WorkspaceSnapshot } from '../src/site-workspace.js';
import { cmdConsentConfig } from '../src/cli/commands/consent-config.js';
import { compatibilityEvaluation, PAGE } from './fixtures/compatibility-report.js';
import { dataLayerConfigEvaluation } from './fixtures/gtm-datalayer-config.js';
import { reconcileCompatibility } from '../src/consent-compatibility.js';

// D8: scan (+ site workspace) → config + snippet + change list. Fixture only
// (test/fixtures/compatibility-report.ts: one tool per verdict, generic hosts).

const NOW = '2026-10-06T12:00:00.000Z';
const OPTS: GenerateConsentConfigOptions = { complykitVersion: '0.0.0-test', now: NOW };
const gen = (e: TrackingEvaluation = compatibilityEvaluation(), o: Partial<GenerateConsentConfigOptions> = {}) => generateConsentConfig(e, { ...OPTS, ...o });

/** The config as the tool would read it: the inline JSON inside the snippet. */
function inlineConfig(snippet: string): unknown {
  const m = new RegExp(`<script type="application/json" id="${CONSENT_CONFIG_ELEMENT_ID}">([^<]*)</script>`).exec(snippet);
  if (!m) throw new Error('no inline config in the snippet');
  return JSON.parse(m[1]);
}

function party(partyId: string, label: string, categories: string[], over: Partial<PartyInventoryItem> = {}): PartyInventoryItem {
  return {
    partyId,
    label,
    domain: partyId.replace(/^unknown:/, ''),
    hosts: [partyId.replace(/^unknown:/, '')],
    recognized: !partyId.startsWith('unknown:'),
    kbStatus: partyId.startsWith('unknown:') ? 'unrecognized' : 'confirmed',
    categories,
    behavesLikeTracker: false,
    trackerSignals: [],
    sends: [],
    stores: [],
    sources: [],
    loadedBy: [],
    samples: [],
    seenIn: [],
    implementation: { class: 'unknown', evidence: [], alsoSeen: [] },
    ...over,
  };
}

function workspace(entries: Record<string, unknown>): WorkspaceSnapshot {
  return { domain: 'example-shop.test', entries: Object.fromEntries(Object.entries(entries).map(([k, value]) => [k, { value, at: NOW, by: 'Ann' }])), runs: [] };
}

describe('the generated config validates (D2)', () => {
  const r = gen();

  it('the JSON file and the snippet’s inline config both parse against the schema, and the hash verifies', () => {
    for (const raw of [JSON.parse(r.json), inlineConfig(r.snippet)]) {
      const p = parseConsentToolConfig(raw);
      expect(p.ok).toBe(true);
      if (p.ok) {
        expect(p.version).toBe('current');
        expect(p.hashMatches).toBe(true);
      }
      expect(guardConsentToolConfig(raw).ok).toBe(true); // what the client itself checks
    }
    expect(inlineConfig(r.snippet)).toEqual(r.config);
  });

  it('generatedFrom names the run, the registrable domain, the versions', () => {
    expect(r.config.generatedFrom).toEqual({ runId: 'b2-fixture', at: NOW, site: 'example-shop.test', complykit: '0.0.0-test', kb: '0' });
  });

  it('the snippet loads the self-hosted placeholder path; the record endpoint is omitted unless asked', () => {
    expect(r.snippet).toContain(`<script src="${DEFAULT_SCRIPT_SRC}"></script>`);
    expect(r.snippet).toMatch(/PLACEHOLDER/);
    expect(r.config.record).toBeUndefined();
    expect(gen(undefined, { recordEndpoint: '/consent-record' }).config.record).toEqual({ endpoint: '/consent-record' });
    expect(gen(undefined, { scriptSrc: '/assets/ck/complykit-consent.js' }).snippet).toContain('<script src="/assets/ck/complykit-consent.js"></script>');
  });

  it('defaults: empty theme and strings (the tool’s defaults per regime), bar layout, 365 days', () => {
    expect(r.config.theme).toEqual({});
    expect(r.config.strings).toEqual({});
    expect(r.config.layout).toBe('bar');
    expect(r.config.consent).toEqual({ lifetimeDays: 365 });
  });

  it('no text says "compliant"', () => {
    for (const s of [r.snippet, r.notesMarkdown, r.json]) expect(containsBannedVocabulary(s)).toBe(false);
  });
});

describe('categories and vendors', () => {
  const r = gen();
  const v = (id: string) => r.config.vendors.find((x) => x.id === id);

  it('categories present only: the tools seen, in order, with necessary first', () => {
    expect(r.config.categories.map((c) => c.id)).toEqual(['necessary', 'analytics', 'advertising']);
    expect(r.config.categories.find((c) => c.id === 'advertising')!.defaultByRegime).toEqual({ 'opt-in': false, 'opt-out-signal': true, 'opt-out': true });
  });

  it('control per verdict: gateable+adapter → api, GTM → api via its adapter, platform → platform, leak → api with a note, CDN → necessary/none', () => {
    expect(v('google.analytics')).toMatchObject({ category: 'analytics', control: 'api', adapter: 'google-consent-mode' });
    expect(v('tiktok.pixel')).toMatchObject({ category: 'advertising', control: 'api', adapter: 'tiktok' });
    expect(v('google.ads.ccm')).toMatchObject({ category: 'advertising', control: 'platform' });
    expect(v('meta.pixel')).toMatchObject({ category: 'advertising', control: 'api', adapter: 'meta' });
    expect(v('meta.pixel')!.note).toMatch(/nothing holds its load/);
    expect(v('cloudflare')).toMatchObject({ category: 'necessary', control: 'none', stores: [] });
  });

  it('unclassified tools go to the strictest category, uncontrolled, with a note', () => {
    expect(v('unknown:tracker.test')).toMatchObject({ category: 'advertising', control: 'none' });
    expect(r.notes.find((n) => n.code === 'unclassified-strictest')!.partyIds).toEqual(['unknown:tracker.test']);
    expect(r.notes.find((n) => n.code === 'loader-not-identified' && n.partyIds?.includes('unknown:tracker.test'))).toBeDefined();
  });

  it('stores come from the knowledge base (withdrawal cleanup)', () => {
    expect(v('meta.pixel')!.stores.length).toBeGreaterThan(0);
    expect(v('meta.pixel')!.stores.every((s) => { new RegExp(s.name); return true; })).toBe(true);
  });

  it('platform bridge from the fingerprint; Shopify reads the region from the platform, others from <meta> with a note', () => {
    expect(r.config.platform).toBe('shopify');
    expect(r.config.regimeSource).toEqual({ kind: 'platform' });
    const e = compatibilityEvaluation();
    delete e.platform;
    e.inventory = e.inventory.filter((p) => p.partyId !== 'google.ads.ccm'); // a platform tool needs a platform
    const o = gen(e);
    expect(o.config.platform).toBe('none');
    expect(o.config.regimeSource).toEqual({ kind: 'meta', name: 'complykit-region' });
    expect(o.notes.find((n) => n.code === 'regime-source')).toMatchObject({ level: 'flag' });
  });

  it('a tag manager and an existing consent tool are not vendors', () => {
    const e = compatibilityEvaluation();
    e.inventory.push(party('google.tag-manager', 'Google Tag Manager', ['tag-manager']), party('cookieyes', 'CookieYes', ['consent']));
    const o = gen(e);
    expect(o.config.vendors.map((x) => x.id)).not.toContain('google.tag-manager');
    expect(o.config.vendors.map((x) => x.id)).not.toContain('cookieyes');
    expect(o.notes.map((n) => n.code)).toEqual(expect.arrayContaining(['tag-manager-not-vendor', 'existing-consent-tool']));
  });
});

describe("control 'gate' names something that holds it (#49)", () => {
  const GTM = 'https://www.googletagmanager.com/gtm.js?id=GTM-XXXX01';
  const viaGtm = { class: 'gtm' as const, evidence: [{ class: 'gtm' as const, kind: 'loader' as const, observed: true, url: GTM, note: `loaded by the GTM container ${GTM}` }], alsoSeen: [] };

  it('a font vendor reached only through a stylesheet / @font-face (no tag maps to it) is none, with a self-host note and no gate rule', () => {
    const e = compatibilityEvaluation();
    e.inventory.push(party('google.fonts', 'Google Fonts', ['fonts'], { implementation: viaGtm }));
    e.markup!.findings.push({ partyId: 'google.fonts', label: 'Google Fonts', recognized: true, verdict: 'leak', trigger: 'page-load', kind: 'link', context: 'document', page: PAGE, line: 9, url: 'https://fonts.googleapis.com/css2?family=X', inline: false, attributes: { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=X' }, matchedBy: 'host', match: 'fonts.googleapis.com', locations: ['de'], alsoOn: [], occurrences: 1 });
    const r = gen(e);
    const v = r.config.vendors.find((x) => x.id === 'google.fonts')!;
    expect(v).toMatchObject({ category: 'functional', control: 'none' });
    expect(v.note).toMatch(/self-host/);
    expect(r.config.gate.some((g) => g.vendor === 'google.fonts')).toBe(false);
    expect(r.config.gtm?.tags.some((t) => t.vendor === 'google.fonts')).toBe(false);
    expect(r.notes.find((n) => n.code === 'not-controlled' && n.partyIds?.includes('google.fonts'))!.message).toMatch(/self-host/);
  });

  it('a GTM-loaded vendor whose tag maps in the container stays gate', () => {
    const e = compatibilityEvaluation();
    e.inventory.push(party('hotjar', 'Hotjar', ['session-recording'], { implementation: viaGtm }));
    e.containers![0].tags.push({ ...structuredClone(e.containers![0].tags[0]), tagId: 8, index: 1, partyId: 'hotjar' });
    const r = gen(e);
    expect(r.config.vendors.find((x) => x.id === 'hotjar')).toMatchObject({ control: 'gate' });
    expect(r.config.gtm!.tags.some((t) => t.vendor === 'hotjar')).toBe(true);
  });

  it('a GTM-loaded vendor no container tag maps to is none (nothing in the config holds it)', () => {
    const e = compatibilityEvaluation();
    e.inventory.push(party('hotjar', 'Hotjar', ['session-recording'], { implementation: viaGtm }));
    const v = gen(e).config.vendors.find((x) => x.id === 'hotjar')!;
    expect(v.control).toBe('none');
    expect(v.note).toMatch(/nothing in the config holds it/);
  });
});

describe('a fingerprinted consent plugin', () => {
  it('is flagged for removal even though it is no outside party (E4)', () => {
    const e = compatibilityEvaluation();
    e.platform = { name: 'wordpress', consentPlugin: 'webtoffee-cookie-consent', evidence: ['plugin path'] };
    e.inventory = e.inventory.filter((p) => p.partyId !== 'google.ads.ccm');
    const n = gen(e).notes.find((x) => x.code === 'existing-consent-tool');
    expect(n).toMatchObject({ level: 'flag' });
    expect(n!.message).toMatch(/webtoffee-cookie-consent/);
    expect(n!.message).toMatch(/accept visit/);
  });

  it("Shopify's Customer Privacy API is not a tool to remove", () => {
    const e = compatibilityEvaluation();
    e.platform = { name: 'shopify', consentPlugin: 'shopify-customer-privacy', evidence: ['window.Shopify'] };
    expect(gen(e).notes.find((x) => x.code === 'existing-consent-tool')).toBeUndefined();
  });
});

describe('a known tracker is never necessary', () => {
  it('a workspace classification of a known tracker as necessary is refused — config and change list agree', () => {
    const e = compatibilityEvaluation();
    const ws = workspace({ [classificationKey({ kind: 'tool', partyId: 'meta.pixel', domain: 'meta.test', recognized: true })]: { category: 'necessary', categoryChosen: true } });
    const r = gen(e, { workspace: ws });
    const meta = r.config.vendors.find((x) => x.id === 'meta.pixel')!;
    expect(meta.category).toBe('advertising');
    expect(r.notes.find((n) => n.code === 'refused-necessary')).toMatchObject({ level: 'refused', partyIds: ['meta.pixel'] });
    expect(r.notes.find((n) => n.code === 'refused-necessary')!.message).toMatch(/knowledge-base entry classifies it as advertising/);
    expect(r.changeList).toContain('Meta Pixel'); // still in the change list: it needs consent
  });

  it('an unrecognized tool that behaves like a tracker cannot be classified necessary', () => {
    const e = compatibilityEvaluation();
    e.inventory.find((p) => p.partyId === 'unknown:tracker.test')!.trackerSignals = ['sends-stored-id'];
    const ws = workspace({ [classificationKey({ kind: 'tool', partyId: 'unknown:tracker.test', domain: 'tracker.test', recognized: false })]: { category: 'necessary', categoryChosen: true } });
    const r = gen(e, { workspace: ws });
    expect(r.config.vendors.find((x) => x.id === 'unknown:tracker.test')!.category).toBe('advertising');
    expect(r.notes.some((n) => n.code === 'refused-necessary' && n.partyIds?.includes('unknown:tracker.test'))).toBe(true);
  });

  it('a stale record that calls a KB tracker a CDN is refused too', () => {
    const e = compatibilityEvaluation();
    e.inventory.find((p) => p.partyId === 'google.analytics')!.categories = ['cdn'];
    const notes = refuseNecessaryTrackers(e, DEFAULT_KB);
    expect(notes.map((n) => n.partyIds)).toEqual([['google.analytics']]);
    expect(e.inventory.find((p) => p.partyId === 'google.analytics')!.categories).toEqual(['analytics']);
  });

  it('no generated variant ever leaves a known tracker in necessary', () => {
    const variants = [compatibilityEvaluation(), (() => { const e = compatibilityEvaluation(); for (const p of e.inventory) p.categories = ['necessary']; return e; })()];
    for (const e of variants) {
      const r = gen(e);
      for (const v of r.config.vendors.filter((x) => x.category === 'necessary')) {
        expect(knownTrackerReason(e.inventory.find((p) => p.partyId === v.id)!, DEFAULT_KB)).toBeUndefined();
      }
    }
  });

  it('a necessary tool that behaved like a tracker stays necessary (per its KB entry) but is flagged', () => {
    const r = gen();
    expect(r.notes.find((n) => n.code === 'necessary-behaves-like-tracker')!.partyIds).toEqual(['cloudflare']);
  });

  it('a workspace classification of an unclassified tool is applied (no strictest-category note)', () => {
    const ws = workspace({ [classificationKey({ kind: 'tool', partyId: 'unknown:tracker.test', domain: 'tracker.test', recognized: false })]: { category: 'analytics', categoryChosen: true } });
    const r = gen(undefined, { workspace: ws });
    expect(r.config.vendors.find((x) => x.id === 'unknown:tracker.test')!.category).toBe('analytics');
    expect(r.notes.some((n) => n.code === 'unclassified-strictest')).toBe(false);
  });
});

describe('gate rules, rewrites and GTM', () => {
  const r = gen();

  it('every rewrite in the snippet is a change-list rewrite, with the vendor’s category', () => {
    const ga = r.rewrites.find((x) => x.partyIds.includes('google.analytics'))!;
    expect(ga).toMatchObject({ category: 'analytics', page: PAGE, line: 12, inline: false, optional: false });
    expect(r.snippet).toContain(ga.after!);
    expect(r.changeList).toContain(ga.after!);
    for (const rw of r.rewrites) {
      expect(r.config.categories.map((c) => c.id)).toContain(rw.category);
      for (const id of rw.partyIds) {
        const v = r.config.vendors.find((x) => x.id === id);
        if (v) expect(v.category).toBe(rw.category);
      }
    }
    // The inline pixel: edited in place, inside a comment (never pasted as placeholder code).
    const inline = r.rewrites.find((x) => x.partyIds.includes('meta.pixel'))!;
    expect(inline.inline).toBe(true);
    expect(r.snippet).not.toMatch(/\n<script type="text\/plain" data-category="advertising">…/);
  });

  it('gate rules match the rewritten data-src and name the vendor', () => {
    expect(r.config.gate).toEqual([{ category: 'analytics', src: '^(?:https?:)?//www\\.googletagmanager\\.com/gtag/js', vendor: 'google.analytics' }]);
    expect(new RegExp(r.config.gate[0].src!).test('https://www.googletagmanager.com/gtag/js?id=G-XXXX01')).toBe(true);
    expect(new RegExp(r.config.gate[0].src!).test('https://evil.test/www.googletagmanager.com/gtag/js')).toBe(false);
    expect(srcRule('//cdn.example.test/a.js?x=1')).toBe('^(?:https?:)?//cdn\\.example\\.test/a\\.js');
  });

  it('GTM: the container id, the tags the change list names, Consent Mode mapped to categories present', () => {
    expect(r.config.gtm).toEqual({
      containers: ['GTM-XXXX01'],
      dataLayer: 'dataLayer',
      consentMode: { security_storage: 'necessary', ad_storage: 'advertising', ad_user_data: 'advertising', ad_personalization: 'advertising', analytics_storage: 'analytics' },
      tags: [{ name: 'GTM-XXXX01 tag 7 (Custom template)', category: 'advertising', vendor: 'tiktok.pixel' }],
    });
  });

  it('an unmapped GTM tag is listed under the strictest category, with a note', () => {
    const e = compatibilityEvaluation();
    e.containers![0].tags.push({ tagId: 9, index: 1, template: '__html', templateLabel: 'Custom HTML', kind: 'tag', custom: false, paused: false, identifiers: [], loads: [], triggers: [], exceptions: [], events: [], firesOnPageLoad: true, consent: { status: 'none', additional: [], builtIn: [] } });
    const o = gen(e);
    expect(o.config.gtm!.tags).toContainEqual({ name: 'GTM-XXXX01 tag 9 (Custom HTML)', category: 'advertising' });
    expect(o.notes.find((n) => n.code === 'unmapped-gtm-tags')).toBeDefined();
  });

  it('a tag in the HTML for a tool that never ran is flagged, not silently dropped', () => {
    const e = compatibilityEvaluation();
    e.markup!.findings.push({ partyId: 'pinterest.tag', label: 'Pinterest Tag', recognized: true, verdict: 'gateable', trigger: 'page-load', kind: 'script', context: 'document', page: PAGE, line: 50, inline: true, attributes: {}, matchedBy: 'inline-pattern', match: 'pintrk(', locations: ['de'], alsoOn: [], occurrences: 1 });
    const o = gen(e);
    expect(o.config.vendors.some((v) => v.id === 'pinterest.tag')).toBe(false);
    expect(o.notes.find((n) => n.code === 'dormant-tags')!.message).toMatch(/Pinterest Tag \(\/:50 inline <script>\)/);
  });

  it('flags: a duplicated id, a synchronous script, document.write', () => {
    const e = compatibilityEvaluation();
    const f = e.markup!.findings.find((x) => x.partyId === 'google.analytics')!;
    f.attributes = { src: f.url!, id: 'ga-loader' }; // no async: synchronous
    const meta = e.markup!.findings.find((x) => x.partyId === 'meta.pixel' && x.inline)!;
    meta.match = 'document.write(';
    const o = gen(e);
    expect(o.notes.map((n) => n.code)).toEqual(expect.arrayContaining(['duplicate-id', 'document-write']));
    const ga = o.rewrites.find((x) => x.partyIds.includes('google.analytics'))!;
    expect(ga.flags.join(' ')).toMatch(/id="ga-loader".*moves the id to the working copy/);
    expect(ga.flags.join(' ')).toMatch(/synchronously/);
    expect(o.rewrites.find((x) => x.partyIds.includes('meta.pixel'))!.flags.join(' ')).toMatch(/cannot be gated as written/);
  });
});

describe('document.write (D4 review, D10 follow-up)', () => {
  it('a snippet whose served body calls document.write is flagged from the markup finding, not only the matched text', () => {
    const e = compatibilityEvaluation();
    const meta = e.markup!.findings.find((x) => x.partyId === 'meta.pixel' && x.inline)!;
    expect(meta.match).not.toMatch(/document\.write/); // the matched text is the vendor's pattern, never the body
    expect(gen(e).notes.some((n) => n.code === 'document-write' && n.partyIds?.includes('meta.pixel'))).toBe(false);
    meta.documentWrite = true;
    const o = gen(e);
    expect(o.notes.find((n) => n.code === 'document-write' && n.partyIds?.includes('meta.pixel'))!.message).toContain('not gateable asynchronously');
    expect(o.rewrites.find((x) => x.partyIds.includes('meta.pixel'))!.flags.join(' ')).toMatch(/cannot be gated as written/);
  });

  it('the markup parser reads document.write from the whole inline body; it survives truncation and redaction', () => {
    const pad = 'x'.repeat(20000);
    const els = parseMarkup(`<html><head><script>var a="${pad}";document.write('<script src="https://ads.example/t.js"><\\/script>');</script><script>fbq('init','1')</script></head></html>`, 'https://shop.test/');
    expect(els[0].documentWrite).toBe(true);
    expect(els[0].body!.length).toBeLessThan(20000);
    expect(els[1].documentWrite).toBeUndefined();
    const [page] = redactMarkupPages([{ url: 'https://shop.test/', pageIndex: 0, status: 'inspected', elements: els }]);
    expect(page.elements[0]).toMatchObject({ documentWrite: true });
    expect(page.elements[0].body).toBeUndefined();
  });
});

describe('the snippet', () => {
  it('inline JSON cannot break out of its <script>', () => {
    const e = compatibilityEvaluation();
    e.inventory.find((p) => p.partyId === 'unknown:tracker.test')!.label = 'x</script><script>alert(1)</script>';
    const r = gen(e);
    expect(r.snippet).not.toContain('x</script>');
    expect(scriptJson({ a: '</script><!--' })).toBe('{"a":"\\u003c/script>\\u003c!--"}');
    expect(parseConsentToolConfig(inlineConfig(r.snippet)).ok).toBe(true);
  });

  it('snapshot: config + snippet for the fixture', () => {
    const r = gen();
    expect(r.json).toMatchSnapshot('complykit-config.json');
    expect(r.snippet).toMatchSnapshot('snippet.html');
    expect(r.notesMarkdown).toMatchSnapshot('generator-notes.md');
  });

  it('is deterministic', () => {
    expect(gen().json).toBe(gen().json);
  });
});

describe('complykit consent-config (CLI wiring)', () => {
  it('writes the four files from a run directory', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-d8-'));
    const run = path.join(tmp, 'run');
    writeTrackingEvaluation(run, compatibilityEvaluation());
    const out = path.join(tmp, 'out');
    const write = process.stdout.write;
    let printed = '';
    process.stdout.write = ((s: string) => ((printed += s), true)) as typeof process.stdout.write;
    try {
      expect(await cmdConsentConfig([run, '--out', out, '--kb-dir', path.join(tmp, 'kb'), '--json'])).toBe(0);
    } finally {
      process.stdout.write = write;
    }
    expect(fs.readdirSync(out).filter((f) => f !== 'complykit').sort()).toEqual(['change-list.md', 'complykit-config.json', 'generator-notes.md', 'remediation-tasks.json', 'snippet.html']);
    const body = JSON.parse(printed) as { config: unknown; changeList: string; snippet: string };
    expect(parseConsentToolConfig(body.config).ok).toBe(true);
    expect(body.changeList).toBe(fs.readFileSync(path.join(out, 'change-list.md'), 'utf8'));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function run(args: string[]): Promise<{ code: number; printed: string }> {
    const write = process.stdout.write;
    let printed = '';
    process.stdout.write = ((s: string) => ((printed += s), true)) as typeof process.stdout.write;
    try {
      return { code: await cmdConsentConfig(args), printed };
    } finally {
      process.stdout.write = write;
    }
  }

  it('copies the two client files under complykit/v1/ (or the --script-src folder) from --client-dist', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-r5-'));
    const runDir = path.join(tmp, 'run');
    writeTrackingEvaluation(runDir, compatibilityEvaluation());
    const dist = path.join(tmp, 'dist');
    fs.mkdirSync(dist);
    fs.writeFileSync(path.join(dist, 'complykit-consent.js'), '/* core */');
    fs.writeFileSync(path.join(dist, 'complykit-consent-ui.js'), '/* ui */');
    const common = ['--kb-dir', path.join(tmp, 'kb'), '--client-dist', dist, '--json'];

    const out = path.join(tmp, 'out');
    expect((await run([runDir, '--out', out, ...common])).code).toBe(0);
    expect(fs.readFileSync(path.join(out, 'complykit', 'v1', 'complykit-consent.js'), 'utf8')).toBe('/* core */');
    expect(fs.readFileSync(path.join(out, 'complykit', 'v1', 'complykit-consent-ui.js'), 'utf8')).toBe('/* ui */');

    const out2 = path.join(tmp, 'out2');
    expect((await run([runDir, '--out', out2, '--script-src', '/assets/ck/consent.js', ...common])).code).toBe(0);
    expect(fs.existsSync(path.join(out2, 'assets', 'ck', 'consent.js'))).toBe(true);
    expect(fs.existsSync(path.join(out2, 'assets', 'ck', 'complykit-consent-ui.js'))).toBe(true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('skips the client files with a note when the dist is missing', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-r5-'));
    const runDir = path.join(tmp, 'run');
    writeTrackingEvaluation(runDir, compatibilityEvaluation());
    const out = path.join(tmp, 'out');
    const r = await run([runDir, '--out', out, '--kb-dir', path.join(tmp, 'kb'), '--client-dist', path.join(tmp, 'nope'), '--json']);
    expect(r.code).toBe(0);
    const body = JSON.parse(r.printed) as { clientFiles: string[]; clientNote: string };
    expect(body.clientFiles).toEqual([]);
    expect(body.clientNote).toMatch(/client files not found/);
    expect(fs.existsSync(path.join(out, 'complykit'))).toBe(false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// complykit#47 + #48 (test/fixtures/gtm-datalayer-config.ts): data: URL tags get a
// rewrite that keeps the URL in data-src; a G- destination GTM loads from the
// page's gtag('config') command is held by rewriting that snippet — never by a
// "require consent on tag N" that has no tag.
describe('data: URL tags and a destination GTM loads from gtag(config) (#47, #48)', () => {
  const ev = dataLayerConfigEvaluation();
  const r = gen(ev);
  const model = buildConsentReportModel({ ...ev, compatibility: reconcileCompatibility(ev, {}) }, []);
  const report = model.compatibility!;
  const rewrite = report.groups.find((g) => g.id === 'rewrite')!;
  const item = (line: number) => rewrite.items.find((i) => i.line === line)!;

  it('B1/B2: the config snippet is a rewrite item with the why; no GTM tag item and no consent-on-tag claim for the destination', () => {
    const ga = item(10);
    expect(ga).toMatchObject({ kind: 'rewrite-tag', partyIds: ['google.analytics'], category: 'analytics' });
    expect(ga.after).toBe('<script type="text/plain" data-category="analytics" data-src="data:text/javascript;base64,…" defer></script>');
    expect(ga.notes!.join(' ')).toMatch(/pushes gtag\('config', 'G-TEST0001X'\) into the dataLayer — no tag in the container carries G-TEST0001X/);
    expect(report.groups.find((g) => g.id === 'gtm')?.items.some((i) => i.partyIds.includes('google.analytics')) ?? false).toBe(false);
    expect(report.groups.find((g) => g.id === 'consent-default')!.items[0].partyIds).toContain('google.analytics');
    const row = report.rows.find((x) => x.partyId === 'google.analytics')!;
    expect(row.whatToChange).not.toMatch(/GTM tag/);
    expect(row.verdictLabel).toMatch(/gtag\('config'\) snippet/);
    expect(r.changeList).not.toMatch(/GTM-XXXX01 · tag/);
  });

  it('B2: the gtag.js loader rewrite says holding it alone is not enough, and points at the snippet', () => {
    expect(item(9).notes!.join(' ')).toMatch(/Holding this loader is not enough while a Google Tag Manager container is on the page: GTM loads G-TEST0001X itself .* gate that snippet too \(\/:10/);
  });

  it('#47: Meta, GTM and TikTok data: URL tags each get a rewrite that moves the data: URL to data-src', () => {
    expect(item(11)).toMatchObject({ partyIds: ['meta.pixel'], element: '<script src="data:…">', after: '<script type="text/plain" data-category="advertising" data-src="data:text/javascript;base64,…" defer></script>' });
    expect(item(8).partyIds).toEqual(['google.tag-manager']);
    expect(item(13).after).toBe('<script type="text/plain" data-category="advertising" data-src="data:text/javascript,…"></script>');
    for (const l of [8, 10, 11, 13]) expect(item(l).notes!.join(' '), `line ${l}`).toMatch(/“…” stands for the existing value — move it unchanged to data-src/);
    expect(model.compatibility!.rows.find((x) => x.partyId === 'tiktok.pixel')!.verdict).toBe('gateable');
  });

  it('D8: snippet rewrites carry the notes; no gate rule from a data: URL; nothing in gtm.tags for the destination', () => {
    const ga = r.rewrites.find((x) => x.line === 10)!;
    expect(ga).toMatchObject({ inline: false, category: 'analytics', after: '<script type="text/plain" data-category="analytics" data-src="data:text/javascript;base64,…" defer></script>' });
    expect(ga.flags.join(' ')).toMatch(/no tag in the container carries G-TEST0001X/);
    expect(r.config.gate.every((g) => !String(g.src ?? '').includes('data'))).toBe(true);
    expect(r.config.gtm!.tags).toEqual([]);
    expect(r.config.gtm!.consentMode.analytics_storage).toBe('analytics');
    expect(r.config.vendors.find((v) => v.id === 'google.analytics')!.note).toMatch(/held once its gtag\('config'\) snippet is rewritten/);
    expect(r.notes.map((n) => n.code)).toEqual(expect.arrayContaining(['gtag-config-via-gtm', 'data-url-tag', 'gtm-loader-gated']));
    expect(r.notes.find((n) => n.code === 'gtm-loader-gated' && n.partyIds?.includes('google.tag-manager') && /\/:8/.test(n.message))!.level).toBe('flag');
    expect(r.snippet).toContain('data-src="data:text/javascript;base64,…"');
  });

  it('no data: URL payload and no client material reaches the outputs', () => {
    const out = `${r.changeList}${r.snippet}${r.notesMarkdown}${r.json}`;
    expect(out).not.toMatch(/base64,[A-Za-z0-9+/]{8}/);
    expect(out).not.toMatch(/fbq\('init'/);
    expect(containsBannedVocabulary(out)).toBe(false);
  });
});
