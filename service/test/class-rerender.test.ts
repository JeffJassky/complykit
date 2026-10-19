import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { JobReportResponse } from '../src/shared/api.js';
import { classRerendersSettled } from '../src/server/job-report.js';
import { startService, stopAll, waitForStatus } from './helpers.js';

// plans/report-truth.md C2 + C3: the server owns the re-render after a
// classification, a stale report updates itself once, and a refused answer
// reaches the to-do task.

afterEach(async () => {
  delete process.env.FAKE_REPORT_FAIL;
  delete process.env.FAKE_REPORT_DELAY_MS;
  await classRerendersSettled();
  await stopAll();
});

type S = Awaited<ReturnType<typeof startService>>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const get = async (s: S, id: string): Promise<JobReportResponse> => (await request(s.app).get(`/api/jobs/${id}/report`).expect(200)).body as JobReportResponse;
const calls = (s: S, id: string): number => {
  const f = path.join(s.store.jobDir(id), 'consent', 'report-calls.ndjson');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').length : 0;
};
const classify = (s: S, category: string, domain = 'example-shop.test') =>
  request(s.app).patch(`/api/sites/${domain}/workspace`).send({ entries: { 'class:fake-widget': { value: { category, categoryChosen: true } } } }).expect(200);

async function scan(s: S, host: string): Promise<string> {
  const res = await request(s.app).post('/api/batches').send({ urls: host }).expect(201);
  const id = res.body.jobs[0].id as string;
  await waitForStatus(s, id, ['done']);
  await s.checklists.settled();
  return id;
}

describe('PATCH /api/sites/:domain/workspace with a class: key', () => {
  it('re-renders the newest done scan once, not an older one', async () => {
    const s = await startService({ autoChecklist: true });
    const older = await scan(s, 'a.example-shop.test');
    await sleep(5);
    const newest = await scan(s, 'widget.example-shop.test');
    const [o, n] = [calls(s, older), calls(s, newest)];

    await classify(s, 'analytics');
    await classRerendersSettled();
    expect(calls(s, newest)).toBe(n + 1);
    expect(calls(s, older)).toBe(o);
    const r = await get(s, newest);
    expect(r.report!.matrix.tools[1]).toMatchObject({ classified: true, answer: { applied: true } });
    expect(r.todo.tasks[0].status).toBe('verified');
    // The re-render's own writes do not make the fresh report look stale: reading it starts nothing.
    await get(s, newest);
    await get(s, newest);
    await classRerendersSettled();
    expect(calls(s, newest)).toBe(n + 1);
  });

  it('a write without a class: key re-renders nothing', async () => {
    const s = await startService({ autoChecklist: true });
    const id = await scan(s, 'widget.example-shop.test');
    const n = calls(s, id);
    await request(s.app).patch('/api/sites/example-shop.test/workspace').send({ entries: { 'task:change:install': { value: { status: 'done-unverified' } } } }).expect(200);
    await classRerendersSettled();
    expect(calls(s, id)).toBe(n);
  });
});

describe('GET /api/jobs/:id/report on a stale report', () => {
  it('answers updating:true and starts one re-render; a second read while it runs starts none', async () => {
    const s = await startService({ autoChecklist: true });
    const older = await scan(s, 'a.example-shop.test');
    await sleep(5);
    await scan(s, 'widget.example-shop.test');
    await classify(s, 'analytics'); // re-renders the newest; the older report is now older than the classification
    await classRerendersSettled();
    const n = calls(s, older);

    process.env.FAKE_REPORT_DELAY_MS = '400';
    const first = await get(s, older);
    expect(first.updating).toBe(true);
    const second = await get(s, older);
    expect(second.updating).toBe(true);
    await classRerendersSettled();
    expect(calls(s, older)).toBe(n + 1);

    const after = await get(s, older);
    expect(after.updating).toBe(false);
    expect(after.updateError).toBeUndefined();
    await classRerendersSettled();
    expect(calls(s, older)).toBe(n + 1);
  });

  it('a failed re-render is not retried for the same classification and says why; a later classification retries', async () => {
    const s = await startService({ autoChecklist: true });
    const id = await scan(s, 'widget.example-shop.test');
    const n = calls(s, id);

    process.env.FAKE_REPORT_FAIL = '1';
    await classify(s, 'analytics');
    await classRerendersSettled();
    expect(calls(s, id)).toBe(n + 1);

    const stuck = await get(s, id);
    expect(stuck.updateError).toMatch(/report crashed/);
    expect(stuck.updating).toBe(false);
    await get(s, id);
    await classRerendersSettled();
    expect(calls(s, id)).toBe(n + 1); // not retried for this stamp

    delete process.env.FAKE_REPORT_FAIL;
    await sleep(5);
    await classify(s, 'advertising'); // a new stamp
    await classRerendersSettled();
    expect(calls(s, id)).toBe(n + 2);
    const ok = await get(s, id);
    expect(ok.updateError).toBeUndefined();
    expect(ok.report!.matrix.tools[1]).toMatchObject({ classified: true });
    await classRerendersSettled();
    expect(calls(s, id)).toBe(n + 2);
  });
});

describe('the fact ids the picker stores', () => {
  it.each(['payments', 'necessary', 'chat', 'embed', 'reviews', 'functional', 'analytics', 'advertising'])('%s decides the classification', async (category) => {
    const s = await startService({ autoChecklist: true });
    const id = await scan(s, 'widget.example-shop.test');
    await classify(s, category);
    await classRerendersSettled();
    expect((await get(s, id)).todo.tasks[0].status).toBe('verified');
  });
});

describe('a refused answer', () => {
  it('reaches the decision task as `refused`, with what the owner answered; an applied one does not', async () => {
    const s = await startService({ autoChecklist: true });
    const id = await scan(s, 'widget.example-shop.test');

    await classify(s, 'necessary');
    await classRerendersSettled();
    const refused = await get(s, id);
    expect(refused.report!.matrix.tools[1]).toMatchObject({ classified: true, answer: { applied: false, reason: 'sends a stored id before consent' } });
    expect(refused.todo.tasks[0]).toMatchObject({ kind: 'classify', status: 'verified', refused: 'sends a stored id before consent', answered: 'necessary' });

    await sleep(5);
    await classify(s, 'analytics');
    await classRerendersSettled();
    const applied = await get(s, id);
    expect(applied.todo.tasks[0].status).toBe('verified');
    expect(applied.todo.tasks[0].refused).toBeUndefined();
  });
});
