import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configHash } from '../src/server/config-hash.js';
import { cloudflarePurger, noopPurger, type CdnPurger } from '../src/server/cdn.js';
import { hostedConfig } from '../src/server/hosted-script.js';
import { loadConfig } from '../src/server/config.js';
import { startService, stopAll, tempDir } from './helpers.js';

// T3 contract (plans/hosted-script.md "Hosted script", "UI file", B1–B3, P1).

afterEach(stopAll);

const EXAMPLE = path.join(__dirname, '..', '..', 'test', 'fixtures', 'consent-config', 'example.json');
const example = (): Record<string, any> => JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
const ORIGIN = 'https://ck.example-host.test';
const DOMAIN = 'example-shop.test';
const BUILD = 'a1b2c3d4e5f6';

function fakeDist(): string {
  const d = tempDir();
  fs.writeFileSync(path.join(d, 'complykit-consent.js'), '!function(){window.ComplyKit={version:"9.9.9"}}();\n');
  fs.writeFileSync(path.join(d, 'complykit-consent-ui.js'), '!function(){/*ui*/}();\n');
  fs.writeFileSync(path.join(d, 'complykit-consent-companion.js'), '!function(){/*companion*/}();\n');
  fs.writeFileSync(path.join(d, 'complykit-build.json'), JSON.stringify({ build: BUILD }));
  return d;
}

class RecordingPurger implements CdnPurger {
  urls: string[][] = [];
  all = 0;
  async purgeUrls(urls: string[]) {
    this.urls.push(urls);
  }
  async purgeAll() {
    this.all++;
  }
}

async function service(opts: { cdn?: boolean; purger?: CdnPurger } = {}) {
  const purger = opts.purger ?? new RecordingPurger();
  const s = await startService({ consentClientDist: fakeDist(), publicOrigin: ORIGIN, ...(opts.cdn ? { cdn: { zoneId: 'zone1', token: 'tok' } } : {}) }, {}, { purger });
  return { s, purger: purger as RecordingPurger };
}

async function storeConfig(s: Awaited<ReturnType<typeof startService>>, config = example(), at?: string) {
  await s.workspaces.patch(DOMAIN, { config: { value: { config, snippet: '', changeList: '', notes: [] }, ...(at ? { at } : {}) } });
}

describe('configHash: parity with the package', () => {
  it('equals the hash the CLI stamped on a generated config', () => {
    const c = example();
    expect(configHash(c)).toBe(c.hash);
  });

  it('ignores the existing hash field and key order', () => {
    const c = example();
    const shuffled = Object.fromEntries(Object.entries({ ...c, hash: 'f'.repeat(64) }).reverse());
    expect(configHash(shuffled)).toBe(c.hash);
  });
});

describe('hostedConfig', () => {
  it('fills in the record and analytics endpoints from the public origin and re-hashes', () => {
    const out = hostedConfig(example(), ORIGIN);
    expect(out.record).toEqual({ endpoint: `${ORIGIN}/api/consent-records` });
    expect(out.analytics).toEqual({ endpoint: `${ORIGIN}/e` });
    expect(out.hash).toBe(configHash(out));
    expect(out.hash).not.toBe(example().hash);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(hostedConfig(example(), ORIGIN))).toBe(JSON.stringify(hostedConfig(example(), ORIGIN)));
  });
});

