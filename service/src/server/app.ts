// The Express app and the service objects behind it. `createApp` does
// everything except listen, so tests drive it with supertest.

import fs from 'node:fs';
import path from 'node:path';
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import {
  parseUrlList,
  type CheckKind,
  type CreateBatchRequest,
  type CreateBatchResponse,
  type JobDetail,
  type JobsResponse,
  type KbConfirmRequest,
  type KbDismissRequest,
  type KbRejectRequest,
  type KbResearchRequest,
} from '../shared/api.js';
import { basicAuth } from './auth.js';
import type { ServiceConfig } from './config.js';
import { KbError, KnowledgeBase, RESEARCH_MAX, categoryList, isDomain, isProposalId, optionalText, requiredText, reviewer } from './kb.js';
import { recoverJobs, sweepRetention } from './lifecycle.js';
import { Runner } from './runner.js';
import { isJobId, JobStore, newId, toSummary } from './store.js';
import { StreamHub } from './stream.js';
import { sendJobZip } from './zip.js';

export interface Service {
  app: Express;
  config: ServiceConfig;
  store: JobStore;
  runner: Runner;
  hub: StreamHub;
  kb: KnowledgeBase;
  /** Epoch ms of the last request that counts as activity (see lifecycle.idleReason). */
  lastActivity(): number;
  /** Kill running checks (marked "server stopped"), close streams, flush to disk. */
  stop(killGraceMs?: number): Promise<void>;
}

const RETENTION_SWEEP_MS = 60 * 60_000;

