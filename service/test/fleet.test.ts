import { describe, expect, it } from 'vitest';
import { authHeader, fakeFleet, flyFleet } from '../src/server/fleet.js';

const TOKEN = 'fo1_supersecrettoken';
const SECRET = 'worker-secret';

interface M { id: string; region: string; state: string; private_ip: string; config: any }

function sim(initial: M[] = [], opts: { healthy?: boolean; fullHost?: string } = {}) {
  const machines = new Map<string, M>(initial.map((m) => [m.id, m]));
  const calls: string[] = [];
  const bodies: any[] = [];
  let clock = 0;
  const pending: Array<() => void> = [];
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
      if (!action && method === 'GET') {
        const r = json(m);
        pending.splice(0).forEach((fn) => fn());
        if (m.state === 'stopping') m.state = 'stopped'; // the stop lands after one read
        return r;
      }
      if (!action && method === 'DELETE') { machines.delete(id); return json({ ok: true }); }
      if (!action && method === 'POST' && opts.fullHost === id) {
        return json({ error: 'aborted: could not reserve resource for machine: insufficient memory available to fulfill request on the current host' }, 409);
      }
      if (!action && method === 'POST') {
        // Like Fly: the reply shows the replacement in flight; a stopped Machine stays stopped once it lands.
        m.config = body.config;
        const after = m.state === 'started' ? 'started' : 'stopped';
        m.state = 'replacing';
        pending.push(() => { m.state = after; });
        return json(m);
      }
      if (action === 'start') { if (m.state !== 'stopped' && m.state !== 'suspended') return json({ error: `cannot start from ${m.state}` }, 412); m.state = 'started'; return json({}); }
      if (action === 'stop') { m.state = 'stopped'; return json({}); }
      if (action === 'wait') return json({ ok: true });
    }
    calls.push(`HEALTH ${u.host} ${init.headers?.['fly-force-instance-id'] ?? ''}`.trim());
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

const SERVICES = [{ protocol: 'tcp', internal_port: 8080, ports: [{ port: 443, handlers: ['tls', 'http'] }, { port: 80, handlers: ['http'], force_https: true }], autostart: false, autostop: 'off' }];
const worker = (over: Partial<M> = {}): M => ({
  id: 'w1', region: 'fra', state: 'stopped', private_ip: 'fdaa::9',
  config: { image: 'img:2', env: { WORKER: '1' }, services: SERVICES, metadata: { complykit_role: 'worker' } }, ...over,
});

describe('flyFleet', () => {
  it('starts a stopped worker and waits for health', async () => {
    const s = sim([worker(), worker({ id: 'other', region: 'lhr', config: { image: 'img:2', metadata: {} } })]);
    const h = await s.fleet.acquire('fra');
    expect(h).toEqual({
      region: 'fra', machineId: 'w1',
      baseUrl: 'https://complykit-workers.fly.dev', headers: { 'fly-force-instance-id': 'w1' }, privateUrl: 'http://[fdaa::9]:8080',
    });
    expect(s.calls).toContain('POST /w1/start');
    expect(s.calls).toContain('HEALTH complykit-workers.fly.dev w1'); // the public URL, routed to the Machine
    expect(s.calls.some((c) => c === 'POST /')).toBe(false);
  });

  it('creates the worker when none exists', async () => {
    const s = sim();
    const h = await s.fleet.acquire('fra');
    expect(h.machineId).toBe('m1');
    expect(s.bodies[0]).toMatchObject({
      name: 'worker-fra', region: 'fra',
      config: { image: 'img:2', env: { WORKER: '1', IDLE_SHUTDOWN_MINUTES: '3' },
        guest: { cpu_kind: 'performance', cpus: 2, memory_mb: 4096 }, services: SERVICES, restart: { policy: 'no' }, metadata: { complykit_role: 'worker' } },
    });
    // Secrets (Spaces keys) come from Fly app secrets, never the Machine's config.
    expect(JSON.stringify(s.bodies[0])).not.toMatch(/SPACES/);
    // The worker secret is a Fly app secret: Machine config is readable with the Fly token.
    expect(JSON.stringify(s.bodies[0])).not.toContain(SECRET);
    expect(s.bodies[0].config.env).not.toHaveProperty('WORKER_SECRET');
  });

  it('gives an existing worker without the public service one, then starts it', async () => {
    const s = sim([worker({ config: { image: 'img:2', guest: { cpu_kind: 'performance', cpus: 2, memory_mb: 4096 }, metadata: { complykit_role: 'worker' } } })]);
    await s.fleet.acquire('fra');
    expect(s.calls.indexOf('POST /w1')).toBeGreaterThan(-1);
    expect(s.calls.indexOf('POST /w1')).toBeLessThan(s.calls.indexOf('POST /w1/start'));
    expect(s.machines.get('w1')!.config.services).toEqual(SERVICES);
  });

  it('leaves a worker that already has the service alone (no update)', async () => {
    const s = sim([worker({ config: { image: 'img:2', guest: { cpu_kind: 'performance', cpus: 2, memory_mb: 4096 }, services: SERVICES, metadata: { complykit_role: 'worker' } } })]);
    await s.fleet.acquire('fra');
    expect(s.calls).not.toContain('POST /w1');
  });

  it('updates the image when it differs, then starts', async () => {
    const s = sim([worker({ config: { image: 'img:1', env: { KEEP: 'x' }, metadata: { complykit_role: 'worker' } } })]);
    await s.fleet.acquire('fra');
    expect(s.calls.indexOf('POST /w1')).toBeGreaterThan(-1);
    expect(s.calls.indexOf('POST /w1')).toBeLessThan(s.calls.indexOf('POST /w1/start'));
    const m = s.machines.get('w1')!;
    expect(m.config.image).toBe('img:2');
    expect(m.config.env).toMatchObject({ KEEP: 'x', WORKER: '1' });
    expect(m.config.env).not.toHaveProperty('WORKER_SECRET');
    expect(m.config.metadata.complykit_role).toBe('worker');
    expect(m.state).toBe('started');
  });

  it('moves an existing shared-cpu worker to dedicated CPUs', async () => {
    const s = sim([worker({ config: { image: 'img:2', guest: { cpu_kind: 'shared', cpus: 2, memory_mb: 2048 }, metadata: { complykit_role: 'worker' } } })]);
    await s.fleet.acquire('fra');
    expect(s.calls.indexOf('POST /w1')).toBeLessThan(s.calls.indexOf('POST /w1/start'));
    expect(s.machines.get('w1')!.config.guest).toEqual({ cpu_kind: 'performance', cpus: 2, memory_mb: 4096 });
    expect(s.machines.get('w1')!.state).toBe('started');
  });

  it('replaces a worker whose host has no room for the new size', async () => {
    const s = sim([worker({ config: { image: 'img:2', guest: { cpu_kind: 'shared', cpus: 2, memory_mb: 2048 }, metadata: { complykit_role: 'worker' } } })], { fullHost: 'w1' });
    const h = await s.fleet.acquire('fra');
    expect(s.calls).toContain('DELETE /w1');
    expect(h.machineId).toBe('m1');
    expect([...s.machines.keys()]).toEqual(['m1']);
    expect(s.machines.get('m1')!.config.guest).toEqual({ cpu_kind: 'performance', cpus: 2, memory_mb: 4096 });
  });

  it('waits for a worker still stopping from the previous scan, then starts it', async () => {
    const s = sim([worker({ config: { image: 'img:2', guest: { cpu_kind: 'performance', cpus: 2, memory_mb: 4096 }, metadata: { complykit_role: 'worker' } }, state: 'stopping' })]);
    const h = await s.fleet.acquire('fra');
    expect(h.machineId).toBe('w1');
    expect(s.calls.filter((c) => c === 'POST /w1/start')).toHaveLength(1);
    expect(s.machines.get('w1')!.state).toBe('started');
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
    expect(s.calls).toContain('GET /w1/wait');
    await expect(s.fleet.release({ ...h, machineId: 'gone' })).resolves.toBeUndefined();
    const boom = flyFleet({ app: 'a', token: TOKEN, image: 'i', secret: 's', fetch: (async () => { throw new Error('net'); }) as typeof fetch });
    await expect(boom.release(h)).resolves.toBeUndefined();
  });
});

