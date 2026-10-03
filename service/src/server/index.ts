// Boot: read config, build the app, listen, and own the process lifecycle
// (signals and idle shutdown).

import fs from 'node:fs';
import type { Server } from 'node:http';
import { createApp, type Service } from './app.js';
import { loadConfig } from './config.js';
import { idleReason } from './lifecycle.js';

const IDLE_CHECK_MS = 30_000;
/** On a signal the platform gives us seconds, not the full 10s kill grace. */
const SIGNAL_KILL_GRACE_MS = 3_000;

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.password) {
    console.warn('\n  !!! SERVICE_PASSWORD is not set — the service is OPEN to anyone who can reach it. !!!\n');
  }
  if (!fs.existsSync(config.cliPath)) {
    console.warn(`[boot] complykit CLI not found at ${config.cliPath} — jobs will fail until it is built (or set COMPLYKIT_CLI)`);
  }

  const service = await createApp(config);
  const server = service.app.listen(config.port, '0.0.0.0', () => {
    console.log(
      `[boot] complykit service ${config.version} on http://0.0.0.0:${config.port}` +
        ` (data ${config.dataDir}, concurrency ${config.concurrency}, retention ${config.retentionDays}d` +
        `${config.idleShutdownMinutes ? `, idle shutdown ${config.idleShutdownMinutes}m` : ''}${config.region ? `, region ${config.region}` : ''})`,
    );
  });

  let stopping = false;
  const shutdown = async (why: string, killGraceMs?: number) => {
    if (stopping) return;
    stopping = true;
    console.log(`[shutdown] ${why}`);
    await closeGracefully(server, service, killGraceMs);
    console.log('[shutdown] done');
    process.exit(0);
  };

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => void shutdown(`received ${sig}`, SIGNAL_KILL_GRACE_MS));
  }

  if (config.idleShutdownMinutes > 0) {
    setInterval(() => {
      const reason = idleReason({ idleMinutes: config.idleShutdownMinutes, busy: service.runner.isBusy(), lastActivity: service.lastActivity() });
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