describe('GET /s/<domain>.js', () => {
  it('200: the banner comment, the config line, then the core bundle unchanged', async () => {
    const { s } = await service();
    await storeConfig(s);
    const res = await request(s.app).get(`/s/${DOMAIN}.js`).expect(200);
    const lines = res.text.split('\n');
    const served = hostedConfig(example(), ORIGIN);
    expect(lines[0]).toMatch(new RegExp(`^/\\*! complykit \\S+ \\| ${DOMAIN.replace('.', '\\.')} \\| config ${served.hash.slice(0, 12)} \\*/$`));
    expect(lines[1]).toBe(`window.ComplyKitConfig=${JSON.stringify(served)};`);
    expect(lines.slice(2).join('\n')).toBe('!function(){window.ComplyKit={version:"9.9.9"}}();\n');
    expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers.vary ?? '').not.toMatch(/cookie/i);
    const etag = `"${crypto.createHash('sha256').update(res.text).digest('hex').slice(0, 32)}"`;
    expect(res.headers.etag).toBe(etag);
    await request(s.app).get(`/s/${DOMAIN}.js`).set('If-None-Match', etag).expect(304);
  });

  it('with a CDN configured: long edge cache, stale-if-error', async () => {
    const { s } = await service({ cdn: true });
    await storeConfig(s);
    const res = await request(s.app).get(`/s/${DOMAIN}.js`).expect(200);
    expect(res.headers['cache-control']).toBe('public, max-age=60, s-maxage=3600, stale-while-revalidate=60, stale-if-error=604800');
  });

  it('is public even when the service has a password', async () => {
    const s = await startService({ consentClientDist: fakeDist(), publicOrigin: ORIGIN, password: 'pw' }, {}, { purger: noopPurger });
    await storeConfig(s);
    await request(s.app).get(`/s/${DOMAIN}.js`).expect(200);
    await request(s.app).get('/api/sites').expect(401);
  });

  it('a subdomain redirects to the registrable domain; junk is 400; no config is a cacheable 404', async () => {
    const { s } = await service();
    await storeConfig(s);
    const r = await request(s.app).get(`/s/www.${DOMAIN}.js`).expect(301);
    expect(r.headers.location).toBe(`/s/${DOMAIN}.js`);
    for (const bad of ['/s/localhost.js', '/s/UPPER..js', '/s/a%2Fb.js', '/s/co.uk.js']) await request(s.app).get(bad).expect((res) => expect([400, 404]).toContain(res.status));
    await request(s.app).get('/s/nothing.js').expect(400);
    const nf = await request(s.app).get('/s/no-config.test.js').expect(404);
    expect(nf.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(nf.headers['cache-control']).toBe('public, max-age=60');
    expect(nf.text).toBe('/* complykit: no consent config for no-config.test */\n');
  });
});

