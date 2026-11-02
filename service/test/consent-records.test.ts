import { fsStorage } from '../src/server/storage/fs.js';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { ConsentRecordStore, RateLimiter, normalizeRecord, originDomain } from '../src/server/consent-records.js';
import { startService, stopAll, tempDir } from './helpers.js';

afterEach(stopAll);

const ORIGIN = 'https://www.example-shop.test';
const record = (over: Record<string, unknown> = {}) => ({
  id: 'k3j9x0aa81QmZp72fD',
  at: new Date().toISOString(),
  categories: { analytics: true, marketing: false },
  configHash: 'sha256:ab12cd34',
  toolVersion: '0.1.0',
  regime: 'opt-in',
  ...over,
});
const lines = (dir: string, domain = 'example-shop.test') => {
  const f = path.join(dir, 'sites', domain, 'consent-records.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

describe('originDomain', () => {
  it('takes the registrable domain from a plain Origin and nothing else', () => {
    expect(originDomain('https://www.example-shop.test')).toBe('example-shop.test');
    expect(originDomain('http://shop.example.co.uk:8080')).toBe('example.co.uk');
    for (const o of [undefined, '', 'null', 'https://example.com/path', 'ftp://example.com', 'https://127.0.0.1', 'https://co.uk']) expect(originDomain(o)).toBeUndefined();
  });
});

describe('normalizeRecord', () => {
  it('keeps the allow-listed fields and stamps receivedAt', () => {
    const r = normalizeRecord(record({ gpc: true, at: '2026-10-05T00:00:00Z' }), 'example-shop.test', Date.parse('2026-10-06T00:00:00Z'));
    expect(r).toMatchObject({ id: 'k3j9x0aa81QmZp72fD', gpc: true, receivedAt: '2026-10-06T00:00:00.000Z', regime: 'opt-in' });
  });

  it('keeps kind, supersedes, gpcHonored and region; each is optional (an older client sends none)', () => {
    const r = normalizeRecord(record({ kind: 'withdrawal', supersedes: 'prev00000000000000id', gpc: true, gpcHonored: false, region: 'US-CA' }), 'example-shop.test');
    expect(r).toMatchObject({ kind: 'withdrawal', supersedes: 'prev00000000000000id', gpc: true, gpcHonored: false, region: 'US-CA' });
    expect(normalizeRecord(record({ kind: 'choice', region: 'DE' }), 'example-shop.test')).toMatchObject({ kind: 'choice', region: 'DE' });
    const bare = normalizeRecord(record(), 'example-shop.test');
    for (const k of ['kind', 'supersedes', 'gpcHonored', 'region', 'source']) expect(k in bare, k).toBe(false);
  });

  it('keeps source: the banner an add-on mode decision was made in (absent = complykit\'s own banner)', () => {
    expect(normalizeRecord(record({ source: 'shopify' }), 'example-shop.test')).toMatchObject({ source: 'shopify' });
    expect(normalizeRecord(record({ source: 'consent-mode' }), 'example-shop.test')).toMatchObject({ source: 'consent-mode' });
    for (const bad of ['', 'Shopify', '=cmd', 'a'.repeat(33), 7, true, '-x']) expect(() => normalizeRecord(record({ source: bad }), 'example-shop.test'), String(bad)).toThrow(/source/);
  });

  it('rejects unknown and identifying fields', () => {
    for (const f of ['ip', 'userAgent', 'email', 'cookie', 'url', 'referrer', 'extra']) {
      expect(() => normalizeRecord(record({ [f]: 'x' }), 'example-shop.test')).toThrow(/unknown field/);
    }
  });

  it('validates each field', () => {
    const bad = [
      { id: 'short' },
      { id: '=cmd|calc-aaaaaaaaaa' },
      { at: 'yesterday' },
      { at: new Date(Date.now() + 3_600_000).toISOString() },
      { categories: {} },
      { categories: { analytics: 'yes' } },
      { categories: { __proto__x: true, 'Bad Key': true } },
      { categories: [true] },
      { configHash: '-1' },
      { toolVersion: 7 },
      { regime: 'Opt In' },
      { gpc: 'true' },
      { kind: 'grant' },
      { kind: 1 },
      { supersedes: 'short' },
      { supersedes: '=cmd|calc-aaaaaaaaaa' },
      { gpcHonored: 'false' },
      { region: 'California' },
      { region: 'us-ca' },
      { region: 'US-CA-LA' },
      { region: 'US-' },
    ];
    for (const b of bad) expect(() => normalizeRecord(record(b), 'example-shop.test'), JSON.stringify(b)).toThrow();
    expect(() => normalizeRecord('x', 'example-shop.test')).toThrow();
    expect(() => normalizeRecord(record({ domain: 'other.test' }), 'example-shop.test')).toThrow(/Origin/);
    expect(() => normalizeRecord(record({ domain: 'shop.example-shop.test' }), 'example-shop.test')).not.toThrow();
  });
});

describe('POST /api/consent-records', () => {
  it('appends one line per record under the Origin domain, with CORS for that origin', async () => {
    const s = await startService();
    const res = await request(s.app).post('/api/consent-records').set('Origin', ORIGIN).send(record()).expect(204);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers.vary).toMatch(/Origin/);
    await request(s.app).post('/api/consent-records').set('Origin', ORIGIN).send(record({ id: 'second0000000000id', gpc: true })).expect(204);
    const got = lines(s.config.dataDir);
    expect(got.map((r) => r.id)).toEqual(['k3j9x0aa81QmZp72fD', 'second0000000000id']);
    expect(Object.keys(got[0]).sort()).toEqual(['at', 'categories', 'configHash', 'id', 'receivedAt', 'regime', 'toolVersion']);
    // nothing about the visitor on disk
    expect(fs.readFileSync(path.join(s.config.dataDir, 'sites/example-shop.test/consent-records.jsonl'), 'utf8')).not.toMatch(/127\.0\.0\.1|supertest|user-agent/i);
  });

  it('accepts text/plain (sendBeacon) and works without a password even when one is set', async () => {
    const s = await startService({ password: 'pw' });
    await request(s.app).post('/api/consent-records').set('Origin', ORIGIN).set('Content-Type', 'text/plain;charset=UTF-8').send(JSON.stringify(record())).expect(204);
    expect(lines(s.config.dataDir)).toHaveLength(1);
    await request(s.app).get('/api/jobs').expect(401); // the rest is still closed
  });

  it('answers the preflight for this route only', async () => {
    const s = await startService();
    const pre = await request(s.app).options('/api/consent-records').set('Origin', ORIGIN).set('Access-Control-Request-Method', 'POST').expect(204);
    expect(pre.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(pre.headers['access-control-allow-methods']).toBe('POST, OPTIONS');
    expect(pre.headers['access-control-allow-credentials']).toBeUndefined();
    const other = await request(s.app).get('/api/health').set('Origin', ORIGIN);
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
    const bad = await request(s.app).options('/api/consent-records').set('Origin', 'null');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('needs a usable Origin and refuses a `domain` that disagrees with it', async () => {
    const s = await startService();
    await request(s.app).post('/api/consent-records').send(record()).expect(400);
    await request(s.app).post('/api/consent-records').set('Origin', 'null').send(record()).expect(400);
    await request(s.app).post('/api/consent-records').set('Origin', ORIGIN).send(record({ domain: 'victim.test' })).expect(403);
    await request(s.app).post('/api/consent-records').set('Origin', ORIGIN).send(record({ domain: 'example-shop.test' })).expect(204);
    expect(fs.existsSync(path.join(s.config.dataDir, 'sites/victim.test'))).toBe(false);
  });

  it('rejects unknown fields, bad JSON and oversized bodies without writing', async () => {
    const s = await startService();
    const post = () => request(s.app).post('/api/consent-records').set('Origin', ORIGIN);
    const r = await post().send(record({ ip: '1.2.3.4' })).expect(400);
    expect(r.body.error).toMatch(/unknown field/);
    expect(r.headers['access-control-allow-origin']).toBe(ORIGIN); // the page can read the error
    await post().set('Content-Type', 'application/json').send('{nope').expect(400);
    await post().send(record({ categories: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`c${i}`, true])) })).expect(413);
    expect(lines(s.config.dataDir)).toHaveLength(0);
  });

  it('only accepts listed sites when CONSENT_RECORD_DOMAINS is set', async () => {
    const s = await startService({ consentRecordDomains: ['example-shop.test'] });
    await request(s.app).post('/api/consent-records').set('Origin', 'https://elsewhere.test').send(record()).expect(403);
    await request(s.app).post('/api/consent-records').set('Origin', ORIGIN).send(record()).expect(204);
  });

  it('rate limits per client and answers 429 with Retry-After', async () => {
    const s = await startService();
    let last = 204;
    for (let i = 0; i < 62 && last === 204; i++) {
      last = (await request(s.app).post('/api/consent-records').set('Origin', ORIGIN).send(record({ id: `rate-limit-id-${String(i).padStart(4, '0')}` }))).status;
    }
    const res = await request(s.app).post('/api/consent-records').set('Origin', ORIGIN).send(record());
    expect(res.status).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('GET /api/sites/:domain/consent-records', () => {
  async function seeded() {
    const s = await startService({ password: 'pw' });
    const post = (b: object) => request(s.app).post('/api/consent-records').set('Origin', ORIGIN).send(b).expect(204);
    await post(record());
    await post(record({ id: 'second0000000000id', kind: 'withdrawal', supersedes: 'k3j9x0aa81QmZp72fD', source: 'shopify', gpc: true, gpcHonored: true, region: 'US-CA', categories: { analytics: false, marketing: false, functional: true } }));
    await post(record()); // a retried POST: same id
    return s;
  }
  const auth = (t: request.Test) => t.auth('x', 'pw');

  it('exports JSONL, one line per consent id', async () => {
    const s = await seeded();
    const res = await auth(request(s.app).get('/api/sites/www.example-shop.test/consent-records?format=jsonl')).expect(200);
    expect(res.headers['content-type']).toMatch(/ndjson/);
    expect(res.headers['content-disposition']).toContain('consent-records-example-shop.test.jsonl');
    expect(res.text.trim().split('\n').map((l) => JSON.parse(l).id)).toEqual(['k3j9x0aa81QmZp72fD', 'second0000000000id']);
  });

  it('exports CSV with a column per category', async () => {
    const s = await seeded();
    const res = await auth(request(s.app).get('/api/sites/example-shop.test/consent-records?format=csv')).expect(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const rows = res.text.trim().split('\r\n');
    expect(rows[0]).toBe('id,at,receivedAt,kind,supersedes,source,regime,region,gpc,gpcHonored,configHash,toolVersion,category:analytics,category:functional,category:marketing');
    expect(rows).toHaveLength(3);
    expect(rows[1].endsWith(',true,,false')).toBe(true);
    // A record without the optional fields leaves their cells empty.
    expect(rows[1].split(',').slice(3, 10)).toEqual(['', '', '', 'opt-in', '', '', '']);
    expect(rows[2].split(',').slice(3, 10)).toEqual(['withdrawal', 'k3j9x0aa81QmZp72fD', 'shopify', 'opt-in', 'US-CA', 'true', 'true']);
  });

  it('is behind the password, validates format and domain, and 404s an unknown site', async () => {
    const s = await seeded();
    await request(s.app).get('/api/sites/example-shop.test/consent-records').expect(401);
    await auth(request(s.app).get('/api/sites/example-shop.test/consent-records?format=xml')).expect(400);
    await auth(request(s.app).get('/api/sites/..%2F..%2Fjobs/consent-records')).expect(400);
    await auth(request(s.app).get('/api/sites/nobody.test/consent-records')).expect(404);
  });
});

describe('retention', () => {
  it('prunes lines received before the cutoff, keeps the rest and anything unreadable', async () => {
    const dataDir = tempDir();
    const store = new ConsentRecordStore(fsStorage(dataDir).consentRecords, 1825);
    const file = (d: string) => path.join(dataDir, 'sites', d, 'consent-records.jsonl');
    const day = 86_400_000;
    const now = Date.parse('2026-10-06T00:00:00Z');
    const mk = (id: string, ageDays: number) => ({ ...normalizeRecord(record({ id, at: new Date(now - ageDays * day).toISOString() }), 'example-shop.test', now - ageDays * day), id });
    await store.append('example-shop.test', mk('old0000000000000id', 1900));
    await store.append('example-shop.test', mk('new0000000000000id', 10));
    fs.appendFileSync(file('example-shop.test'), '{torn\n');
    expect(await store.prune(now)).toBe(1);
    const left = fs.readFileSync(file('example-shop.test'), 'utf8').trim().split('\n');
    expect(left).toHaveLength(2);
    expect(left[0]).toContain('new0000000000000id');
    expect(left[1]).toBe('{torn');
    expect(await store.prune(now)).toBe(0);
  });

  it('defaults to 1825 days and is set by CONSENT_RECORD_RETENTION_DAYS', async () => {
    const { loadConfig } = await import('../src/server/config.js');
    expect(loadConfig({}).consentRecordRetentionDays).toBe(1825);
    expect(loadConfig({ CONSENT_RECORD_RETENTION_DAYS: '365' }).consentRecordRetentionDays).toBe(365);
    expect(() => loadConfig({ CONSENT_RECORD_RETENTION_DAYS: '0' })).toThrow();
    expect(loadConfig({ CONSENT_RECORD_DOMAINS: 'www.a.test, b.test' }).consentRecordDomains).toEqual(['a.test', 'b.test']);
  });

  it('refuses a post once a site file is at its size cap', async () => {
    const store = new ConsentRecordStore(fsStorage(tempDir(), { consentMaxBytes: 100 }).consentRecords, 1825);
    const r = normalizeRecord(record(), 'example-shop.test');
    await store.append('example-shop.test', r);
    await expect(store.append('example-shop.test', r)).rejects.toMatchObject({ status: 507 });
  });
});

describe('RateLimiter', () => {
  it('counts per key per window', () => {
    const l = new RateLimiter(2, 1000);
    expect([l.hit('a', 0), l.hit('a', 1), l.hit('a', 2)]).toEqual([0, 0, 1]);
    expect(l.hit('b', 2)).toBe(0);
    expect(l.hit('a', 1001)).toBe(0);
  });
});
