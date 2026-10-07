import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobSummary, RemediationTask, SiteWorkspace } from '../../shared/api';
import { api, ApiError } from '../lib/api';
import { configDownloads, configStoredOf, generatableRuns, generateErrorText, summarizeWorkspace } from '../lib/sites';
import { parseHash, siteHref } from '../lib/useHashView';
import { checklistFromWorkspace, checklistProgress, readTaskValue, reportChecklistHref } from '../lib/checklist';
import { LIVE_REFRESH_MS, startLiveRefresh } from '../lib/useSites';
import { ChecklistPanel, SitePageView, SitesListView } from './Sites';

const NOW = Date.parse('2026-10-06T12:00:00Z');
const at = (n: number) => new Date(NOW - n * 3600_000).toISOString();

const workspace: SiteWorkspace = {
  version: 1,
  domain: 'example-shop.test',
  entries: {
    'task:a': { value: { status: 'open' }, at: at(5) },
    'task:b': { value: { status: 'done' }, at: at(5) },
    'task:c': { value: { status: 'in-progress' }, at: at(5) },
    'task:gone': { value: null, at: at(5) },
    'class:x': { value: { category: 'analytics' }, at: at(5) },
    'class:y': { value: { category: 'reviews' }, at: at(5) },
    'class:cleared': { value: null, at: at(5) },
    'other:z': { value: 1, at: at(5) },
  },
  config: { value: { version: 1, changeList: [{ change: 'gate pixel' }] }, at: at(2), by: 'Ann', runId: 'run-2' },
  runs: [
    { id: 'run-1', at: at(48), jobId: 'job-1', url: 'https://example-shop.test/' },
    { id: 'run-2', at: at(2), jobId: 'job-2', url: 'https://example-shop.test/', meta: { findings: 4 } },
  ],
};

const job = (id: string): JobSummary =>
  ({ id, status: 'done', result: { downloadUrl: `/api/jobs/${id}/download`, consent: { runId: `${id}-run`, reportUrl: `/reports/${id}/consent/consent-report.html` } } }) as unknown as JobSummary;

describe('site workspace summary', () => {
  it('counts open tasks and classifications from entry keys, ignoring cleared values', () => {
    const s = summarizeWorkspace(workspace);
    expect(s).toMatchObject({ openTasks: 2, doneTasks: 1, classifications: 2 });
    expect(s.runs.map((r) => r.id)).toEqual(['run-2', 'run-1']);
  });

  it('offers config and change list downloads only when a config exists', () => {
    expect(configDownloads(workspace).map((d) => d.filename)).toEqual(['example-shop.test-consent-config.json', 'example-shop.test-change-list.json']);
    expect(configDownloads({ ...workspace, config: undefined })).toEqual([]);
  });

  it('the generator’s shape (D8): change list as Markdown, and the snippet', () => {
    const ws: SiteWorkspace = { ...workspace, config: { value: { config: { version: '1.0' }, snippet: '<script></script>', changeList: '# Change list', notes: [] }, at: at(1), runId: 'run-2' } };
    const d = configDownloads(ws);
    expect(d.map((x) => x.filename)).toEqual(['example-shop.test-consent-config.json', 'example-shop.test-change-list.md', 'example-shop.test-snippet.html']);
    expect(d[1].body).toBe('# Change list');
    expect(d[2].body).toBe('<script></script>');
  });
});

describe('routing', () => {
  it('parses site hashes', () => {
    expect(parseHash('#sites')).toEqual({ view: 'sites' });
    expect(parseHash(siteHref('a.co.uk'))).toEqual({ view: 'sites', domain: 'a.co.uk' });
    expect(parseHash('#kb')).toEqual({ view: 'kb' });
    expect(parseHash('')).toEqual({ view: 'checks' });
  });
});

