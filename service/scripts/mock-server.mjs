#!/usr/bin/env node
// Dev mock of the complykit service API (src/shared/api.ts), zero dependencies.
// Lets the client be built and screenshotted without the real server.
//
//   node scripts/mock-server.mjs        # :8080
//   npx vite                            # :5173, proxies /api and /reports here
//
// Seeds a few finished jobs, one failure, one running and one queued job; the
// running ones advance every second and are pushed over /api/stream. POST
// /api/batches creates jobs that run to completion in ~30s.

import http from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 8080);
const CONCURRENCY = 2;
const MAX_URLS = 50;

// --- parseUrlList (mirror of src/shared/api.ts; the mock can't import TS) ----
function parseUrlList(raw) {
  const urls = [];
  const rejected = [];
  const seen = new Set();
  for (const token of raw.split(/[\s,]+/)) {
    const t = token.trim().replace(/^[<("']+|[>)"';.]+$/g, '');
    if (!t) continue;
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`;
    let u;
    try {
      u = new URL(withScheme);
    } catch {
      rejected.push(token);
      continue;
    }
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname.includes('.')) {
      rejected.push(token);
      continue;
    }
    u.hash = '';
    const key = u.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(key);
  }
  return { urls: urls.slice(0, MAX_URLS), rejected: [...rejected, ...urls.slice(MAX_URLS).map((u) => `${u} (over the ${MAX_URLS}-URL limit)`)] };
}

// --- fake data ---------------------------------------------------------------
const FULL_PLAN = [
  ['local', 'do-nothing'], ['local', 'reject'], ['local', 'accept'], ['local', 'gpc'], ['local', 'withdraw'],
  ['us-ca', 'do-nothing'], ['us-ca', 'gpc'], ['us-ca', 'opt-out-link'],
  ['eu-de', 'do-nothing'], ['eu-de', 'reject'],
];
const QUICK_PLAN = [['local', 'do-nothing'], ['local', 'reject'], ['local', 'gpc'], ['us-ca', 'gpc']];
const BANNERS = ['OneTrust', 'Cookiebot', 'Osano', 'Termly', undefined];
const TICKS_PER_SCENARIO = 3;

const rand = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const min = 60_000;

/** @type {Map<string, any>} */
const jobs = new Map();
const sim = new Map(); // id -> { tick, plan, banner }

function baseJob(url, { checks = ['consent'], quick = false, batchId = randomUUID().slice(0, 8), createdAgo = 0 } = {}) {
  const host = new URL(url).hostname.replace(/^www\./, '');
  return {
    id: randomUUID().slice(0, 12),
    batchId,
    url,
    host,
    checks,
    quick,
    status: 'queued',
    createdAt: iso(createdAgo),
    progress: { fraction: 0, done: 0, total: 0, phase: 'queued' },
    metrics: { requests: 0, thirdPartyRequests: 0, parties: 0, cookies: 0, scenarios: [] },
  };
}

function finishedResult(job, totals, extra = {}) {
  const findings = totals.violation + totals['needs-review'] + totals.exposure + totals.practice;
  const result = {
    consent: {
      runId: `run-${job.id}`,
      findings,
      totals,
      parties: extra.parties ?? rand(6, 30),
      unrecognized: extra.unrecognized ?? rand(0, 4),
      reportUrl: `/reports/${job.id}/consent/consent-report.html`,
    },
    downloadUrl: `/api/jobs/${job.id}/download`,
  };
  if (job.checks.includes('accessibility')) result.accessibility = { runId: `a11y-${job.id}`, findings: rand(4, 40), reportUrl: `/reports/${job.id}/accessibility/report.html` };
  return result;
}

function seedDone(url, agoMin, durMin, totals, opts = {}) {
  const job = baseJob(url, { ...opts, createdAgo: (agoMin + durMin + 0.5) * min });
  const plan = job.quick ? QUICK_PLAN : FULL_PLAN;
  job.status = 'done';
  job.startedAt = iso((agoMin + durMin) * min);
  job.finishedAt = iso(agoMin * min);
  job.progress = { fraction: 1, done: plan.length, total: plan.length, phase: 'finished' };
  job.metrics = {
    requests: rand(300, 1400), thirdPartyRequests: rand(80, 600), parties: rand(6, 30), cookies: rand(8, 60),
    banner: opts.banner, location: { id: 'local', verdict: 'verified', observed: 'US-FL' },
    scenarios: plan.map(([location, scenario]) => ({ location, scenario, status: 'tested', durationMs: rand(9000, 30000) })),
  };
  job.result = finishedResult(job, totals, { parties: job.metrics.parties });
  jobs.set(job.id, job);
  return job;
}

function seed() {
  seedDone('https://www.storyfolder.com/', 1440 * 2, 6, { violation: 2, 'needs-review': 3, exposure: 1, practice: 1 }, { banner: 'Cookiebot', checks: ['consent', 'accessibility'] });
  seedDone('https://acme-dental.com/', 600, 4, { violation: 0, 'needs-review': 1, exposure: 0, practice: 2 }, { banner: 'OneTrust' });
  seedDone('https://bluewaterbikes.co/', 180, 3, { violation: 4, 'needs-review': 2, exposure: 3, practice: 0 }, {});
  const failed = baseJob('https://shop.northwind-traders.io/', { createdAgo: 95 * min });
  failed.status = 'failed';
  failed.startedAt = iso(94 * min);
  failed.finishedAt = iso(92 * min);
  failed.error = 'Navigation timeout: page did not load within 45s (net::ERR_CONNECTION_TIMED_OUT)';
  failed.progress = { fraction: 0.1, done: 0, total: 10, phase: 'scenarios' };
  failed.metrics.location = { id: 'local', verdict: 'verified', observed: 'US-FL' };
  failed.metrics.scenarios = FULL_PLAN.map(([location, scenario]) => ({ location, scenario, status: 'not-tested', reason: 'site unreachable' }));
  jobs.set(failed.id, failed);
  seedDone('https://lumen-yoga.studio/', 22, 2, { violation: 1, 'needs-review': 0, exposure: 0, practice: 0 }, { banner: 'Termly', quick: true });
  seedDone('https://parkside-legal.com/', 8, 5, { violation: 0, 'needs-review': 0, exposure: 0, practice: 0 }, { banner: 'Osano' });

  const running = baseJob('https://www.harborlight-coffee.com/', { createdAgo: 40_000 });
  jobs.set(running.id, running);
  startJob(running, 9); // partway through
  const queued = baseJob('https://meridianfitness.com/', { checks: ['consent', 'accessibility'], createdAgo: 20_000 });
  jobs.set(queued.id, queued);
  const queued2 = baseJob('https://oakandiron.design/', { quick: true, createdAgo: 10_000 });
  jobs.set(queued2.id, queued2);
}

function startJob(job, fastForward = 0) {
  const plan = job.quick ? QUICK_PLAN : FULL_PLAN;
  const banner = BANNERS[rand(0, BANNERS.length - 1)];
  job.status = 'running';
  job.startedAt = new Date(Date.now() - fastForward * 1000).toISOString();
  job.progress = { fraction: 0, done: 0, total: 0, phase: 'verifying-location', current: 'local' };
  sim.set(job.id, { tick: 0, plan, banner, log: [`[${job.startedAt}] start ${job.url}`] });
  for (let i = 0; i < fastForward; i++) step(job);
}

function step(job) {
  const s = sim.get(job.id);
  if (!s) return;
  s.tick++;
  const { plan } = s;
  const a11y = job.checks.includes('accessibility');
  const unitsTotal = plan.length + (a11y ? 1 : 0);
  const m = job.metrics;
  const t = s.tick;
  const VERIFY = 2;
  const scenEnd = VERIFY + plan.length * TICKS_PER_SCENARIO;
  const ANALYZE = 2;
  const A11Y = a11y ? 5 : 0;

  if (t <= VERIFY) {
    if (t === VERIFY) {
      m.location = { id: 'local', verdict: 'verified', observed: 'US-FL' };
      job.progress = { ...job.progress, total: unitsTotal, phase: 'scenarios' };
      s.log.push(`location local verified (observed US-FL); plan: ${plan.length} scenarios`);
    }
  } else if (t <= scenEnd) {
    const idx = Math.floor((t - VERIFY - 1) / TICKS_PER_SCENARIO);
    const within = (t - VERIFY - 1) % TICKS_PER_SCENARIO;
    if (within === 0) m.scenarios.push({ location: plan[idx][0], scenario: plan[idx][1], status: 'running' });
    const sc = m.scenarios[idx];
    const label = `${sc.location} · ${sc.scenario}`;
    if (within === 0) {
      if (!s.banner && (sc.scenario === 'withdraw' || sc.scenario === 'reject' && sc.location === 'eu-de')) {
        sc.status = 'not-applicable';
        sc.reason = 'no consent banner';
      } else if (sc.location === 'eu-de' && Math.random() < 0.25) {
        sc.status = 'not-tested';
        sc.reason = 'egress for eu-de unavailable';
      } else {
        sc.status = 'running';
        delete sc.reason;
      }
      s.log.push(`scenario ${label} ${sc.status}`);
    }
    if (sc.status === 'running') {
      m.requests += rand(20, 70);
      m.thirdPartyRequests += rand(5, 30);
      m.parties = Math.max(m.parties, rand(3, 18) + idx);
      m.cookies = Math.max(m.cookies, rand(4, 20) + idx * 2);
      if (s.banner && !m.banner) m.banner = s.banner;
    }
    if (within === TICKS_PER_SCENARIO - 1) {
      if (sc.status === 'running') {
        sc.status = 'tested';
        sc.durationMs = TICKS_PER_SCENARIO * 1000 + rand(0, 900);
      }
      job.progress.done = idx + 1;
    }
    job.progress.current = label;
  } else if (t <= scenEnd + ANALYZE) {
    job.progress = { ...job.progress, phase: 'analyzing', current: 'classifying parties' };
  } else if (t <= scenEnd + ANALYZE + A11Y) {
    job.progress = { ...job.progress, phase: 'accessibility', current: `page ${t - scenEnd - ANALYZE} of 15` };
  } else {
    job.progress = { fraction: 1, done: unitsTotal, total: unitsTotal, phase: 'finished' };
    job.status = 'done';
    job.finishedAt = new Date().toISOString();
    const totals = { violation: rand(0, 3), 'needs-review': rand(0, 4), exposure: rand(0, 2), practice: rand(0, 2) };
    job.result = finishedResult(job, totals, { parties: m.parties });
    s.log.push(`done: ${job.result.consent.findings} findings`);
    s.done = true;
    return;
  }
  if (job.progress.total > 0) {
    const doneUnits = job.progress.done + (job.progress.phase === 'finished' ? (a11y ? 1 : 0) : 0);
    job.progress.fraction = Math.min(0.99, doneUnits / unitsTotal);
  }
}

// --- SSE ---------------------------------------------------------------------
const clients = new Set();
function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(event, data) {
  for (const res of clients) send(res, event, data);
}

setInterval(() => {
  for (const job of jobs.values()) {
    if (job.status !== 'running') continue;
    step(job);
    broadcast('job', job);
  }
  const running = [...jobs.values()].filter((j) => j.status === 'running').length;
  const next = [...jobs.values()].filter((j) => j.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (let i = 0; i < CONCURRENCY - running && i < next.length; i++) {
    startJob(next[i]);
    broadcast('job', next[i]);
  }
}, 1000);
setInterval(() => broadcast('ping', {}), 20_000);

// --- HTTP --------------------------------------------------------------------
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
function list() {
  return [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;
  const m = p.match(/^\/api\/jobs\/([^/]+)(\/cancel|\/download)?$/);

  if (req.method === 'GET' && p === '/api/health') return json(res, 200, { ok: true });
  if (req.method === 'GET' && p === '/api/jobs') {
    const all = list();
    return json(res, 200, {
      jobs: all,
      server: { concurrency: CONCURRENCY, running: all.filter((j) => j.status === 'running').length, queued: all.filter((j) => j.status === 'queued').length, retentionDays: 30, region: 'iad', version: '0.0.0-mock' },
    });
  }
  if (req.method === 'GET' && p === '/api/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (req.method === 'POST' && p === '/api/batches') {
    let body = {};
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: 'invalid JSON' });
    }
    const { urls, rejected } = parseUrlList(String(body.urls ?? ''));
    if (!urls.length) return json(res, 400, { error: 'no valid URLs', rejected });
    const checks = Object.entries({ consent: true, ...(body.checks ?? {}) }).filter(([, v]) => v).map(([k]) => k);
    const batchId = randomUUID().slice(0, 8);
    const created = urls.map((u) => baseJob(u, { checks, quick: !!body.quick, batchId }));
    for (const j of created) {
      jobs.set(j.id, j);
      broadcast('job', j);
    }
    return json(res, 201, { batchId, jobs: created, rejected });
  }
  if (m) {
    const job = jobs.get(m[1]);
    if (!job) return json(res, 404, { error: 'not found' });
    if (req.method === 'GET' && !m[2]) {
      const s = sim.get(job.id);
      const log = s?.log ?? (job.status === 'failed'
        ? [`[${job.startedAt}] start ${job.url}`, 'location local verified (observed US-FL)', `navigating ${job.url}`, 'retry 1/2 after timeout', 'retry 2/2 after timeout', `error: ${job.error}`]
        : [`[${job.startedAt}] start ${job.url}`, '…', `done: ${job.result?.consent?.findings ?? 0} findings`]);
      return json(res, 200, { ...job, log });
    }
    if (req.method === 'POST' && m[2] === '/cancel') {
      if (job.status === 'running' || job.status === 'queued') {
        job.status = 'cancelled';
        job.finishedAt = new Date().toISOString();
        sim.delete(job.id);
        broadcast('job', job);
      }
      return json(res, 200, job);
    }
    if (req.method === 'GET' && m[2] === '/download') {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="complykit-${job.host}.zip"` });
      // Empty zip: just the end-of-central-directory record.
      return res.end(Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]));
    }
    if (req.method === 'DELETE' && !m[2]) {
      jobs.delete(job.id);
      sim.delete(job.id);
      broadcast('removed', { id: job.id });
      res.writeHead(204);
      return res.end();
    }
  }
  if (req.method === 'GET' && p.startsWith('/reports/')) {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(`<!doctype html><meta charset="utf-8"><title>Mock report</title><body style="font:16px system-ui;padding:40px"><h1>Mock report</h1><p>${p.replace(/</g, '&lt;')}</p><p>The real server serves the generated report here.</p></body>`);
  }
  json(res, 404, { error: 'not found' });
});

seed();
server.listen(PORT, () => console.log(`complykit mock API on http://localhost:${PORT}`));
