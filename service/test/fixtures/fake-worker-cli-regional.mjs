#!/usr/bin/env node
// Like fake-worker-cli.mjs, but narrates its scenarios (location, scenario-start/-done)
// so a primary's progress can be summed across regions. For multi-region tests.
// A stand-in for `complykit consent --collect-only`, for worker tests. Writes
// two events to --events and a run dir with collection.json under
// <--cwd>/.comply/runs/run-1/. Behaviour is chosen by the URL's hostname:
//   slow.*  waits (until killed) before finishing
//   fail.*  writes one event and exits 1
//   empty.* exits 0 without writing a run dir
//   hold.*  waits ~500 ms before its first visit and ~1500 ms after its last, before `collected`
//   nobanner.*  the owner report says no banner
// After each visit it rewrites <run>/owner-report.json (minimal, valid; banner provider
// FakeCMP; one `locations` entry) and emits a `live` event, like the real collect-only run.
// It writes its argv to <--cwd>/argv.json so tests can see what the worker passed.

import fs from 'node:fs';
import path from 'node:path';

const [cmd, ...rest] = process.argv.slice(2);
const opts = {};
for (let i = 0; i < rest.length; i++) {
  if (!rest[i].startsWith('--')) continue;
  const next = rest[i + 1];
  if (next === undefined || next.startsWith('--')) opts[rest[i].slice(2)] = true;
  else opts[rest[i].slice(2)] = rest[++i];
}
fs.writeFileSync(path.join(opts.cwd, 'argv.json'), JSON.stringify([cmd, ...rest]));
const host = new URL(opts.url).hostname;
const emit = (ev) => fs.appendFileSync(opts.events, JSON.stringify(ev) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const loc = opts.locations;
const SCENARIOS = ['do-nothing', 'reject'];
const run = path.join(opts.cwd, '.comply', 'runs', 'run-1');
const startedAt = new Date().toISOString();

function ownerReport(visitsDone) {
  const banner = visitsDone === 0 ? { state: 'pending', visitsWithBanner: 0, visitsChecked: 0 } : host.startsWith('nobanner.') ? { state: 'none', visitsWithBanner: 0, visitsChecked: visitsDone } : { state: 'detected', provider: 'FakeCMP', visitsWithBanner: visitsDone, visitsChecked: visitsDone };
  const columns = SCENARIOS.map((sc, i) => ({ id: `${loc}:${sc}`, location: loc, scenario: sc, label: sc, state: i < visitsDone ? 'done' : 'pending' }));
  const cells = SCENARIOS.map((_, i) => (i < visitsDone ? { state: 'ok', expected: 'Off until the visitor gives permission', observed: '1 data request(s) observed', reason: 'Working as expected.' } : { state: 'pending' }));
  return {
    version: 1, stage: 'live', runId: 'run-1', generatedAt: new Date().toISOString(),
    site: { url: opts.url, host, domain: host.split('.').slice(-2).join('.') },
    scan: { startedAt, visitsDone, visitsTotal: SCENARIOS.length, pagesVisited: visitsDone, location: { id: loc, label: loc, observed: loc, verified: true } },
    banner,
    matrix: {
      columns,
      tools: [{ id: 'tool:fake', partyId: 'fake', label: 'Fake Tool', domain: 'fake.test', purpose: 'Analytics', categories: ['analytics'], classified: true, recognized: true, classKey: 'class:fake', cells, cookies: [] }],
      counts: { ok: visitsDone, mismatch: 0, needsDecision: 0, pending: SCENARIOS.length - visitsDone, notChecked: 0 },
    },
    decisions: [],
    locations: [{ id: loc, label: loc, verified: true, observed: loc, visitsDone, visitsTotal: SCENARIOS.length, banner }],
  };
}
function writeOwner(visitsDone) {
  fs.mkdirSync(run, { recursive: true });
  const file = path.join(run, 'owner-report.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(ownerReport(visitsDone)));
  fs.renameSync(file + '.tmp', file);
  emit({ type: 'live', file, stage: 'live', visitsDone, visitsTotal: SCENARIOS.length });
}

emit({ type: 'start', locations: [opts.locations] });
if (host.startsWith('fail.')) {
  console.error('boom: navigation failed');
  process.exit(1);
}
if (host.startsWith('slow.')) await sleep(60_000);
emit({ type: 'location', location: opts.locations, verdict: 'verified', scenarios: ['do-nothing', 'reject'], runs: 1 });
if (host.startsWith('hold.')) await sleep(500);
let visits = 0;
for (const scenario of SCENARIOS) {
  emit({ type: 'scenario-start', location: opts.locations, scenario });
  await sleep(30);
  emit({ type: 'scenario-done', location: opts.locations, scenario, status: 'tested', requests: 5, thirdPartyRequests: 2, parties: 1, cookies: 1, durationMs: 30 });
  if (!host.startsWith('empty.')) writeOwner(++visits);
}
if (host.startsWith('hold.')) await sleep(1500);
emit({ type: 'collected', locations: [opts.locations] });
if (!host.startsWith('empty.')) {
  fs.mkdirSync(path.join(run, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(run, 'collection.json'), JSON.stringify({ location: opts.locations }));
  fs.writeFileSync(path.join(run, 'evidence', 'a.txt'), 'evidence');
}
