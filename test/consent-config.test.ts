import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONSENT_CONFIG_VERSION,
  CONSENT_CONFIG_MAJOR,
  NECESSARY_CATEGORY,
  REGIMES,
  canonicalJson,
  hashConsentToolConfig,
  withConsentConfigHash,
  parseConsentToolConfig,
  guardConsentToolConfig,
  consentConfigVersionStatus,
  readConsentConfigHeader,
  CONSENT_CONFIG_ELEMENT_ID,
  consentCategoryDefault,
  consentToolConfigJsonSchema,
  type ConsentToolConfig,
  type ConsentToolConfigInput,
} from '../src/index.js';

// D2: the config contract. Schema invariants, round trip (generate → serialize →
// parse → equal, hash stable), the migration policy, and freshness of the
// emitted JSON Schema + example fixture. `UPDATE_SCHEMA=1 npx vitest run
// test/consent-config.test.ts` rewrites both files from the source of truth.

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const SCHEMA_FILE = path.join(ROOT, 'schema', 'consent-tool-config.schema.json');
const EXAMPLE_FILE = path.join(ROOT, 'test', 'fixtures', 'consent-config', 'example.json');

/** A representative generator output for a GTM-heavy site (generic ids only). */
function exampleInput(): Omit<ConsentToolConfigInput, 'hash'> {
  return {
    version: CONSENT_CONFIG_VERSION,
    generatedFrom: { runId: '2026-10-06T00-00-00-000Z', at: '2026-10-06T00:00:00.000Z', site: 'example-shop.test', complykit: '0.0.0', kb: '2026-10-02' },
    regimeSource: { kind: 'header', header: 'cf-ipcountry', endpoint: '/.well-known/complykit-location' },
    categories: [
      { id: 'necessary', label: 'Necessary', description: 'Required for the site to work.', defaultByRegime: { 'opt-in': true, 'opt-out-signal': true, 'opt-out': true } },
      { id: 'analytics', label: 'Analytics', description: 'How the site is used.', defaultByRegime: { 'opt-in': false, 'opt-out-signal': true, 'opt-out': true } },
      { id: 'advertising', label: 'Advertising', description: 'Ads and measurement.', defaultByRegime: { 'opt-in': false, 'opt-out-signal': false, 'opt-out': true } },
    ],
    vendors: [
      { id: 'google.analytics', label: 'Google Analytics 4', category: 'analytics', control: 'api', adapter: 'google-consent-mode', stores: [{ name: '^_ga(_.+)?$' }] },
      { id: 'meta.pixel', label: 'Meta Pixel', category: 'advertising', control: 'api', adapter: 'meta', stores: [{ name: '^_fb[cp]$', kind: 'cookie' }] },
      { id: 'example.widget', label: 'Example widget', category: 'analytics', control: 'gate', stores: [] },
      { id: 'example.noscript-pixel', label: 'Example pixel (noscript img)', category: 'advertising', control: 'none', note: 'markup leak: <noscript><img>' },
    ],
    gate: [
      { category: 'analytics', src: '^https://widget\\.example-vendor\\.test/', vendor: 'example.widget' },
      { category: 'advertising', selector: 'script[data-ck-inline="meta"]', vendor: 'meta.pixel' },
    ],
    gtm: {
      containers: ['GTM-XXXX01'],
      consentMode: { analytics_storage: 'analytics', ad_storage: 'advertising', ad_user_data: 'advertising', ad_personalization: 'advertising', security_storage: 'necessary' },
      tags: [{ name: 'GA4 - config', category: 'analytics', vendor: 'google.analytics' }],
    },
    theme: { accent: '#2563eb', radius: '6px' },
    strings: { en: { 'banner.title': 'Your privacy choices', byRegime: { 'opt-out-signal': { 'optOut.link': 'Do Not Sell or Share My Personal Information' } } } },
    consent: { lifetimeDays: 180, cookieDomain: '.example-shop.test' },
    privacyPolicyUrl: 'https://example-shop.test/privacy',
    record: { endpoint: '/consent-record' },
    layout: 'bar',
  };
}

