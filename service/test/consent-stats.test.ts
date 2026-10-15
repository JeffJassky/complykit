import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { noopPurger } from '../src/server/cdn.js';
import { bucketMs } from '../src/server/consent-stats.js';
import { startService, stopAll, tempDir } from './helpers.js';

// T4 contract (plans/hosted-script.md "Event beacon", "Counters", "Stats API",
// P1–P6). Counters only: a body becomes increments; nothing else is kept.

afterEach(stopAll);

const EXAMPLE = path.join(__dirname, '..', '..', 'test', 'fixtures', 'consent-config', 'example.json');
const ORIGIN = 'https://ck.example-host.test';
const DOMAIN = 'example-shop.test';
const SITE_ORIGIN = 'https://www.example-shop.test';

function fakeDist(): string {
  const d = tempDir();
  fs.writeFileSync(path.join(d, 'complykit-consent.js'), '/*core*/\n');
  fs.writeFileSync(path.join(d, 'complykit-consent-ui.js'), '/*ui*/\n');
  return d;
}

/** A service with the example config stored and served once (so its hash is a known snapshot). */
async function service(over: Record<string, unknown> = {}) {
  const s = await startService({ consentClientDist: fakeDist(), publicOrigin: ORIGIN, ...over }, {}, { purger: noopPurger });
  await s.workspaces.patch(DOMAIN, { config: { value: { config: JSON.parse(fs.readFileSync(EXAMPLE, 'utf8')), snippet: '', changeList: '', notes: [] } } });
  const line = (await request(s.app).get(`/s/${DOMAIN}.js`).expect(200)).text.split('\n')[1];
  const hash = JSON.parse(line.replace(/^window\.ComplyKitConfig=/, '').replace(/;$/, '')).hash as string;
  return { s, hash };
}

const body = (hash: string, ev: unknown[], over: Record<string, unknown> = {}) => JSON.stringify({ v: 1, h: hash, tv: '0.1.0', r: 'opt-in', ev, ...over });
const post = (s: Awaited<ReturnType<typeof startService>>, text: string, headers: Record<string, string> = {}) => {
  let r = request(s.app).post('/e').set('Origin', SITE_ORIGIN).set('Content-Type', 'text/plain;charset=UTF-8');
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return r.send(text);
};
const totals = async (s: Awaited<ReturnType<typeof startService>>, hash: string): Promise<Record<string, number>> => {
  await s.stats.flush();
  const res = await request(s.app).get(`/api/sites/${DOMAIN}/stats?days=30`).expect(200);
  return res.body.configs.find((c: { hash: string }) => c.hash === hash)?.totals ?? {};
};

describe('bucketMs', () => {
  it('buckets time to decide', () => {
    const cases: Array<[number, string]> = [
      [0, 'lt2s'],
      [1999, 'lt2s'],
      [2000, '2-5s'],
      [4999, '2-5s'],
      [5000, '5-10s'],
      [10_000, '10-30s'],
      [30_000, '30-60s'],
      [60_000, '1-5m'],
      [300_000, 'gt5m'],
      [86_400_000, 'gt5m'],
    ];
    for (const [ms, b] of cases) expect(bucketMs(ms), String(ms)).toBe(b);
  });
});

