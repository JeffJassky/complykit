// Fleet manager: starts and stops the regional worker Machines (Fly Machines
// API). The host acquires a region's worker, waits for /internal/health,
// uses it, then releases (stops) it. The API token is never logged or put in
// an error message.
//
// Workers are addressed publicly: `https://<app>.fly.dev` plus a
// `fly-force-instance-id` header that routes the request to one Machine. Peers
// (the merge worker) reach each other over Fly's private network instead.

import { FLY_INSTANCE_HEADER, WORKER_SECRET_HEADER } from './worker-protocol.js';

export interface WorkerHandle {
  region: string;
  machineId: string;
  /** Where the host sends requests (public). */
  baseUrl: string;
  /** Sent on every request to baseUrl (routes to this Machine). */
  headers: Record<string, string>;
  /** Where another worker reaches this one (private network). */
  privateUrl: string;
}

export interface Fleet {
  /** Start (or create) the region's worker and wait for /internal/health. Throws with a message on failure/timeout (90 s). */
  acquire(region: string): Promise<WorkerHandle>;
  /** Stop it (best effort, never throws). */
  release(h: WorkerHandle): Promise<void>;
}

export interface FlyFleetConfig {
  app: string;
  token: string;
  image: string;
  secret: string;
  fetch?: typeof fetch;
  /** Test seams. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Machines API base (default https://api.machines.dev/v1). */
  apiBase?: string;
  /** Total health wait (default 90 s). */
  healthTimeoutMs?: number;
}

interface Machine {
  id: string;
  name?: string;
  region: string;
  state: string;
  private_ip?: string;
  config?: { image?: string; env?: Record<string, string>; metadata?: Record<string, string>; services?: unknown; [k: string]: unknown };
}

const HEALTH_TIMEOUT_MS = 90_000;
const HEALTH_POLL_MS = 1_000;
const SETTLE_TIMEOUT_MS = 30_000;
/**
 * Dedicated CPUs. A shared-cpu worker runs on burst credit: Chromium on a heavy
 * page drains it within minutes and the Machine is throttled to a fraction of a
 * core. A 2026-10-10 field run on a large Shopify store went from 11 s visits to
 * 150-400 s and hit the 30-minute remote limit in every region, while the
 * primary (performance-2x) ran the same visits at normal speed.
 */
const WORKER_GUEST = { cpu_kind: 'performance', cpus: 2, memory_mb: 4096 };
/**
 * The public service: HTTPS through Fly's proxy to the worker's port. The fleet
 * starts and stops Machines itself, so the proxy must not.
 */
const WORKER_SERVICES = [
  {
    protocol: 'tcp',
    internal_port: 8080,
    ports: [
      { port: 443, handlers: ['tls', 'http'] },
      { port: 80, handlers: ['http'], force_https: true },
    ],
    autostart: false,
    autostop: 'off',
  },
];
const sameServices = (s: unknown) => {
  if (!Array.isArray(s)) return false;
  return s.some((x) => {
    const svc = (x ?? {}) as Record<string, unknown>;
    const ports = Array.isArray(svc.ports) ? (svc.ports as Array<Record<string, unknown>>) : [];
    return svc.internal_port === 8080 && ports.some((p) => p.port === 443) && svc.autostart === false && svc.autostop === 'off';
  });
};
const sameGuest = (g: unknown) => {
  const x = (g ?? {}) as Record<string, unknown>;
  return x.cpu_kind === WORKER_GUEST.cpu_kind && x.cpus === WORKER_GUEST.cpus && x.memory_mb === WORKER_GUEST.memory_mb;
};
/** States a Machine can be started from, or is already up in. Anything else (stopping, replacing…) is in flight. */
const SETTLED = new Set(['stopped', 'suspended', 'started', 'starting']);

/** Fly macaroon tokens ("FlyV1 fm2_…", from `fly tokens create`) carry their own scheme; older API tokens take Bearer. */
export function authHeader(token: string): string {
  return token.startsWith('FlyV1 ') ? token : `Bearer ${token}`;
}

