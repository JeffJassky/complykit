// Demo harness for the guided remediation flow (R6's end-to-end test, kept alive
// so a person can walk through it in a browser).
//
//   npm run demo:remediation
//
// Needs the builds: `npm run build`, `npm --prefix client run build`,
// `npm --prefix service run build`; plus a browser (installed Chrome:
// COMPLYKIT_BROWSER_CHANNEL=chrome npm run demo:remediation) and openssl.
//
// What it does
//   1. Starts the fixture storefront (test/fixtures/remediation-e2e-site.ts):
//      shop.example-e2e.test, mapped by Chrome's --host-resolver-rules, with a
//      throwaway-TLS "third party" server. The same COMPLYKIT_BROWSER_ARGS the
//      e2e uses is exported, so the service's scans and verifies reach it.
//   2. Starts the real built service (service/dist/server/index.js, real
//      dist/cli.js and client/dist) on :8090 with DATA_DIR=reports/demo-data
//      (gitignored; wiped at start).
//   3. Runs the first scan through the service (--quick, one run per scenario),
//      classifies the unknown widget, generates the consent config and re-renders
//      the report in one step (rerender with generate: true, the report's Generate
//      button), so the printed report is current — then STAYS RUNNING and prints URLs.
//   4. A control server on :8091 (DEMO_CONTROL_PORT) plays the owner's hands:
//        GET /                    the storefront page as it is now (for viewing)
//        GET /__demo/state        what has been applied
//        GET /__demo/step/1       install the snippet + client files
//        GET /__demo/step/2       remove the old consent tool
//        GET /__demo/step/3       rewrite the tags the checklist names
//        GET /__demo/step/4       remove the Meta Pixel noscript leak
//        GET /__demo/step/reset   put the site back to its starting state
//      Press Verify in the service UI between steps. The same steps are
//      available at the terminal: type 1-4 / reset / state + Enter.
//
// Viewing: open the service at http://localhost:8090 — the human's browser needs
// no host mapping; the service's scans/verifies run in Chrome launched with it.
// The report links are service-relative (/reports/<job>/...), so they work from
// localhost:8090. The control server's page at :8091 shows the markup only: its
// third-party scripts are the fixture's invented hosts and will not load there.
//
// Ctrl-C stops the service child, both fixture servers and removes temp files.
// Env: SERVICE_PORT (8090), DEMO_CONTROL_PORT (8091), COMPLYKIT_BROWSER_CHANNEL.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { startE2eSite, opensslAvailable, SITE, GTAG_SRC, PIXEL_SRC, WIDGET_SRC, type E2eSite } from '../test/fixtures/remediation-e2e-site.js';
import { classificationKey } from '../src/site-workspace.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVICE_PORT = Number(process.env.SERVICE_PORT || 8090);
const CONTROL_PORT = Number(process.env.DEMO_CONTROL_PORT || 8091);
const DATA_DIR = path.join(ROOT, 'reports', 'demo-data');
const SERVICE_ENTRY = path.join(ROOT, 'service', 'dist', 'server', 'index.js');
const BASE = `http://127.0.0.1:${SERVICE_PORT}`;

interface Task {
  id: string;
  kind: string;
  optional?: boolean;
  snippet?: { after?: string };
  verify: { check?: string; category?: string; element?: { host?: string; path?: string; inline?: unknown } };
}

function die(msg: string): never {
  console.error(`demo: ${msg}`);
  process.exit(1);
}

for (const [ok, what] of [
  [fs.existsSync(path.join(ROOT, 'dist', 'cli.js')), 'dist/cli.js (npm run build)'],
  [fs.existsSync(path.join(ROOT, 'client', 'dist', 'complykit-consent.js')), 'client/dist (npm --prefix client run build)'],
  [fs.existsSync(SERVICE_ENTRY), 'service/dist (npm --prefix service run build)'],
  [opensslAvailable(), 'openssl'],
] as const) if (!ok) die(`needs ${what}`);

async function api<T>(method: string, url: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(BASE + url, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* html */
  }
  return { status: res.status, body: parsed as T };
}

let site: E2eSite | undefined;
let child: ChildProcess | undefined;
let control: http.Server | undefined;
let tmp: string | undefined;
let stopping = false;

async function stop(code = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log('\ndemo: stopping…');
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise<void>((r) => {
      const t = setTimeout(() => (child!.kill('SIGKILL'), r()), 6000);
      child!.once('exit', () => (clearTimeout(t), r()));
    });
  }
  control?.closeAllConnections();
  await new Promise<void>((r) => (control ? control.close(() => r()) : r()));
  await site?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(code);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());