describe('site page', () => {
  it('renders a site with two runs, job links and counts', () => {
    const html = renderToStaticMarkup(<SitePageView workspace={workspace} jobs={{ 'job-1': job('job-1'), 'job-2': job('job-2') }} now={NOW} />);
    expect(html).toContain('example-shop.test');
    expect(html).toContain('href="/reports/job-1/consent/consent-report.html"');
    expect(html).toContain('href="/reports/job-2/consent/consent-report.html"');
    // The workbench's own to-dos are "report notes", after the facts; the header leads with the checklist.
    expect(html).toMatch(/data-testid="report-notes">2 open \/ 1 done</);
    expect(html).not.toContain('Open tasks');
    expect(html).toMatch(/<dt>Checklist<\/dt><dd data-testid="header-checklist"><span class="muted">not generated yet/);
    expect(html).toMatch(/data-testid="classifications">2</);
    expect(html).toContain('Download latest config');
    expect(html).toContain('Download change list');
    expect(html).toContain('findings: 4');
  });

  it('says none yet without a config, and flags a run whose job is gone', () => {
    const html = renderToStaticMarkup(<SitePageView workspace={{ ...workspace, config: undefined }} jobs={{ 'job-2': job('job-2') }} now={NOW} />);
    expect(html).toContain('none yet');
    expect(html).not.toContain('Download latest config');
    expect(html).toContain('Report deleted or expired');
  });

  it('renders the sites list, and its empty state', () => {
    const html = renderToStaticMarkup(<SitesListView sites={[{ domain: 'example-shop.test', entries: 3, runs: 2, lastRunAt: at(2) }]} now={NOW} />);
    expect(html).toContain('href="#sites/example-shop.test"');
    expect(html).toContain('none yet');
    expect(renderToStaticMarkup(<SitesListView sites={[]} now={NOW} />)).toContain('No sites yet');
  });
});

describe('generate consent tool config', () => {
  const jobs = { 'job-1': job('job-1'), 'job-2': job('job-2') };
  const labelCount = (html: string) => html.split('Generate consent tool config').length - 1;

  it('offers a primary button for the latest finished run and one per finished run', () => {
    const html = renderToStaticMarkup(<SitePageView workspace={workspace} jobs={jobs} now={NOW} />);
    expect(labelCount(html)).toBe(3); // latest (config panel) + both run rows
    expect(html).toContain('btn btn-sm btn-primary');
    expect(generatableRuns(summarizeWorkspace(workspace).runs, jobs).map((r) => r.id)).toEqual(['run-2', 'run-1']);
  });

  it('offers nothing for runs whose job is gone, unfinished, or has no consent run', () => {
    const running = { ...job('job-2'), status: 'running' } as unknown as JobSummary;
    const accessOnly = { id: 'job-1', status: 'done', result: { downloadUrl: '/x', accessibility: { reportUrl: '/y' } } } as unknown as JobSummary;
    const runs = summarizeWorkspace(workspace).runs;
    expect(generatableRuns(runs, { 'job-2': running, 'job-1': accessOnly })).toEqual([]);
    expect(generatableRuns(runs, null)).toEqual([]);
    const html = renderToStaticMarkup(<SitePageView workspace={workspace} jobs={null} now={NOW} />);
    expect(html).not.toContain('Generate consent tool config');
    expect(html).toContain('needs a finished consent scan');
  });

  it('shows progress, disabling every button', () => {
    const html = renderToStaticMarkup(<SitePageView workspace={workspace} jobs={jobs} now={NOW} generate={{ busyRunId: 'run-2' }} />);
    expect(html).toContain('Generating…');
    expect(html).toContain('Generating from run run-2');
    expect(html.match(/<button[^>]*disabled=""[^>]*>(Generat|Generate)/g)?.length).toBe(3);
  });

  it('shows an error, and says when a newer config kept this one from being stored', () => {
    const err = renderToStaticMarkup(<SitePageView workspace={workspace} jobs={jobs} now={NOW} generate={{ error: 'boom' }} />);
    expect(err).toContain('role="alert"');
    expect(err).toContain('boom');
    const refresh = renderToStaticMarkup(<SitePageView workspace={workspace} jobs={jobs} now={NOW} generate={{ reportFailed: { jobId: 'job-2', runId: 'run-2', reason: 'complykit report exited with code 1' } }} />);
    expect(refresh).toContain('Your checklist was generated; the report couldn’t refresh — reload or press Update report.');
    expect(refresh).toContain('Why: complykit report exited with code 1');
    expect(refresh).toContain('>Update report<');
    expect(configStoredOf(new ApiError('x', 500, { error: 'x', configStored: true }))).toBe(true);
    expect(configStoredOf(new ApiError('x', 500, { error: 'x' }))).toBe(false);
    const stale = renderToStaticMarkup(<SitePageView workspace={workspace} jobs={jobs} now={NOW} generate={{ done: { runId: 'run-2', stale: true } }} />);
    expect(stale).toContain('was not stored');
  });

  it('words 409 and 400 for people', () => {
    expect(generateErrorText(new ApiError('the job has no finished consent run', 409))).toContain('Run a new consent scan');
    expect(generateErrorText(new ApiError('`scriptSrc` must be a string', 400))).toContain('refused');
    expect(generateErrorText(new Error('network down'))).toContain('network down');
  });
});

