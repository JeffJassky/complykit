#!/usr/bin/env node
// Like fake-worker-cli.mjs, but narrates its scenarios (location, scenario-start/-done)
// so a primary's progress can be summed across regions. For multi-region tests.
// A stand-in for `complykit consent --collect-only`, for worker tests. Writes
// two events to --events and a run dir with collection.json under
// <--cwd>/.comply/runs/run-1/. Behaviour is chosen by the URL's hostname:
//   slow.*  waits (until killed) before finishing
//   fail.*  writes one event and exits 1
//   empty.* exits 0 without writing a run dir
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

emit({ type: 'start', location: opts.locations });
if (host.startsWith('fail.')) {
  console.error('boom: navigation failed');
  process.exit(1);
}
if (host.startsWith('slow.')) await sleep(60_000);
emit({ type: 'location', location: opts.locations, verdict: 'verified', scenarios: ['do-nothing', 'reject'], runs: 1 });
for (const scenario of ['do-nothing', 'reject']) {
  emit({ type: 'scenario-start', location: opts.locations, scenario });
  await sleep(30);
  emit({ type: 'scenario-done', location: opts.locations, scenario, status: 'tested', requests: 5, thirdPartyRequests: 2, parties: 1, cookies: 1, durationMs: 30 });
}
emit({ type: 'collected', location: opts.locations });
if (!host.startsWith('empty.')) {
  const run = path.join(opts.cwd, '.comply', 'runs', 'run-1');
  fs.mkdirSync(path.join(run, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(run, 'collection.json'), JSON.stringify({ location: opts.locations }));
  fs.writeFileSync(path.join(run, 'evidence', 'a.txt'), 'evidence');
}
