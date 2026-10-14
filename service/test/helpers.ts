import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, type Service } from '../src/server/app.js';
import type { RunnerOptions } from '../src/server/runner.js';
import { loadConfig, type ServiceConfig } from '../src/server/config.js';
import type { JobDetail } from '../src/shared/api.js';

export const FAKE_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-cli.mjs');

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'complykit-service-'));
}

export function testConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  const dataDir = overrides.dataDir ?? tempDir();
  return {
    ...loadConfig({}),
    dataDir,
    kbDir: path.join(dataDir, 'kb'),
    researchAvailable: false,
    cliPath: FAKE_CLI,
    clientDir: path.join(tempDir(), 'no-client'),
    pollMs: 25,
    killGraceMs: 500,
    // Off by default here: tests that exercise the automatic to-do list turn it on.
    autoChecklist: false,
    ...overrides,
  };
}

const services: Service[] = [];
export async function startService(overrides: Partial<ServiceConfig> = {}, runnerOptions: RunnerOptions = {}): Promise<Service> {
  const s = await createApp(testConfig(overrides), runnerOptions);
  services.push(s);
  return s;
}
export async function stopAll(): Promise<void> {
  await Promise.all(services.splice(0).map((s) => s.stop(200)));
}

export async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 10_000, label = 'condition'): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export function waitForStatus(s: Service, id: string, statuses: JobDetail['status'][], timeoutMs?: number): Promise<JobDetail> {
  return waitFor(() => {
    const j = s.store.get(id);
    return j && statuses.includes(j.status) ? j : undefined;
  }, timeoutMs, `job ${id} → ${statuses.join('|')}`);
}

/** supertest doesn't buffer application/zip; collect it as a Buffer. The
 *  callback receives the raw Node response stream at runtime. */
export function binaryParser(res: unknown, cb: (err: Error | null, body: Buffer) => void): void {
  const stream = res as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  stream.on('end', () => cb(null, Buffer.concat(chunks)));
}