describe('api.generateConsentConfig', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs the options to the job’s consent-config endpoint and returns the response', async () => {
    const body = { domain: 'a.test', runId: 'r', value: {}, files: {}, stale: false };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.generateConsentConfig('job/1', { by: 'Ann' })).resolves.toEqual(body);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/jobs/job%2F1/consent-config');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ by: 'Ann' });
  });

  it('throws an ApiError carrying the status and the server’s message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'the job has no finished consent run' }), { status: 409, statusText: 'Conflict' })));
    await expect(api.generateConsentConfig('j')).rejects.toMatchObject({ name: 'ApiError', status: 409, message: 'the job has no finished consent run' });
  });
});

// --- Checklist (R3) ------------------------------------------------------------

const task = (id: string, order: number, over: Partial<RemediationTask> = {}): RemediationTask => ({
  id,
  kind: id === 'install' ? 'install' : 'rewrite-tag',
  group: id === 'install' ? 'install' : 'rewrite',
  title: id === 'install' ? 'Install the complykit consent tool' : `Rewrite tag ${id}`,
  summary: 'One line.',
  tools: [],
  partyIds: [],
  steps: ['Do it.'],
  pages: ['https://example-shop.test/'],
  verify: { check: id === 'install' ? 'install' : 'rewrite-tag', method: 'static', page: 'https://example-shop.test/' },
  status: 'todo',
  optional: false,
  notes: [],
  order,
  ...over,
});

const withTasks: SiteWorkspace = {
  ...workspace,
  entries: {
    ...workspace.entries,
    'task:change:install': { value: { status: 'verified', lastVerify: { at: at(1), result: 'pass', message: 'The served HTML carries the change.', evidence: ['line 4'] } }, at: at(1) },
    'task:change:rewrite-tag:aaaaaaaaaaaa': { value: { status: 'done' }, at: at(1) },
  },
  config: {
    value: {
      config: {},
      snippet: '',
      changeList: '',
      notes: [],
      tasks: [
        task('rewrite-tag:aaaaaaaaaaaa', 1),
        task('install', 0),
        task('accepted-exposure:bbbbbbbbbbbb', 2, { kind: 'accepted-exposure', title: 'Decide about X', verify: { check: 'manual', method: 'manual' } }),
        task('rewrite-tag:cccccccccccc', 3, { optional: true, title: 'Chat widget' }),
      ],
    },
    at: at(2),
    runId: 'run-2',
  },
};