describe('POST /e', () => {
  it('counts a full banner visit into the documented keys; 204 with CORS for the site', async () => {
    const { s, hash } = await service();
    const res = await post(s, body(hash, [{ t: 'load', d: 0, gpc: 0 }, { t: 'shown' }, { t: 'open', via: 'banner' }, { t: 'decide', a: 'custom', via: 'settings', ms: 3200, cats: { analytics: true, advertising: false } }])).expect(204);
    expect(res.headers['access-control-allow-origin']).toBe(SITE_ORIGIN);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(await totals(s, hash)).toEqual({
      load: 1,
      'regime:opt-in': 1,
      shown: 1,
      'open:banner': 1,
      'decide:custom:settings': 1,
      'ttd:custom:2-5s': 1,
      'cat:analytics:on': 1,
      'cat:advertising:off': 1,
      'geo:XX:load': 1,
      'geo:XX:shown': 1,
      'geo:XX:decide:custom': 1,
    });
  });

  it('a returning visit with GPC; accumulates across bodies', async () => {
    const { s, hash } = await service();
    await post(s, body(hash, [{ t: 'load', d: 1, gpc: 1 }])).expect(204);
    await post(s, body(hash, [{ t: 'load', d: 1, gpc: 0 }])).expect(204);
    expect(await totals(s, hash)).toMatchObject({ load: 2, 'load:decided': 2, 'load:gpc': 1, 'regime:opt-in': 2, 'geo:XX:load': 2 });
  });

  it('geo from Cloudflare headers only when TRUST_CF_GEO', async () => {
    const off = await service();
    await post(off.s, body(off.hash, [{ t: 'load', d: 0, gpc: 0 }]), { 'cf-ipcountry': 'US', 'cf-region-code': 'CA' }).expect(204);
    expect(await totals(off.s, off.hash)).toHaveProperty(['geo:XX:load'], 1);
    await stopAll();
    const on = await service({ trustCfGeo: true });
    await post(on.s, body(on.hash, [{ t: 'load', d: 0, gpc: 0 }]), { 'cf-ipcountry': 'US', 'cf-region-code': 'CA' }).expect(204);
    await post(on.s, body(on.hash, [{ t: 'load', d: 0, gpc: 0 }]), { 'cf-ipcountry': 'DE' }).expect(204);
    await post(on.s, body(on.hash, [{ t: 'load', d: 0, gpc: 0 }]), { 'cf-ipcountry': 'not a country', 'cf-region-code': '<x>' }).expect(204);
    expect(await totals(on.s, on.hash)).toMatchObject({ 'geo:US-CA:load': 1, 'geo:DE:load': 1, 'geo:XX:load': 1 });
  });

  it('drops the whole body for an unknown hash or another site’s Origin (still 204)', async () => {
    const { s, hash } = await service();
    await post(s, body('a'.repeat(64), [{ t: 'load', d: 0, gpc: 0 }])).expect(204);
    await request(s.app).post('/e').set('Origin', 'https://other.test').send(body(hash, [{ t: 'load', d: 0, gpc: 0 }])).expect(204);
    await request(s.app).post('/e').send(body(hash, [{ t: 'load', d: 0, gpc: 0 }])).expect(204);
    expect(await totals(s, hash)).toEqual({});
  });

  it('drops bad events one by one; at most one load and one shown; at most 20 events', async () => {
    const { s, hash } = await service();
    const ev = [
      { t: 'load', d: 0, gpc: 0 },
      { t: 'load', d: 0, gpc: 0 },
      { t: 'shown' },
      { t: 'shown' },
      { t: 'click' },
      { t: 'decide', a: 'maybe', via: 'banner' },
      { t: 'decide', a: 'accept', via: 'popup' },
      { t: 'decide', a: 'custom', via: 'settings', cats: { 'not a category': true } },
      { t: 'decide', a: 'custom', via: 'settings', cats: { marketing_x: true } },
      { t: 'decide', a: 'accept', via: 'banner', ms: -5 },
      { t: 'open', via: 'window' },
      ...Array.from({ length: 15 }, () => ({ t: 'open', via: 'choices' })),
    ];
    await post(s, body(hash, ev)).expect(204);
    const t = await totals(s, hash);
    expect(t.load).toBe(1);
    expect(t.shown).toBe(1);
    expect(t['decide:accept:banner']).toBe(1);
    expect(t['ttd:accept:lt2s']).toBe(1);
    expect(t['open:choices']).toBe(9); // events 12–20 of the first 20
    expect(Object.keys(t).some((k) => /maybe|popup|click|window|not a category|marketing_x/.test(k))).toBe(false);
  });

  it('cmp decisions (add-on mode) count under via cmp', async () => {
    const { s, hash } = await service();
    await post(s, body(hash, [{ t: 'decide', a: 'reject', via: 'cmp' }])).expect(204);
    expect(await totals(s, hash)).toMatchObject({ 'decide:reject:cmp': 1 });
  });

  it('413 over 4096 bytes; non-JSON is dropped with 204; preflight answers', async () => {
    const { s, hash } = await service();
    await post(s, body(hash, [{ t: 'load', d: 0, gpc: 0 }], { pad: 'x'.repeat(5000) })).expect(413);
    await post(s, 'not json').expect(204);
    const pre = await request(s.app).options('/e').set('Origin', SITE_ORIGIN).expect(204);
    expect(pre.headers['access-control-allow-origin']).toBe(SITE_ORIGIN);
  });

  it('429 past 120 bodies a minute from one address', async () => {
    const { s, hash } = await service();
    let limited = 0;
    for (let i = 0; i < 125; i++) {
      const r = await post(s, body(hash, [{ t: 'shown' }]));
      if (r.status === 429) limited++;
    }
    expect(limited).toBeGreaterThanOrEqual(5);
  });

  it('is public even when the service has a password', async () => {
    const { s, hash } = await service({ password: 'pw' });
    await post(s, body(hash, [{ t: 'shown' }])).expect(204);
  });
});

