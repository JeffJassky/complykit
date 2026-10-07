import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { RemediationResponse, RemediationTask, SiteWorkspace, VerifyTaskResponse } from '../src/shared/api.js';
import { startService, stopAll } from './helpers.js';

afterEach(stopAll);

// R4: GET /api/sites/:domain/remediation merges the stored checklist
// (config.value.tasks) with the task:change:<id> statuses; POST …/:id/verify
// runs `complykit verify-change` (the fake CLI here) and stores
// { status, lastVerify } by 'verify', one verify per site at a time.

const task = (id: string, order: number, verify: RemediationTask['verify'], extra: Partial<RemediationTask> = {}): RemediationTask => ({
  id,
  kind: id === 'install' ? 'install' : id.split(':')[0],
  group: 'g',
  title: `Task ${id}`,
  summary: 's',
  tools: [],
  partyIds: [],
  steps: ['do it'],
  pages: [],
  verify,
  status: 'todo',
  optional: false,
  notes: [],
  order,
  ...extra,
});

const TASKS: RemediationTask[] = [
  task('install', 0, { check: 'install', method: 'static', page: 'https://shop.example.com/', configHash: 'a'.repeat(64), scriptSrc: '/ck.js', elementId: 'complykit-config' }),
  task('rewrite-tag:aaaaaaaaaaaa', 1, { check: 'rewrite-tag', method: 'static', page: 'https://shop.example.com/fail', element: { kind: 'script', context: 'document', ids: [] }, category: 'analytics' }),
  task('change-dns:bbbbbbbbbbbb', 2, { check: 'manual', method: 'manual', reason: 'DNS' }),
  task('behavior-mismatch:cccccccccccc', 3, { check: 'spot-check', method: 'browser', page: 'https://shop.example.com/slow', partyId: 'x', hosts: ['x.example'], scenario: 'reject-then-accept' }),
  task('remove-leak:dddddddddddd', 4, { check: 'remove-leak', method: 'static', page: 'https://shop.example.com/crash', element: { kind: 'img', context: 'noscript', ids: [] } }, { optional: true }),
];

async function seeded() {
  const s = await startService();
  await request(s.app)
    .patch('/api/sites/example.com/workspace')
    .send({
      by: 'Ann',
      config: { value: { config: {}, snippet: '', changeList: '', notes: [], tasks: TASKS }, runId: 'run-a' },
      entries: {
        // The report workbench's vocabulary: 'done' reads as done-unverified, never verified.
        'task:change:change-dns:bbbbbbbbbbbb': { value: { status: 'done', note: 'CNAME removed' } },
        'task:change:rewrite-tag:aaaaaaaaaaaa': { value: { status: 'todo', note: 'theme header.php' } },
      },
    })
    .expect(200);
  return s;
}

describe('GET /api/sites/:domain/remediation', () => {
  it('a status stored under a folded item’s id is found through the task’s aliases; a carried pass on a static task reads as done-unverified, on a spot check as verified', async () => {
    const s = await startService();
    const spot = { check: 'spot-check' as const, method: 'browser' as const, page: 'https://shop.example.com/', partyId: 'x', hosts: ['x.example'], scenario: 'reject-then-accept' };
    const tasks = [
      task('rewrite-tag:111111111111', 0, TASKS[1].verify, { aliases: ['behavior-mismatch:999999999999'] }),
      task('confirm-in-browser:222222222222', 1, spot, { aliases: ['behavior-mismatch:999999999999'] }),
      task('remove-leak:333333333333', 2, TASKS[4].verify, { aliases: ['behavior-mismatch:999999999999'] }),
    ];
    await request(s.app)
      .patch('/api/sites/example.com/workspace')
      .send({
        config: { value: { config: {}, snippet: '', changeList: '', notes: [], tasks }, runId: 'run-a' },
        entries: { 'task:change:behavior-mismatch:999999999999': { value: { status: 'verified', note: 'old' } }, 'task:change:remove-leak:333333333333': { value: { status: 'failed' } } },
      })
      .expect(200);
    const res = (await request(s.app).get('/api/sites/example.com/remediation').expect(200)).body as RemediationResponse;
    expect(res.tasks.map((t) => t.status)).toEqual(['done-unverified', 'verified', 'failed']);
  });

  it('is empty before a config with tasks exists', async () => {
    const s = await startService();
    const res = await request(s.app).get('/api/sites/example.com/remediation').expect(200);
    expect(res.body).toEqual({ domain: 'example.com', tasks: [], totals: { total: 0, verified: 0, doneUnverified: 0, failed: 0, cannotVerify: 0, todo: 0, required: 0 } });
  });

  it('merges the stored checklist with the workspace statuses, from any host of the site', async () => {
    const s = await seeded();
    const body = (await request(s.app).get('/api/sites/shop.example.com/remediation').expect(200)).body as RemediationResponse;
    expect(body.domain).toBe('example.com');
    expect(body.runId).toBe('run-a');
    expect(body.configAt).toEqual(expect.any(String));
    expect(body.tasks.map((t) => [t.id, t.status])).toEqual([
      ['install', 'todo'],
      ['rewrite-tag:aaaaaaaaaaaa', 'todo'],
      ['change-dns:bbbbbbbbbbbb', 'done-unverified'],
      ['behavior-mismatch:cccccccccccc', 'todo'],
      ['remove-leak:dddddddddddd', 'todo'],
    ]);
    expect(body.tasks[2].note).toBe('CNAME removed');
    expect(body.totals).toEqual({ total: 5, verified: 0, doneUnverified: 1, failed: 0, cannotVerify: 0, todo: 4, required: 4 });
  });
});

