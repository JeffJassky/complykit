import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { JobReportResponse, JobSummary, OwnerReport, RemediationTask, SiteSummary } from '../../shared/api';
import { parseHash, reportHref } from '../lib/useHashView';
import { createRerenderQueue, isMoving } from '../lib/useJobReport';
import { HomeView, siteRows, siteStatus } from './Home';
import { BannerLine, Matrix, ReportPageView, ScanStatus, TodoList, readyForFinalScan } from './ReportPage';

// The report page (plans/simple-report.md), rendered per section and state.

const NOW = Date.parse('2026-10-07T12:00:00Z');
const job = (over: Partial<JobSummary> = {}): JobSummary =>
  ({
    id: 'job1', batchId: 'b', url: 'https://shop.example/', host: 'shop.example', checks: ['consent'], quick: false, slowRepeat: false, status: 'running', createdAt: '2026-10-07T11:58:00Z', startedAt: '2026-10-07T11:58:00Z',
    progress: { fraction: 0.33, done: 1, total: 3, phase: 'scenarios', current: 'local · reject' }, metrics: { requests: 0, thirdPartyRequests: 0, parties: 0, cookies: 0, scenarios: [] }, ...over,
  }) as JobSummary;

const pending = { state: 'pending' as const };
const ok = { state: 'ok' as const, expected: 'Off until the visitor gives permission', observed: 'No activity', reason: 'Working as expected.' };
const bad = { state: 'mismatch' as const, expected: 'Off until the visitor gives permission', observed: '2 data request(s) observed', reason: 'Active when opt-in rules expect it to be off.' };
const ask = { state: 'needs-decision' as const, reason: 'Classify the purpose before an expectation can be checked.' };
const gap = { state: 'not-checked' as const, reason: 'There was no consent banner, so this choice couldn’t be made.' };

function owner(over: Partial<OwnerReport> = {}): OwnerReport {
  return {
    version: 1, stage: 'live', runId: 'r', generatedAt: 'x', site: { url: 'https://shop.example/', host: 'shop.example', domain: 'shop.example' },
    scan: { startedAt: '2026-10-07T11:58:00Z', visitsDone: 1, visitsTotal: 3, pagesVisited: 4, current: 'After rejection', location: { id: 'local', label: 'This machine', verified: true } },
    banner: { state: 'detected', provider: 'OneTrust', visitsWithBanner: 1, visitsChecked: 1 },
    matrix: {
      columns: [
        { id: 'local:do-nothing', location: 'local', scenario: 'do-nothing', label: 'Before a choice', state: 'done' },
        { id: 'local:reject', location: 'local', scenario: 'reject', label: 'After rejection', state: 'running' },
        { id: 'local:gpc', location: 'local', scenario: 'gpc', label: 'Privacy signal (GPC)', state: 'pending' },
      ],
      tools: [
        { id: 'tool:meta', partyId: 'meta', label: 'Meta Pixel', domain: 'facebook.com', purpose: 'Advertising', categories: ['advertising'], classified: true, recognized: true, classKey: 'class:meta', cells: [bad, pending, pending], cookies: [{ id: 'c1', name: '_fbp', kind: 'cookie', purpose: 'Advertising', classified: true, cells: [bad, pending, pending] }] },
        { id: 'tool:w', partyId: 'unknown:widgets.test', label: 'widgets.test', domain: 'widgets.test', purpose: 'Unclassified', categories: [], classified: false, recognized: false, classKey: 'class:w', cells: [ask, pending, pending], cookies: [] },
      ],
      counts: { ok: 0, mismatch: 2, needsDecision: 1, pending: 6, notChecked: 0 },
    },
    decisions: [{ partyId: 'unknown:widgets.test', label: 'widgets.test', domain: 'widgets.test', classKey: 'class:w' }],
    ...over,
  };
}

