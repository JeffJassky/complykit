import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cmdReport } from '../src/cli/commands/report.js';
import { assembleAndWrite } from '../src/cli/write-run.js';
import { asRunId, runDir, writeTrackingEvaluation } from '../src/record/index.js';
import { classificationKey } from '../src/site-workspace.js';
import { reportRenderInfo } from '../src/report/consent-rerender.js';
import { compatibilityEvaluation } from './fixtures/compatibility-report.js';

// R2 (plans/remediation-flow.md): `complykit report --workspace <file>` re-renders
// a saved consent run with the site's current classifications — the
// compatibility section and the change list follow them, nothing is rescanned —
// and records which classifications it applied (<script id="ck-render">).

const RUN = '2026-10-06T10-00-00-000Z';
const CDN_KEY = classificationKey({ kind: 'tool', partyId: 'cloudflare', domain: 'cloudflare.test', recognized: true });

let cwd: string;
let kbDir: string;
let out: string[];
let err: string[];
const realOut = process.stdout.write.bind(process.stdout);
const realErr = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'complykit-rerender-'));
  kbDir = path.join(cwd, 'kb'); // an empty store: the seed entries only, never the user's ~/.complykit/kb
  const ev = compatibilityEvaluation();
  ev.runId = RUN;
  assembleAndWrite({ runId: asRunId(RUN), property: 'Example shop', now: ev.startedAt, packageVersion: '0.0.0-test', findings: [], engines: {}, accessLevels: ['public'], cwd });
  writeTrackingEvaluation(runDir(asRunId(RUN), cwd), ev);
  out = [];
  err = [];
  process.stdout.write = ((c: string) => (out.push(String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string) => (err.push(String(c)), true)) as typeof process.stderr.write;
});
afterEach(() => {
  process.stdout.write = realOut;
  process.stderr.write = realErr;
  fs.rmSync(cwd, { recursive: true, force: true });
});

function writeWorkspace(entries: Record<string, { value: unknown; at?: string }>): string {
  const f = path.join(cwd, 'workspace.json');
  fs.writeFileSync(f, JSON.stringify({ domain: 'example-shop.test', entries }));
  return f;
}

async function report(format: string, ...extra: string[]): Promise<string> {
  const file = path.join(cwd, `out-${out.length}-${format}.${format === 'consent-html' ? 'html' : 'md'}`);
  const code = await cmdReport(['--run', RUN, '--cwd', cwd, '--format', format, '--out', file, '--kb-dir', kbDir, ...extra]);
  expect(code, err.join('')).toBe(0);
  return fs.readFileSync(file, 'utf8');
}

const renderInfo = (html: string) => JSON.parse(html.match(/<script type="application\/json" id="ck-render">([^<]*)<\/script>/)![1]) as ReturnType<typeof reportRenderInfo>;

describe('complykit report --workspace (re-render in place)', () => {
  it('a classification changes the change list and the compatibility section, from the saved run', async () => {
    const before = await report('consent-changes');
    const htmlBefore = await report('consent-html');
    // The CDN needs no consent as the knowledge base classifies it: no change for it.
    expect(before).not.toMatch(/^### .*Cloudflare/m);
    expect(before).toMatch(/Not counted: .*Cloudflare/);

    // The team says this "CDN" is used for analytics on their site.
    const ws = writeWorkspace({ ['class:' + CDN_KEY.slice('class:'.length)]: { value: { category: 'analytics', categoryChosen: true }, at: '2026-10-07T09:00:00.000Z' } });
    const after = await report('consent-changes', '--workspace', ws);
    const htmlAfter = await report('consent-html', '--workspace', ws);
    expect(after).toMatch(/^### .*Cloudflare/m);
    expect(after).not.toMatch(/Not counted: .*Cloudflare/);
    const section = (h: string) => h.slice(h.indexOf('id="compatibility"'), h.indexOf('id="consent-tool-proof"') > 0 ? h.indexOf('id="consent-tool-proof"') : undefined);
    expect(section(htmlAfter)).not.toBe(section(htmlBefore));
    expect(section(htmlAfter)).toMatch(/Cloudflare[\s\S]*analytics/i);

    // The change list and the model are written beside the HTML, from the same rendering.
    expect(fs.readFileSync(path.join(cwd, 'change-list.md'), 'utf8')).toMatch(/^### .*Cloudflare/m);
    expect(fs.readdirSync(cwd).filter((f) => f.endsWith('-consent-html.json'))).toHaveLength(2);

    // The report records which classifications it applied.
    expect(renderInfo(htmlAfter)).toMatchObject({ version: 1, runId: RUN, workspace: true, classifications: { [CDN_KEY.slice('class:'.length)]: '2026-10-07T09:00:00.000Z' } });
    expect(renderInfo(htmlBefore)).toMatchObject({ workspace: false, classifications: {} });
    // The saved run itself is untouched.
    expect(JSON.parse(fs.readFileSync(path.join(runDir(asRunId(RUN), cwd), 'tracking.json'), 'utf8')).siteWorkspace).toBeUndefined();
  });

  it('a cleared classification is not applied, and a bad workspace file is a usage error', async () => {
    const ws = writeWorkspace({ [CDN_KEY]: { value: null, at: '2026-10-07T09:00:00.000Z' } });
    const html = await report('consent-html', '--workspace', ws);
    expect(renderInfo(html).classifications).toEqual({});
    expect(await report('consent-changes', '--workspace', ws)).not.toMatch(/^### .*Cloudflare/m);

    fs.writeFileSync(path.join(cwd, 'bad.json'), '{"nope":1}');
    expect(await cmdReport(['--run', RUN, '--cwd', cwd, '--format', 'consent-html', '--workspace', path.join(cwd, 'bad.json')])).toBe(2);
    expect(err.join('')).toMatch(/not a site workspace/);
  });

  it('a workspace classification of a known tracker as necessary is refused, as the generator refuses it', async () => {
    const pixel = classificationKey({ kind: 'tool', partyId: 'meta.pixel', domain: 'meta.test', recognized: true });
    const ws = writeWorkspace({ [pixel]: { value: { category: 'necessary', categoryChosen: true } } });
    const changes = await report('consent-changes', '--workspace', ws);
    expect(changes).toMatch(/Meta Pixel/);
    expect(err.join('')).toMatch(/refused: Meta Pixel/);
  });
});

describe('reportRenderInfo', () => {
  it('keeps the stamp of every class: entry with a value, nothing else', () => {
    const info = reportRenderInfo('r1', { entries: { 'class:a': { value: { category: 'analytics' }, at: 'T1' }, 'class:b': { value: null, at: 'T2' }, 'class:c': { value: {} }, 'task:x': { value: { status: 'done' }, at: 'T3' } } }, 'NOW');
    expect(info).toEqual({ version: 1, at: 'NOW', runId: 'r1', workspace: true, classifications: { a: 'T1', c: '' } });
    expect(reportRenderInfo('r1', undefined, 'NOW')).toEqual({ version: 1, at: 'NOW', runId: 'r1', workspace: false, classifications: {} });
  });
});
