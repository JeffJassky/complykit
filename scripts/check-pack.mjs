#!/usr/bin/env node
// Fails if `npm pack` would ship something that must never ship.
//
//   node scripts/check-pack.mjs [dir] [--refuse-private]
//
// Structural checks (always): reports/, .comply/, plans/, test fixtures, src/,
// .env*, node_modules, docs/ and *.tgz must not appear in the tarball.
//
// Content check (opt-in by presence): a deny-list of client hostnames/ids, kept
// OUT of the repo. Read from $COMPLYKIT_DENYLIST (path) or ~/.complykit/denylist
// — one case-insensitive term per line, `#` comments allowed. With no deny-list
// only the structural checks run, and that is said out loud.
//
// --refuse-private: also fail while package.json has "private": true (the
// client package's prepublishOnly: it is not publishable until a human flips it).
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const refusePrivate = args.includes('--refuse-private');
const dir = resolve(args.find((a) => !a.startsWith('--')) ?? process.cwd());
const fail = [];

const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
if (refusePrivate && pkg.private) {
  console.error(
    `check-pack: ${pkg.name} is "private": true — refusing. Publishing needs a human go ` +
      `and the release checklist (.github/ISSUE_TEMPLATE/release-checklist.md).`,
  );
  process.exit(1);
}

const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: dir,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
const files = JSON.parse(out)[0].files.map((f) => f.path);

const STRUCTURAL = [
  [/^reports\//, 'reports/ (client scan output)'],
  [/(^|\/)\.comply(\/|$)/, '.comply (run state / dispositions)'],
  [/^plans\//, 'plans/ (design notes)'],
  [/^docs\//, 'docs/ (site source, not the package)'],
  [/^(test|tests|fixtures)\//, 'test fixtures'],
  [/(^|\/)__screenshots__\//, 'test screenshots'],
  [/^src\//, 'src/ (sources)'],
  [/(^|\/)\.env/, '.env file'],
  [/(^|\/)node_modules\//, 'node_modules'],
  [/\.tgz$/, 'a tarball'],
  [/^service\//, 'service/ (deployable, not the package)'],
];
for (const f of files) for (const [re, why] of STRUCTURAL) if (re.test(f)) fail.push(`${f}: ${why}`);

const denyPath = process.env.COMPLYKIT_DENYLIST || join(homedir(), '.complykit', 'denylist');
let terms = [];
if (existsSync(denyPath)) {
  terms = readFileSync(denyPath, 'utf8')
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim().toLowerCase())
    .filter(Boolean);
}
if (terms.length) {
  for (const f of files) {
    const p = join(dir, f);
    if (!existsSync(p) || !statSync(p).isFile()) continue;
    const text = readFileSync(p, 'latin1').toLowerCase();
    for (const t of terms) if (text.includes(t)) fail.push(`${f}: contains a deny-listed term (#${terms.indexOf(t) + 1})`);
  }
  console.log(`check-pack: ${files.length} files, deny-list of ${terms.length} terms from ${denyPath}`);
} else {
  console.log(
    `check-pack: ${files.length} files — structural checks only (no deny-list at ` +
      `$COMPLYKIT_DENYLIST or ~/.complykit/denylist)`,
  );
}

if (fail.length) {
  console.error('check-pack: FAILED\n  ' + [...new Set(fail)].join('\n  '));
  process.exit(1);
}
console.log('check-pack: ok');