const task = (id: string, over: Partial<RemediationTask> = {}): RemediationTask => ({ id, kind: 'rewrite-tag', group: 'g', title: `Hold the ${id} tag until consent`, summary: 'It runs before consent.', tools: [], partyIds: [], steps: ['Open the page template', 'Change the tag'], snippet: { before: '<script src="x.js"></script>', after: '<script type="text/plain" data-category="advertising" src="x.js"></script>' }, pages: ['https://shop.example/'], verify: { check: 'rewrite-tag', method: 'static' }, status: 'todo', optional: false, notes: [], order: 1, ...over });
const decision = task('classify:1', { kind: 'classify', title: 'Decide: what is widgets.test?', tools: ['widgets.test'], classKey: 'class:w', verify: { check: 'manual', method: 'manual' }, order: 0, snippet: undefined, steps: [] });
const install = task('install', { kind: 'install', title: 'Install the complykit consent tool', verify: { check: 'install', method: 'static' }, snippet: { after: '<script id="complykit-config"></script>' } });

const running = (over: Partial<JobReportResponse> = {}): JobReportResponse => ({ job: job(), domain: 'shop.example', report: owner(), todo: { state: 'waiting', tasks: [] }, updating: false, ...over });
const finalOwner = owner({
  stage: 'final',
  scan: { startedAt: 'x', finishedAt: 'y', visitsDone: 3, visitsTotal: 3, pagesVisited: 9, location: { id: 'local', label: 'This machine', verified: true } },
  matrix: {
    columns: [
      { id: 'local:do-nothing', location: 'local', scenario: 'do-nothing', label: 'Before a choice', state: 'done' },
      { id: 'local:reject', location: 'local', scenario: 'reject', label: 'After rejection', state: 'not-checked', note: 'There was no consent banner, so this choice couldn’t be made.' },
      { id: 'local:gpc', location: 'local', scenario: 'gpc', label: 'Privacy signal (GPC)', state: 'done' },
    ],
    tools: [{ id: 'tool:meta', partyId: 'meta', label: 'Meta Pixel', domain: 'facebook.com', purpose: 'Advertising', categories: ['advertising'], classified: true, recognized: true, classKey: 'class:meta', cells: [bad, gap, ok], cookies: [] }],
    counts: { ok: 1, mismatch: 1, needsDecision: 0, pending: 0, notChecked: 1 },
  },
  decisions: [],
});
const done = (over: Partial<JobReportResponse> = {}): JobReportResponse => ({
  job: job({ status: 'done', finishedAt: '2026-10-07T12:00:00Z' }), domain: 'shop.example', report: finalOwner,
  todo: { state: 'ready', tasks: [decision, install, task('meta')], progress: { verified: 0, required: 3, doneUnverified: 0, failed: 0 }, fromThisRun: true },
  updating: false, technicalReportUrl: '/reports/job1/consent/.comply/runs/r/consent-report.html', installZipUrl: '/api/sites/shop.example/install.zip', ...over,
});

const html = (el: ReactElement) => renderToStaticMarkup(el);
const text = (el: ReactElement) => html(el).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('report page: sections in order, nothing else', () => {
  it('while scanning: status, banner, matrix, to-do list, then the technical details link', () => {
    const out = html(<ReportPageView data={running()} now={NOW} />);
    const order = ['data-testid="scan-status"', 'data-testid="banner"', 'data-testid="matrix"', 'data-testid="todo"'].map((m) => out.indexOf(m));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(out).not.toContain('Technical details'); // no full report yet
  });
  it('when finished: no status section; the technical details link is the only extra', () => {
    const out = html(<ReportPageView data={done()} now={NOW} />);
    expect(out).not.toContain('data-testid="scan-status"');
    expect(out).toContain('>Technical details</a>');
    expect(out).toContain('href="/reports/job1/consent/.comply/runs/r/consent-report.html"');
  });
  it('a failed scan says so and offers a new one', () => {
    const out = text(<ReportPageView data={done({ job: job({ status: 'failed', error: 'page.goto: net::ERR\nstack' }), todo: { state: 'none', tasks: [] } })} now={NOW} actions={{ onRescan: () => {} }} />);
    expect(out).toContain('The scan didn’t finish.');
    expect(out).toContain('page.goto: net::ERR');
    expect(out).not.toContain('stack');
    expect(out).toContain('Scan again');
  });
});

