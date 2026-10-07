import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { CreateBatchResponse, SiteWorkspace } from '../src/shared/api.js';
import { startService, stopAll, waitForStatus } from './helpers.js';

afterEach(stopAll);

// C3: a consent job applies its site's workspace (--workspace), compares with
// the site's previous run still on disk (--previous), and records itself in the
// workspace's runs.

async function scan(s: Awaited<ReturnType<typeof startService>>, url: string): Promise<string> {
  const res = await request(s.app).post('/api/batches').send({ urls: url, quick: true }).expect(201);
  const id = (res.body as CreateBatchResponse).jobs[0].id;
  await waitForStatus(s, id, ['done']);
  return id;
}

describe('consent jobs and the site workspace', () => {
  it('passes the workspace and the previous run, and appends each finished run', async () => {
    const s = await startService();
    await request(s.app)
      .patch('/api/sites/example.com/workspace')
      .send({ by: 'Dana', entries: { 'class:storage-abc': { value: { category: 'analytics', categoryChosen: true } }, 'task:action-1': { value: { status: 'done' } } } })
      .expect(200);

    const first = await scan(s, 'shop.example.com');
    const job1 = s.store.get(first)!;
    const cmd1 = job1.log.find((l) => l.includes('$ complykit consent'))!;
    expect(cmd1).toContain('--workspace');
    expect(cmd1).not.toContain('--previous');
    const written = JSON.parse(fs.readFileSync(path.join(s.store.jobDir(first), 'consent', 'workspace.json'), 'utf8')) as SiteWorkspace;
    expect(written.entries['class:storage-abc'].value).toMatchObject({ category: 'analytics' });

    let ws = (await request(s.app).get('/api/sites/example.com/workspace').expect(200)).body as SiteWorkspace;
    expect(ws.runs).toHaveLength(1);
    expect(ws.runs[0]).toMatchObject({ jobId: first, url: 'https://shop.example.com/', meta: { findings: 2, parties: 4 } });

    // Run ids from the fake CLI are timestamps; keep the second one distinct.
    await new Promise((r) => setTimeout(r, 5));
    const second = await scan(s, 'www.example.com');
    const cmd2 = s.store.get(second)!.log.find((l) => l.includes('$ complykit consent'))!;
    expect(cmd2).toContain(`--previous ${path.join(s.store.jobDir(first), 'consent', '.comply', 'runs', ws.runs[0].id)}`);

    ws = (await request(s.app).get('/api/sites/example.com/workspace').expect(200)).body as SiteWorkspace;
    expect(ws.runs.map((r) => r.jobId)).toEqual([first, second]);
    // The team's entries are untouched by run recording.
    expect(Object.keys(ws.entries).sort()).toEqual(['class:storage-abc', 'task:action-1']);
  });

  it('a site with no workspace still scans, and gets one holding the run', async () => {
    const s = await startService();
    const id = await scan(s, 'new-site.example.org');
    const ws = (await request(s.app).get('/api/sites/example.org/workspace').expect(200)).body as SiteWorkspace;
    expect(ws.runs.map((r) => r.jobId)).toEqual([id]);
  });
});