describe('what is stored (P2–P5)', () => {
  it('only counter documents: domain, day, hash and the counter map — no IP, no body, no URL', async () => {
    const { s, hash } = await service();
    await post(s, body(hash, [{ t: 'load', d: 0, gpc: 0 }, { t: 'decide', a: 'accept', via: 'banner', ms: 900 }], { extra: 'https://www.example-shop.test/checkout?email=a@b.test' }), { 'User-Agent': 'Mozilla/5.0 test-agent', Referer: 'https://www.example-shop.test/checkout' }).expect(204);
    await s.stats.flush();
    const dir = path.join(s.config.dataDir, 'stats', DOMAIN);
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.json$/);
    const text = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    for (const bad of ['127.0.0.1', '::1', '::ffff', 'test-agent', 'Mozilla', 'checkout', 'email', 'a@b.test', 'example-shop.test/']) expect(text).not.toContain(bad);
    const doc = JSON.parse(text);
    const docs = Array.isArray(doc) ? doc : Object.values(doc);
    for (const d of docs as Array<Record<string, unknown>>) {
      expect(Object.keys(d).sort()).toEqual(['day', 'domain', 'hash', 'n']);
      for (const k of Object.keys(d.n as object)) expect(k).toMatch(/^[a-z0-9:_-]+$/i);
    }
  });
});

describe('GET /api/sites/:domain/stats and configs/:hash', () => {
  it('per config version, newest first, with the snapshot readable by hash', async () => {
    const { s, hash } = await service();
    await post(s, body(hash, [{ t: 'shown' }])).expect(204);
    await s.stats.flush();
    const res = await request(s.app).get(`/api/sites/${DOMAIN}/stats`).expect(200);
    expect(res.body).toMatchObject({ domain: DOMAIN, from: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), to: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(res.body.configs[0]).toMatchObject({ hash, firstServed: expect.any(String), totals: { shown: 1 }, days: [{ day: res.body.to, n: { shown: 1 } }] });
    const snap = (await request(s.app).get(`/api/sites/${DOMAIN}/configs/${hash}`).expect(200)).body;
    expect(snap).toMatchObject({ hash, domain: DOMAIN, config: { hash } });
    await request(s.app).get(`/api/sites/${DOMAIN}/configs/${'b'.repeat(64)}`).expect(404);
    await request(s.app).get(`/api/sites/${DOMAIN}/stats?days=0`).expect(400);
    await request(s.app).get(`/api/sites/${DOMAIN}/stats?days=367`).expect(400);
  });

  it('behind the password', async () => {
    const { s } = await service({ password: 'pw' });
    await request(s.app).get(`/api/sites/${DOMAIN}/stats`).expect(401);
  });
});