describe('a. scan status', () => {
  it('pages, visits, elapsed, the current visit, a progress bar and Cancel', () => {
    const out = text(<ScanStatus data={running()} now={NOW} onCancel={() => {}} />);
    expect(out).toContain('Scanning shop.example…');
    expect(out).toContain('Visits 1 of 3');
    expect(out).toContain('Pages 4');
    expect(out).toContain('Time 2:00');
    expect(out).toContain('Now After rejection');
    expect(out).toContain('Cancel');
    expect(html(<ScanStatus data={running()} now={NOW} />)).toContain('aria-valuenow="33"');
  });
  it('queued: waiting; done: not shown at all', () => {
    expect(text(<ScanStatus data={running({ job: job({ status: 'queued' }), report: null })} now={NOW} />)).toContain('Waiting to start…');
    expect(html(<ScanStatus data={done()} now={NOW} />)).toBe('');
  });
});

describe('b. consent banner', () => {
  it('names the provider; says when none; looks while pending', () => {
    expect(text(<BannerLine data={running()} />)).toContain('Consent banner: OneTrust');
    expect(text(<BannerLine data={running({ report: owner({ banner: { state: 'detected', visitsWithBanner: 1, visitsChecked: 1 } }) })} />)).toContain('detected (provider not recognized)');
    expect(text(<BannerLine data={done({ report: owner({ banner: { state: 'none', visitsWithBanner: 0, visitsChecked: 3 } }) })} />)).toContain('No consent banner detected');
    expect(text(<BannerLine data={running({ report: null })} />)).toContain('Looking for a consent banner…');
    expect(text(<BannerLine data={running({ report: owner({ banner: { state: 'pending', visitsWithBanner: 0, visitsChecked: 0 } }) })} />)).toContain('Looking for a consent banner…');
  });
});

describe('c. the matrix', () => {
  it('tools with their cookies under them; spinners for pending cells; ✕ and ? cells', () => {
    const out = html(<Matrix data={running()} />);
    expect(out).toContain('Before a choice');
    expect(out).toContain('After rejection');
    expect(out.match(/class="rp-cell" data-state="pending"/g)?.length).toBe(6);
    expect(out.match(/class="rp-cell" data-state="mismatch"/g)?.length).toBe(2);
    expect(out).toContain('aria-label="widgets.test · Before a choice: Needs your decision"');
    expect(out.indexOf('Meta Pixel')).toBeLessThan(out.indexOf('_fbp'));
    expect(out.indexOf('_fbp')).toBeLessThan(out.indexOf('widgets.test'));
    expect(out).toContain('data-unclassified="true"');
    expect(out).toContain('aria-label="visiting now"');
  });
  it('a not-checked column gets one note, its cells a dash', () => {
    const out = html(<Matrix data={done()} />);
    expect(out).toContain('data-testid="column-gaps"');
    expect(text(<Matrix data={done()} />)).toContain('– After rejection: There was no consent banner, so this choice couldn’t be made.');
    expect(out).toContain('data-state="not-checked"');
    expect(out).toContain('data-state="ok"');
    expect(out).not.toContain('class="rp-spinner');
  });
  it('before any tool is seen; an unverified location', () => {
    expect(text(<Matrix data={running({ report: owner({ matrix: { columns: owner().matrix.columns, tools: [], counts: { ok: 0, mismatch: 0, needsDecision: 0, pending: 0, notChecked: 0 } } }) })} />)).toContain('Tools and cookies appear here as the scan finds them.');
    expect(text(<Matrix data={running({ report: null })} />)).toContain('Tools and cookies appear here as the scan finds them.');
    const unverified = owner({ scan: { ...owner().scan, location: { id: 'de', label: 'Germany', verified: false, note: 'exit in US' } }, matrix: { columns: [], tools: [], counts: { ok: 0, mismatch: 0, needsDecision: 0, pending: 0, notChecked: 0 } } });
    expect(text(<Matrix data={done({ report: unverified })} />)).toContain('We could not confirm where the scan was running from (exit in US), so nothing was checked.');
  });
  it('a tool classified on this page shows as saved until the next report arrives', () => {
    expect(text(<Matrix data={running()} ui={{ saved: { 'class:w': 'analytics' } }} />)).toContain('Analytics (saved)');
  });
});

