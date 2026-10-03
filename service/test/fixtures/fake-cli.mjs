#!/usr/bin/env node
// A stand-in for complykit's dist/cli.js. Speaks the same argv and writes the
// same files/events as the real CLI, fast. Behaviour is chosen by the target
// URL's hostname so one service instance can exercise every path:
//   fail.*        consent exits 1 with stderr (no `done`)
//   error.*       consent writes an `error` event and exits 2
//   slow.*        300ms between events (for cancel / concurrency tests)
//   unverified.*  location unverified, no scenarios
//   anything else 30ms between events (FAKE_CLI_DELAY overrides)

import fs from 'node:fs';
import path from 'node:path';

const [cmd, ...rest] = process.argv.slice(2);
const opts = {};
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) {
    const key = rest[i].slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) opts[key] = true;
    else opts[key] = rest[++i];
  }
}
const host = opts.url ? new URL(opts.url).hostname : '';
const delay = host.startsWith('slow.') ? 300 : Number(process.env.FAKE_CLI_DELAY ?? 30);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runId = new Date().toISOString().replace(/:/g, '-');
const cwd = opts.cwd ?? process.cwd();

function emit(ev) {
  if (!opts.events) return;
  fs.appendFileSync(opts.events, JSON.stringify({ at: new Date().toISOString(), ...ev }) + '\n');
}

async function consent() {
  emit({ type: 'start', runId, url: opts.url, locations: ['local'] });
  await sleep(delay);
  if (host.startsWith('fail.')) {
    process.stderr.write('Error: page.goto: net::ERR_NAME_NOT_RESOLVED\n');
    process.exit(1);
  }
  if (host.startsWith('error.')) {
    emit({ type: 'error', message: 'location verification crashed' });
    process.exit(2);
  }
  const scenarios = host.startsWith('unverified.') ? [] : ['do-nothing', 'reject', 'gpc'];
  emit({ type: 'location', location: 'local', verdict: scenarios.length ? 'verified' : 'unverified', observed: 'US-FL', scenarios, ...(scenarios.length ? {} : { note: 'no geolocation source answered' }) });
  for (const [i, scenario] of scenarios.entries()) {
    emit({ type: 'scenario-start', location: 'local', scenario });
    await sleep(delay);
    // Write half a line first, like a writer caught mid-append.
    const done = JSON.stringify({ at: new Date().toISOString(), type: 'scenario-done', location: 'local', scenario, status: i === 1 ? 'not-applicable' : 'tested', ...(i === 1 ? { reason: 'no banner' } : {}), requests: 10 * (i + 1), thirdPartyRequests: 3 * (i + 1), parties: 2 + i, cookies: 4 - i, durationMs: delay, ...(i === 2 ? { banner: 'onetrust' } : {}) });
    fs.appendFileSync(opts.events, done.slice(0, 20));
    await sleep(Math.min(delay, 20));
    fs.appendFileSync(opts.events, done.slice(20) + '\n');
  }
  const runDir = path.join(cwd, '.comply', 'runs', runId);
  fs.mkdirSync(path.join(runDir, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'evidence', 'note.txt'), 'evidence for ' + opts.url + '\n');
  fs.writeFileSync(path.join(runDir, 'tracking.json'), JSON.stringify({ url: opts.url }));
  fs.writeFileSync(path.join(runDir, 'findings.jsonl'), '{"ruleId":"fake"}\n');
  fs.writeFileSync(path.join(runDir, 'consent-report.html'), `<!doctype html><title>consent report</title><h1>Consent report for ${opts.url}</h1><a href="evidence/note.txt">evidence</a>\n`);
  fs.mkdirSync(path.join(cwd, '.comply', 'cache'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.comply', 'cache', 'verdicts.json'), '{}');
  await sleep(delay);
  emit({ type: 'done', runId, runDir, report: path.join(runDir, 'consent-report.html'), findings: 2, totals: { violation: 1, 'needs-review': 0, exposure: 1, practice: 0 }, parties: 4, unrecognized: 1 });
  process.stdout.write(`wrote ${runDir}\n`);
}

async function scan() {
  await sleep(delay);
  const runDir = path.join(cwd, '.comply', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ id: runId, property: opts.url }));
  fs.writeFileSync(path.join(runDir, 'findings.jsonl'), '{"ruleId":"color-contrast"}\n');
  process.stdout.write(`scanned ${opts.url}\n`);
}

async function report() {
  const runs = fs.readdirSync(path.join(cwd, '.comply', 'runs')).sort();
  const id = runs.at(-1);
  fs.writeFileSync(opts.out, `<!doctype html><title>a11y</title><h1>Accessibility ${id}</h1>\n`);
  fs.writeFileSync(opts.out.replace(/\.html?$/i, '') + '.json', JSON.stringify({ run: { id }, counts: { defects: 3 } }));
  process.stdout.write(`wrote ${opts.out}\n`);
}

const commands = { consent, scan, report };
if (!commands[cmd]) {
  process.stderr.write(`fake-cli: unknown command ${cmd}\n`);
  process.exit(2);
}
await commands[cmd]();
