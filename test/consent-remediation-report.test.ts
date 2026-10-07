import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { generateConsentConfig } from '../src/consent-generator.js';
import { buildConsentReportModel, renderConsentHtml, containsBannedVocabulary, renderRemediationHtml, remediationFromWorkspace, parseRemediationTasks, taskAnchor } from '../src/report/index.js';
import { reconcileCompatibility } from '../src/consent-compatibility.js';
import { remediationTaskKey } from '../src/record/index.js';
import { readRunRemediation, REMEDIATION_TASKS_FILE } from '../src/cli/remediation-input.js';
import { compatibilityEvaluation } from './fixtures/compatibility-report.js';

// R3: the report's "Make these changes" section (plans/remediation-flow.md §6).

const NOW = '2026-10-06T12:00:00.000Z';
const gen = () => generateConsentConfig(compatibilityEvaluation(), { complykitVersion: '0.0.0-test', now: NOW });

function model() {
  const e = compatibilityEvaluation();
  e.compatibility = reconcileCompatibility(e);
  return buildConsentReportModel(e, []);
}

describe('renderRemediationHtml', () => {
  const r = gen();

  it('with a checklist, “What a scan cannot tell you” is compact (two columns on wide screens) but never hidden; without one it is as before', () => {
    const scope = (html: string) => html.slice(html.indexOf('<section id="scan-scope"'), html.indexOf('</section>', html.indexOf('<section id="scan-scope"')));
    const m = model();
    const plain = renderConsentHtml(m);
    expect(scope(plain)).not.toContain('data-compact');
    m.remediation = { tasks: r.tasks, source: 'run', configAt: NOW };
    const html = renderConsentHtml(m);
    const s = scope(html);
    expect(s).toMatch(/^<section id="scan-scope" class="human-callout" aria-labelledby="scan-scope-title" data-compact>/);
    // The scope sentence and every blind spot are still there, not behind a <details>.
    expect(s).toContain('These results describe those pages, at that time');
    expect(s.match(/<li>/g)?.length).toBe(scope(plain).match(/<li>/g)?.length);
    expect(s).not.toContain('<details');
    expect(html).toContain('#scan-scope[data-compact] #blind-spots ul{columns:2 24em');
    expect(html.indexOf('id="scan-scope"')).toBeLessThan(html.indexOf('id="remediation"'));
  });

  it('without a generated config: the prompt to generate it, no checklist', () => {
    const html = renderRemediationHtml(undefined);
    expect(html).toContain('id="remediation"');
    expect(html).toContain('Make these changes');
    expect(html).toContain('Generate the consent tool config to get your checklist');
    expect(html).toContain('data-rem-generate');
    expect(html).not.toContain('data-remediation-id');
  });

  it('a numbered checklist, install first; each card has why, steps, copyable markup, pages and status', () => {
    const html = renderRemediationHtml({ tasks: r.tasks, source: 'run', configAt: NOW, runId: 'run-1' });
    const ids = [...html.matchAll(/data-remediation-id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids[0]).toBe('install');
    expect(new Set(ids).size).toBe(r.tasks.length);
    expect(html).toContain(`id="${taskAnchor('install')}"`);
    expect(html).toContain('<ol class="ck-task-steps">');
    expect(html).toContain('data-rem-copy');
    expect(html).toContain('Paste this first in &lt;head&gt;');
    expect(html).toContain('What it looks like now');
    expect(html).toContain('I’ve made this change');
    expect(html).toContain('data-rem-verify');
    expect(html).toContain('Download install bundle (.zip)');
    expect(html).toContain('>To do<');
    expect(html).toMatch(/0 of \d+ verified/);
    expect(html).toContain('run <code>run-1</code>');
    // The install snippet is escaped: no live <script> from task data.
    expect(html).not.toMatch(/<pre data-rem-code><script/);
    expect(containsBannedVocabulary(html)).toBe(false);
  });

  it('a task with folded items shows “This also fixes” and carries their ids for the change list’s links; a status stored under a folded id is found', () => {
    const html = renderRemediationHtml({ tasks: r.tasks, source: 'run' });
    const leak = r.tasks.find((t) => t.kind === 'remove-leak')!;
    expect(leak.aliases?.length).toBe(2);
    const card = html.slice(html.indexOf(`data-remediation-id="${leak.id}"`)).split('</li>\n')[0];
    expect(card).toContain(`data-rem-aliases="${leak.aliases!.join(' ')}"`);
    expect(card).toContain('<strong>This also fixes:</strong><ul><li>Meta Pixel running before the visitor chooses (seen in the scan).</li>');
    const install = html.slice(html.indexOf('data-remediation-id="install"')).split('</li>\n')[0];
    expect(install).toContain('Telling Google Analytics 4 the visitor’s choice');
    const mismatch = leak.aliases![0];
    const section = remediationFromWorkspace({ entries: { [remediationTaskKey(mismatch)]: { value: { status: 'failed' } } }, config: { value: { tasks: r.tasks }, at: NOW } })!;
    expect(section.tasks.find((t) => t.id === leak.id)!.status).toBe('failed');
  });

  it('manual tasks have no Verify button and say why; classify-first and optional tasks are grouped last', () => {
    const html = renderRemediationHtml({ tasks: r.tasks, source: 'run' });
    const manual = r.tasks.find((t) => t.verify.method === 'manual');
    if (manual) {
      const card = html.slice(html.indexOf(`data-remediation-id="${manual.id}"`));
      const one = card.slice(0, card.indexOf('</li>\n'));
      expect(one).not.toContain('data-rem-verify');
      expect(one).toContain('Can’t be checked automatically');
    }
    const later = r.tasks.filter((t) => t.optional || t.classifyFirst);
    if (later.length) {
      const group = html.slice(html.indexOf('ck-rem-later'));
      for (const t of later) expect(group).toContain(`data-remediation-id="${t.id}"`);
    }
  });

  it('status labels: verified, failed, marked done, cannot verify — and progress counts verified only', () => {
    const tasks = r.tasks.map((t, i) => ({ ...t, status: (['verified', 'done-unverified', 'failed', 'cannot-verify'] as const)[i % 4] }));
    const html = renderRemediationHtml({ tasks, source: 'run' });
    expect(html).toContain('Verified ✓');
    expect(html).toContain('Marked done');
    expect(html).toContain('Failed ✗');
    expect(html).toContain('Can’t verify automatically');
    const required = tasks.filter((t) => !t.optional && !t.classifyFirst);
    expect(html).toContain(`${required.filter((t) => t.status === 'verified').length} of ${required.length} verified`);
  });

  it('the consent report places it after the scope box, links it first in the nav', () => {
    const m = model();
    m.remediation = { tasks: r.tasks, source: 'run' };
    const html = renderConsentHtml(m);
    expect(html.indexOf('id="remediation"')).toBeGreaterThan(html.indexOf('ck-scope') > 0 ? html.indexOf('ck-scope') : 0);
    expect(html.indexOf('id="remediation"')).toBeLessThan(html.indexOf('id="behavior-matrix"'));
    expect(html).toContain('<a href="#remediation">Make these changes</a>');
    expect(containsBannedVocabulary(html.replace(/<script[\s\S]*?<\/script>/g, ''))).toBe(false);
  });
});

describe('where the checklist comes from', () => {
  const r = gen();

  it('the workspace config value, with status from task:change:<id> entries', () => {
    const ws = { entries: { [remediationTaskKey('install')]: { value: { status: 'verified', lastVerify: { at: NOW, result: 'pass', message: 'ok', evidence: [] } } } }, config: { value: { tasks: r.tasks }, at: NOW, runId: 'run-9' } };
    const s = remediationFromWorkspace(ws)!;
    expect(s.source).toBe('workspace');
    expect(s.runId).toBe('run-9');
    expect(s.tasks[0].status).toBe('verified');
    expect(s.tasks[0].lastVerify?.message).toBe('ok');
    expect(s.tasks.slice(1).every((t) => t.status === 'todo')).toBe(true);
    expect(remediationFromWorkspace({ entries: {}, config: { value: { config: {} } } })).toBeUndefined();
    expect(parseRemediationTasks([{ id: 'nope' }, ...r.tasks]).length).toBe(r.tasks.length);
  });

  it('the run dir: consent-config/remediation-tasks.json; a workspace config wins', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-rem-'));
    expect(readRunRemediation(dir)).toBeUndefined();
    fs.mkdirSync(path.join(dir, 'consent-config'));
    fs.writeFileSync(path.join(dir, 'consent-config', REMEDIATION_TASKS_FILE), JSON.stringify({ version: 1, at: NOW, runId: 'run-1', tasks: r.tasks }));
    const s = readRunRemediation(dir)!;
    expect(s.source).toBe('run');
    expect(s.tasks.map((t) => t.id)).toEqual(r.tasks.map((t) => t.id));
    expect(readRunRemediation(dir, { entries: {}, config: { value: { tasks: r.tasks.slice(0, 1) } } })!.tasks.length).toBe(1);
  });
});
