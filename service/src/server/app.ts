// The Express app and the service objects behind it. `createApp` does
// everything except listen, so tests drive it with supertest.

import fs from 'node:fs';
import path from 'node:path';
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import {
  parseUrlList,
  type CheckKind,
  type ConsentConfigRequest,
  type CreateBatchRequest,
  type CreateBatchResponse,
  type JobDetail,
  type JobsResponse,
  type KbConfirmRequest,
  type KbDismissRequest,
  type KbRejectRequest,
  type KbResearchRequest,
  type RerenderRequest,
  type RescanRequest,
  type SitesResponse,
} from '../shared/api.js';
import { basicAuth } from './auth.js';
import type { ServiceConfig } from './config.js';
import { ConsentRecordStore, MAX_BODY_BYTES, RateLimiter, normalizeRecord, originDomain, type ExportFormat } from './consent-records.js';
import { KbError, KnowledgeBase, RESEARCH_MAX, categoryList, isDomain, isProposalId, optionalText, requiredText, reviewer } from './kb.js';
import { recoverJobs, sweepRetention } from './lifecycle.js';
import { Runner } from './runner.js';
import { isJobId, JobStore, newId, toSummary } from './store.js';
import { StreamHub } from './stream.js';
import { sendInstallZip } from './install-zip.js';
import { WorkspaceError, WorkspaceStore } from './workspace.js';
import { serveReportWithConfig } from './report-config.js';
import { generateConsentConfigForJob } from './consent-config.js';
import { checklistProgress, RemediationVerifier, remediationView } from './remediation.js';
import { rescanSite } from './rescan.js';
import { rerenderJob } from './rerender.js';
import { sendJobZip } from './zip.js';

export interface Service {
  app: Express;
  config: ServiceConfig;
  store: JobStore;
  runner: Runner;
  hub: StreamHub;
  kb: KnowledgeBase;
  /** Per-site workspaces under DATA_DIR/sites (never swept by retention). */
  workspaces: WorkspaceStore;
  /** Consent records under DATA_DIR/sites/<domain>/consent-records.jsonl (pruned by CONSENT_RECORD_RETENTION_DAYS, not by retentionDays). */
  consentRecords: ConsentRecordStore;
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
  const workspaces = new WorkspaceStore(path.join(config.dataDir, 'sites'), checklistProgress);
  // A consent job applies its site's workspace and records itself as a run (C3).
  const runner = new Runner(
    store,
    config,
    () => {
      touch();
      hub.notifyKb();
    },
    workspaces,
  );
  const kb = new KnowledgeBase(config, () => hub.notifyKb());
  const consentRecords = new ConsentRecordStore(path.join(config.dataDir, 'sites'), config.consentRecordRetentionDays);
  void consentRecords.prune();
  const consentSweep = setInterval(() => void consentRecords.prune(), RETENTION_SWEEP_MS);
  consentSweep.unref();

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

  /** A WorkspaceError answers with its own status and message. */
  const siteRoute =
    (fn: RequestHandler): RequestHandler =>
    async (req, res, next) => {
      try {
        await fn(req, res, next);
      } catch (err) {
        if (!(err instanceof WorkspaceError)) throw err;
        if (err.status >= 500) console.error(`[workspace] ${req.method} ${req.originalUrl}: ${err.message}`);
        res.status(err.status).json({ ...err.extra, error: err.message });
      }
    };

  // --- Consent records (public by design) -------------------------------------------
  // Mounted before basicAuth: a visitor's browser on a client's site posts here
  // and has no password. Only this route is cross-origin; it accepts one
  // strictly validated record shape and answers nothing but 204. The export
  // (below, behind auth) is how a team reads them back.

  const consentLimitIp = new RateLimiter(60);
  const consentLimitSite = new RateLimiter(1200);
  const allowed = config.consentRecordDomains ? new Set(config.consentRecordDomains) : undefined;

