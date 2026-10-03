// Real-CLI smoke test: runs complykit consent --quick against a live site.
// Skipped unless SERVICE_E2E=1 (needs network, Chromium, and ~2 minutes).
// Requires complykit to be built: `npm run build` in packages/complykit.

import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/server/config.js';
import type { CreateBatchResponse } from '../src/shared/api.js';
import { startService, stopAll, waitForStatus } from './helpers.js';

afterEach(stopAll);

describe.skipIf(process.env.SERVICE_E2E !== '1')('e2e: real complykit CLI', () => {
  it('scans https://storyfolder.com/ in quick mode and serves the report', async () => {
    const s = await startService({ cliPath: loadConfig({}).cliPath, pollMs: 500 });
    const res = await request(s.app).post('/api/batches').send({ urls: 'https://storyfolder.com/', quick: true }).expect(201);
    const id = (res.body as CreateBatchResponse).jobs[0].id;
    const job = await waitForStatus(s, id, ['done', 'failed'], 10 * 60_000);
    expect(job.error).toBeUndefined();
    expect(job.progress.fraction).toBe(1);
    expect(job.metrics.requests).toBeGreaterThan(0);
    const html = await request(s.app).get(job.result!.consent!.reportUrl).expect(200);
    expect(html.headers['content-type']).toMatch(/text\/html/);
  }, 11 * 60_000);
});
