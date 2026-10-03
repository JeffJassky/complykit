#!/usr/bin/env node
// A stand-in for complykit's dist/cli.js. Speaks the same argv and writes the
// same files/events as the real CLI, fast. Behaviour is chosen by the target
// URL's hostname so one service instance can exercise every path:
//   fail.*        consent exits 1 with stderr (no `done`)
//   error.*       consent writes an `error` event and exits 2
//   slow.*        300ms between events (for cancel / concurrency tests)
//   unverified.*  location unverified, no scenarios
//   anything else 30ms between events (FAKE_CLI_DELAY overrides)
// consent also writes env.json (the KB dir it was given) into its cwd.
//
// `kb <sub>` keeps a tiny JSON store at <--dir>/fake-kb.json, seeded on first
// use, and appends every invocation's argv to <--dir>/calls.ndjson so tests
// can see exactly what the service passed. Exit 2 + stderr = user error, like
// the real CLI. `research` waits FAKE_KB_RESEARCH_MS (default 50).

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
  fs.writeFileSync(path.join(cwd, 'env.json'), JSON.stringify({ COMPLYKIT_KB_DIR: process.env.COMPLYKIT_KB_DIR ?? null }));
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

// --- kb -----------------------------------------------------------------------

function seedKb() {
  const now = new Date().toISOString();
  const item = (domain, extra = {}) => ({
    domain, kind: 'unrecognized', status: 'open', reason: 'behaves like a tracker (sets id cookie)', firstSeen: now, lastSeen: now,
    sites: ['a.example', 'b.example'], runs: 2, requests: 40, hosts: [`px.${domain}`], behavesLikeTracker: true, trackerSignals: ['sends-stored-id'],
    sends: ['browser-id'], stores: [{ name: '_x', kind: 'cookie', lifetimeDays: 365 }], sources: ['injected'], loadedBy: [], samples: [`https://px.${domain}/i?id=1`], phases: ['before-choice'],
    ...extra,
  });
  return {
    queue: [item('adnxs.com', { sites: ['a.example', 'b.example', 'c.example'] }), item('quiet.example'), item('vendor.io', { status: 'proposed', proposalId: 'p-vendor.io-1' })],
    proposals: [proposal('vendor.io', 1, 'agent:fake-model')],
    entries: [],
  };
}

function proposal(domain, n, by) {
  const now = new Date().toISOString();
  return {
    id: `p-${domain}-${n}`, domain, status: 'proposed', proposedBy: by, proposedAt: now,
    entry: { id: `${domain.split('.')[0]}.pixel`, vendor: `${domain} Pixel`, owner: `${domain} Inc.`, match: { hosts: [domain] }, categories: ['advertising'], sends: ['browser-id'], stores: [], decoder: 'none' },
    sources: [`https://${domain}/docs`], rationale: 'Its docs describe a conversion pixel.', confidence: 'medium', disagreements: ['sets _x before consent; docs say it waits'], firstParty: false,
  };
}

async function kb() {
  const [sub, ...args] = rest;
  const pos = [];
  const o = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) pos.push(args[i]);
    else if (args[i + 1] === undefined || args[i + 1].startsWith('--')) o[args[i].slice(2)] = true;
    else o[args[i].slice(2)] = args[++i];
  }
  const dir = o.dir;
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'calls.ndjson'), JSON.stringify([sub, ...args]) + '\n');
  const file = path.join(dir, 'fake-kb.json');
  const db = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : seedKb();
  const save = () => fs.writeFileSync(file, JSON.stringify(db, null, 2));
  const out = (v) => process.stdout.write((typeof v === 'string' ? v : JSON.stringify(v, null, 2)) + '\n');
  const fail = (msg, code = 2) => {
    process.stderr.write(`${code === 2 ? '' : 'complykit: '}${msg}\n`);
    process.exit(code);
  };
  const counts = () => db.queue.reduce((c, x) => ((c[x.status] = (c[x.status] ?? 0) + 1), c), {});
  const by = o.by ?? '';

  switch (sub) {
    case 'queue':
      return out({ dir, queue: o.all ? db.queue : db.queue.filter((x) => x.status === 'open'), counts: counts() });
    case 'proposals':
      return out(db.proposals.filter((p) => (o.status ?? 'proposed') === 'all' || p.status === (o.status ?? 'proposed')));
    case 'entries':
      return out(db.entries);
    case 'packet': {
      const item = db.queue.find((x) => x.domain === pos[0]);
      if (!item) fail(`not in the queue: ${pos[0]}`);
      return out(`# Research: ${item.domain}\n\nSeen on ${item.sites.length} site(s).\n`);
    }
    case 'research': {
      await sleep(Number(process.env.FAKE_KB_RESEARCH_MS ?? 50));
      const results = [];
      for (const d of pos) {
        const item = db.queue.find((x) => x.domain === d && x.status === 'open');
        if (!item) {
          results.push({ domain: d, error: 'not in the queue' });
          continue;
        }
        const p = proposal(d, db.proposals.filter((x) => x.domain === d).length + 1, 'agent:fake-model');
        db.proposals.push(p);
        item.status = 'proposed';
        item.proposalId = p.id;
        results.push({ domain: d, proposal: p });
      }
      save();
      return out({ model: 'fake-model', results });
    }
    case 'confirm': {
      if (!by) fail('kb confirm needs --by (the person confirming) or COMPLYKIT_REVIEWER');
      const p = db.proposals.find((x) => x.id === pos[0]);
      if (!p) fail(`no proposal or entry with id ${pos[0]}`, 1);
      p.status = 'confirmed';
      p.reviewedBy = by;
      p.reviewedAt = new Date().toISOString();
      const entry = {
        ...p.entry,
        ...(o.category ? { categories: o.category.split(',') } : {}),
        ...(o.vendor ? { vendor: o.vendor } : {}),
        ...(o.owner ? { owner: o.owner } : {}),
        ...(o['consent-api'] ? { consentApi: o['consent-api'] } : {}),
        ...(o.note ? { notes: o.note } : {}),
        provenance: { proposedBy: p.proposedBy, proposedAt: p.proposedAt, confirmedBy: by, confirmedAt: p.reviewedAt, sources: p.sources },
      };
      db.entries.push(entry);
      for (const x of db.queue) if (x.domain === p.domain) x.status = 'resolved';
      save();
      return out(entry);
    }
    case 'reject': {
      if (!pos[0] || !o.reason) fail('usage: kb reject <proposal-id> --by <who> --reason <why>');
      if (!by) fail('kb reject needs --by or COMPLYKIT_REVIEWER');
      const p = db.proposals.find((x) => x.id === pos[0]);
      if (!p) fail(`no proposal ${pos[0]}`, 1);
      Object.assign(p, { status: 'rejected', reviewedBy: by, reviewedAt: new Date().toISOString(), reviewNote: o.reason });
      for (const x of db.queue) if (x.domain === p.domain) Object.assign(x, { status: 'open', proposalId: undefined });
      save();
      return out(p);
    }
    case 'dismiss': {
      const hit = db.queue.filter((x) => x.domain === pos[0]);
      if (!hit.length) fail(`${pos[0]} is not in the queue`, 1);
      for (const x of hit) Object.assign(x, { status: 'dismissed', note: o.note ?? '' });
      save();
      return out(`dismissed ${pos[0]}.`);
    }
    default:
      fail(`unknown kb subcommand: ${sub}`);
  }
}

const commands = { consent, scan, report, kb };
if (!commands[cmd]) {
  process.stderr.write(`fake-cli: unknown command ${cmd}\n`);
  process.exit(2);
}
await commands[cmd]();