describe('decisions (classify tasks) in the same list', () => {
  it('a decision’s status is its tool’s classification in the workspace — never a task:change entry; it counts on the sites list; Verify refuses it', async () => {
    const s = await startService();
    const classKey = 'class:tool-0123456789abcdef0123456789abcdef';
    const decision = task('classify:111111111111', 0, { check: 'manual', method: 'manual', reason: 'a decision' }, { classKey });
    const blocked = task('rewrite-tag:222222222222', 2, TASKS[1].verify, { classifyFirst: true, waitingOn: [decision.id] });
    await request(s.app)
      .patch('/api/sites/example.com/workspace')
      .send({ config: { value: { config: {}, snippet: '', changeList: '', notes: [], tasks: [decision, TASKS[0], blocked] }, runId: 'run-a' }, entries: { 'task:change:classify:111111111111': { value: { status: 'verified' } } } })
      .expect(200);
    const get = async () => (await request(s.app).get('/api/sites/example.com/remediation').expect(200)).body as RemediationResponse;
    expect((await get()).tasks.map((t) => [t.id, t.status])).toEqual([['classify:111111111111', 'todo'], ['install', 'todo'], ['rewrite-tag:222222222222', 'todo']]);
    const refused = await request(s.app).post(`/api/sites/example.com/remediation/${encodeURIComponent(decision.id)}/verify`).expect(409);
    expect(refused.body.error).toMatch(/decision/);
    await request(s.app).patch('/api/sites/example.com/workspace').send({ entries: { [classKey]: { value: { category: 'analytics', categoryChosen: true } } } }).expect(200);
    const after = await get();
    expect(after.tasks[0].status).toBe('verified');
    expect(after.totals).toMatchObject({ total: 3, verified: 1, required: 3 });
    const sites = (await request(s.app).get('/api/sites').expect(200)).body as { sites: Array<{ domain: string; checklist?: { verified: number; required: number } }> };
    expect(sites.sites.find((x) => x.domain === 'example.com')?.checklist).toMatchObject({ verified: 1, required: 3 });
  });
});

describe('POST /api/sites/:domain/remediation/:id/verify', () => {
  it('pass → verified, stored by "verify" with lastVerify; fail → failed, keeping the owner’s note', async () => {
    const s = await seeded();
    const ok = (await request(s.app).post('/api/sites/example.com/remediation/install/verify').expect(200)).body as VerifyTaskResponse;
    expect(ok.task).toMatchObject({ id: 'install', status: 'verified', lastVerify: { result: 'pass', message: 'the served HTML carries the change' } });
    expect(ok.outcome).toMatchObject({ result: 'pass', check: 'install', fetched: { status: 200 } });
    expect(ok.stale).toBe(false);

    const bad = (await request(s.app).post(`/api/sites/example.com/remediation/${encodeURIComponent('rewrite-tag:aaaaaaaaaaaa')}/verify`).expect(200)).body as VerifyTaskResponse;
    expect(bad.task).toMatchObject({ status: 'failed', note: 'theme header.php', lastVerify: { result: 'fail' } });

    const ws = (await request(s.app).get('/api/sites/example.com/workspace').expect(200)).body as SiteWorkspace;
    expect(ws.entries['task:change:install']).toMatchObject({ by: 'verify', value: { status: 'verified', lastVerify: { result: 'pass', evidence: ['served HTML of https://shop.example.com/ (HTTP 200)'] } } });
    expect(ws.entries['task:change:rewrite-tag:aaaaaaaaaaaa'].value).toMatchObject({ status: 'failed', note: 'theme header.php' });

    const view = (await request(s.app).get('/api/sites/example.com/remediation').expect(200)).body as RemediationResponse;
    expect(view.totals).toMatchObject({ verified: 1, failed: 1, doneUnverified: 1 });
  });

  it('one verify per site at a time: a second one while the first runs is a 409', async () => {
    const s = await seeded();
    const first = request(s.app).post(`/api/sites/example.com/remediation/${encodeURIComponent('behavior-mismatch:cccccccccccc')}/verify`).then((r) => r);
    // Let the first spawn before the second arrives.
    await new Promise((r) => setTimeout(r, 80));
    const second = await request(s.app).post('/api/sites/example.com/remediation/install/verify');
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already running/);
    expect((await first).status).toBe(200);
    // Free again afterwards.
    await request(s.app).post('/api/sites/example.com/remediation/install/verify').expect(200);
  });

  it('refuses a manual task (409), an unknown task (404), and answers a crashed check with 500 and no status write', async () => {
    const s = await seeded();
    const manual = await request(s.app).post(`/api/sites/example.com/remediation/${encodeURIComponent('change-dns:bbbbbbbbbbbb')}/verify`).expect(409);
    expect(manual.body.error).toMatch(/mark it done/);
    await request(s.app).post('/api/sites/example.com/remediation/nope/verify').expect(404);
    await request(s.app).post('/api/sites/nothing.example/remediation/install/verify').expect(404);
    const crash = await request(s.app).post(`/api/sites/example.com/remediation/${encodeURIComponent('remove-leak:dddddddddddd')}/verify`).expect(500);
    expect(crash.body.error).toMatch(/boom/);
    const ws = (await request(s.app).get('/api/sites/example.com/workspace').expect(200)).body as SiteWorkspace;
    expect(ws.entries['task:change:remove-leak:dddddddddddd']).toBeUndefined();
    // The lock is released after a failure.
    await request(s.app).post('/api/sites/example.com/remediation/install/verify').expect(200);
  });
});