async function tasks(): Promise<Task[]> {
  return (await api<{ tasks: Task[] }>('GET', `/api/sites/${SITE}/remediation`)).body.tasks;
}

// ---- the owner's hands ------------------------------------------------------
async function applyInstall(s: E2eSite): Promise<string> {
  const install = (await tasks()).find((t) => t.id === 'install');
  if (!install?.snippet?.after) throw new Error('no install snippet yet (config not generated?)');
  const res = await fetch(`${BASE}/api/sites/${SITE}/install.zip`);
  if (res.status !== 200) throw new Error(`install.zip answered ${res.status}`);
  const dir = path.join(tmp!, 'install');
  fs.rmSync(dir, { recursive: true, force: true });
  const zip = path.join(tmp!, 'install.zip');
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  execFileSync('unzip', ['-o', '-q', zip, '-d', dir]);
  const files = fs.readdirSync(dir, { recursive: true }).map(String);
  for (const f of ['complykit-consent.js', 'complykit-consent-ui.js']) {
    const rel = files.find((x) => path.basename(x) === f);
    if (!rel) throw new Error(`${f} not in the zip`);
    s.state.clientFiles[f] = fs.readFileSync(path.join(dir, rel), 'utf8');
  }
  s.state.head = install.snippet.after;
  return 'snippet placed first in <head>; client files served at /complykit/v1/';
}
async function applyRewrites(s: E2eSite): Promise<string> {
  const rewrites = (await tasks()).filter((t) => t.verify.check === 'rewrite-tag');
  for (const t of rewrites) {
    const el = t.verify.element ?? {};
    const category = t.verify.category!;
    const src = [GTAG_SRC, PIXEL_SRC, WIDGET_SRC].find((u) => el.host && new URL(u).host === el.host && new URL(u).pathname === el.path);
    if (src) s.state.held[src] = category;
    else if (el.inline) s.state.held['inline:gtag'] = category;
  }
  return `${rewrites.length} tags rewritten (type="text/plain" data-category=…)`;
}
const STEPS: Record<string, { label: string; run: (s: E2eSite) => Promise<string> | string }> = {
  '1': { label: 'install the snippet + client files', run: applyInstall },
  '2': { label: 'remove the old consent tool', run: (s) => ((s.state.oldToolRemoved = true), 'old consent tool script removed') },
  '3': { label: 'rewrite the tags', run: applyRewrites },
  '4': { label: 'remove the Meta Pixel noscript leak', run: (s) => ((s.state.leakRemoved = true), 'noscript pixel removed') },
};
async function doStep(s: E2eSite, name: string): Promise<{ ok: boolean; message: string }> {
  if (name === 'reset') {
    s.state.head = undefined;
    s.state.clientFiles = {};
    s.state.oldToolRemoved = false;
    s.state.held = {};
    s.state.leakRemoved = false;
    return { ok: true, message: 'site reset to its starting state' };
  }
  const step = STEPS[name];
  if (!step) return { ok: false, message: `unknown step "${name}" (1-4, reset)` };
  try {
    return { ok: true, message: `step ${name}: ${step.label} — ${await step.run(s)}` };
  } catch (e) {
    return { ok: false, message: `step ${name} failed: ${(e as Error).message}` };
  }
}
const stateOf = (s: E2eSite) => ({
  installed: Boolean(s.state.head),
  clientFiles: Object.keys(s.state.clientFiles),
  oldToolRemoved: s.state.oldToolRemoved,
  heldTags: s.state.held,
  leakRemoved: s.state.leakRemoved,
});