const stripHash = (c: ConsentToolConfig): Omit<ConsentToolConfig, 'hash'> => {
  const { hash: _h, ...rest } = c;
  return rest;
};

describe('consent tool config: schema', () => {
  it('accepts the example and fills defaults', () => {
    const cfg = withConsentConfigHash(exampleInput());
    expect(cfg.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(cfg.gtm?.dataLayer).toBe('dataLayer');
    expect(cfg.gtm?.tags[0]).toEqual({ name: 'GA4 - config', category: 'analytics', vendor: 'google.analytics' });
    expect(cfg.vendors[0]?.stores[0]).toEqual({ name: '^_ga(_.+)?$', kind: 'cookie' });
    expect(cfg.platform).toBe('none');
    expect(cfg.layout).toBe('bar');
  });

  it('fills every default when only the minimum is given', () => {
    const cfg = withConsentConfigHash({
      version: CONSENT_CONFIG_VERSION,
      generatedFrom: { runId: 'r', at: '2026-10-06T00:00:00.000Z', site: 'example-shop.test', complykit: '0.0.0' },
      regimeSource: { kind: 'meta' },
      categories: [{ id: 'necessary', label: 'Necessary', description: '', defaultByRegime: { 'opt-in': true, 'opt-out-signal': true, 'opt-out': true } }],
    });
    expect(cfg.regimeSource).toEqual({ kind: 'meta', name: 'complykit-region' });
    expect(cfg).toMatchObject({ vendors: [], gate: [], platform: 'none', theme: {}, strings: {}, consent: { lifetimeDays: 365 }, layout: 'bar' });
    expect(cfg.privacyPolicyUrl).toBeUndefined();
    expect(cfg.gtm).toBeUndefined();
    expect(cfg.record).toBeUndefined();
  });

  const invalid = (mutate: (c: ReturnType<typeof exampleInput>) => void, pathFragment: string) => {
    const input = exampleInput();
    mutate(input);
    const r = parseConsentToolConfig({ ...input, hash: '0'.repeat(64) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid');
    expect(r.issues.map((i) => i.path).join(' | ')).toContain(pathFragment);
  };

  it('requires the necessary category', () => invalid((c) => (c.categories = c.categories.filter((x) => x.id !== NECESSARY_CATEGORY)), 'categories'));
  it('necessary is always granted in every regime', () => invalid((c) => (c.categories[0]!.defaultByRegime['opt-out'] = false), 'categories.0.defaultByRegime.opt-out'));
  it('nothing else is granted by default under opt-in', () => invalid((c) => (c.categories[1]!.defaultByRegime['opt-in'] = true), 'categories.1.defaultByRegime.opt-in'));
  it('rejects duplicate category ids', () => invalid((c) => c.categories.push({ ...c.categories[1]! }), 'categories.3.id'));
  it('rejects a vendor in an unlisted category', () => invalid((c) => (c.vendors![0]!.category = 'social'), 'vendors.0.category'));
  it("control 'api' needs an adapter", () => invalid((c) => delete c.vendors![0]!.adapter, 'vendors.0.adapter'));
  it("control 'platform' needs a platform", () => invalid((c) => (c.vendors![2]!.control = 'platform'), 'vendors.2.control'));
  it('rejects duplicate vendor ids', () => invalid((c) => c.vendors!.push({ ...c.vendors![2]! }), 'vendors.4.id'));
  it('a gate rule needs src or selector', () => invalid((c) => c.gate!.push({ category: 'analytics' }), 'gate.2'));
  it('a gate rule names a listed vendor', () => invalid((c) => (c.gate![0]!.vendor = 'nobody'), 'gate.0.vendor'));
  it('GTM container ids are GTM-…', () => invalid((c) => (c.gtm!.containers = ['G-ABC']), 'gtm.containers.0'));
  it('GTM consent-mode mappings name a listed category', () => invalid((c) => (c.gtm!.consentMode = { ad_storage: 'ads' }), 'gtm.consentMode.ad_storage'));
  it("regimeSource 'platform' needs a platform", () => invalid((c) => (c.regimeSource = { kind: 'platform' }), 'regimeSource'));
  it('header endpoint must be same-origin', () => invalid((c) => (c.regimeSource = { kind: 'header', header: 'x', endpoint: 'https://geo.example/x' }), 'regimeSource.endpoint'));
  it('category ids are lower-case slugs', () => invalid((c) => (c.categories[1]!.id = 'Analytics'), 'categories.1.id'));
  it('language keys are BCP 47 tags', () => invalid((c) => (c.strings = { English: {} }), 'strings'));
  it('string tables refuse unknown keys', () => invalid((c) => (c.strings = { en: { 'banner.titel': 'x' } as never }), 'strings.en'));
  it('string tables refuse empty strings', () => invalid((c) => (c.strings = { en: { 'banner.reject': '' } }), 'strings.en.banner.reject'));
  it('per-regime string overrides are checked the same way', () => {
    invalid((c) => (c.strings = { en: { byRegime: { 'opt-in': { 'banner.accept': '' } } } }), 'strings.en.byRegime.opt-in.banner.accept');
    invalid((c) => (c.strings = { en: { byRegime: { notice: {} } as never } }), 'strings.en.byRegime');
  });
  it('consent lifetime is 1..395 days', () => {
    invalid((c) => (c.consent = { lifetimeDays: 396 }), 'consent.lifetimeDays');
    invalid((c) => (c.consent = { lifetimeDays: 0 }), 'consent.lifetimeDays');
  });
  it('privacyPolicyUrl must be https', () => invalid((c) => (c.privacyPolicyUrl = 'http://example-shop.test/privacy'), 'privacyPolicyUrl'));
  it('generatedFrom.site is a registrable domain', () => invalid((c) => (c.generatedFrom.site = 'https://example-shop.test'), 'generatedFrom.site'));
  it('store and gate regexes must compile', () => invalid((c) => (c.gate![0]!.src = '(unclosed'), 'gate.0.src'));
  it('tracking Consent Mode signals cannot be granted by necessary', () =>
    invalid((c) => (c.gtm!.consentMode = { ...c.gtm!.consentMode, analytics_storage: 'necessary' }), 'gtm.consentMode.analytics_storage'));

  it("accepts control 'platform' once a platform is set", () => {
    const input = exampleInput();
    input.platform = 'shopify';
    input.regimeSource = { kind: 'platform' };
    input.vendors![2]!.control = 'platform';
    expect(parseConsentToolConfig({ ...input, hash: '0'.repeat(64) }).ok).toBe(true);
  });
});

describe('consent tool config: round trip and hash', () => {
  it('generate → serialize → parse → deep equal, hash matches', () => {
    const generated = withConsentConfigHash(exampleInput());
    const wire = JSON.stringify(generated);
    const r = parseConsentToolConfig(JSON.parse(wire));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config).toEqual(generated);
    expect(r.hashMatches).toBe(true);
    expect(r.version).toBe('current');
    // Parsing is idempotent: the parsed form re-hashes to the same value.
    expect(hashConsentToolConfig(r.config)).toBe(generated.hash);
  });

  it('hash is independent of key order and of the hash field itself', () => {
    const a = withConsentConfigHash(exampleInput());
    const reordered = JSON.parse(canonicalJson(stripHash(a)));
    const shuffled = Object.fromEntries(Object.entries(reordered).reverse());
    expect(hashConsentToolConfig(shuffled as unknown as ConsentToolConfig)).toBe(a.hash);
    expect(hashConsentToolConfig({ ...a, hash: 'f'.repeat(64) })).toBe(a.hash);
  });

  it('a hand edit after generation is detected', () => {
    const a = withConsentConfigHash(exampleInput());
    const edited = { ...a, layout: 'modal' as const };
    const r = parseConsentToolConfig(edited);
    expect(r.ok && r.hashMatches).toBe(false);
    // …and re-stamping fixes it.
    expect(parseConsentToolConfig(withConsentConfigHash(edited)).ok && true).toBe(true);
  });

  it('an older or newer minor is not mistaken for a hand edit', () => {
    // Deployed bytes carry a field this build does not know (newer minor); its hash
    // was stamped over those bytes. Parsing strips the field; the hash must still match.
    const { hash: _h, ...rest } = withConsentConfigHash(exampleInput());
    const deployed = { ...rest, version: `${CONSENT_CONFIG_MAJOR}.99`, futureField: { x: 1 } };
    const stamped = { ...deployed, hash: hashConsentToolConfig(deployed as unknown as ConsentToolConfig) };
    const r = parseConsentToolConfig(JSON.parse(JSON.stringify(stamped)));
    expect(r.ok && r.version === 'newer-minor' && r.hashMatches).toBe(true);
  });

  it('canonical JSON sorts keys recursively and drops undefined', () => {
    expect(canonicalJson({ b: [{ z: 1, a: undefined, m: 2 }], a: 'x', c: undefined })).toBe('{"a":"x","b":[{"m":2,"z":1}]}');
  });
});

describe('consent tool config: migration policy', () => {
  const current = () => withConsentConfigHash(exampleInput());
  const major = CONSENT_CONFIG_MAJOR;

  it('refuses a newer major (tool and parser)', () => {
    const cfg = { ...current(), version: `${major + 1}.0` };
    const p = parseConsentToolConfig(cfg);
    expect(p.ok).toBe(false);
    expect(!p.ok && p.reason).toBe('newer-major');
    const g = guardConsentToolConfig(cfg);
    expect(!g.ok && g.reason).toBe('newer-major');
  });

  it('refuses an older major (no migration exists)', () => {
    const cfg = { ...current(), version: `${major - 1}.9` };
    expect(parseConsentToolConfig(cfg)).toMatchObject({ ok: false, reason: 'older-major' });
    expect(guardConsentToolConfig(cfg)).toMatchObject({ ok: false, reason: 'older-major' });
  });

  it('accepts a newer minor (additive) and reports it', () => {
    const cfg = { ...current(), version: `${major}.99`, futureField: { anything: true } };
    const p = parseConsentToolConfig(cfg);
    expect(p.ok && p.version).toBe('newer-minor');
    expect(p.ok && 'futureField' in p.config).toBe(false); // unknown keys stripped
    const g = guardConsentToolConfig(cfg);
    expect(g.ok && g.version).toBe('newer-minor');
  });

  it('flags an older minor without refusing it', () => {
    const minor = Number(CONSENT_CONFIG_VERSION.split('.')[1]);
    if (minor === 0) {
      // No older minor exists yet; the status function still knows the shape.
      expect(consentConfigVersionStatus(`${major}.0`)).toBe('current');
      return;
    }
    const cfg = { ...current(), version: `${major}.${minor - 1}` };
    expect(parseConsentToolConfig(cfg)).toMatchObject({ ok: true, version: 'older-minor' });
    expect(guardConsentToolConfig(cfg)).toMatchObject({ ok: true, version: 'older-minor' });
  });

  it('version status covers every case', () => {
    expect(consentConfigVersionStatus(undefined)).toBe('invalid');
    expect(consentConfigVersionStatus('1')).toBe('invalid');
    expect(consentConfigVersionStatus('v1.0')).toBe('invalid');
    expect(consentConfigVersionStatus(`${major}.0`)).toBe(minorOf() === 0 ? 'current' : 'older-minor');
    expect(consentConfigVersionStatus(`${major}.${minorOf() + 1}`)).toBe('newer-minor');
    expect(consentConfigVersionStatus(`${major + 1}.0`)).toBe('newer-major');
    expect(consentConfigVersionStatus(`${major - 1}.0`)).toBe('older-major');
    function minorOf() {
      return Number(CONSENT_CONFIG_VERSION.split('.')[1]);
    }
  });

  it('the header is readable even when the parser refuses', () => {
    const cfg = withConsentConfigHash(exampleInput());
    const newer = { ...cfg, version: `${major + 1}.0`, categories: 'garbage' };
    expect(parseConsentToolConfig(newer).ok).toBe(false);
    expect(readConsentConfigHeader(newer)).toEqual({ version: `${major + 1}.0`, hash: cfg.hash, generatedFrom: cfg.generatedFrom });
    expect(readConsentConfigHeader({ version: 7, hash: 'x', generatedFrom: { runId: 'r', at: 1 } })).toEqual({ hash: 'x', generatedFrom: { runId: 'r' } });
    expect(readConsentConfigHeader(null)).toEqual({});
    expect(readConsentConfigHeader('{}')).toEqual({});
  });

  it('an invalid version is "invalid", not refused as a major', () => {
    expect(parseConsentToolConfig({ ...current(), version: 'latest' })).toMatchObject({ ok: false, reason: 'invalid', version: 'invalid' });
    expect(guardConsentToolConfig({ ...current(), version: 'latest' })).toMatchObject({ ok: false, reason: 'invalid-version' });
  });
});

describe('consent tool config: the dependency-free guard', () => {
  it('names the config element', () => expect(CONSENT_CONFIG_ELEMENT_ID).toBe('complykit-config'));
  it('requires consent.lifetimeDays and generatedFrom.site', () => {
    const cfg = withConsentConfigHash(exampleInput());
    expect(guardConsentToolConfig({ ...cfg, consent: {} })).toMatchObject({ ok: false, reason: 'missing-field' });
    expect(guardConsentToolConfig({ ...cfg, generatedFrom: { runId: 'r' } })).toMatchObject({ ok: false, reason: 'missing-field' });
  });
  it('passes a generated config', () => {
    const g = guardConsentToolConfig(withConsentConfigHash(exampleInput()));
    expect(g.ok).toBe(true);
  });
  it.each([
    ['not-an-object', null],
    ['not-an-object', [1]],
    ['missing-field', { version: '1.0' }],
    ['missing-field', { ...withConsentConfigHash(exampleInput()), categories: [] }],
    ['missing-field', { ...withConsentConfigHash(exampleInput()), categories: [{ id: 'analytics', defaultByRegime: {} }] }],
    ['missing-field', { ...withConsentConfigHash(exampleInput()), vendors: 'none' }],
    ['missing-field', { ...withConsentConfigHash(exampleInput()), layout: undefined }],
    ['missing-field', { ...withConsentConfigHash(exampleInput()), categories: [...withConsentConfigHash(exampleInput()).categories, { id: 'ads', defaultByRegime: { 'opt-in': true, 'opt-out-signal': true, 'opt-out': true } }] }],
    ['missing-field', { ...withConsentConfigHash(exampleInput()), regimeSource: { kind: 'fixed', regime: 'gdpr' } }],
    ['missing-field', { ...withConsentConfigHash(exampleInput()), vendors: [{ id: 'x', category: 'analytics', control: 'gate' }] }],
    ['missing-field', { ...withConsentConfigHash(exampleInput()), gate: [{ category: 'analytics' }] }],
    ['missing-field', { ...withConsentConfigHash(exampleInput()), gtm: { containers: ['GTM-XXXX01'] } }],
    ['missing-field', { ...withConsentConfigHash(exampleInput()), record: '/consent' }],
  ])('refuses %s', (reason, raw) => {
    const g = guardConsentToolConfig(raw);
    expect(g.ok).toBe(false);
    expect(!g.ok && g.reason).toBe(reason);
  });
});

describe('consent tool config: category semantics (fail closed)', () => {
  const cfg = withConsentToolConfig();
  function withConsentToolConfig() {
    return withConsentConfigHash(exampleInput());
  }
  it('necessary is granted everywhere, even if the config forgot to list it', () => {
    for (const r of REGIMES) expect(consentCategoryDefault(cfg, NECESSARY_CATEGORY, r)).toBe(true);
    const without = { ...cfg, categories: cfg.categories.filter((c) => c.id !== NECESSARY_CATEGORY) };
    expect(consentCategoryDefault(without, NECESSARY_CATEGORY, 'opt-in')).toBe(true);
  });
  it('an unknown category is denied in every regime', () => {
    for (const r of REGIMES) expect(consentCategoryDefault(cfg, 'social', r)).toBe(false);
  });
  it('nothing but necessary is granted under opt-in, even if the config says so', () => {
    const tampered = { ...cfg, categories: cfg.categories.map((c) => ({ ...c, defaultByRegime: { 'opt-in': true, 'opt-out-signal': true, 'opt-out': true } })) };
    expect(consentCategoryDefault(tampered, 'analytics', 'opt-in')).toBe(false);
    // A regime this build does not know is treated as opt-in.
    expect(consentCategoryDefault(tampered, 'analytics', 'notice' as never)).toBe(false);
  });
  it('listed categories follow their per-regime defaults', () => {
    expect(consentCategoryDefault(cfg, 'analytics', 'opt-in')).toBe(false);
    expect(consentCategoryDefault(cfg, 'analytics', 'opt-out')).toBe(true);
    expect(consentCategoryDefault(cfg, 'analytics', 'opt-out-signal')).toBe(true);
    expect(consentCategoryDefault(cfg, 'advertising', 'opt-out-signal')).toBe(false);
    expect(consentCategoryDefault(cfg, 'advertising', 'opt-out')).toBe(true);
    expect(consentCategoryDefault(cfg, 'advertising', 'notice' as never)).toBe(false); // unknown regime ⇒ strictest
  });
});

describe('consent tool config: emitted artifacts are fresh', () => {
  const update = process.env.UPDATE_SCHEMA === '1';
  const pretty = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

  it('schema/consent-tool-config.schema.json matches the zod schema', () => {
    const want = pretty(consentToolConfigJsonSchema());
    if (update) {
      fs.mkdirSync(path.dirname(SCHEMA_FILE), { recursive: true });
      fs.writeFileSync(SCHEMA_FILE, want);
    }
    expect(fs.existsSync(SCHEMA_FILE), 'run UPDATE_SCHEMA=1 npx vitest run test/consent-config.test.ts').toBe(true);
    expect(fs.readFileSync(SCHEMA_FILE, 'utf8')).toBe(want);
  });

  it('the JSON Schema says what the zod schema says', () => {
    const s = consentToolConfigJsonSchema() as { $id: string; required: string[]; properties: Record<string, unknown> };
    expect(s.$id).toMatch(/consent-tool-config\.schema\.json$/);
    expect(s.required).toEqual(expect.arrayContaining(['version', 'generatedFrom', 'hash', 'regimeSource', 'categories']));
    expect(s.required).not.toContain('gtm');
    expect(s.required).not.toContain('layout'); // has a default
    expect(Object.keys(s.properties).sort()).toEqual(
      ['categories', 'consent', 'gate', 'generatedFrom', 'gtm', 'hash', 'layout', 'platform', 'privacyPolicyUrl', 'record', 'regimeSource', 'strings', 'theme', 'vendors', 'version'].sort(),
    );
  });

  it('test/fixtures/consent-config/example.json is a current generated config', () => {
    const want = pretty(withConsentConfigHash(exampleInput()));
    if (update) {
      fs.mkdirSync(path.dirname(EXAMPLE_FILE), { recursive: true });
      fs.writeFileSync(EXAMPLE_FILE, want);
    }
    expect(fs.existsSync(EXAMPLE_FILE)).toBe(true);
    expect(fs.readFileSync(EXAMPLE_FILE, 'utf8')).toBe(want);
    const r = parseConsentToolConfig(JSON.parse(fs.readFileSync(EXAMPLE_FILE, 'utf8')));
    expect(r.ok && r.hashMatches && r.version === 'current').toBe(true);
  });
});