describe('site checklist', () => {
  it('merges status from task:change:<id> entries, install first; the workbench’s done reads as marked done, never verified', () => {
    const tasks = checklistFromWorkspace(withTasks);
    expect(tasks.map((t) => t.id)).toEqual(['install', 'rewrite-tag:aaaaaaaaaaaa', 'accepted-exposure:bbbbbbbbbbbb', 'rewrite-tag:cccccccccccc']);
    expect(tasks.map((t) => t.status)).toEqual(['verified', 'done-unverified', 'todo', 'todo']);
    expect(checklistProgress(tasks)).toEqual({ required: 3, verified: 1, doneUnverified: 1, failed: 0 });
    expect(readTaskValue({ status: 'bogus' })).toBeUndefined();
    expect(checklistFromWorkspace(workspace)).toEqual([]);
    // Checklist entries don't count as workbench tasks.
    expect(summarizeWorkspace(withTasks)).toMatchObject({ openTasks: 2, doneTasks: 1 });
  });

  it('renders progress, status pills, Verify only for checkable tasks, the install zip and a link into the report', () => {
    const jobs = { 'job-2': job('job-2') };
    expect(reportChecklistHref(withTasks, jobs)).toBe('/reports/job-2/consent/consent-report.html#remediation');
    const html = renderToStaticMarkup(<ChecklistPanel workspace={withTasks} jobs={jobs} />);
    expect(html).toContain('1 of 3 done');
    expect(html).toContain('1 more marked done, not verified yet');
    expect(html).toContain('Verified ✓');
    expect(html).toContain('Marked done');
    expect(html).toContain('The served HTML carries the change.');
    expect(html).toContain('href="/api/sites/example-shop.test/install.zip"');
    expect(html).toContain('href="/reports/job-2/consent/consent-report.html#remediation"');
    expect(html).toContain('Can’t be checked automatically');
    expect(html).toContain('Only if they apply (1): chat, embeds and fonts');
    expect(html).toContain('>To-do list</h2>');
    expect(html.match(/>Verify( again)?</g)?.length).toBe(3); // install, rewrite, optional rewrite — not the manual one
    expect(html).not.toMatch(/compliant/i);
  });

  it('while one Verify runs, every Verify button is disabled and the running one says so', () => {
    const html = renderToStaticMarkup(<ChecklistPanel workspace={withTasks} jobs={null} state={{ verifying: 'rewrite-tag:aaaaaaaaaaaa', errors: { install: 'Could not run the check: busy.' } }} />);
    expect(html).toContain('Checking the live page…');
    expect(html.match(/<button[^>]*disabled=""[^>]*>(Verify|Checking)/g)?.length).toBe(3);
    expect(html).toContain('Could not run the check: busy.');
  });

  it('a folded item’s stored status is found through the task’s aliases (a carried pass reads as marked done on a static task); “This also fixes” is shown', () => {
    const ws: SiteWorkspace = {
      ...withTasks,
      entries: { 'task:change:behavior-mismatch:eeeeeeeeeeee': { value: { status: 'verified' }, at: at(1) } },
      config: { ...withTasks.config!, value: { tasks: [task('install', 0), task('rewrite-tag:dddddddddddd', 1, { aliases: ['behavior-mismatch:eeeeeeeeeeee'], alsoFixes: ['Meta Pixel running before the visitor chooses (seen in the scan).'] })] } },
    };
    expect(checklistFromWorkspace(ws).map((t) => t.status)).toEqual(['todo', 'done-unverified']);
    const html = renderToStaticMarkup(<ChecklistPanel workspace={ws} jobs={null} />);
    expect(html).toContain('<strong>This also fixes:</strong> Meta Pixel running before the visitor chooses (seen in the scan).');
  });

  it('without tasks: the prompt to generate the config; the site page shows the panel', () => {
    expect(renderToStaticMarkup(<ChecklistPanel workspace={workspace} jobs={null} />)).toContain('Generate the consent tool config to get your checklist');
    const page = renderToStaticMarkup(<SitePageView workspace={withTasks} jobs={null} now={NOW} />);
    expect(page).toContain('id="site-checklist"');
    // The header leads with checklist progress, before the report notes.
    expect(page).toMatch(/data-testid="header-checklist"><strong>1 of 3 done<\/strong>/);
    expect(page.indexOf('header-checklist')).toBeLessThan(page.indexOf('report-notes'));
  });
});

describe('checklist api calls', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('Verify POSTs to the task’s verify endpoint; Mark done PATCHes task:change:<id>', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.verifyTask('example-shop.test', 'rewrite-tag:aaaaaaaaaaaa');
    await api.patchWorkspace('example-shop.test', { entries: { 'task:change:install': { value: { status: 'done-unverified' } } } });
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0][0]).toBe('/api/sites/example-shop.test/remediation/rewrite-tag%3Aaaaaaaaaaaaa/verify');
    expect(calls[0][1].method).toBe('POST');
    expect(calls[1][0]).toBe('/api/sites/example-shop.test/workspace');
    expect(calls[1][1].method).toBe('PATCH');
    expect(JSON.parse(calls[1][1].body as string)).toEqual({ entries: { 'task:change:install': { value: { status: 'done-unverified' } } } });
  });
});

