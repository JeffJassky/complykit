// Fleet manager: starts and stops the regional worker Machines (Fly Machines
// API). The primary acquires a region's worker, waits for /internal/health,
// uses it, then releases (stops) it. The API token is never logged or put in
// an error message.

export interface WorkerHandle {
  region: string;
  machineId: string;
  baseUrl: string;
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
  config?: { image?: string; env?: Record<string, string>; metadata?: Record<string, string>; [k: string]: unknown };
}

const HEALTH_TIMEOUT_MS = 90_000;
const HEALTH_POLL_MS = 1_000;

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
      headers: { authorization: `Bearer ${cfg.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
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
    let m = all.find((x) => x.region === region && x.config?.metadata?.complykit_role === 'worker');
    if (!m) {
      return call<Machine>('POST', base, {
        name: `worker-${region}`,
        region,
        config: {
          image: cfg.image,
          env: workerEnv,
          guest: { cpu_kind: 'shared', cpus: 2, memory_mb: 2048 },
          restart: { policy: 'no' },
          metadata: { complykit_role: 'worker' },
        },
      });
    }
    if (m.config?.image !== cfg.image) {
      const updated = await call<Machine | undefined>('POST', `${base}/${m.id}`, {
        region,
        config: { ...m.config, image: cfg.image, env: { ...m.config?.env, ...workerEnv } },
      });
      m = { ...m, ...(updated ?? {}), config: updated?.config ?? { ...m.config, image: cfg.image } };
    }
    if (m.state === 'stopped' || m.state === 'suspended') {
      await call('POST', `${base}/${m.id}/start`);
    }
    return m;
  }

  async function acquireOnce(region: string): Promise<WorkerHandle> {
    let m = await ensureMachine(region);
    // Best effort: let Fly tell us when it is up; the health poll is the real gate.
    await call('GET', `${base}/${m.id}/wait?state=started&timeout=60`).catch(() => undefined);
    // Re-read for the private IP (create/update responses can predate it).
    m = { ...m, ...(await call<Machine>('GET', `${base}/${m.id}`).catch(() => ({}) as Partial<Machine>)) };
    if (!m.private_ip) throw new Error(`worker in ${region}: Machine ${m.id} has no private address`);
    const baseUrl = `http://[${m.private_ip}]:8080`;
    const deadline = now() + healthTimeout;
    let last = 'no response';
    for (;;) {
      try {
        const res = await doFetch(`${baseUrl}/internal/health`, { headers: { 'x-complykit-worker-secret': cfg.secret } });
        if (res.ok) return { region, machineId: m.id, baseUrl };
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
      return { region, machineId: `fake-${region}`, baseUrl };
    },
    async release() {},
  };
}
