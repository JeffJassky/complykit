import { describe, expect, it, vi } from 'vitest';
import type { JobDetail } from '../src/shared/api.js';
import { JobStore } from '../src/server/store.js';
import { fsStorage } from '../src/server/storage/fs.js';
import type { Storage } from '../src/server/storage/types.js';
import { tempDir } from './helpers.js';

function flaky(failTimes: number) {
  const dir = tempDir();
  const base = fsStorage(dir);
  const puts: JobDetail[] = [];
  let attempts = 0;
  const storage: Storage = {
    ...base,
    jobs: {
      ...base.jobs,
      async put(job) {
        attempts++;
        if (attempts <= failTimes) throw new Error('mongo blip');
        puts.push(JSON.parse(JSON.stringify(job)) as JobDetail);
      },
    },
  };
  return { dir, storage, puts, attempts: () => attempts };
}

describe('JobStore persist retries', () => {
  it('retries a failed record write until it lands, and flush() waits for it', async () => {
    const f = flaky(3);
    const store = new JobStore(f.dir, f.storage, [1, 1, 1, 1]);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const job = store.create({ batchId: 'b', url: 'https://a.example.com/', checks: ['consent'], quick: true });
    job.status = 'done';
    store.update(job);
    await store.flush();
    expect(f.puts.at(-1)?.status).toBe('done');
    expect(f.attempts()).toBeGreaterThanOrEqual(4);
  });

  it('logs at error level with the job id after the last attempt, then starts afresh on the next change', async () => {
    const f = flaky(100);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new JobStore(f.dir, f.storage, [1, 1]);
    const job = store.create({ batchId: 'b', url: 'https://a.example.com/', checks: ['consent'], quick: true });
    await store.flush();
    expect(f.attempts()).toBe(3);
    expect(err.mock.calls.some((c) => String(c[0]).includes(job.id))).toBe(true);
  });
});