describe('decisions in the same list (classify)', () => {
  const classKey = 'class:tool-0123456789abcdef0123456789abcdef';
  const decisionTask = task('classify:111111111111', 0, { kind: 'classify', group: 'classify', title: 'Decide: what is getscrolly.com?', tools: ['getscrolly.com'], partyIds: ['unknown:getscrolly.com'], classKey, verify: { check: 'manual', method: 'manual' }, pages: [] });
  const blockedTask = task('rewrite-tag:222222222222', 2, { title: 'Hold the getscrolly.com tag until consent', partyIds: ['unknown:getscrolly.com'], classifyFirst: true, waitingOn: ['classify:111111111111'] });
  const ws = (entries: SiteWorkspace['entries'] = {}): SiteWorkspace => ({ ...workspace, entries, config: { value: { tasks: [blockedTask, task('install', 1), decisionTask] }, at: at(2), runId: 'run-2' } });

  it('one ordered list: the decision first, then install, then the change that waits on it — counted in the progress', () => {
    const tasks = checklistFromWorkspace(ws());
    expect(tasks.map((t) => t.id)).toEqual(['classify:111111111111', 'install', 'rewrite-tag:222222222222']);
    expect(checklistProgress(tasks)).toEqual({ required: 3, verified: 0, doneUnverified: 0, failed: 0 });
    const jobs = { 'job-2': job('job-2') };
    const html = renderToStaticMarkup(<ChecklistPanel workspace={ws()} jobs={jobs} />);
    expect(html.match(/<ol class="checklist">/g)).toHaveLength(1);
    expect(html).toContain('0 of 3 done');
    expect(html).toContain('To decide');
    expect(html).toContain('href="/reports/job-2/consent/consent-report.html#task-classify-111111111111"');
    expect(html).toContain('<strong>Unblocks:</strong> Hold the getscrolly.com tag until consent');
    expect(html).toContain('<strong>Waiting on:</strong> your decision on what getscrolly.com is (above).');
    expect(html).not.toMatch(/Classify first/);
    // The waiting change offers no buttons yet; the decision has none (it is made in the report).
    const blocked = html.slice(html.indexOf('data-task-id="rewrite-tag:222222222222"'));
    expect(blocked).not.toContain('I’ve made this change');
    expect(html.slice(html.indexOf('data-task-id="classify:111111111111"'), html.indexOf('data-task-id="install"'))).not.toMatch(/>Verify<|made this change/);
  });

  it('decided when the workspace holds a purpose for the tool (not “Other”, not a suggestion; never a task:change entry): Decided ✓, counted, the change unblocked', () => {
    const decided = (value: unknown, extra: SiteWorkspace['entries'] = {}) => checklistFromWorkspace(ws({ [classKey]: { value, at: at(1) }, ...extra }))[0].status;
    expect(decided({ category: 'analytics', categoryChosen: true })).toBe('verified');
    expect(decided({ category: 'other', categoryChosen: true })).toBe('todo');
    expect(decided({ category: 'analytics', categoryChosen: false })).toBe('todo');
    expect(decided(null, { 'task:change:classify:111111111111': { value: { status: 'verified' }, at: at(1) } })).toBe('todo');
    const done = ws({ [classKey]: { value: { category: 'analytics', categoryChosen: true }, at: at(1) } });
    expect(checklistProgress(checklistFromWorkspace(done))).toMatchObject({ required: 3, verified: 1 });
    const html = renderToStaticMarkup(<ChecklistPanel workspace={done} jobs={null} />);
    expect(html).toContain('Decided ✓');
    expect(html).toContain('1 of 3 done');
    expect(html).not.toContain('Waiting on:');
    expect(html.slice(html.indexOf('data-task-id="rewrite-tag:222222222222"'))).toContain('I’ve made this change');
  });
});

