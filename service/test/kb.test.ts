import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { KB_CATEGORIES, type CreateBatchResponse, type KbEntry, type KbProposal, type KbResearchState, type KbResponse } from '../src/shared/api.js';
import { SERVICE_DIR } from '../src/server/config.js';
import { startService, stopAll, waitFor, waitForStatus } from './helpers.js';
import type { Service } from '../src/server/app.js';

afterEach(stopAll);

/** Every `kb` invocation the fake CLI saw, as argv arrays. */
function calls(s: Service): string[][] {
  const file = path.join(s.config.kbDir, 'calls.ndjson');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as string[]);
}

/** Count `kb` SSE events by listening on the hub the way a client would. */
function countKbEvents(s: Service): () => number {
  let n = 0;
  const fakeRes = {
    status: () => fakeRes,
    set: () => fakeRes,
    flushHeaders: () => undefined,
    write: (frame: string) => {
      if (frame.startsWith('event: kb')) n++;
      return true;
    },
    end: () => undefined,
  };
  const fakeReq = { on: () => undefined };
  s.hub.handle(fakeReq as never, fakeRes as never);
  return () => n;
}

describe('GET /api/kb', () => {
  it('returns queue (all statuses), proposals, entries and research state from the CLI', async () => {
    const s = await startService();
    const body = (await request(s.app).get('/api/kb').expect(200)).body as KbResponse;
    expect(body.dir).toBe(s.config.kbDir);
    expect(body.queue.map((q) => q.domain)).toEqual(['adnxs.com', 'quiet.example', 'vendor.io']);
    expect(body.counts).toEqual({ open: 2, proposed: 1 });
    expect(body.proposals.map((p) => [p.id, p.status])).toEqual([['p-vendor.io-1', 'proposed']]);
    expect(body.entries).toEqual([]);
    expect(body.researchAvailable).toBe(false);
    expect(body.research).toEqual({ running: false, domains: [] });
    // Every call targets the configured store explicitly.
    for (const argv of calls(s)) expect(argv.slice(-2)).toEqual(['--dir', s.config.kbDir]);
  });

  it('serves the research packet as markdown, 400 for an unknown domain', async () => {
    const s = await startService();
    const res = await request(s.app).get('/api/kb/packet/adnxs.com').expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/markdown/);
    expect(res.text).toContain('# Research: adnxs.com');
    const missing = await request(s.app).get('/api/kb/packet/nope.example').expect(400);
    expect(missing.body.error).toBe('not in the queue: nope.example');
    await request(s.app).get('/api/kb/packet/--all').expect(400);
  });
});