describe('flyFleet: secrets and sweeps', () => {
  it('drops a WORKER_SECRET an older Machine still carries in its env, even when nothing else differs', async () => {
    const s = sim([worker({ config: { image: 'img:2', env: { WORKER: '1', WORKER_SECRET: 'old-secret' }, guest: { cpu_kind: 'performance', cpus: 2, memory_mb: 4096 }, services: SERVICES, metadata: { complykit_role: 'worker' } } })]);
    await s.fleet.acquire('fra');
    expect(s.calls).toContain('POST /w1');
    expect(s.machines.get('w1')!.config.env).toEqual({ WORKER: '1', IDLE_SHUTDOWN_MINUTES: '3' });
  });

  it('stopAll stops every worker Machine that is up, and only those', async () => {
    const mk = (id: string, state: string, role = 'worker') => worker({ id, state, config: { image: 'img:2', metadata: { complykit_role: role } } });
    const s = sim([mk('a', 'started'), mk('b', 'starting'), mk('c', 'stopped'), mk('d', 'started', 'other')]);
    await s.fleet.stopAll();
    expect(s.machines.get('a')!.state).toBe('stopped');
    expect(s.machines.get('b')!.state).toBe('stopped');
    expect(s.machines.get('d')!.state).toBe('started');
    expect(s.calls.filter((c) => c.endsWith('/stop')).sort()).toEqual(['POST /a/stop', 'POST /b/stop']);
  });

  it('stopAll swallows errors and gives up after its time limit', async () => {
    const boom = flyFleet({ app: 'a', token: TOKEN, image: 'i', secret: 's', fetch: (async () => { throw new Error('net'); }) as typeof fetch });
    await expect(boom.stopAll()).resolves.toBeUndefined();
    const hang = flyFleet({ app: 'a', token: TOKEN, image: 'i', secret: 's', fetch: (() => new Promise(() => {})) as typeof fetch });
    const t0 = Date.now();
    await expect(hang.stopAll(150)).resolves.toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('halt fires the stop without waiting for it to land, and gives up on a hung API', async () => {
    const s = sim([worker({ state: 'started' })]);
    const h = await s.fleet.acquire('fra');
    s.calls.length = 0;
    await s.fleet.halt(h);
    expect(s.calls).toEqual(['POST /w1/stop']); // no wait?state=stopped
    const hang = flyFleet({ app: 'a', token: TOKEN, image: 'i', secret: 's', fetch: ((_u: unknown, init: any) => new Promise((_r, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))))) as typeof fetch });
    const t0 = Date.now();
    await expect(hang.halt(h, 100)).resolves.toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});

describe('fakeFleet', () => {
  it('returns the mapped base URL, no headers, and the same private URL', async () => {
    const f = fakeFleet({ fra: 'http://127.0.0.1:9999' });
    const h = await f.acquire('fra');
    expect(h.baseUrl).toBe('http://127.0.0.1:9999');
    expect(h.headers).toEqual({});
    expect(h.privateUrl).toBe('http://127.0.0.1:9999');
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
