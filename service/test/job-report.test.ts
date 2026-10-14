import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { JobReportResponse, SiteWorkspace } from '../src/shared/api.js';
import { shouldGenerate } from '../src/server/job-report.js';
import { startService, stopAll, waitForStatus } from './helpers.js';

// GET /api/jobs/:id/report (plans/simple-report.md): the owner report page in
// one poll — live while the scan runs (the fake CLI rewrites owner-report.json
// after every visit), final when done, with the site's to-do list.

afterEach(stopAll);

async function start(app: Parameters<typeof request>[0], url: string, extra: object = {}): Promise<string> {
  const res = await request(app).post('/api/batches').send({ urls: url, ...extra }).expect(201);
  return res.body.jobs[0].id as string;
}
const get = async (app: Parameters<typeof request>[0], id: string): Promise<JobReportResponse> => (await request(app).get(`/api/jobs/${id}/report`).expect(200)).body as JobReportResponse;

describe('GET /api/jobs/:id/report', () => {
  it('live while the scan runs: pending columns fill in, rows appear, the to-do list waits; final when done', async () => {
    const s = await startService();
    const id = await start(s.app, 'slow.widget.example-shop.test');

    let live: JobReportResponse | undefined;
    for (let i = 0; i < 200 && !live; i++) {
      const r = await get(s.app, id);
      if (r.report && r.job.status === 'running') live = r;
      else await new Promise((res) => setTimeout(res, 20));
    }
    expect(live, 'a live owner report while running').toBeTruthy();
    expect(live!.report!.stage).toBe('live');
    expect(live!.todo).toEqual({ state: 'waiting', tasks: [] });
    expect(live!.report!.matrix.columns.some((c) => c.state === 'pending' || c.state === 'running')).toBe(true);
    expect(live!.domain).toBe('example-shop.test');

    // Mid-scan: the first column judged, the widget's row appears after the second visit with "needs a decision".
    let mid: JobReportResponse | undefined;
    for (let i = 0; i < 400 && !mid; i++) {
      const r = await get(s.app, id);
      if (r.report && r.report.stage === 'live' && r.report.decisions.length) mid = r;
      else await new Promise((res) => setTimeout(res, 20));
    }
    expect(mid, 'the unknown tool appears while scanning').toBeTruthy();
    expect(mid!.report!.banner).toMatchObject({ state: 'detected', provider: 'OneTrust' });
    expect(mid!.report!.matrix.tools.map((t) => t.label)).toEqual(['Meta Pixel', 'widgets.test']);
    expect(mid!.report!.matrix.tools[1].cells.map((c) => c.state)).toContain('needs-decision');

    await waitForStatus(s, id, ['done']);
    const done = await get(s.app, id);
    expect(done.report!.stage).toBe('final');
    expect(done.report!.matrix.columns.every((c) => c.state === 'done' || c.state === 'not-checked')).toBe(true);
    expect(done.report!.matrix.counts.pending).toBe(0);
    // autoChecklist is off in this service: nothing made the list.
    expect(done.todo.state).toBe('none');
    expect(done.technicalReportUrl).toMatch(/^\/reports\/.+\/consent-report\.html$/);
    expect(done.jsonReportUrl).toBe(done.technicalReportUrl!.replace(/\.html$/, '.json'));
    expect(done.downloadUrl).toBe(`/api/jobs/${id}/download`);
    const json = await request(s.app).get(done.jsonReportUrl!);
    expect(json.status).toBe(200);
    expect(done.updating).toBe(false);
  });

  it('makes the to-do list when the scan finishes; a classification re-renders the report and decides the decision', async () => {
    const s = await startService({ autoChecklist: true });
    const id = await start(s.app, 'widget.example-shop.test');
    await waitForStatus(s, id, ['done']);
    let r: JobReportResponse | undefined;
    for (let i = 0; i < 300; i++) {
      r = await get(s.app, id);
      if (r.todo.state === 'ready') break;
      expect(['preparing', 'ready']).toContain(r.todo.state);
      await new Promise((res) => setTimeout(res, 20));
    }
    await s.checklists.settled();
    r = await get(s.app, id);
    expect(r.todo.state).toBe('ready');
    expect(r.todo.tasks.map((t) => t.id)).toEqual(['classify:aaaaaaaaaaaa', 'install', 'rewrite-tag:0123456789ab']);
    expect(r.todo.tasks[0]).toMatchObject({ kind: 'classify', classKey: 'class:fake-widget', status: 'todo' });
    expect(r.todo).toMatchObject({ fromThisRun: true, progress: { verified: 0, required: 3 } });
    expect(r.installZipUrl).toBe('/api/sites/example-shop.test/install.zip');
    expect(r.report!.matrix.tools[1]).toMatchObject({ classified: false, classKey: 'class:fake-widget' });

    // The owner decides; the page asks for a re-render (no "Update report" button).
    await request(s.app).patch('/api/sites/example-shop.test/workspace').send({ entries: { 'class:fake-widget': { value: { category: 'analytics', categoryChosen: true } } } }).expect(200);
    await request(s.app).post(`/api/jobs/${id}/rerender`).send({}).expect(200);
    const after = await get(s.app, id);
    expect(after.report!.matrix.tools[1]).toMatchObject({ classified: true, purpose: 'Analytics' });
    expect(after.report!.matrix.tools[1].cells.map((c) => c.state)).not.toContain('needs-decision');
    expect(after.report!.decisions).toEqual([]);
    expect(after.todo.tasks[0].status).toBe('verified');
    expect(after.todo.progress).toMatchObject({ verified: 1, required: 3 });
  });

  it('an accessibility-only job has no owner report and no list', async () => {
    const s = await startService();
    const id = await start(s.app, 'a11y.example-shop.test', { checks: { consent: false, accessibility: true } });
    await waitForStatus(s, id, ['done']);
    const r = await get(s.app, id);
    expect(r.report).toBeNull();
    expect(r.todo.state).toBe('none');
    expect(r.accessibilityReportUrl).toMatch(/accessibility\/report\.html$/);
  });

  it('a failed scan: whatever was seen stays, no list; an unknown job is a 404', async () => {
    const s = await startService({ autoChecklist: true });
    const id = await start(s.app, 'fail.example-shop.test');
    await waitForStatus(s, id, ['failed']);
    const r = await get(s.app, id);
    expect(r.job.status).toBe('failed');
    expect(r.todo.state).toBe('none');
    await request(s.app).get('/api/jobs/nope/report').expect(404);
  });
});