export async function createApp(config: ServiceConfig): Promise<Service> {
  const store = new JobStore(config.dataDir);
  let lastActivity = Date.now();
  const touch = () => (lastActivity = Date.now());
  const hub = new StreamHub(store);
  // A job finishing counts as activity, and a consent check feeds the KB queue.
  const runner = new Runner(store, config, () => {
    touch();
    hub.notifyKb();
  });
  const kb = new KnowledgeBase(config, () => hub.notifyKb());

  // Restart recovery, then retention, then resume the queue.
  const loaded = await store.load();
  const requeue = recoverJobs(store, loaded);
  await sweepRetention(store, config.retentionDays);
  const sweep = setInterval(() => void sweepRetention(store, config.retentionDays), RETENTION_SWEEP_MS);
  sweep.unref();
  for (const id of requeue) runner.enqueue(id);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // Activity for idle shutdown: everything except the health check. The SSE
  // connect counts once; the open stream and its pings don't.
  app.use((req, _res, next) => {
    if (req.path !== '/api/health') touch();
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use(basicAuth(config.password));
  app.use(express.json({ limit: '256kb' }));

  // --- API ---------------------------------------------------------------------

  app.get('/api/jobs', (_req, res) => {
    const body: JobsResponse = {
      jobs: store.list().map(toSummary),
      server: {
        concurrency: config.concurrency,
        running: runner.running,
        queued: runner.queued,
        retentionDays: config.retentionDays,
        ...(config.region ? { region: config.region } : {}),
        version: config.version,
      },
    };
    res.json(body);
  });

  app.post('/api/batches', (req, res) => {
    const body = (req.body ?? {}) as Partial<CreateBatchRequest>;
    if (typeof body.urls !== 'string') {
      res.status(400).json({ error: '`urls` (string) is required' });
      return;
    }
    const wanted = { consent: true, accessibility: false, ...(body.checks ?? {}) };
    const checks = (['consent', 'accessibility'] as CheckKind[]).filter((c) => wanted[c] === true);
    if (!checks.length) {
      res.status(400).json({ error: 'enable at least one check' });
      return;
    }
    const { urls, rejected } = parseUrlList(body.urls);
    if (!urls.length) {
      res.status(400).json({ error: 'no valid URLs', rejected });
      return;
    }
    const batchId = newId();
    const quick = body.quick === true;
    const jobs = urls.map((url) => store.create({ batchId, url, checks, quick }));
    for (const job of jobs) runner.enqueue(job.id);
    const out: CreateBatchResponse = { batchId, jobs: jobs.map(toSummary), rejected };
    res.status(201).json(out);
  });

  /** Resolve :id to a job or answer 404. */
  const withJob: RequestHandler = (req, res, next) => {
    const id = String(req.params.id ?? '');
    const job = isJobId(id) ? store.get(id) : undefined;
    if (!job) {
      res.status(404).json({ error: 'job not found' });
      return;
    }
    res.locals.job = job;
    next();
  };

  app.get('/api/jobs/:id', withJob, (_req, res) => {
    res.json(res.locals.job as JobDetail);
  });

  app.post('/api/jobs/:id/cancel', withJob, async (_req, res) => {
    const job = res.locals.job as JobDetail;
    if (!(await runner.cancel(job.id))) {
      res.status(409).json({ error: `job is ${job.status}`, job: toSummary(job) });
      return;
    }
    res.json(toSummary(job));
  });

  app.delete('/api/jobs/:id', withJob, async (_req, res) => {
    const job = res.locals.job as JobDetail;
    await runner.cancel(job.id); // waits for the child to exit before files go
    await store.remove(job.id);
    res.status(204).end();
  });

  app.get('/api/jobs/:id/download', withJob, async (_req, res) => {
    const job = res.locals.job as JobDetail;
    await sendJobZip(res, job, store.jobDir(job.id));
  });

  app.get('/api/stream', hub.handle);

  // --- Knowledge base -------------------------------------------------------------
  // Every handler goes through kbRoute: a KbError answers with its own status
  // and message (the CLI's stderr for a 400 is written for people).

  const kbRoute =
    (fn: RequestHandler): RequestHandler =>
    async (req, res, next) => {
      try {
        await fn(req, res, next);
      } catch (err) {
        if (!(err instanceof KbError)) throw err;
        if (err.status >= 500) console.error(`[kb] ${req.method} ${req.originalUrl}: ${err.message}`);
        res.status(err.status).json({ error: err.message });
      }
    };

  app.get(
    '/api/kb',
    kbRoute(async (_req, res) => {
      res.json(await kb.snapshot());
    }),
  );

  app.get(
    '/api/kb/packet/:domain',
    kbRoute(async (req, res) => {
      const domain = String(req.params.domain ?? '');
      if (!isDomain(domain)) throw new KbError(400, 'not a domain');
      const packet = await kb.packet(domain); // before res.type(): an error answers JSON
      res.type('text/markdown; charset=utf-8').send(packet);
    }),
  );

  app.post(
    '/api/kb/research',
    kbRoute(async (req, res) => {
      const body = (req.body ?? {}) as Partial<KbResearchRequest>;
      let domains: string[] | undefined;
      if (body.domains !== undefined) {
        if (!Array.isArray(body.domains) || !body.domains.length || body.domains.length > RESEARCH_MAX || !body.domains.every(isDomain)) {
          throw new KbError(400, `\`domains\` must be 1–${RESEARCH_MAX} domains`);
        }
        domains = body.domains;
      }
      let top: number | undefined;
      if (body.top !== undefined) {
        if (!Number.isInteger(body.top) || body.top < 1 || body.top > RESEARCH_MAX) throw new KbError(400, `\`top\` must be an integer 1–${RESEARCH_MAX}`);
        top = body.top;
      }
      res.status(202).json(await kb.startResearch({ domains, top }));
    }),
  );

  /** :id must look like a proposal id before it reaches the CLI. */
  const proposalId = (req: Parameters<RequestHandler>[0]): string => {
    const id = String(req.params.id ?? '');
    if (!isProposalId(id)) throw new KbError(404, 'no such proposal');
    return id;
  };

  app.post(
    '/api/kb/proposals/:id/confirm',
    kbRoute(async (req, res) => {
      const id = proposalId(req);
      const body = (req.body ?? {}) as Partial<KbConfirmRequest>;
      const entry = await kb.confirm(id, {
        by: reviewer(body.by),
        categories: categoryList(body.categories),
        vendor: optionalText(body.vendor, 'vendor', 200),
        owner: optionalText(body.owner, 'owner', 200),
        consentApi: optionalText(body.consentApi, 'consentApi', 500),
        note: optionalText(body.note, 'note', 2000),
      });
      res.json(entry);
    }),
  );

  app.post(
    '/api/kb/proposals/:id/reject',
    kbRoute(async (req, res) => {
      const id = proposalId(req);
      const body = (req.body ?? {}) as Partial<KbRejectRequest>;
      const by = reviewer(body.by);
      const reason = requiredText(body.reason, 'reason', 2000, 'the next researcher reads it');
      res.json(await kb.reject(id, by, reason));
    }),
  );

  app.post(
    '/api/kb/dismiss',
    kbRoute(async (req, res) => {
      const body = (req.body ?? {}) as Partial<KbDismissRequest>;
      if (!isDomain(body.domain)) throw new KbError(400, '`domain` is required');
      await kb.dismiss(body.domain, optionalText(body.note, 'note', 2000));
      res.status(204).end();
    }),
  );

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  // --- Reports: the job directory, as files -------------------------------------
  // dotfiles 'allow' because runs live under .comply/. serve-static (send)
  // rejects `..` escapes with 403; the job id is validated before use.

  const statics = new Map<string, RequestHandler>();
  store.on('removed', (id) => statics.delete(id));
  app.use('/reports/:id', (req, res, next) => {
    const id = String(req.params.id ?? '');
    if (!isJobId(id) || !store.get(id)) {
      res.status(404).type('text/plain').send('report not found');
      return;
    }
    let serve = statics.get(id);
    if (!serve) {
      serve = express.static(store.jobDir(id), { dotfiles: 'allow', index: false, redirect: false, fallthrough: false });
      statics.set(id, serve);
    }
    serve(req, res, next);
  });

  // --- Client SPA ------------------------------------------------------------------

  const indexHtml = path.join(config.clientDir, 'index.html');
  app.use(express.static(config.clientDir, { index: false }));
  app.use((req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || req.path.startsWith('/api') || req.path.startsWith('/reports')) return next();
    if (fs.existsSync(indexHtml)) {
      res.sendFile(indexHtml);
      return;
    }
    res.status(503).type('html').send(CLIENT_NOT_BUILT);
  });

  const onError: ErrorRequestHandler = (err: { status?: number; statusCode?: number; message?: string }, req, res, _next) => {
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500) console.error(`[http] ${req.method} ${req.originalUrl}:`, err);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (req.path.startsWith('/api')) res.status(status).json({ error: status >= 500 ? 'internal error' : (err.message ?? 'error') });
    else res.status(status).type('text/plain').send(status === 404 ? 'not found' : status === 403 ? 'forbidden' : 'error');
  };
  app.use(onError);

  return {
    app,
    config,
    store,
    runner,
    hub,
    kb,
    lastActivity: () => lastActivity,
    async stop(killGraceMs?: number) {
      clearInterval(sweep);
      await Promise.all([runner.shutdown(killGraceMs), kb.stop(killGraceMs)]);
      hub.closeAll();
      await store.flush();
    },
  };
}

const CLIENT_NOT_BUILT = `<!doctype html><meta charset="utf-8"><title>complykit service</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#222}code{background:#f2f2f2;padding:.1em .3em;border-radius:3px}</style>
<h1>Client not built</h1>
<p>The API is up, but <code>dist/client</code> is missing. Run <code>npm run build:client</code> in <code>service/</code>, or <code>npm run dev</code> and use the Vite dev server.</p>`;
