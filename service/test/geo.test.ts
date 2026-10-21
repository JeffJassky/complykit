import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { hostedConfig } from '../src/server/hosted-script.js';
import type { GeoLookup } from '../src/server/geo.js';
import { startService, stopAll, tempDir } from './helpers.js';

// Contract (plans/regime-overrides.md "Hosted location"): GET /geo tells the
// hosted consent script where the visitor is, so wiretap holds and regimes apply
// without the site writing a meta tag. The host already serves the script, so the
// request reaches no new party. It sets no cookie, is never cached, and echoes
// "CC" or "CC-RR" as text (what the client's header source parses); empty = unknown.

afterEach(stopAll);

const ORIGIN = 'https://ck.example-host.test';
const DOMAIN = 'example-shop.test';
const EXAMPLE = path.join(__dirname, '..', '..', 'test', 'fixtures', 'consent-config', 'example.json');
const example = (): Record<string, any> => JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));

function fakeDist(): string {
  const d = tempDir();
  fs.writeFileSync(path.join(d, 'complykit-consent.js'), '/*core*/\n');
  fs.writeFileSync(path.join(d, 'complykit-consent-ui.js'), '/*ui*/\n');
  return d;
}

/** 203.0.113.7 → California, 198.51.100.9 → Germany, anything else unknown. */
const lookup: GeoLookup = (ip) => (ip === '203.0.113.7' ? { country: 'US', region: 'CA' } : ip === '198.51.100.9' ? { country: 'DE' } : undefined);

/** `geo: null` = no database at all. */
async function service(over: Record<string, unknown> = {}, geo: GeoLookup | null = lookup) {
  return startService({ consentClientDist: fakeDist(), publicOrigin: ORIGIN, geoIpHeader: 'do-connecting-ip', ...over }, {}, { geo: geo ?? undefined });
}

describe('GET /geo', () => {
  it('answers the visitor location from the configured client-IP header, as text', async () => {
    const s = await service();
    const res = await request(s.app).get('/geo').set('do-connecting-ip', '203.0.113.7').set('origin', 'https://www.example-shop.test').expect(200);
    expect(res.text).toBe('US-CA');
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect((await request(s.app).get('/geo').set('do-connecting-ip', '198.51.100.9').expect(200)).text).toBe('DE');
  });

  it('unknown IP, missing header, or no database: 200 with an empty body (the client then treats the location as unknown)', async () => {
    const s = await service();
    expect((await request(s.app).get('/geo').set('do-connecting-ip', '192.0.2.1').expect(200)).text).toBe('');
    expect((await request(s.app).get('/geo').expect(200)).text).toBe('');
    const none = await service({}, null);
    expect((await request(none.app).get('/geo').set('do-connecting-ip', '203.0.113.7').expect(200)).text).toBe('');
  });

  it('with TRUST_CF_GEO, Cloudflare headers win over the database', async () => {
    const s = await service({ trustCfGeo: true });
    const res = await request(s.app).get('/geo').set('do-connecting-ip', '198.51.100.9').set('cf-ipcountry', 'US').set('cf-region-code', 'TX').expect(200);
    expect(res.text).toBe('US-TX');
  });

  it('does not trust the client-IP header unless configured; never answers from x-forwarded-for', async () => {
    const s = await service({ geoIpHeader: undefined });
    expect((await request(s.app).get('/geo').set('do-connecting-ip', '203.0.113.7').set('x-forwarded-for', '203.0.113.7').expect(200)).text).toBe('');
  });

  it('is public (no basic auth) like the hosted script', async () => {
    const s = await service({ password: 'secret' });
    expect((await request(s.app).get('/geo').set('do-connecting-ip', '203.0.113.7').expect(200)).text).toBe('US-CA');
  });
});

describe('hostedConfig: where the served script learns the location', () => {
  it("a site on the generated meta source gets the host's /geo as a header source (the meta tag is still read first by the client)", () => {
    const out = hostedConfig({ ...example(), regimeSource: { kind: 'meta', name: 'complykit-region' } }, ORIGIN);
    expect(out.regimeSource).toEqual({ kind: 'header', header: 'complykit-geo', endpoint: `${ORIGIN}/geo` });
  });

  it('platform, fixed and an owner-chosen header source are left alone', () => {
    for (const rs of [{ kind: 'platform' }, { kind: 'fixed', regime: 'opt-in' }, { kind: 'header', header: 'cf-ipcountry', endpoint: '/.well-known/loc' }]) {
      expect(hostedConfig({ ...example(), regimeSource: rs }, ORIGIN).regimeSource).toEqual(rs);
    }
  });
});