describe('rescan and progress on the sites list', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a site row shows N of M done once a checklist exists, a dash before', () => {
    const html = renderToStaticMarkup(
      <SitesListView
        now={NOW}
        sites={[
          { domain: 'a.test', entries: 3, runs: 2, checklist: { verified: 2, required: 5, doneUnverified: 1, failed: 1 } },
          { domain: 'b.test', entries: 0, runs: 1 },
        ]}
      />,
    );
    expect(html).toContain('2 of 5 done');
    expect(html).toContain('1 marked done');
    expect(html).toContain('1 failed');
    expect(html.match(/data-testid="site-checklist"/g)?.length).toBe(2);
    expect(html).not.toMatch(/compliant/i);
  });

  it('the checklist ends with the rescan: says the rescan’s proof section is the final word, counts what is left, reports the started job', () => {
    const html = renderToStaticMarkup(<ChecklistPanel workspace={withTasks} jobs={null} />);
    expect(html).toContain('Last step: rescan the site');
    expect(html).toContain('Your complykit consent tool: what it controls');
    expect(html).toContain('1 required item is not done yet');
    expect(html).toContain('>Rescan site<');
    const started = renderToStaticMarkup(<ChecklistPanel workspace={withTasks} jobs={null} rescan={{ started: { jobId: 'j9', url: 'https://example-shop.test/', quick: true } }} />);
    expect(started).toContain('Rescanning https://example-shop.test/ (quick)… starting');
    expect(started).toMatch(/<button[^>]*disabled=""[^>]*>Rescan site</);
    expect(renderToStaticMarkup(<ChecklistPanel workspace={withTasks} jobs={null} rescan={{ error: 'a scan of example-shop.test is already running' }} />)).toContain('Couldn’t start the rescan: a scan of example-shop.test is already running');
    expect(renderToStaticMarkup(<ChecklistPanel workspace={{ ...withTasks, runs: [] }} jobs={null} />)).toContain('Rescanning needs an earlier scan of this site');
  });

  it('rescan options: the location as fixed text (no picker), full or quick preselected from the site’s latest scan', () => {
    const quickJob = { ...job('job-2'), checks: ['consent'], quick: true } as JobSummary;
    const html = renderToStaticMarkup(<ChecklistPanel workspace={withTasks} jobs={{ 'job-2': quickJob }} />);
    expect(html).toContain('Location: <strong>this service’s own connection</strong>');
    expect(html).not.toMatch(/<select/);
    expect(html).toMatch(/<input type="radio"[^>]*checked=""[^>]*\/> <span>Quick/);
    const full = renderToStaticMarkup(<ChecklistPanel workspace={withTasks} jobs={{ 'job-2': { ...quickJob, quick: false } }} />);
    expect(full).toMatch(/<input type="radio"[^>]*checked=""[^>]*\/> <span>Full/);
  });

  it('rescan options: a full rescan can also repeat on a slow connection (preselected from the latest scan); not with quick', () => {
    const slowJob = { ...job('job-2'), checks: ['consent'], quick: false, slowRepeat: true } as JobSummary;
    const box = (html: string) => html.match(/<input type="checkbox"[^>]*data-testid="rescan-slow-repeat"[^>]*\/>/)?.[0] ?? '';
    const on = renderToStaticMarkup(<ChecklistPanel workspace={withTasks} jobs={{ 'job-2': slowJob }} />);
    expect(on).toContain('Also repeat on a slow connection');
    expect(on).toContain('takes about 3x longer');
    expect(box(on)).toContain('checked=""');
    expect(box(on)).not.toContain('disabled=""');
    const off = renderToStaticMarkup(<ChecklistPanel workspace={withTasks} jobs={{ 'job-2': { ...slowJob, slowRepeat: false } }} />);
    expect(box(off)).not.toContain('checked=""');
    // Quick preselected: the repeat is off and cannot be turned on.
    const quick = renderToStaticMarkup(<ChecklistPanel workspace={withTasks} jobs={{ 'job-2': { ...slowJob, quick: true } }} />);
    expect(box(quick)).toContain('disabled=""');
    expect(box(quick)).not.toContain('checked=""');
    const started = renderToStaticMarkup(<ChecklistPanel workspace={withTasks} jobs={null} rescan={{ started: { jobId: 'j9', url: 'https://example-shop.test/', quick: false, slowRepeat: true } }} />);
    expect(started).toContain('Rescanning https://example-shop.test/ (full, with a slow-connection repeat)… starting');
  });

  it('follows the started rescan from the live jobs: progress while it runs, then a link straight to the new report’s proof section', () => {
    const started = { jobId: 'j9', url: 'https://example-shop.test/', quick: false };
    const running = { id: 'j9', status: 'running', progress: { fraction: 0.4, done: 2, total: 5, phase: 'scenarios', current: 'local · reject' } } as unknown as JobSummary;
    const html = renderToStaticMarkup(<ChecklistPanel workspace={withTasks} jobs={{ j9: running }} rescan={{ started }} />);
    expect(html).toContain('Rescanning https://example-shop.test/ (full)… Testing visitor choices — local · reject');
    expect(html).toMatch(/<progress[^>]*value="40"/);
    const done = renderToStaticMarkup(<ChecklistPanel workspace={withTasks} jobs={{ j9: job('j9') }} rescan={{ started }} />);
    expect(done).toContain('href="/reports/j9/consent/consent-report.html#consent-tool-proof"');
    expect(done).toContain('>Rescan again<');
    const failed = renderToStaticMarkup(<ChecklistPanel workspace={withTasks} jobs={{ j9: { ...running, status: 'failed', error: 'browser crashed' } as JobSummary }} rescan={{ started }} />);
    expect(failed).toContain('The rescan did not finish: browser crashed');
  });

  it('api.rescan POSTs to the site’s rescan endpoint with the chosen mode; Generate goes through rerender with generate: true', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.rescan('example-shop.test', { quick: false });
    await api.rerender('job/1', { generate: true, by: 'Ann' });
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0][0]).toBe('/api/sites/example-shop.test/rescan');
    expect(calls[0][1].method).toBe('POST');
    expect(JSON.parse(calls[0][1].body as string)).toEqual({ quick: false });
    expect(calls[1][0]).toBe('/api/jobs/job%2F1/rerender');
    expect(JSON.parse(calls[1][1].body as string)).toEqual({ generate: true, by: 'Ann' });
  });
});

