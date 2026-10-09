import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { JobReportResponse, JobSummary, LawScanProgress, OwnerReport, RemediationTask, SiteSummary } from '../../shared/api';
import { LAWS, type LawId } from '../../shared/laws';
import { parseHash, reportHref } from '../lib/useHashView';
import { createRerenderQueue, isMoving } from '../lib/useJobReport';
import { HomeView, siteRows, siteStatus } from './Home';
import { BannerLine, LawTabsView, Matrix, PingDecision, ReportPageView, pagesVisited, ScanStatus, TodoList, activityLine, readyForFinalScan } from './ReportPage';

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
      counts: { ok: 0, mismatch: 2, needsDecision: 1, pending: 6, notChecked: 0, notApplicable: 0, blocked: 0 },
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
    counts: { ok: 1, mismatch: 1, needsDecision: 0, pending: 0, notChecked: 1, notApplicable: 0, blocked: 0 },
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
  it('a small "Delete this report" link sits in the footer when deleting is wired', () => {
    expect(html(<ReportPageView data={done()} now={NOW} />)).not.toContain('Delete this report');
    const out = html(<ReportPageView data={done()} now={NOW} actions={{ onDelete: () => {} }} />);
    expect(out).toMatch(/<footer class="rp-footer">.*Technical details.*class="rp-delete"[^>]*>Delete this report<\/button>.*<\/footer>/s);
    expect(html(<ReportPageView data={done()} now={NOW} ui={{ deleting: true }} actions={{ onDelete: () => {} }} />)).toContain('Deleting…');
  });
  it('the footer offers the report as JSON and everything as a zip, beside the delete link', () => {
    expect(html(<ReportPageView data={done()} now={NOW} />)).not.toContain('Download JSON');
    const out = html(<ReportPageView data={done({ jsonReportUrl: '/reports/job1/consent/.comply/runs/r/consent-report.json', downloadUrl: '/api/jobs/job1/download' })} now={NOW} actions={{ onDelete: () => {} }} />);
    expect(out).toMatch(/<footer class="rp-footer">.*Technical details.*Download JSON.*Download everything \(\.zip\).*Delete this report.*<\/footer>/s);
    expect(out).toContain('href="/reports/job1/consent/.comply/runs/r/consent-report.json"');
    expect(out).toContain('href="/api/jobs/job1/download"');
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
  it('a site that was never reached: one notice, no banner line, matrix or to-do list', () => {
    const r = owner({ stage: 'final', scan: { ...owner().scan, unreachable: { reason: 'bot protection blocked the visit (HTTP 503)' } }, matrix: { columns: [], tools: [], counts: { ok: 0, mismatch: 0, needsDecision: 0, pending: 0, notChecked: 0, notApplicable: 0, blocked: 0 } } });
    const out = html(<ReportPageView data={done({ report: r })} now={NOW} />);
    expect(out).toContain('data-testid="unreachable"');
    expect(text(<ReportPageView data={done({ report: r })} now={NOW} />)).toContain('We couldn’t reach shop.example.');
    for (const id of ['banner', 'matrix', 'todo']) expect(out).not.toContain(`data-testid="${id}"`);
  });
  it('a not-checked column gets one note, its cells a dash', () => {
    const out = html(<Matrix data={done()} />);
    expect(out).toContain('data-testid="column-gaps"');
    expect(text(<Matrix data={done()} />)).toContain('– After rejection: There was no consent banner, so this choice couldn’t be made.');
    expect(out).toContain('data-state="not-checked"');
    expect(out).toContain('data-state="ok"');
    expect(out).not.toContain('class="rp-spinner');
  });
  it('the three skip kinds look different: icon, text and column note', () => {
    const na = { state: 'not-applicable' as const, reason: 'No banner here.' };
    const blocked = { state: 'blocked' as const, reason: 'The settings button opens nothing.' };
    const base = finalOwner.matrix;
    const r = owner({
      stage: 'final',
      matrix: {
        ...base,
        columns: [
          { id: 'a', location: 'local', scenario: 'close', label: 'Close the banner', state: 'not-applicable', note: 'There is no close control.' },
          { id: 'b', location: 'local', scenario: 'reject', label: 'After rejection', state: 'not-checked', note: 'The click did not land.' },
          { id: 'c', location: 'local', scenario: 'withdraw', label: 'Withdraw consent', state: 'blocked', note: 'A visitor cannot do this: no way to withdraw.' },
        ],
        tools: [{ ...base.tools[0], cells: [na, gap, blocked], cookies: [] }],
        counts: { ok: 0, mismatch: 0, needsDecision: 0, pending: 0, notChecked: 1, notApplicable: 1, blocked: 1 },
      },
    });
    const out = html(<Matrix data={done({ report: r })} />);
    expect(out).toMatch(/data-state="not-applicable"[^>]*>∅</);
    expect(out).toMatch(/data-state="not-checked"[^>]*>–</);
    expect(out).toMatch(/data-state="blocked"[^>]*>⊘</);
    expect(out).toContain('Not applicable — nothing to test');
    expect(out).toContain('Couldn’t test — the scan could not complete this');
    expect(out).toContain('Blocked — a visitor can’t do this either (a problem)');
    const t = text(<Matrix data={done({ report: r })} />);
    expect(t).toContain('∅ Close the banner: There is no close control.');
    expect(t).toContain('– After rejection: The click did not land.');
    expect(t).toContain('⊘ Withdraw consent: A visitor cannot do this: no way to withdraw.');
  });
  it('the legend lists all three skip kinds with their icons', () => {
    const legend = html(<Matrix data={done()} />).match(/<p class="rp-legend[\s\S]*?<\/p>/)![0];
    expect(legend).toMatch(/data-state="blocked">⊘<\/b> blocked/);
    expect(legend).toMatch(/data-state="not-checked">–<\/b> couldn’t test/);
    expect(legend).toMatch(/data-state="not-applicable">∅<\/b> not applicable/);
  });
  it('before any tool is seen; an unverified location', () => {
    expect(text(<Matrix data={running({ report: owner({ matrix: { columns: owner().matrix.columns, tools: [], counts: { ok: 0, mismatch: 0, needsDecision: 0, pending: 0, notChecked: 0, notApplicable: 0, blocked: 0 } } }) })} />)).toContain('Tools and cookies appear here as the scan finds them.');
    expect(text(<Matrix data={running({ report: null })} />)).toContain('Tools and cookies appear here as the scan finds them.');
    const unverified = owner({ scan: { ...owner().scan, location: { id: 'de', label: 'Germany', verified: false, note: 'exit in US' } }, matrix: { columns: [], tools: [], counts: { ok: 0, mismatch: 0, needsDecision: 0, pending: 0, notChecked: 0, notApplicable: 0, blocked: 0 } } });
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
  it('a decision shows what the tool loaded — hosting, requests, the addresses in a list to expand', () => {
    const activity = { requests: 16, visits: 8, cookies: 0, storage: 0, samples: ['storyfolder-releases.s3.amazonaws.com/beta.yml?t', 'storyfolder-releases.s3.amazonaws.com/beta-mac.yml?t'], loadedBy: ['https://shop.example/js/app.58a05869.js'], hostedOn: { provider: 'Amazon S3', name: 'storyfolder-releases', matchesSite: true } };
    const base = owner();
    const report = { ...base, matrix: { ...base.matrix, tools: base.matrix.tools.map((t) => (t.classKey === 'class:w' ? { ...t, activity } : t)) } };
    const data = done({ report, todo: { state: 'ready', tasks: [decision] } });
    const out = html(<TodoList data={data} />);
    expect(out).toMatch(/What is widgets.test for\?.*data-testid="tool-evidence".*<details class="rp-urls"><summary>Addresses it loaded \(2\)<\/summary>.*beta-mac\.yml/s);
    const t = text(<TodoList data={data} />);
    expect(t).toContain('in storage named “storyfolder-releases”. The name matches your site, so it is probably your own.');
    expect(t).toContain('16 requests across 8 visits. Set no cookies or browser storage. Loaded by app.58a05869.js');
    // The matrix row says it only makes requests; a tool with cookies says how many.
    const m = html(<Matrix data={data} />);
    expect(m).toContain('class="rp-activity" data-stores="false">requests only, no cookies</small>');
    expect(activityLine({ ...activity, cookies: 2, storage: 1 })).toBe('sets 2 cookies and 1 storage key');
    expect(activityLine(undefined)).toBeUndefined();
    // Reports made before activity was recorded render as before.
    expect(html(<TodoList data={done({ todo: { state: 'ready', tasks: [decision] } })} />)).not.toContain('tool-evidence');
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
  it('the ping decision is the first item, with the checks it settles; the answer shows once recorded', () => {
    const undecided = { key: 'decision:limited-pings', cells: 4 };
    const t = text(<TodoList data={running({ report: owner({ pingDecision: undecided }) })} />);
    expect(t).toContain('Google’s cookieless pings before consent');
    expect(t).toContain('This settles 4 checks.');
    expect(t).toContain('To decide');
    expect(t.indexOf('Google’s cookieless pings')).toBeLessThan(t.indexOf('What is widgets.test for?'));
    // Also with the checklist ready.
    expect(html(<TodoList data={done({ report: { ...finalOwner, pingDecision: undecided } })} />)).toContain('data-testid="ping-decision"');
    expect(text(<TodoList data={running({ report: owner({ pingDecision: { ...undecided, cells: 1 } }) })} />)).toContain('This settles 1 check.');
    const held = text(<TodoList data={running({ report: owner({ pingDecision: { ...undecided, choice: 'hold', at: '2026-10-07T12:00:00Z' } }) })} />);
    expect(held).toContain('Your answer: Hold them until consent');
    expect(held).toContain('Decided ✓');
    // A value saved on this page wins until the report carries it.
    const saved = text(<TodoList data={running({ report: owner({ pingDecision: undecided }) })} ui={{ saved: { 'decision:limited-pings': 'allow' } }} />);
    expect(saved).toContain('Your answer: Accept them');
  });
  it('the ping decision buttons write the answer, and are off with no handler or while saving', () => {
    const onDecide = vi.fn();
    const el = PingDecision({ decision: { key: 'decision:limited-pings', cells: 2 }, ui: {}, actions: { onDecide } });
    const buttons: Array<{ props: { 'data-value'?: string; onClick?: () => void } }> = [];
    const walk = (n: unknown): void => {
      if (!n || typeof n !== 'object') return;
      const node = n as { type?: unknown; props?: { children?: unknown; 'data-value'?: string } };
      if (Array.isArray(n)) return n.forEach(walk);
      if (node.type === 'button') buttons.push(node as never);
      walk(node.props?.children);
    };
    walk(el);
    buttons.find((b) => b.props['data-value'] === 'allow')?.props.onClick?.();
    expect(onDecide).toHaveBeenCalledWith('decision:limited-pings', 'allow');
    const none = { key: 'decision:limited-pings', cells: 2 };
    expect(html(<PingDecision decision={none} ui={{}} actions={{}} />)).toMatch(/<fieldset[^>]*disabled=""/);
    expect(html(<PingDecision decision={none} ui={{ saving: none.key }} actions={{ onDecide }} />)).toContain('Saving…');
    expect(html(<PingDecision decision={{ ...none, choice: 'allow' }} ui={{}} actions={{ onDecide }} />)).toMatch(/aria-pressed="true"[^>]*data-value="allow"|data-value="allow"[^>]*aria-pressed="true"/);
  });
  it('no ping decision card when the report has none', () => {
    expect(html(<TodoList data={running()} />)).not.toContain('ping-decision');
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

// plans/per-law-report-contract.md, PR C3: a job with two or more laws shows one tab per
// law (its banner and matrix), above one to-do list; one law or none: the page as before.
describe('law tabs', () => {
  const progress = (id: LawId, state: LawScanProgress['state'], over: Partial<LawScanProgress> = {}): LawScanProgress => {
    const l = LAWS.find((x) => x.id === id)!;
    return { id, locationId: l.locationId, region: l.flyRegion, local: !!l.local, state, visitsDone: 0, visitsTotal: 0, ...over };
  };
  const fiveLaws = (eu: OwnerReport | null = owner()): JobReportResponse => {
    const laws: JobReportResponse['laws'] = [
      { id: 'eu', progress: progress('eu', 'scanning', { visitsDone: 1, visitsTotal: 3 }), report: eu },
      { id: 'uk', progress: progress('uk', 'failed', { error: 'worker in lhr failed: did not become healthy' }), report: null },
      { id: 'ca', progress: progress('ca', 'collected'), report: null },
      { id: 'tx', progress: progress('tx', 'starting'), report: null },
      { id: 'us', progress: progress('us', 'waiting'), report: null },
    ];
    const j = job({ laws: laws.map((l) => l.id), progress: { ...job().progress, phase: 'verifying-location', current: 'verifying de, uk' }, metrics: { ...job().metrics, laws: laws.map((l) => l.progress) } });
    return running({ job: j, report: null, laws });
  };
  const panel = (out: string) => out.slice(out.indexOf('role="tabpanel"'));

  it('five tabs in catalog order, the chosen one selected, one panel', () => {
    const out = html(<LawTabsView data={fiveLaws()} selected="eu" onSelect={() => {}} />);
    expect([...out.matchAll(/role="tab"[^>]*>/g)]).toHaveLength(5);
    expect(text(<LawTabsView data={fiveLaws()} selected="eu" onSelect={() => {}} />)).toMatch(/EU law.*UK law.*California law.*Texas law.*US, no state privacy law/s);
    expect(out.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(out).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>(?:(?!role="tab").)*EU law/s);
    expect(out.match(/role="tabpanel"/g)).toHaveLength(1);
  });

  it('a scanning law shows its own banner line and matrix', () => {
    const p = panel(html(<LawTabsView data={fiveLaws()} selected="eu" onSelect={() => {}} />));
    expect(p).toContain('data-testid="banner"');
    expect(p).toContain('data-testid="matrix"');
    expect(p).toContain('Meta Pixel');
  });

  it('a failed law says it could not be scanned, and why', () => {
    const p = panel(html(<LawTabsView data={fiveLaws()} selected="uk" onSelect={() => {}} />));
    expect(p).toContain('role="alert"');
    expect(p).toContain('This law could not be scanned.');
    expect(p).toContain('worker in lhr failed: did not become healthy');
    expect(p).not.toContain('data-testid="matrix"');
  });

  it('a starting remote law with nothing yet says where its worker is starting', () => {
    const p = panel(html(<LawTabsView data={fiveLaws()} selected="tx" onSelect={() => {}} />));
    expect(p).toContain('Starting the worker in Dallas');
    expect(p).not.toContain('data-testid="matrix"');
  });

  it('a finished job’s tab shows the final report cut to that law’s location', () => {
    const final = owner({
      stage: 'final',
      matrix: {
        columns: [
          { id: 'de:do-nothing', location: 'de', scenario: 'do-nothing', label: 'Before a choice', state: 'done' },
          { id: 'us-ca:gpc', location: 'us-ca', scenario: 'gpc', label: 'Privacy signal (GPC)', state: 'done' },
        ],
        tools: [{ id: 'tool:meta', partyId: 'meta', label: 'Meta Pixel', domain: 'facebook.com', purpose: 'Advertising', categories: ['advertising'], classified: true, recognized: true, classKey: 'class:meta', cells: [bad, ok], cookies: [] }],
        counts: { ok: 1, mismatch: 1, needsDecision: 0, pending: 0, notChecked: 0, notApplicable: 0, blocked: 0 },
      },
    });
    const d = fiveLaws(null);
    const doneLaws = d.laws!.map((l) => ({ ...l, progress: { ...l.progress, state: l.id === 'uk' ? ('failed' as const) : ('done' as const) }, report: null }));
    const data = { ...d, job: job({ status: 'done', laws: d.job.laws }), report: final, laws: doneLaws };
    const p = panel(html(<LawTabsView data={data} selected="eu" onSelect={() => {}} />));
    expect(p).toContain('Before a choice');
    expect(p).not.toContain('Privacy signal (GPC)');
  });

  it('the page: two or more laws get the tabs and one to-do list; one law gets the page as before', () => {
    const many = html(<ReportPageView data={fiveLaws()} now={NOW} />);
    expect(many).toContain('role="tablist"');
    expect(many.match(/data-testid="todo"/g)).toHaveLength(1);
    expect(many.indexOf('role="tablist"')).toBeLessThan(many.indexOf('data-testid="todo"'));
    const one = html(<ReportPageView data={running({ job: job({ laws: ['eu'] }) })} now={NOW} />);
    expect(one).not.toContain('role="tablist"');
    expect(one).toContain('data-testid="matrix"');
  });

  it('pages: the merged report’s, else the most any one law has visited', () => {
    const d = fiveLaws(owner({ scan: { ...owner().scan, pagesVisited: 6 } }));
    d.laws![2] = { ...d.laws![2], report: owner({ scan: { ...owner().scan, pagesVisited: 9 } }) };
    expect(pagesVisited(d)).toBe(9);
    expect(pagesVisited({ ...d, report: owner({ scan: { ...owner().scan, pagesVisited: 11 } }) })).toBe(11);
    expect(pagesVisited(fiveLaws(null))).toBe(0);
  });

  it('with several laws the status drops the "Now" line (it would flip between locations)', () => {
    expect(html(<ReportPageView data={fiveLaws()} now={NOW} />)).not.toContain('data-testid="current"');
    expect(html(<ReportPageView data={running()} now={NOW} />)).toContain('data-testid="current"');
  });
});
