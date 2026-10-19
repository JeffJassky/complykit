// Boot: read config, build the app, listen, and own the process lifecycle
// (signals and idle shutdown).

import fs from 'node:fs';
import type { Server } from 'node:http';
import { createApp, type Service } from './app.js';
import { loadConfig } from './config.js';
import { openStorage } from './storage/index.js';
import { idleReason } from './lifecycle.js';
import { createWorkerApp, loadWorkerConfig } from './worker.js';

const IDLE_CHECK_MS = 30_000;
/** On a signal the platform gives us seconds, not the full 10s kill grace. */
const SIGNAL_KILL_GRACE_MS = 3_000;
/** The whole host shutdown (jobs failed, Machines halted, records flushed) gets this long; then the process exits whatever is left. */
const SHUTDOWN_BOUND_MS = 15_000;

/** WORKER=1: serve only /internal/* for the primary's multi-region scans. */
async function mainWorker(): Promise<void> {
  const config = loadWorkerConfig(); // throws without WORKER_SECRET
  if (!fs.existsSync(config.cliPath)) {
    console.warn(`[boot] complykit CLI not found at ${config.cliPath} — collections will fail until it is built (or set COMPLYKIT_CLI)`);
  }
  const worker = createWorkerApp(config);
  const server = worker.app.listen(config.port, config.bind, () => {
    console.log(`[boot] complykit worker ${config.version} on ${config.bind}:${config.port} (tmp ${config.tmpDir}${config.idleShutdownMinutes ? `, idle shutdown ${config.idleShutdownMinutes}m` : ''})`);
  });

  let stopping = false;
  const shutdown = async (why: string, killGraceMs?: number) => {
    if (stopping) return;
    stopping = true;
    console.log(`[shutdown] ${why}`);
    await worker.stop(killGraceMs);
    server.closeIdleConnections();
    await Promise.race([new Promise<void>((resolve) => server.close(() => resolve())), new Promise((r) => setTimeout(r, 2_000).unref())]);
    server.closeAllConnections();
    console.log('[shutdown] done');
    process.exit(0);
  };
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => void shutdown(`received ${sig}`, SIGNAL_KILL_GRACE_MS));
  }
  if (config.idleShutdownMinutes > 0) {
    setInterval(() => {
      const reason = idleReason({ idleMinutes: config.idleShutdownMinutes, busy: worker.isBusy(), lastActivity: worker.lastActivity() });
      if (reason) void shutdown(reason);
    }, IDLE_CHECK_MS).unref();
  }
}

async function main(): Promise<void> {
  if (process.env.WORKER === '1') return mainWorker();
  const config = loadConfig();
  if (!config.password) {
    console.warn('\n  !!! SERVICE_PASSWORD is not set — the service is OPEN to anyone who can reach it. !!!\n');
  }
  if (!fs.existsSync(config.cliPath)) {
    console.warn(`[boot] complykit CLI not found at ${config.cliPath} — jobs will fail until it is built (or set COMPLYKIT_CLI)`);
  }

  const storage = await openStorage({ dataBackend: config.dataBackend, dataDir: config.dataDir, cloud: config.cloud });
  const service = await createApp(config, {}, { storage });
  const server = service.app.listen(config.port, '0.0.0.0', () => {
    console.log(
      `[boot] complykit service ${config.version} on http://0.0.0.0:${config.port}` +
        ` (${config.dataBackend === 'cloud' ? 'storage cloud (Spaces + MongoDB), scratch' : 'data'} ${config.dataDir}, concurrency ${config.concurrency}, retention ${config.retentionDays}d` +
        `${config.idleShutdownMinutes ? `, idle shutdown ${config.idleShutdownMinutes}m` : ''}${config.region ? `, region ${config.region}` : ''})`,
    );
  });

  let stopping = false;
  const shutdown = async (why: string, killGraceMs?: number) => {
    if (stopping) return;
    stopping = true;
    console.log(`[shutdown] ${why}`);
    // A stuck step (a Machines API call, a database write) must not outlast the platform's patience: jobs are already persisted as failed by then.
    setTimeout(() => {
      console.error(`[shutdown] still not done after ${SHUTDOWN_BOUND_MS / 1000} s; exiting`);
      process.exit(0);
    }, SHUTDOWN_BOUND_MS).unref();
    await closeGracefully(server, service, killGraceMs);
    await storage.close().catch(() => undefined);
    console.log('[shutdown] done');
    process.exit(0);
  };

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => void shutdown(`received ${sig}`, SIGNAL_KILL_GRACE_MS));
  }

  if (config.idleShutdownMinutes > 0) {
    setInterval(() => {
      const reason = idleReason({ idleMinutes: config.idleShutdownMinutes, busy: service.busy(), lastActivity: service.lastActivity() });
      // exit(0): fly.toml's restart policy is on-failure, so the Machine stays
      // stopped until the next request wakes it.
      if (reason) void shutdown(reason);
    }, IDLE_CHECK_MS).unref();
  }
}

async function closeGracefully(server: Server, service: Service, killGraceMs?: number): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  await service.stop(killGraceMs); // kills checks, ends SSE streams, flushes job.json
  server.closeIdleConnections();
  // Don't hang on a slow client (e.g. a zip download in progress).
  await Promise.race([closed, new Promise((r) => setTimeout(r, 2_000).unref())]);
  server.closeAllConnections();
}

main().catch((err: unknown) => {
  console.error(`[boot] ${(err as Error).message ?? String(err)}`);
  process.exit(1);
});