describe('POST /api/kb/proposals/:id/confirm', () => {
  it('confirms with the reviewer and corrections, and broadcasts a kb event', async () => {
    const s = await startService();
    const kbEvents = countKbEvents(s);
    const res = await request(s.app)
      .post('/api/kb/proposals/p-vendor.io-1/confirm')
      .send({ by: 'Jeff', categories: ['advertising', 'analytics', 'advertising'], owner: '  Vendor Corp ', note: 'checked docs' })
      .expect(200);
    const entry = res.body as KbEntry;
    expect(entry).toMatchObject({ categories: ['advertising', 'analytics'], owner: 'Vendor Corp', notes: 'checked docs', provenance: { confirmedBy: 'Jeff' } });
    const confirm = calls(s).find((c) => c[0] === 'confirm')!;
    expect(confirm).toEqual(['confirm', 'p-vendor.io-1', '--by', 'Jeff', '--category', 'advertising,analytics', '--owner', 'Vendor Corp', '--note', 'checked docs', '--json', '--dir', s.config.kbDir]);

    const kb = (await request(s.app).get('/api/kb').expect(200)).body as KbResponse;
    expect(kb.entries).toHaveLength(1);
    expect(kb.proposals[0].status).toBe('confirmed');
    await waitFor(() => kbEvents() > 0, 2000, 'kb event');

    // Already reviewed → 409, not a CLI crash.
    const again = await request(s.app).post('/api/kb/proposals/p-vendor.io-1/confirm').send({ by: 'Jeff' }).expect(409);
    expect(again.body.error).toMatch(/already confirmed/);
  });

  it('400 without a reviewer, for an agent reviewer, or for an unknown category; 404 for no proposal', async () => {
    const s = await startService();
    const noBy = await request(s.app).post('/api/kb/proposals/p-vendor.io-1/confirm').send({}).expect(400);
    expect(noBy.body.error).toMatch(/`by` is required/);
    await request(s.app).post('/api/kb/proposals/p-vendor.io-1/confirm').send({ by: '   ' }).expect(400);
    const agent = await request(s.app).post('/api/kb/proposals/p-vendor.io-1/confirm').send({ by: 'agent:claude' }).expect(400);
    expect(agent.body.error).toMatch(/agents never/);
    const cat = await request(s.app)
      .post('/api/kb/proposals/p-vendor.io-1/confirm')
      .send({ by: 'Jeff', categories: ['advertising', 'mind-reading'] })
      .expect(400);
    expect(cat.body.error).toBe('unknown category: mind-reading');
    await request(s.app).post('/api/kb/proposals/p-nope.example-1/confirm').send({ by: 'Jeff' }).expect(404);
    await request(s.app).post('/api/kb/proposals/--by/confirm').send({ by: 'Jeff' }).expect(404);
    // None of these reached `kb confirm`.
    expect(calls(s).filter((c) => c[0] === 'confirm')).toEqual([]);
  });

  it('passes the CLI’s exit-2 message through as a 400', async () => {
    // A CLI that only knows the confirm rules: drop the server-side reviewer
    // check by calling the module directly with an empty reviewer.
    const s = await startService();
    await expect(s.kb.confirm('p-vendor.io-1', { by: '' })).rejects.toMatchObject({ status: 400, message: 'kb confirm needs --by (the person confirming) or COMPLYKIT_REVIEWER' });
  });

  it('serializes concurrent mutations: the second click sees the first one’s result', async () => {
    const s = await startService();
    const [a, b] = await Promise.all([
      request(s.app).post('/api/kb/proposals/p-vendor.io-1/confirm').send({ by: 'A' }),
      request(s.app).post('/api/kb/proposals/p-vendor.io-1/reject').send({ by: 'B', reason: 'wrong vendor' }),
    ]);
    // Whichever arrived first wins; the other sees a reviewed proposal.
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const kb = (await request(s.app).get('/api/kb').expect(200)).body as KbResponse;
    expect(kb.proposals[0]).toMatchObject(a.status === 200 ? { status: 'confirmed', reviewedBy: 'A' } : { status: 'rejected', reviewedBy: 'B' });
    expect(kb.entries).toHaveLength(a.status === 200 ? 1 : 0);
  });
});

describe('POST /api/kb/proposals/:id/reject', () => {
  it('rejects with a reason and reopens the queue item; 400 without a reason or reviewer', async () => {
    const s = await startService();
    await request(s.app).post('/api/kb/proposals/p-vendor.io-1/reject').send({ by: 'Jeff' }).expect(400);
    await request(s.app).post('/api/kb/proposals/p-vendor.io-1/reject').send({ reason: 'wrong' }).expect(400);
    const res = await request(s.app).post('/api/kb/proposals/p-vendor.io-1/reject').send({ by: 'Jeff', reason: 'that is a CDN' }).expect(200);
    expect(res.body as KbProposal).toMatchObject({ status: 'rejected', reviewedBy: 'Jeff', reviewNote: 'that is a CDN' });
    const kb = (await request(s.app).get('/api/kb').expect(200)).body as KbResponse;
    expect(kb.queue.find((q) => q.domain === 'vendor.io')?.status).toBe('open');
  });
});

describe('POST /api/kb/dismiss', () => {
  it('dismisses a queued domain with a note; 404 when not queued, 400 without a domain', async () => {
    const s = await startService();
    await request(s.app).post('/api/kb/dismiss').send({ domain: 'quiet.example', note: 'site’s own CDN' }).expect(204);
    const kb = (await request(s.app).get('/api/kb').expect(200)).body as KbResponse;
    expect(kb.queue.find((q) => q.domain === 'quiet.example')).toMatchObject({ status: 'dismissed', note: 'site’s own CDN' });
    await request(s.app).post('/api/kb/dismiss').send({ domain: 'nope.example' }).expect(404);
    await request(s.app).post('/api/kb/dismiss').send({}).expect(400);
    await request(s.app).post('/api/kb/dismiss').send({ domain: '--all' }).expect(400);
  });
});