async function main(): Promise<void> {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'complykit-demo-'));
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  site = await startE2eSite();
  const s = site;
  const browserArgs = s.launchArgs.join(' ');

  // The service (real build) as a child: its CLI children inherit COMPLYKIT_BROWSER_ARGS.
  child = spawn(process.execPath, [SERVICE_ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(SERVICE_PORT),
      DATA_DIR,
      COMPLYKIT_CLI: path.join(ROOT, 'dist', 'cli.js'),
      COMPLYKIT_CLIENT_DIST: path.join(ROOT, 'client', 'dist'),
      COMPLYKIT_BROWSER_ARGS: browserArgs,
      CONSENT_RUNS: '1',
      CONCURRENCY: '1',
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logFile = fs.createWriteStream(path.join(DATA_DIR, 'service.log'));
  child.stdout!.pipe(logFile, { end: false });
  child.stderr!.pipe(logFile, { end: false });
  child.once('exit', (c) => {
    if (!stopping) {
      console.error(`demo: the service exited (${c}); see ${path.join(DATA_DIR, 'service.log')}`);
      void stop(1);
    }
  });
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${BASE}/api/sites`)).status === 200) break;
    } catch {
      /* not up yet */
    }
    if (i > 60) die('the service did not start');
    await new Promise((r) => setTimeout(r, 250));
  }

  // The control server.
  control = http.createServer((req, res) => {
    const p = (req.url ?? '/').split('?')[0];
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body, null, 2));
    };
    const step = /^\/__demo\/step\/([a-z0-9]+)$/.exec(p);
    if (step) {
      void doStep(s, step[1]).then((r) => (console.log(`demo: ${r.message}`), json(r.ok ? 200 : 400, { ...r, state: stateOf(s) })));
      return;
    }
    if (p === '/__demo/state') return json(200, stateOf(s));
    if (p === '/' || p === '/products/thing') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return void res.end(s.html());
    }
    const file = p.startsWith('/complykit/v1/') ? s.state.clientFiles[p.slice('/complykit/v1/'.length)] : undefined;
    if (file !== undefined) {
      res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' });
      return void res.end(file);
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  await new Promise<void>((resolve, reject) => {
    control!.once('error', reject);
    control!.listen(CONTROL_PORT, '127.0.0.1', () => resolve());
  });

  // First scan, through the service.
  console.log(`demo: scanning ${s.url} through the service (a few minutes)…`);
  const created = await api<{ jobs: { id: string }[] }>('POST', '/api/batches', { urls: s.url, quick: true });
  if (created.status !== 201) die(`could not start the scan: ${JSON.stringify(created.body)}`);
  const jobId = created.body.jobs[0].id;
  let job: { status: string; error?: string; result?: { consent?: { reportUrl: string } } } = { status: 'queued' };
  for (const start = Date.now(); !['done', 'failed', 'cancelled'].includes(job.status); ) {
    if (Date.now() - start > 8 * 60_000) die('the scan timed out');
    await new Promise((r) => setTimeout(r, 1000));
    job = (await api<typeof job>('GET', `/api/jobs/${jobId}`)).body;
  }
  if (job.status !== 'done') die(`the scan ${job.status}: ${job.error ?? ''}`);

  // Preparation the e2e does: classify the unknown widget, then generate the config AND
  // re-render the report in one step (the report's Generate button: rerender with
  // generate: true), so the printed report already shows this config's checklist — no
  // "checklist was regenerated" notice, no Generate prompt.
  const key = classificationKey({ kind: 'tool', partyId: 'unknown:e2e-widgets.test', domain: 'e2e-widgets.test', recognized: false });
  await api('PATCH', `/api/sites/${SITE}/workspace`, { by: 'demo', entries: { [key]: { value: { category: 'analytics', categoryChosen: true } } } });
  const rr = await api<{ ok?: boolean; reportUrl?: string; config?: { regenerated?: boolean; stale?: boolean }; error?: string }>('POST', `/api/jobs/${jobId}/rerender`, { generate: true, by: 'demo' });
  if (rr.status !== 200 || !rr.body.ok || !rr.body.config?.regenerated) die(`preparation failed: rerender with generate answered ${rr.status} ${JSON.stringify(rr.body)}`);

  const reportUrl = rr.body.reportUrl ?? job.result!.consent!.reportUrl;
  const c = `http://localhost:${CONTROL_PORT}`;
  console.log(`
demo ready. Browser: ${process.env.COMPLYKIT_BROWSER_CHANNEL || 'Playwright Chromium'}; data ${DATA_DIR}

  Service UI        http://localhost:${SERVICE_PORT}/
  Report page       http://localhost:${SERVICE_PORT}/#report/${jobId}
  Site workspace    http://localhost:${SERVICE_PORT}/  (site ${SITE}; checklist API: http://localhost:${SERVICE_PORT}/api/sites/${SITE}/remediation)
  Full report       http://localhost:${SERVICE_PORT}${reportUrl}
  Site page         ${c}/            (current markup; the scanned URL is ${s.url})
  State             ${c}/__demo/state

  Steps (press Verify in the service between them):
    ${c}/__demo/step/1   install the snippet + client files
    ${c}/__demo/step/2   remove the old consent tool
    ${c}/__demo/step/3   rewrite the tags
    ${c}/__demo/step/4   remove the leak
    ${c}/__demo/step/reset

  Or type 1, 2, 3, 4, reset, state here + Enter. Ctrl-C to stop.
`);

  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const w = line.trim();
      if (w === 'state') console.log(JSON.stringify(stateOf(s), null, 2));
      else if (w) void doStep(s, w).then((r) => console.log(`demo: ${r.message}`));
    });
  }
}

main().catch((e: unknown) => {
  console.error(`demo: ${(e as Error).stack ?? String(e)}`);
  void stop(1);
});
