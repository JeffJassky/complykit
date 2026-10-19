// The Express app and the service objects behind it. `createApp` does
// everything except listen, so tests drive it with supertest.

import fs from 'node:fs';
import path from 'node:path';
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import {
  parseUrlList,
  type CheckKind,
  type ConsentConfigRequest,
  type ConsentSettingsResponse,
  type CreateBatchRequest,
  type CreateBatchResponse,
  type JobDetail,
  type JobsResponse,
  type KbConfirmRequest,
  type KbDismissRequest,
  type KbRejectRequest,
  type KbResearchRequest,
  type RemediationTask,
  type RerenderRequest,
  type RescanRequest,
  type SitesResponse,
} from '../shared/api.js';
import { basicAuth } from './auth.js';
import type { ServiceConfig } from './config.js';
import { ConsentRecordStore, MAX_BODY_BYTES, RateLimiter, normalizeRecord, originDomain, type ExportFormat } from './consent-records.js';
import { KbError, KnowledgeBase, RESEARCH_MAX, categoryList, isDomain, isProposalId, optionalText, requiredText, reviewer } from './kb.js';
import { recoverJobs, sweepRetention } from './lifecycle.js';
import { Runner, type RunnerOptions } from './runner.js';
import { isJobId, JobStore, newId, toSummary } from './store.js';
import { StreamHub } from './stream.js';
import { cloudflarePurger, noopPurger, type CdnPurger } from './cdn.js';
import { CONSENT_SETTINGS_KEY, detectedBannerOf, normalizeConsentSettings, storedConsentSettings } from './consent-settings.js';
import { hostedBundleHash, hostedScript } from './hosted-script.js';
import { ConsentStats, MAX_BEACON_BYTES, readStats } from './consent-stats.js';
import { WorkspaceError, WorkspaceStore } from './workspace.js';
import { serveReports } from './report-config.js';
import { assertCanGenerate } from './history.js';
import { generateConsentConfigForJob } from './consent-config.js';
import { checklistProgress, RemediationVerifier, rehomeHostedUrl, rehomeTasks, remediationView } from './remediation.js';
import { rescanSite } from './rescan.js';
import { parseLaws } from './law-input.js';
import { rerenderJob } from './rerender.js';
import { ChecklistMaker, afterClassWrite, jobReport } from './job-report.js';
import { sendJobZip } from './zip.js';
import { KbSync } from './kb-sync.js';
import { openStorage, type Storage } from './storage/index.js';

export interface Service {
  app: Express;
  config: ServiceConfig;
  store: JobStore;
  runner: Runner;
  hub: StreamHub;
  kb: KnowledgeBase;
  /** Per-site workspaces (never swept by retention). */
  workspaces: WorkspaceStore;
  /** Consent records (pruned by CONSENT_RECORD_RETENTION_DAYS, not by retentionDays). */
  consentRecords: ConsentRecordStore;
  /** Banner analytics counters (POST /e): held in memory, flushed every STATS_FLUSH_MS and on stop. */
  stats: { flush(): Promise<void> };
  /** Epoch ms of the last request that counts as activity (see lifecycle.idleReason). */
  lastActivity(): number;
  /** Makes the to-do list after a consent scan (config.autoChecklist). */
  checklists: ChecklistMaker;
  /** Resolves once every in-flight publish of a finished job's files, knowledge-base upload and to-do list is done. */
  settled(): Promise<void>;
  /** Upload the knowledge-base directory to blobs (cloud backend; a no-op for fs). Called after anything that changes it. */
  saveKb(): Promise<void>;
  /** Kill running checks (marked "server stopped"), close streams, flush to disk, and close the storage if createApp opened it. */
  stop(killGraceMs?: number): Promise<void>;
}

export interface AppDeps {
  /** Where records and files live. Absent: opened from the config (DATA_BACKEND), and closed by `stop`. */
  storage?: Storage;
  /** Purges the CDN in front of the hosted script. Absent: Cloudflare when the config has `cdn`, else nothing. */
  purger?: CdnPurger;
}