describe('POST /api/kb/research', () => {
  it('400 when the server has no API key', async () => {
    const s = await startService();
    const res = await request(s.app).post('/api/kb/research').send({ top: 5 }).expect(400);
    expect(res.body.error).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('202, runs in the background one at a time, and exposes state in GET /api/kb', async () => {
    const s = await startService({ researchAvailable: true });
    const kbEvents = countKbEvents(s);
    process.env.FAKE_KB_RESEARCH_MS = '400';
    try {
      const res = await request(s.app).post('/api/kb/research').send({}).expect(202);
      const started = res.body as KbResearchState;
      // Default: the top open items (the fake queue has two).
      expect(started).toMatchObject({ running: true, domains: ['adnxs.com', 'quiet.example'] });
      expect(started.startedAt).toBeTruthy();

      const busy = await request(s.app)
        .post('/api/kb/research')
        .send({ domains: ['adnxs.com'] })
        .expect(409);
      expect(busy.body.error).toMatch(/already running/);
      expect(((await request(s.app).get('/api/kb')).body as KbResponse).research.running).toBe(true);

      await waitFor(() => !s.kb.researchState().running, 5000, 'research to finish');
      const kb = (await request(s.app).get('/api/kb').expect(200)).body as KbResponse;
      expect(kb.research).toMatchObject({
        running: false,
        domains: ['adnxs.com', 'quiet.example'],
        model: 'fake-model',
        lastResults: [
          { domain: 'adnxs.com', proposalId: 'p-adnxs.com-1' },
          { domain: 'quiet.example', proposalId: 'p-quiet.example-1' },
        ],
      });
      expect(kb.research.finishedAt).toBeTruthy();
      expect(kb.proposals.filter((p) => p.status === 'proposed').map((p) => p.domain)).toEqual(['vendor.io', 'adnxs.com', 'quiet.example']);
      expect(
        calls(s)
          .find((c) => c[0] === 'research')
          ?.slice(0, 3),
      ).toEqual(['research', 'adnxs.com', 'quiet.example']);
      await waitFor(() => kbEvents() >= 2, 2000, 'kb events for start and finish');
    } finally {
      delete process.env.FAKE_KB_RESEARCH_MS;
    }
  });

  it('validates domains and top; a domain must be open in the queue', async () => {
    const s = await startService({ researchAvailable: true });
    await request(s.app).post('/api/kb/research').send({ top: 0 }).expect(400);
    await request(s.app).post('/api/kb/research').send({ top: 'five' }).expect(400);
    await request(s.app).post('/api/kb/research').send({ domains: [] }).expect(400);
    await request(s.app)
      .post('/api/kb/research')
      .send({ domains: ['--model'] })
      .expect(400);
    const notOpen = await request(s.app)
      .post('/api/kb/research')
      .send({ domains: ['vendor.io'] })
      .expect(400);
    expect(notOpen.body.error).toBe('not open in the queue: vendor.io');
    // A refused request leaves the slot free.
    expect(s.kb.researchState().running).toBe(false);
    await request(s.app)
      .post('/api/kb/research')
      .send({ domains: ['quiet.example'] })
      .expect(202);
    await waitFor(() => !s.kb.researchState().running, 5000, 'research to finish');
  });
});

describe('consent checks and the KB', () => {
  it('runs consent with COMPLYKIT_KB_DIR set to the service’s store', async () => {
    const s = await startService();
    const res = await request(s.app).post('/api/batches').send({ urls: 'site.example.com', quick: true }).expect(201);
    const id = (res.body as CreateBatchResponse).jobs[0].id;
    await waitForStatus(s, id, ['done']);
    const env = JSON.parse(fs.readFileSync(path.join(s.store.jobDir(id), 'consent', 'env.json'), 'utf8')) as { COMPLYKIT_KB_DIR: string };
    expect(env.COMPLYKIT_KB_DIR).toBe(s.config.kbDir);
  });

  it('defaults the store to <dataDir>/kb, overridable with COMPLYKIT_KB_DIR', async () => {
    const { loadConfig } = await import('../src/server/config.js');
    expect(loadConfig({ DATA_DIR: '/srv/data' }).kbDir).toBe(path.resolve('/srv/data/kb'));
    expect(loadConfig({ DATA_DIR: '/srv/data', COMPLYKIT_KB_DIR: '/srv/kb' }).kbDir).toBe(path.resolve('/srv/kb'));
    expect(loadConfig({ ANTHROPIC_API_KEY: 'x' }).researchAvailable).toBe(true);
    expect(loadConfig({}).researchAvailable).toBe(false);
  });
});

describe('KB_CATEGORIES', () => {
  it('matches complykit’s PartyCategory vocabulary', () => {
    // Read as text: the service doesn't import complykit, even in tests.
    const src = fs.readFileSync(path.join(SERVICE_DIR, '..', 'src', 'registry', 'kb', 'schema.ts'), 'utf8');
    const block = /export const PartyCategory = z\.enum\(\[([^\]]*)\]\)/.exec(src)?.[1] ?? '';
    const ids = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    expect(KB_CATEGORIES.map((c) => c.id)).toEqual(ids);
  });
});