describe('shouldGenerate (the automatic to-do list)', () => {
  const task = (id: string, extra: object = {}) => ({ id, kind: 'rewrite-tag', group: 'g', title: id, summary: '', tools: [], partyIds: [], steps: [], pages: [], verify: { check: 'rewrite-tag', method: 'static' }, status: 'todo', optional: false, notes: [], order: 0, ...extra });
  const ws = (entries: SiteWorkspace['entries'], tasks: object[] | undefined, runId = 'run-old'): SiteWorkspace => ({ version: 1, domain: 'x.test', entries, runs: [], ...(tasks ? { config: { value: { tasks }, at: '2026-10-07T00:00:00Z', runId } } : {}) });

  it('makes a list when there is none, or the stored one came from this run', () => {
    expect(shouldGenerate(ws({}, undefined), 'run-new')).toBe(true);
    expect(shouldGenerate(ws({ 'task:change:a': { value: { status: 'verified' }, at: 'x' } }, [task('a')], 'run-new'), 'run-new')).toBe(true);
  });
  it('follows the newest scan, whatever was done on other tasks (their status carries over by id)', () => {
    expect(shouldGenerate(ws({ 'class:k': { value: { category: 'analytics' }, at: 'x' } }, [task('a'), task('classify:1', { kind: 'classify', classKey: 'class:k' })]), 'run-new')).toBe(true);
    expect(shouldGenerate(ws({ 'task:change:a': { value: { status: 'done-unverified' }, at: 'x' } }, [task('a')]), 'run-new')).toBe(true);
    expect(shouldGenerate(ws({ 'task:change:a': { value: { status: 'failed' }, at: 'x' } }, [task('a')]), 'run-new')).toBe(true);
  });
  it('keeps the list while complykit\'s tool is deployed from it (install done or verified): a new config could move its hash', () => {
    const install = task('install', { kind: 'install' });
    expect(shouldGenerate(ws({ 'task:change:install': { value: { status: 'verified' }, at: 'x' } }, [install, task('a')]), 'run-new')).toBe(false);
    expect(shouldGenerate(ws({ 'task:change:install': { value: { status: 'done-unverified' }, at: 'x' } }, [install, task('a')]), 'run-new')).toBe(false);
    expect(shouldGenerate(ws({ 'task:change:install': { value: { status: 'failed' }, at: 'x' } }, [install, task('a')]), 'run-new')).toBe(true);
    expect(shouldGenerate(ws({}, [install, task('a')]), 'run-new')).toBe(true);
  });
});