export function flyFleet(cfg: FlyFleetConfig): Fleet {
  const doFetch = cfg.fetch ?? fetch;
  const now = cfg.now ?? Date.now;
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const api = (cfg.apiBase ?? 'https://api.machines.dev/v1').replace(/\/$/, '');
  const healthTimeout = cfg.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;
  const base = `${api}/apps/${encodeURIComponent(cfg.app)}/machines`;
  const workerEnv = { WORKER: '1', WORKER_SECRET: cfg.secret, IDLE_SHUTDOWN_MINUTES: '3' };

  async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await doFetch(url, {
      method,
      headers: { authorization: authHeader(cfg.token), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Fly Machines API ${method} ${url.slice(api.length)} → ${res.status}${text ? ` ${text.slice(0, 200)}` : ''}`);
    }
    const text = await res.text().catch(() => '');
    return (text ? JSON.parse(text) : undefined) as T;
  }

  const redact = (s: string) => (cfg.token ? s.split(cfg.token).join('[redacted]') : s);

  async function ensureMachine(region: string): Promise<Machine> {
    const all = (await call<Machine[]>('GET', base)) ?? [];
    const m = all.find((x) => x.region === region && x.config?.metadata?.complykit_role === 'worker');
    if (!m) return create(region);
    try {
      return await prepare(m);
    } catch (err) {
      if (!noRoom(err)) throw err;
      // The Machine's host has no room for it (a resize, or a start on a full host).
      // A worker keeps no state: destroy it and let Fly place a new one elsewhere.
      await call('DELETE', `${base}/${m.id}?force=true`);
      return create(region);
    }
  }

  /** Fly's answer when a Machine's current host cannot fit it (409/412 "could not reserve resource", "insufficient memory/cpu"). */
  const noRoom = (err: unknown) => /could not reserve resource|insufficient (memory|cpu|resources)/i.test(err instanceof Error ? err.message : String(err));

  function create(region: string): Promise<Machine> {
    return call<Machine>('POST', base, {
      name: `worker-${region}`,
      region,
      config: {
        image: cfg.image,
        env: workerEnv,
        guest: WORKER_GUEST,
        services: WORKER_SERVICES,
        restart: { policy: 'no' },
        metadata: { complykit_role: 'worker' },
      },
    });
  }

  /** Bring an existing worker to this image and size, then start it. */
  async function prepare(m: Machine): Promise<Machine> {
    if (m.config?.image !== cfg.image || !sameGuest(m.config?.guest) || !sameServices(m.config?.services)) {
      const updated = await call<Machine | undefined>('POST', `${base}/${m.id}`, {
        region: m.region,
        config: { ...m.config, image: cfg.image, env: { ...m.config?.env, ...workerEnv }, guest: WORKER_GUEST, services: WORKER_SERVICES },
      });
      m = { ...m, ...(updated ?? {}), config: updated?.config ?? { ...m.config, image: cfg.image } };
      // Fly leaves a stopped Machine stopped after an update, but its reply shows a
      // transitional state. Wait for it to settle, then start it below.
      m.state = await settle(m.id);
    }
    // The previous scan's release may still be stopping it: Fly refuses a start
    // until the stop lands (412), so wait for it to settle first.
    if (!SETTLED.has(m.state)) m.state = await settle(m.id);
    if (m.state !== 'started' && m.state !== 'starting') {
      try {
        await call('POST', `${base}/${m.id}/start`);
      } catch {
        // Raced a transition between the read and the start: settle and try once more.
        m.state = await settle(m.id);
        if (m.state !== 'started' && m.state !== 'starting') await call('POST', `${base}/${m.id}/start`);
      }
    }
    return m;
  }

  /** Polls a Machine until it is stopped, suspended or started (an update replaces it first). */
  async function settle(id: string): Promise<string> {
    const deadline = now() + SETTLE_TIMEOUT_MS;
    for (;;) {
      const state = (await call<Machine>('GET', `${base}/${id}`).catch(() => undefined))?.state ?? 'unknown';
      if (state === 'stopped' || state === 'suspended' || state === 'started' || state === 'starting' || now() >= deadline) return state;
      await sleep(HEALTH_POLL_MS);
    }
  }

  async function acquireOnce(region: string): Promise<WorkerHandle> {
    let m = await ensureMachine(region);
    // Best effort: let Fly tell us when it is up; the health poll is the real gate.
    await call('GET', `${base}/${m.id}/wait?state=started&timeout=60`).catch(() => undefined);
    // Re-read for the private IP (create/update responses can predate it).
    m = { ...m, ...(await call<Machine>('GET', `${base}/${m.id}`).catch(() => ({}) as Partial<Machine>)) };
    if (!m.private_ip) throw new Error(`worker in ${region}: Machine ${m.id} has no private address`);
    const privateUrl = `http://[${m.private_ip}]:8080`;
    const baseUrl = `https://${cfg.app}.fly.dev`;
    const headers = { [FLY_INSTANCE_HEADER]: m.id };
    const deadline = now() + healthTimeout;
    let last = 'no response';
    for (;;) {
      try {
        const res = await doFetch(`${baseUrl}/internal/health`, { headers: { ...headers, [WORKER_SECRET_HEADER]: cfg.secret } });
        if (res.ok) return { region, machineId: m.id, baseUrl, headers, privateUrl };
        last = `HTTP ${res.status}`;
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
      }
      if (now() >= deadline) break;
      await sleep(HEALTH_POLL_MS);
    }
    throw new Error(`worker in ${region} did not become healthy within ${Math.round(healthTimeout / 1000)}s (last error: ${last})`);
  }

  // One acquire at a time per region, so two jobs can't both create a Machine.
  const chains = new Map<string, Promise<unknown>>();
  function acquire(region: string): Promise<WorkerHandle> {
    const prev = chains.get(region) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => acquireOnce(region));
    const tail = run.catch(() => undefined);
    chains.set(region, tail);
    void tail.then(() => {
      if (chains.get(region) === tail) chains.delete(region);
    });
    return run.catch((e) => {
      throw new Error(redact(e instanceof Error ? e.message : String(e)));
    });
  }

  async function release(h: WorkerHandle): Promise<void> {
    try {
      await call('POST', `${base}/${h.machineId}/stop`);
      // Hand the region over stopped, not stopping: the next scan starts it right away.
      await call('GET', `${base}/${h.machineId}/wait?state=stopped&timeout=60`).catch(() => undefined);
    } catch {
      /* best effort */
    }
  }

  return { acquire, release };
}

/** For tests: region → base URL of an already-running (fake) worker. */
export function fakeFleet(map: Record<string, string>): Fleet {
  return {
    async acquire(region) {
      const baseUrl = map[region];
      if (!baseUrl) throw new Error(`no fake worker for region ${region}`);
      return { region, machineId: `fake-${region}`, baseUrl, headers: {}, privateUrl: baseUrl };
    },
    async release() {},
  };
}