  const consentCors = (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1]): string | undefined => {
    const origin = req.get('origin');
    const domain = originDomain(origin);
    if (domain && origin) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
    }
    return domain;
  };

  app.options('/api/consent-records', (req, res) => {
    if (consentCors(req, res)) {
      res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      res.set('Access-Control-Max-Age', '86400');
    }
    res.status(204).end();
  });

  app.post(
    '/api/consent-records',
    // type: any content type, so navigator.sendBeacon's text/plain (no preflight) parses too.
    (req, res, next) => {
      consentCors(req, res);
      express.json({ limit: MAX_BODY_BYTES, type: () => true })(req, res, next);
    },
    siteRoute(async (req, res) => {
      const domain = consentCors(req, res);
      if (!domain) {
        res.status(400).json({ error: 'a consent record must be posted from a web page: the Origin header is missing or is not a site' });
        return;
      }
      if (allowed && !allowed.has(domain)) {
        res.status(403).json({ error: 'this service does not accept consent records for that site' });
        return;
      }
      const wait = Math.max(consentLimitIp.hit(req.ip ?? ''), consentLimitSite.hit(domain));
      if (wait) {
        res.set('Retry-After', String(wait)).status(429).json({ error: 'too many consent records; slow down' });
        return;
      }
      const record = normalizeRecord(req.body, domain);
      await consentRecords.append(domain, record);
      res.status(204).end();
    }),
  );

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
    const slowRepeat = body.slowRepeat === true;
    const jobs = urls.map((url) => store.create({ batchId, url, checks, quick, slowRepeat }));
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

  // The consent tool config from a finished consent job (D8), stored as the
  // site workspace's `config`. Mounted after siteRoute exists: a
  // WorkspaceError answers with its own status.
  app.post(
    '/api/jobs/:id/consent-config',
    withJob,
    siteRoute(async (req, res) => {
      const job = res.locals.job as JobDetail;
      const out = await generateConsentConfigForJob(job, (req.body ?? {}) as ConsentConfigRequest, {
        config,
        workspaces,
        jobDir: store.jobDir(job.id),
        origin: `${req.protocol}://${req.get('host') ?? 'localhost'}`,
      });
      res.json(out);
    }),
  );

  // R2: re-render the job's consent report with the site's current workspace (no rescan).
  app.post(
    '/api/jobs/:id/rerender',
    withJob,
    siteRoute(async (req, res) => {
      const job = res.locals.job as JobDetail;
      const out = await rerenderJob(job, (req.body ?? {}) as RerenderRequest, {
        config,
        workspaces,
        jobDir: (id) => store.jobDir(id),
        origin: `${req.protocol}://${req.get('host') ?? 'localhost'}`,
      });
      res.json(out);
    }),
  );

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

  // --- Site workspaces --------------------------------------------------------------

  app.get(
    '/api/sites',
    siteRoute(async (_req, res) => {
      const body: SitesResponse = { sites: await workspaces.list() };
      res.json(body);
    }),
  );

  app.get(
    '/api/sites/:domain/workspace',
    siteRoute(async (req, res) => {
      res.json(await workspaces.get(req.params.domain));
    }),
  );

  app.patch(
    '/api/sites/:domain/workspace',
    siteRoute(async (req, res) => {
      res.json(await workspaces.patch(req.params.domain, req.body));
    }),
  );

  // The guided remediation checklist (R4): the stored tasks with their status, and Verify.
  const verifier = new RemediationVerifier({ config, workspaces });
  app.get(
    '/api/sites/:domain/remediation',
    siteRoute(async (req, res) => {
      res.json(remediationView(await workspaces.get(req.params.domain)));
    }),
  );

  app.post(
    '/api/sites/:domain/remediation/:id/verify',
    siteRoute(async (req, res) => {
      res.json(await verifier.verify(req.params.domain, req.params.id));
    }),
  );

  // The last checklist step: rescan the site with the options of its latest job.
  app.post(
    '/api/sites/:domain/rescan',
    siteRoute(async (req, res) => {
      res.status(201).json(await rescanSite(req.params.domain, { store, workspaces, enqueue: (id) => runner.enqueue(id) }, (req.body ?? {}) as RescanRequest));
    }),
  );

  // The install bundle (R5): the two client files, the snippet and the change list.
  app.get(
    '/api/sites/:domain/install.zip',
    siteRoute(async (req, res) => {
      const domain = workspaces.domain(req.params.domain);
      await sendInstallZip(res, domain, (await workspaces.get(domain)).config?.value, config.consentClientDist);
    }),
  );

  app.get(
    '/api/sites/:domain/consent-records',
    siteRoute(async (req, res) => {
      const domain = workspaces.domain(req.params.domain);
      const format = req.query.format === undefined ? 'jsonl' : req.query.format;
      if (format !== 'csv' && format !== 'jsonl') throw new WorkspaceError(400, '`format` must be csv or jsonl');
      if (!(await consentRecords.exists(domain))) throw new WorkspaceError(404, 'no consent records for this site');
      res.type(format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="consent-records-${domain}.${format}"`);
      for await (const chunk of consentRecords.export(domain, format as ExportFormat)) {
        if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
      }
      res.end();
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
    // A report with a workbench gets the site's workspace config injected (report-config.ts).
    void serveReportWithConfig(store.jobDir(id), store.get(id)!)(req, res, (err?: unknown) => (err ? next(err) : serve(req, res, next)));
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
    workspaces,
    consentRecords,
    lastActivity: () => lastActivity,
    async stop(killGraceMs?: number) {
      clearInterval(sweep);
      clearInterval(consentSweep);
      await Promise.all([runner.shutdown(killGraceMs), kb.stop(killGraceMs)]);
      hub.closeAll();
      await Promise.all([store.flush(), workspaces.flush(), consentRecords.flush()]);
    },
  };
}

const CLIENT_NOT_BUILT = `<!doctype html><meta charset="utf-8"><title>complykit service</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#222}code{background:#f2f2f2;padding:.1em .3em;border-radius:3px}</style>
<h1>Client not built</h1>
<p>The API is up, but <code>dist/client</code> is missing. Run <code>npm run build:client</code> in <code>service/</code>, or <code>npm run dev</code> and use the Vite dev server.</p>`;