describe('GET /s/complykit-consent-ui.js', () => {
  it('immutable for the current build id, short otherwise', async () => {
    const { s } = await service();
    const plain = await request(s.app).get('/s/complykit-consent-ui.js').expect(200);
    expect(plain.text).toBe('!function(){/*ui*/}();\n');
    expect(plain.headers['cache-control']).toBe('public, max-age=60');
    expect(plain.headers['set-cookie']).toBeUndefined();
    const pinned = await request(s.app).get(`/s/complykit-consent-ui.js?v=${BUILD}`).expect(200);
    expect(pinned.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const version = (await import('../src/server/config.js')).readVersion();
    const byPackageVersion = await request(s.app).get(`/s/complykit-consent-ui.js?v=${encodeURIComponent(version)}`).expect(200);
    expect(byPackageVersion.headers['cache-control']).toBe('public, max-age=60');
    const other = await request(s.app).get('/s/complykit-consent-ui.js?v=0.0.0-old').expect(200);
    expect(other.headers['cache-control']).toBe('public, max-age=60');
  });
});

describe('the build file', () => {
  it('a missing build file means nothing is immutable', async () => {
    const dist = fakeDist();
    fs.rmSync(path.join(dist, 'complykit-build.json'));
    const s = await startService({ consentClientDist: dist, publicOrigin: ORIGIN }, {}, { purger: noopPurger });
    const r = await request(s.app).get(`/s/complykit-consent-ui.js?v=${BUILD}`).expect(200);
    expect(r.headers['cache-control']).toBe('public, max-age=60');
  });
});

describe('GET /s/complykit-consent-companion.js', () => {
  it('served like the UI file: immutable for the current build id, short otherwise', async () => {
    const { s } = await service();
    const plain = await request(s.app).get('/s/complykit-consent-companion.js').expect(200);
    expect(plain.text).toBe('!function(){/*companion*/}();\n');
    expect(plain.headers['cache-control']).toBe('public, max-age=60');
    expect(plain.headers['set-cookie']).toBeUndefined();
    const pinned = await request(s.app).get(`/s/complykit-consent-companion.js?v=${BUILD}`).expect(200);
    expect(pinned.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const version = (await import('../src/server/config.js')).readVersion();
    const byPackageVersion = await request(s.app).get(`/s/complykit-consent-companion.js?v=${encodeURIComponent(version)}`).expect(200);
    expect(byPackageVersion.headers['cache-control']).toBe('public, max-age=60');
    const other = await request(s.app).get('/s/complykit-consent-companion.js?v=0.0.0-old').expect(200);
    expect(other.headers['cache-control']).toBe('public, max-age=60');
  });
});

describe('a config change reaches visitors (B2)', () => {
  it('the next request serves the new config, and the CDN URL is purged once', async () => {
    const { s, purger } = await service();
    await storeConfig(s, example(), '2026-10-06T10:00:00.000Z');
    const before = (await request(s.app).get(`/s/${DOMAIN}.js`)).text;
    purger.urls = [];
    const changed = { ...example(), layout: 'box' };
    await storeConfig(s, changed, '2026-10-06T11:00:00.000Z');
    const after = (await request(s.app).get(`/s/${DOMAIN}.js`)).text;
    expect(after).not.toBe(before);
    expect(after.split('\n')[1]).toContain('"layout":"box"');
    await vi.waitFor(() => expect(purger.urls).toEqual([[`${ORIGIN}/s/${DOMAIN}.js`]]));
  });

  it('a stale write (older at) changes nothing and purges nothing', async () => {
    const { s, purger } = await service();
    await storeConfig(s, example(), '2026-10-06T11:00:00.000Z');
    await vi.waitFor(() => expect(purger.urls.length).toBe(1));
    await storeConfig(s, { ...example(), layout: 'box' }, '2026-10-06T10:00:00.000Z');
    await new Promise((r) => setTimeout(r, 50));
    expect(purger.urls.length).toBe(1);
  });

  it('a purge failure never fails the write', async () => {
    const failing: CdnPurger = { purgeUrls: async () => Promise.reject(new Error('cf down')), purgeAll: async () => Promise.reject(new Error('cf down')) };
    const { s } = await service({ purger: failing });
    await expect(storeConfig(s)).resolves.toBeUndefined();
    await request(s.app).get(`/s/${DOMAIN}.js`).expect(200);
  });
});

describe('boot purge when the bundle or origin changed', () => {
  it('purges everything once for a new bundle, not again for the same one', async () => {
    const dataDir = tempDir();
    const dist = fakeDist();
    const p1 = new RecordingPurger();
    await startService({ dataDir, consentClientDist: dist, publicOrigin: ORIGIN }, {}, { purger: p1 });
    await vi.waitFor(() => expect(p1.all).toBe(1));
    await stopAll();
    const p2 = new RecordingPurger();
    await startService({ dataDir, consentClientDist: dist, publicOrigin: ORIGIN }, {}, { purger: p2 });
    await new Promise((r) => setTimeout(r, 100));
    expect(p2.all).toBe(0);
    await stopAll();
    fs.appendFileSync(path.join(dist, 'complykit-consent.js'), '//v2\n');
    const p3 = new RecordingPurger();
    await startService({ dataDir, consentClientDist: dist, publicOrigin: ORIGIN }, {}, { purger: p3 });
    await vi.waitFor(() => expect(p3.all).toBe(1));
  });
});

describe('cloudflarePurger', () => {
  it('posts files in batches of 30 with a bearer token; purge_everything; one retry; never throws', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let fail = 1;
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (fail-- > 0) return new Response('{"success":false}', { status: 500 });
      return new Response('{"success":true}', { status: 200 });
    });
    const p = cloudflarePurger({ zoneId: 'zone1', token: 'tok', fetch: fetch as never, log: () => {} });
    const urls = Array.from({ length: 31 }, (_, i) => `${ORIGIN}/s/site${i}.test.js`);
    await p.purgeUrls(urls);
    expect(calls[0].url).toBe('https://api.cloudflare.com/client/v4/zones/zone1/purge_cache');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(calls.map((c) => JSON.parse(String(c.init.body)).files?.length)).toEqual([30, 30, 1]); // first failed and retried
    calls.length = 0;
    await p.purgeAll();
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ purge_everything: true });
    const down = cloudflarePurger({ zoneId: 'z', token: 't', fetch: (async () => Promise.reject(new Error('net'))) as never, log: () => {} });
    await expect(down.purgeUrls(['x'])).resolves.toBeUndefined();
  });
});

describe('configuration', () => {
  it('PUBLIC_ORIGIN, CF_ZONE_ID + CF_API_TOKEN, TRUST_CF_GEO', () => {
    const c = loadConfig({ PUBLIC_ORIGIN: 'https://ck.example-host.test/', CF_ZONE_ID: 'z', CF_API_TOKEN: 't', TRUST_CF_GEO: '1' });
    expect(c.publicOrigin).toBe('https://ck.example-host.test');
    expect(c.cdn).toEqual({ zoneId: 'z', token: 't' });
    expect(c.trustCfGeo).toBe(true);
    const d = loadConfig({ PORT: '4555' });
    expect(d.publicOrigin).toBe('http://localhost:4555');
    expect(d.cdn).toBeUndefined();
    expect(d.trustCfGeo).toBe(false);
    expect(loadConfig({ CF_ZONE_ID: 'z' }).cdn).toBeUndefined();
  });
});

describe('the install bundle is gone', () => {
  it('no install.zip route', async () => {
    const { s } = await service();
    await storeConfig(s);
    await request(s.app).get(`/api/sites/${DOMAIN}/install.zip`).expect(404);
    expect(fs.existsSync(path.join(__dirname, '..', 'src', 'server', 'install-zip.ts'))).toBe(false);
  });
});