describe('d. the to-do list', () => {
  it('while scanning: the decisions found so far, then a placeholder, then the final scan (disabled)', () => {
    const out = html(<TodoList data={running()} />);
    expect(out).toContain('data-state="waiting"');
    expect(text(<TodoList data={running()} />)).toContain('What is widgets.test for?');
    expect(out).toContain('data-testid="purpose-picker"');
    expect(out).toContain('data-purpose="analytics"');
    expect(out).toContain('data-testid="todo-waiting"');
    expect(out).toMatch(/data-testid="final-scan"[\s\S]*<button[^>]*disabled=""[^>]*>Run the final scan/);
  });
  it('preparing; an error with a retry; none with "Make my to-do list"', () => {
    expect(html(<TodoList data={done({ todo: { state: 'preparing', tasks: [] } })} />)).toContain('data-testid="todo-preparing"');
    const err = text(<TodoList data={done({ todo: { state: 'error', tasks: [], error: 'consent-config exited with code 1' } })} actions={{ onMakeList: () => {} }} />);
    expect(err).toContain('Your list couldn’t be made: consent-config exited with code 1');
    expect(err).toContain('Try again');
    expect(text(<TodoList data={done({ todo: { state: 'none', tasks: [] } })} actions={{ onMakeList: () => {} }} />)).toContain('Make my to-do list');
  });
  it('ready: one numbered list — decisions first, then the changes with steps, snippet + copy, install files and Verify, then the final scan', () => {
    const data = done();
    const out = html(<TodoList data={data} actions={{ onVerify: () => {}, onMarkDone: () => {}, onCopy: async () => true, onRescan: () => {} }} />);
    const t = text(<TodoList data={data} actions={{ onVerify: () => {}, onMarkDone: () => {}, onCopy: async () => true, onRescan: () => {} }} />);
    expect(t).toContain('0 of 3 done');
    expect(t.indexOf('What is widgets.test for?')).toBeLessThan(t.indexOf('Install the complykit consent tool'));
    expect(t.indexOf('Install the complykit consent tool')).toBeLessThan(t.indexOf('Hold the meta tag until consent'));
    expect(t.indexOf('Hold the meta tag until consent')).toBeLessThan(t.indexOf('Run the final scan'));
    expect(out).toContain('href="/api/sites/shop.example/install.zip"');
    expect(t).toContain('Paste first in &lt;head&gt;');
    expect(t).toContain('Copy');
    expect(t).toContain('Open the page template');
    expect(t).toContain('What it looks like now');
    expect(out.match(/>Verify</g)?.length).toBe(2);
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Run the final scan/);
  });
  it('a change waiting on a decision hides its buttons until the answer', () => {
    const waiting = task('w', { waitingOn: ['classify:1'] });
    const t = text(<TodoList data={done({ todo: { state: 'ready', tasks: [decision, waiting] } })} actions={{ onVerify: () => {} }} />);
    expect(t).toContain('Waiting on your answer about widgets.test');
    expect(t).not.toContain('Verify');
    expect(text(<TodoList data={done({ todo: { state: 'ready', tasks: [decision, waiting] } })} ui={{ saved: { 'class:w': 'analytics' } }} actions={{ onVerify: () => {} }} />)).toContain('Verify');
  });
  it('the final scan opens up when every required item is verified, decided or marked done', () => {
    const tasks = [{ ...decision, status: 'verified' as const }, { ...install, status: 'verified' as const, lastVerify: { at: 'x', result: 'pass' as const, message: 'the served HTML carries the change', evidence: [] } }, task('meta', { status: 'done-unverified' }), task('opt', { optional: true })];
    expect(readyForFinalScan(tasks)).toBe(true);
    expect(readyForFinalScan(tasks.map((t) => (t.id === 'meta' ? { ...t, status: 'failed' as const } : t)))).toBe(false);
    const widget = { ...owner().matrix.tools[1], classified: true, purpose: 'Analytics', categories: ['analytics'], cells: [ok, gap, ok] };
    const data = done({ todo: { state: 'ready', tasks }, report: { ...finalOwner, matrix: { ...finalOwner.matrix, tools: [...finalOwner.matrix.tools, widget] } } });
    const out = html(<TodoList data={data} actions={{ onRescan: () => {} }} />);
    expect(out).toMatch(/<button[^>]*class="btn btn-sm btn-primary"[^>]*>Run the final scan/);
    expect(out).not.toMatch(/disabled=""[^>]*>Run the final scan/);
    expect(text(<TodoList data={data} />)).toContain('3 of 3 done');
    expect(text(<TodoList data={data} />)).toContain('Last check: the served HTML carries the change');
    expect(text(<TodoList data={data} />)).toContain('Only if they apply (1)');
    expect(text(<TodoList data={data} />)).toContain('Your answer: Analytics');
    expect(text(<TodoList data={done({ todo: { state: 'ready', tasks } })} />)).toContain('Your answer is saved for this site.');
  });
  it('says so while the report updates with new answers, and when the list came from an earlier scan', () => {
    expect(html(<TodoList data={done()} ui={{ rerender: 'running' }} />)).toContain('data-testid="updating"');
    expect(text(<TodoList data={done({ todo: { ...done().todo, fromThisRun: false } })} />)).toContain('This list comes from an earlier scan of this site');
  });
});