describe('the site page stays current (verifies done elsewhere)', () => {
  it('re-reads on focus, when the page becomes visible, and every 30 s while visible — not while hidden; stop removes it all', () => {
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    let tick: (() => void) | undefined;
    let cleared = false;
    const refresh = vi.fn();
    const stop = startLiveRefresh(refresh, {
      win,
      doc,
      setInterval: ((fn: () => void, ms: number) => ((tick = fn), expect(ms).toBe(LIVE_REFRESH_MS), 1)) as unknown as typeof setInterval,
      clearInterval: (() => (cleared = true)) as unknown as typeof clearInterval,
    });
    expect(LIVE_REFRESH_MS).toBe(30_000);
    win.dispatchEvent(new Event('focus'));
    expect(refresh).toHaveBeenCalledTimes(1);
    tick!();
    expect(refresh).toHaveBeenCalledTimes(2);
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    tick!();
    expect(refresh).toHaveBeenCalledTimes(2); // hidden: no poll, no read
    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(refresh).toHaveBeenCalledTimes(3);
    stop();
    expect(cleared).toBe(true);
    win.dispatchEvent(new Event('focus'));
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('a re-read with statuses stored elsewhere shows them: To do → Verified, and the rescan’s “not verified” count drops', () => {
    const before = renderToStaticMarkup(<ChecklistPanel workspace={withTasks} jobs={null} />);
    expect(before).toContain('1 of 3 done');
    const after: SiteWorkspace = { ...withTasks, entries: { ...withTasks.entries, 'task:change:rewrite-tag:aaaaaaaaaaaa': { value: { status: 'verified' }, at: at(0) }, 'task:change:accepted-exposure:bbbbbbbbbbbb': { value: { status: 'done-unverified' }, at: at(0) } } };
    const html = renderToStaticMarkup(<ChecklistPanel workspace={after} jobs={null} />);
    expect(html).toContain('2 of 3 done');
    expect(html).not.toMatch(/required items? (is|are) not done/);
  });
});
