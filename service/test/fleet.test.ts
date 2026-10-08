import { describe, expect, it } from 'vitest';
import { authHeader, fakeFleet, flyFleet } from '../src/server/fleet.js';

const TOKEN = 'fo1_supersecrettoken';
const SECRET = 'worker-secret';

interface M { id: string; region: string; state: string; private_ip: string; config: any }

function sim(initial: M[] = [], opts: { healthy?: boolean } = {}) {
  const machines = new Map<string, M>(initial.map((m) => [m.id, m]));
  const calls: string[] = [];
  const bodies: any[] = [];
  let clock = 0;
  let n = 0;
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  const f = (async (url: any, init: any = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? 'GET';
    if (u.hostname === 'api.machines.dev') {
      if (init.headers?.authorization !== `Bearer ${TOKEN}`) return json({ error: 'unauthorized' }, 401);
      const p = u.pathname.replace('/v1/apps/complykit-workers/machines', '');
      calls.push(`${method} ${p || '/'}`);
      const body = init.body ? JSON.parse(init.body) : undefined;
      if (body) bodies.push(body);
      if (p === '' && method === 'GET') return json([...machines.values()]);
      if (p === '' && method === 'POST') {
        const m: M = { id: `m${++n}`, region: body.region, state: 'started', private_ip: `fdaa::${n}`, config: body.config };
        machines.set(m.id, m);
        return json(m);
      }
      const [, id, action] = p.split('/');
      const m = machines.get(id);
      if (!m) return json({ error: 'nf' }, 404);
      if (!action && method === 'GET') return json(m);
      if (!action && method === 'POST') { m.config = body.config; return json(m); }
      if (action === 'start') { m.state = 'started'; return json({}); }
      if (action === 'stop') { m.state = 'stopped'; return json({}); }
      if (action === 'wait') return json({ ok: true });
    }
    calls.push(`HEALTH ${u.host}`);
    if (opts.healthy === false) throw new Error('connect ECONNREFUSED');
    if (init.headers?.['x-complykit-worker-secret'] !== SECRET) return json({}, 403);
    return json({ ok: true });
  }) as typeof fetch;
  const fleet = flyFleet({
    app: 'complykit-workers', token: TOKEN, image: 'img:2', secret: SECRET, fetch: f,
    now: () => clock, sleep: async (ms) => { clock += ms; },
  });
  return { fleet, machines, calls, bodies };
}

const worker = (over: Partial<M> = {}): M => ({
  id: 'w1', region: 'fra', state: 'stopped', private_ip: 'fdaa::9',
  config: { image: 'img:2', env: { WORKER: '1' }, metadata: { complykit_role: 'worker' } }, ...over,
});

describe('flyFleet', () => {
  it('starts a stopped worker and waits for health', async () => {
    const s = sim([worker(), worker({ id: 'other', region: 'lhr', config: { image: 'img:2', metadata: {} } })]);
    const h = await s.fleet.acquire('fra');
    expect(h).toEqual({ region: 'fra', machineId: 'w1', baseUrl: 'http://[fdaa::9]:8080' });
    expect(s.calls).toContain('POST /w1/start');
    expect(s.calls.some((c) => c.startsWith('HEALTH'))).toBe(true);
    expect(s.calls.some((c) => c === 'POST /')).toBe(false);
  });

  it('creates the worker when none exists', async () => {
    const s = sim();
    const h = await s.fleet.acquire('fra');
    expect(h.machineId).toBe('m1');
    expect(s.bodies[0]).toMatchObject({
      name: 'worker-fra', region: 'fra',
      config: { image: 'img:2', env: { WORKER: '1', WORKER_SECRET: SECRET, IDLE_SHUTDOWN_MINUTES: '3' },
        guest: { cpu_kind: 'shared', cpus: 2, memory_mb: 2048 }, restart: { policy: 'no' }, metadata: { complykit_role: 'worker' } },
    });
  });

  it('updates the image when it differs, then starts', async () => {
    const s = sim([worker({ config: { image: 'img:1', env: { KEEP: 'x' }, metadata: { complykit_role: 'worker' } } })]);
    await s.fleet.acquire('fra');
    expect(s.calls.indexOf('POST /w1')).toBeGreaterThan(-1);
    expect(s.calls.indexOf('POST /w1')).toBeLessThan(s.calls.indexOf('POST /w1/start'));
    const m = s.machines.get('w1')!;
    expect(m.config.image).toBe('img:2');
    expect(m.config.env).toMatchObject({ KEEP: 'x', WORKER: '1', WORKER_SECRET: SECRET });
    expect(m.config.metadata.complykit_role).toBe('worker');
  });

  it('serializes concurrent acquires of one region: one create', async () => {
    const s = sim();
    const [a, b] = await Promise.all([s.fleet.acquire('fra'), s.fleet.acquire('fra')]);
    expect(a.machineId).toBe(b.machineId);
    expect(s.calls.filter((c) => c === 'POST /')).toHaveLength(1);
    expect(s.machines.size).toBe(1);
  });

  it('throws naming the region, without the token, when health never comes up', async () => {
    const s = sim([worker({ state: 'started' })], { healthy: false });
    const err = await s.fleet.acquire('fra').then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain('fra');
    expect(err!.message).toContain('ECONNREFUSED');
    expect(err!.message).not.toContain(TOKEN);
  });

  it('a failed acquire does not block the next one for the region', async () => {
    const s = sim([worker({ state: 'started' })], { healthy: false });
    await expect(s.fleet.acquire('fra')).rejects.toThrow();
    await expect(s.fleet.acquire('fra')).rejects.toThrow(/fra/);
  });

  it('release stops the machine and swallows errors', async () => {
    const s = sim([worker({ state: 'started' })]);
    const h = await s.fleet.acquire('fra');
    await s.fleet.release(h);
    expect(s.machines.get('w1')!.state).toBe('stopped');
    await expect(s.fleet.release({ ...h, machineId: 'gone' })).resolves.toBeUndefined();
    const boom = flyFleet({ app: 'a', token: TOKEN, image: 'i', secret: 's', fetch: (async () => { throw new Error('net'); }) as typeof fetch });
    await expect(boom.release(h)).resolves.toBeUndefined();
  });
});

describe('fakeFleet', () => {
  it('returns the mapped base URL', async () => {
    const f = fakeFleet({ fra: 'http://127.0.0.1:9999' });
    const h = await f.acquire('fra');
    expect(h.baseUrl).toBe('http://127.0.0.1:9999');
    expect(h.region).toBe('fra');
    await expect(f.release(h)).resolves.toBeUndefined();
    await expect(f.acquire('lhr')).rejects.toThrow(/lhr/);
  });
});

describe('authHeader', () => {
  it('sends Fly macaroon tokens as-is and plain tokens as Bearer', () => {
    expect(authHeader('FlyV1 fm2_abc')).toBe('FlyV1 fm2_abc');
    expect(authHeader('abc123')).toBe('Bearer abc123');
  });
});