describe('routing, polling and the re-render queue', () => {
  it('#report/<job> is the report page', () => {
    expect(parseHash('#report/abc123')).toEqual({ view: 'report', jobId: 'abc123' });
    expect(parseHash('#report/')).toEqual({ view: 'checks' });
    expect(reportHref('abc')).toBe('#report/abc');
  });
  it('polls fast only while something moves', () => {
    expect(isMoving(null)).toBe(true);
    expect(isMoving(running())).toBe(true);
    expect(isMoving(done())).toBe(false);
    expect(isMoving(done({ todo: { state: 'preparing', tasks: [] } }))).toBe(true);
    expect(isMoving(done({ updating: true }))).toBe(true);
  });
  it('coalesces decisions into one re-render, and runs one more if asked while running', async () => {
    vi.useFakeTimers();
    try {
      let resolve: () => void = () => {};
      const run = vi.fn(() => new Promise<void>((r) => (resolve = r)));
      const states: string[] = [];
      const q = createRerenderQueue(run, { delayMs: 100, onState: (s) => states.push(s) });
      q.request();
      q.request();
      await vi.advanceTimersByTimeAsync(100);
      expect(run).toHaveBeenCalledTimes(1);
      q.request(); // while running
      await vi.advanceTimersByTimeAsync(100);
      expect(run).toHaveBeenCalledTimes(1);
      resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(run).toHaveBeenCalledTimes(2);
      resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(states.at(-1)).toBe('idle');
      expect(states).toContain('running');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('home', () => {
  const j = (id: string, host: string, createdAt: string, over: Partial<JobSummary> = {}) => job({ id, host, url: `https://${host}/`, createdAt, status: 'done', finishedAt: createdAt, ...over });
  it('one row per site, its newest scan, newest first, with to-do progress', () => {
    const sites: SiteSummary[] = [{ domain: 'shop.example', entries: 3, runs: 2, checklist: { verified: 2, required: 5, doneUnverified: 0, failed: 0 } }];
    const rows = siteRows([j('a', 'shop.example', '2026-10-07T10:00:00Z'), j('b', 'shop.example', '2026-10-07T11:00:00Z'), j('c', 'other.test', '2026-10-07T09:00:00Z', { status: 'failed' })], sites);
    expect(rows.map((r) => [r.host, r.job.id])).toEqual([
      ['shop.example', 'b'],
      ['other.test', 'c'],
    ]);
    expect(siteStatus(rows[0], NOW).text).toBe('2 of 5 to-dos done · scanned 1 hour ago');
    expect(siteStatus(rows[1], NOW).text).toBe('Scan didn’t finish');
    expect(siteStatus({ host: 'x', job: job({ progress: { fraction: 0.5, done: 1, total: 2, phase: 'scenarios' } }) }, NOW).text).toBe('Scanning… 50%');
  });
  it('a URL field and a Scan button; options tucked away; sites link to their report', () => {
    const rows = siteRows([j('b', 'shop.example', '2026-10-07T11:00:00Z')]);
    const out = html(<HomeView rows={rows} now={NOW} loaded onSubmit={() => {}} />);
    expect(out).toContain('placeholder="example.com"');
    expect(out).toContain('>Scan</button>');
    expect(out).toMatch(/<details class="home-options"><summary>Options<\/summary>/);
    expect(out).toContain('href="#report/b"');
    expect(out).not.toContain('scenario');
    expect(text(<HomeView rows={[]} now={NOW} loaded onSubmit={() => {}} />)).toContain('No sites yet.');
  });
});