const RETENTION_SWEEP_MS = 60 * 60_000;

export async function createApp(config: ServiceConfig, runnerOptions: RunnerOptions = {}, deps: AppDeps = {}): Promise<Service> {
  const ownsStorage = !deps.storage;
  const storage = deps.storage ?? (await openStorage({ dataBackend: config.dataBackend, dataDir: config.dataDir, cloud: config.cloud }));
  const store = new JobStore(config.dataDir, storage);
  // The knowledge base is a directory the CLI reads and writes; with the cloud backend it is restored from blobs now and saved back after every change.
  const kbSync = new KbSync(storage, config.kbDir);
  await kbSync.restore();
  let lastActivity = Date.now();
  const touch = () => (lastActivity = Date.now());
  const hub = new StreamHub(store);
  // A job finishing counts as activity, and a consent check feeds the KB queue.
  const purger = deps.purger ?? (config.cdn ? cloudflarePurger(config.cdn) : noopPurger);
  // Rebinds once the hosted script exists (it needs the workspaces); a change only ever arrives after boot.
  let onConfigChange: (domain: string) => void = () => undefined;
  const workspaces = new WorkspaceStore(storage.workspaces, checklistProgress, { onConfigChange: (domain) => onConfigChange(domain) });
  const hosted = hostedScript({ config, workspaces, snapshots: storage.configSnapshots });
  onConfigChange = (domain) => {
    // B2: drop the rendered copy and purge the CDN, without making the write wait for Cloudflare.
    hosted.invalidate(domain);
    void purger.purgeUrls([`${config.publicOrigin}/s/${domain}.js`]).catch((err: Error) => console.warn(`[cdn] purge ${domain}: ${err.message}`));
  };
  // A new bundle or origin makes every cached copy at the edge wrong: purge it all, once.
  const bootPurge = (async () => {
    const BUNDLE_HASH_KEY = 'meta/hosted-bundle.sha256';
    const now = hostedBundleHash(config.consentClientDist, config.publicOrigin);
    const before = (await storage.blobs.get(BUNDLE_HASH_KEY))?.toString('utf8').trim();
    if (before === now) return;
    await purger.purgeAll();
    await storage.blobs.put(BUNDLE_HASH_KEY, now + '\n', { contentType: 'text/plain' });
  })().catch((err: Error) => console.warn(`[cdn] boot purge: ${err.message}`));
  // A consent job applies its site's workspace and records itself as a run (C3).
  // The to-do list is made when a consent scan finishes (plans/simple-report.md).
  const checklists = new ChecklistMaker({ config, workspaces, files: store.files });
  const runner = new Runner(
    store,
    config,
    (job) => {
      touch();
      hub.notifyKb();
      void kbSync.save(); // a consent check feeds the KB queue
      if (job) {
        store.files.publish(job); // the finished job's files go to blobs; the to-do list below waits for that
        if (config.autoChecklist) checklists.afterScan(job);
      }
    },
    workspaces,
    { ...runnerOptions, ingestRun: runnerOptions.ingestRun ?? ((dir) => kb.ingestRun(dir)), reloadJobs: runnerOptions.reloadJobs ?? (() => storage.jobs.loadAll()) },
  );
  const kb = new KnowledgeBase(config, () => {
    hub.notifyKb();
    void kbSync.save(); // every KB change (confirm, reject, dismiss, research) is saved
  });
  const consentRecords = new ConsentRecordStore(storage.consentRecords, config.consentRecordRetentionDays);
  const prune = () => void consentRecords.prune().catch((err: Error) => console.warn(`[consent-records] prune: ${err.message}`));
  prune();
  const consentSweep = setInterval(prune, RETENTION_SWEEP_MS);
  consentSweep.unref();

  // Restart recovery, then retention, then resume the queue.
  const loaded = await store.load();
  const requeue = recoverJobs(store, loaded);
  await sweepRetention(store, config.retentionDays);
  const sweep = setInterval(() => void sweepRetention(store, config.retentionDays), RETENTION_SWEEP_MS);
  sweep.unref();
  // Workers an earlier host left busy are stopped first, so this host's first POST doesn't meet a 409.
  await runner.afterBoot();
  for (const id of requeue) runner.enqueue(id);

  const app = express();
  app.disable('x-powered-by');
  // One hop: the platform's proxy. `true` would trust the leftmost, client-supplied
  // X-Forwarded-For entry, which resets any per-IP limit by changing a header.
  app.set('trust proxy', 1);
  // The per-IP limiters' key (memory only). Behind Cloudflare the edge sets cf-connecting-ip itself.
  const limiterIp = (req: express.Request): string => {
    if (config.trustCfGeo) {
      const cfIp = req.get('cf-connecting-ip');
      if (cfIp) return cfIp.slice(0, 64);
    }
    return req.ip ?? '';
  };

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
      const wait = Math.max(consentLimitIp.hit(limiterIp(req)), consentLimitSite.hit(domain));
      if (wait) {
        res.set('Retry-After', String(wait)).status(429).json({ error: 'too many consent records; slow down' });
        return;
      }
      const record = normalizeRecord(req.body, domain);
      await consentRecords.append(domain, record);
      res.status(204).end();
    }),
  );

  // --- Banner analytics beacon (public by design) -------------------------------------
  // POST /e: counters only (plans/hosted-script.md). The body is parsed, turned into
  // increments and dropped; the IP feeds the in-memory rate limiter and nothing else;
  // user agent, referrer and URL are never read. Always 204 except 413 and 429.
  const stats = new ConsentStats(storage.configSnapshots, storage.consentStats, { flushMs: config.statsFlushMs, trustCfGeo: config.trustCfGeo });
  const beaconLimitIp = new RateLimiter(120);
  const beaconLimitSite = new RateLimiter(20_000);

  app.options('/e', (req, res) => {
    if (consentCors(req, res)) {
      res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      res.set('Access-Control-Max-Age', '86400');
    }
    res.status(204).end();
  });

  app.post(
    '/e',
    (req, res, next) => {
      consentCors(req, res);
      const wait = beaconLimitIp.hit(limiterIp(req));
      if (wait) {
        res.set('Retry-After', String(wait)).status(429).end();
        return;
      }
      // Any content type (sendBeacon's text/plain needs no preflight); the limit applies while streaming.
      express.text({ limit: MAX_BEACON_BYTES, type: () => true })(req, res, (err?: unknown) => {
        if (err) {
          // Too large: 413. Anything else unreadable (bad charset, aborted): nothing to count.
          res.status((err as { status?: number }).status === 413 ? 413 : 204).end();
          return;
        }
        next();
      });
    },
    async (req, res, next) => {
      try {
        let body: unknown;
        try {
          body = JSON.parse(typeof req.body === 'string' ? req.body : '');
        } catch {
          res.status(204).end();
          return;
        }
        const cf = (name: string): string | undefined => {
          const v = req.get(name);
          return v === undefined ? undefined : v.slice(0, 16);
        };
        let waitSite = 0;
        const outcome = await stats.ingest(body, originDomain(req.get('origin')), config.trustCfGeo ? { country: cf('cf-ipcountry'), region: cf('cf-region-code') } : {}, (domain) => (waitSite = beaconLimitSite.hit(domain)) === 0);
        if (outcome === 'limited') {
          res.set('Retry-After', String(waitSite)).status(429).end();
          return;
        }
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },
  );

  // --- Hosted consent script (public by design) --------------------------------------
  // /s/<domain>.js and the UI bundle: a visitor's browser on a client's site loads
  // them, so they sit before basic auth. No cookies, ever (P1).
  app.use(hosted.router);

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
    const lawsIn = parseLaws(body.laws, body.authorized, checks.includes('consent'));
    if (!lawsIn.ok) {
      res.status(400).json({ error: lawsIn.error });
      return;
    }
    const batchId = newId();
    const quick = body.quick === true;
    const slowRepeat = body.slowRepeat === true;
    const jobs = urls.map((url) => store.create({ batchId, url, checks, quick, slowRepeat, laws: lawsIn.laws, authorizedAt: lawsIn.authorizedAt }));
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
    await sendJobZip(res, job, store.files);
  });

  // The consent tool config from a finished consent job (D8), stored as the
  // site workspace's `config`. Mounted after siteRoute exists: a
  // WorkspaceError answers with its own status.
  app.post(
    '/api/jobs/:id/consent-config',
    withJob,
    siteRoute(async (req, res) => {
      const job = res.locals.job as JobDetail;
      assertCanGenerate(job, store.list(), await workspaces.get(workspaces.domain(new URL(job.url).hostname)), (h) => workspaces.domain(h));
      const out = await generateConsentConfigForJob(job, (req.body ?? {}) as ConsentConfigRequest, {
        config,
        workspaces,
        files: store.files,
      });
      res.json(out);
    }),
  );

  // The owner report page in one poll: the job, the live/final owner report, the site's to-do list.
  app.get(
    '/api/jobs/:id/report',
    withJob,
    siteRoute(async (_req, res) => {
      const job = res.locals.job as JobDetail;
      res.set('Cache-Control', 'no-store');
      res.json(await jobReport(job, { files: store.files, workspaces, maker: checklists, jobs: store.list(), publicOrigin: config.publicOrigin, rerender: { config, workspaces, files: store.files } }));
    }),
  );

  // R2: re-render the job's consent report with the site's current workspace (no rescan).
  app.post(
    '/api/jobs/:id/rerender',
    withJob,
    siteRoute(async (req, res) => {
      const job = res.locals.job as JobDetail;
      const body = (req.body ?? {}) as RerenderRequest;
      if (body.generate === true) assertCanGenerate(job, store.list(), await workspaces.get(workspaces.domain(new URL(job.url).hostname)), (h) => workspaces.domain(h));
      const out = await rerenderJob(job, body, {
        config,
        workspaces,
        files: store.files,
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
      const ws = await workspaces.get(req.params.domain);
      // The stored hosted URL (and the install task's snippet and verify spec) follow a changed PUBLIC_ORIGIN.
      const v = ws.config?.value;
      if (ws.config && v && typeof v === 'object' && !Array.isArray(v)) {
        const value: Record<string, unknown> = { ...(v as Record<string, unknown>) };
        if (typeof value.hostedScriptUrl === 'string') value.hostedScriptUrl = rehomeHostedUrl(value.hostedScriptUrl, config.publicOrigin);
        if (Array.isArray(value.tasks)) value.tasks = rehomeTasks(value.tasks as RemediationTask[], config.publicOrigin);
        res.json({ ...ws, config: { ...ws.config, value } });
        return;
      }
      res.json(ws);
    }),
  );

  app.patch(
    '/api/sites/:domain/workspace',
    siteRoute(async (req, res) => {
      const out = await workspaces.patch(req.params.domain, req.body);
      // A classification changes what the report says: the server re-renders the newest scan's report (no rescan, no generate).
      const entries = (req.body as { entries?: unknown } | null)?.entries;
      if (entries && typeof entries === 'object' && Object.keys(entries).some((k) => k.startsWith('class:'))) {
        await afterClassWrite(out.workspace.domain, store.list(), { config, workspaces, files: store.files }).catch((e: unknown) => console.warn(`[report] re-render after classification: ${(e as Error).message}`));
      }
      res.json(out);
    }),
  );

  // The owner's consent settings (the install task's form). Saving is a workspace write: it re-renders and purges the script.
  const consentSettings = async (domain: string): Promise<ConsentSettingsResponse> => {
    const ws = await workspaces.get(domain);
    const v = ws.config?.value;
    const detected = typeof v === 'object' && v !== null ? (v as { detectedCmp?: unknown }).detectedCmp : undefined;
    const banner = detectedBannerOf(v);
    return { settings: storedConsentSettings(ws) ?? { mode: 'full' }, ...(typeof detected === 'string' ? { detectedCmp: detected as ConsentSettingsResponse['detectedCmp'] } : {}), ...(banner ? { detectedBanner: banner } : {}) };
  };
  app.get(
    '/api/sites/:domain/consent-settings',
    siteRoute(async (req, res) => {
      res.json(await consentSettings(workspaces.domain(req.params.domain)));
    }),
  );
  app.put(
    '/api/sites/:domain/consent-settings',
    siteRoute(async (req, res) => {
      const domain = workspaces.domain(req.params.domain);
      const settings = normalizeConsentSettings(req.body);
      await workspaces.patch(domain, { entries: { [CONSENT_SETTINGS_KEY]: { value: settings } } });
      res.json(await consentSettings(domain));
    }),
  );

  // The guided remediation checklist (R4): the stored tasks with their status, and Verify.
  const verifier = new RemediationVerifier({ config, workspaces, fleet: runner.workerFleet, locks: runner.regionLocks });
  app.get(
    '/api/sites/:domain/remediation',
    siteRoute(async (req, res) => {
      res.json(remediationView(await workspaces.get(req.params.domain), config.publicOrigin));
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

  // Banner analytics, read back per config version (plans/hosted-script.md "Stats API").
  app.get(
    '/api/sites/:domain/stats',
    siteRoute(async (req, res) => {
      const domain = workspaces.domain(req.params.domain);
      const raw = req.query.days;
      const days = raw === undefined ? 30 : typeof raw === 'string' && /^\d{1,3}$/.test(raw) ? Number(raw) : 0;
      if (days < 1 || days > 366) throw new WorkspaceError(400, '`days` must be a whole number from 1 to 366');
      res.json(await readStats(domain, days, { stats: storage.consentStats, snapshots: storage.configSnapshots }));
    }),
  );

  app.get(
    '/api/sites/:domain/configs/:hash',
    siteRoute(async (req, res) => {
      const domain = workspaces.domain(req.params.domain);
      const snap = await storage.configSnapshots.get(String(req.params.hash));
      if (!snap || snap.domain !== domain) throw new WorkspaceError(404, 'no such config version for this site');
      res.json(snap);
    }),
  );

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  // --- Reports: the job's files --------------------------------------------------
  // Read through the job's files (blobs for a finished job, scratch while it
  // runs); dotfile paths such as .comply/ are allowed, `..` is refused.

  app.use('/reports/:id', serveReports(store));

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
    stats: { flush: () => stats.flush() },
    checklists,
    lastActivity: () => lastActivity,
    async settled() {
      // A to-do list waits for a publish and a publish can follow a to-do list's rerender (consent-config files), so loop until quiet.
      do {
        await Promise.all([store.files.settled(), checklists.settled(), kbSync.settled(), store.flush()]);
      } while (store.files.pending() > 0);
    },
    saveKb: () => kbSync.save(),
    async stop(killGraceMs?: number) {
      clearInterval(sweep);
      clearInterval(consentSweep);
      await Promise.all([runner.shutdown(killGraceMs), kb.stop(killGraceMs), bootPurge]);
      // Stopped jobs are failed ("server stopped"); their partial files are published too.
      await store.files.settled();
      await checklists.settled();
      hub.closeAll();
      await Promise.all([store.flush(), workspaces.flush(), consentRecords.flush(), stats.stop(), kbSync.settled()]);
      if (ownsStorage) await storage.close();
    },
  };
}

const CLIENT_NOT_BUILT = `<!doctype html><meta charset="utf-8"><title>complykit service</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#222}code{background:#f2f2f2;padding:.1em .3em;border-radius:3px}</style>
<h1>Client not built</h1>
<p>The API is up, but <code>dist/client</code> is missing. Run <code>npm run build:client</code> in <code>service/</code>, or <code>npm run dev</code> and use the Vite dev server.</p>`;
