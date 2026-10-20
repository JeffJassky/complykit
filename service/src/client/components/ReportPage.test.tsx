import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { JobReportResponse, JobSummary, LawScanProgress, OwnerCell, OwnerReport, RemediationTask, SiteSummary } from '../../shared/api';
import { LAWS, type LawId } from '../../shared/laws';
import { reportSeverity, scoreReport } from '../../shared/score';
import { parseHash, reportHref } from '../lib/useHashView';
import { isMoving } from '../lib/useJobReport';
import { answersAfter, shownData } from '../lib/shown';
import { HomeView, siteRows, siteStatus } from './Home';
import { BannerLine, LawTabsView, Matrix, Overview, ReportPageView, pagesVisited, pdfTitle, ScanHistory, ScanStatus, TodoList, activityLine, readyForFinalScan, saveClassification, PURPOSES } from './ReportPage';

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
        { id: 'tool:meta', partyId: 'meta', label: 'Meta Pixel', domain: 'facebook.com', purpose: 'Advertising', categories: ['advertising'], classified: true, recognized: true, classKey: 'class:meta', judge: { base: ['advertising'] }, cells: [bad, pending, pending], cookies: [{ id: 'c1', name: '_fbp', kind: 'cookie', purpose: 'Advertising', classified: true, judge: { name: [], site: [] }, cells: [bad, pending, pending] }] },
        { id: 'tool:w', partyId: 'unknown:widgets.test', label: 'widgets.test', domain: 'widgets.test', purpose: 'Unclassified', categories: [], classified: false, recognized: false, classKey: 'class:w', judge: { base: [] }, cells: [ask, pending, pending], cookies: [] },
      ],
      counts: { ok: 0, mismatch: 2, needsDecision: 1, pending: 6, notChecked: 0, notApplicable: 0, blocked: 0 },
    },
    decisions: [{ partyId: 'unknown:widgets.test', label: 'widgets.test', domain: 'widgets.test', classKey: 'class:w' }],
    answers: {},
    ...over,
  };
}

const task = (id: string, over: Partial<RemediationTask> = {}): RemediationTask => ({ id, kind: 'rewrite-tag', group: 'g', title: `Hold the ${id} tag until consent`, summary: 'It runs before consent.', tools: [], partyIds: [], steps: ['Open the page template', 'Change the tag'], snippet: { before: '<script src="x.js"></script>', after: '<script type="text/plain" data-category="advertising" src="x.js"></script>' }, pages: ['https://shop.example/'], verify: { check: 'rewrite-tag', method: 'static' }, status: 'todo', optional: false, notes: [], order: 1, ...over });
const decision = task('classify:1', { kind: 'classify', title: 'Decide: what is widgets.test?', tools: ['widgets.test'], classKey: 'class:w', verify: { check: 'manual', method: 'manual' }, order: 0, snippet: undefined, steps: [] });
const install = task('install', { kind: 'install', title: 'Install the complykit consent tool', verify: { check: 'install', method: 'static' }, snippet: { after: '<script id="complykit-config"></script>' } });

const running = (over: Partial<JobReportResponse> = {}): JobReportResponse => ({ job: job(), domain: 'shop.example', report: owner(), todo: { state: 'waiting', tasks: [] }, updating: false, history: [], ...over });
const finalOwner = owner({
  stage: 'final',
  scan: { startedAt: 'x', finishedAt: 'y', visitsDone: 3, visitsTotal: 3, pagesVisited: 9, location: { id: 'local', label: 'This machine', verified: true } },
  matrix: {
    columns: [
      { id: 'local:do-nothing', location: 'local', scenario: 'do-nothing', label: 'Before a choice', state: 'done' },
      { id: 'local:reject', location: 'local', scenario: 'reject', label: 'After rejection', state: 'not-checked', note: 'There was no consent banner, so this choice couldn’t be made.' },
      { id: 'local:gpc', location: 'local', scenario: 'gpc', label: 'Privacy signal (GPC)', state: 'done' },
    ],
    tools: [{ id: 'tool:meta', partyId: 'meta', label: 'Meta Pixel', domain: 'facebook.com', purpose: 'Advertising', categories: ['advertising'], classified: true, recognized: true, classKey: 'class:meta', judge: { base: ['advertising'] }, cells: [bad, gap, ok], cookies: [] }],
    counts: { ok: 1, mismatch: 1, needsDecision: 0, pending: 0, notChecked: 1, notApplicable: 0, blocked: 0 },
  },
  decisions: [],
});
const done = (over: Partial<JobReportResponse> = {}): JobReportResponse => ({
  job: job({ status: 'done', finishedAt: '2026-10-07T12:00:00Z' }), domain: 'shop.example', report: finalOwner,
  todo: { state: 'ready', tasks: [decision, install, task('meta')], progress: { verified: 0, required: 3, doneUnverified: 0, failed: 0 }, fromThisRun: true },
  updating: false, technicalReportUrl: '/reports/job1/consent/.comply/runs/r/consent-report.html', hostedScriptUrl: 'https://ck.example-host.test/s/shop.example.js', history: [], ...over,
});

// A finished report with the facts a verdict needs (what the scan saw in each cell), so the browser can re-judge it.
const fact = (scenario: string, hasActivity: boolean) => ({ scenario, hasActivity, limitedOnly: false, captureGap: false });
const factual = (cell: OwnerCell, scenario: string, hasActivity: boolean): OwnerCell => ({ ...cell, facts: fact(scenario, hasActivity) });
const ASKED = { state: 'needs-decision' as const, reason: 'Classify the purpose before an expectation can be checked.' };
const TRACKER = 'sends a stored id to a third party';
/** meta (advertising, known), widgets (unknown, not a tracker), paylater (unknown, behaves like a tracker): all active before a choice, quiet after rejection. */
function responsive(over: Partial<OwnerReport> = {}): OwnerReport {
  const row = (id: string, label: string, judge: { base: string[]; trackerReason?: string }, cat: string[]) => ({
    id: `tool:${id}`, partyId: id, label, domain: `${id}.test`, purpose: cat.length ? 'Advertising' : 'Unclassified', categories: cat, classified: cat.length > 0, recognized: cat.length > 0, classKey: `class:${id}`, judge,
    cells: [factual(cat.length ? bad : ASKED, 'do-nothing', true), factual(cat.length ? ok : ASKED, 'reject', false)],
    cookies: [{ id: `c:${id}`, name: `_${id}`, kind: 'cookie', purpose: cat.length ? 'Advertising' : `Depends on what ${label} is for`, classified: cat.length > 0, judge: { name: [], site: [] }, cells: [factual(cat.length ? bad : ASKED, 'do-nothing', true), factual(cat.length ? ok : ASKED, 'reject', false)] }],
  });
  const tools = [row('meta', 'Meta Pixel', { base: ['advertising'] }, ['advertising']), row('w', 'widgets.test', { base: [] }, []), row('pay', 'paylater.test', { base: [], trackerReason: TRACKER }, [])];
  return {
    ...finalOwner,
    matrix: { columns: finalOwner.matrix.columns.slice(0, 2).map((c) => ({ ...c, state: 'done' as const, note: undefined })), tools, counts: { ok: 1, mismatch: 1, needsDecision: 4, pending: 0, notChecked: 0, notApplicable: 0, blocked: 0 } },
    decisions: ['w', 'pay'].map((id) => ({ partyId: id, label: `${id}.test`, domain: `${id}.test`, classKey: `class:${id}` })),
    ...over,
  };
}
const decisionPay = task('classify:2', { kind: 'classify', title: 'Decide: what is paylater.test?', tools: ['paylater.test'], classKey: 'class:pay', verify: { check: 'manual', method: 'manual' }, order: 0, snippet: undefined, steps: [] });
const responsiveData = (over: Partial<JobReportResponse> = {}) => done({ report: responsive(), todo: { state: 'ready', tasks: [decision, decisionPay, install], fromThisRun: true }, ...over });
const scoreOf = (out: string) => Number(out.match(/data-testid="score">(\d+)</)![1]);
const rowCells = (out: string, label: string) => {
  const r = out.slice(out.indexOf(`data-row="tool:${label}"`));
  return [...r.slice(0, r.indexOf('</tr>')).matchAll(/class="rp-cell" data-state="([\w-]+)"/g)].map((m) => m[1]);
};

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
    const broken = text(<BannerLine data={done({ report: owner({ banner: { state: 'none', visitsWithBanner: 0, visitsChecked: 3, consentTools: ['WebToffee'], broken: { reason: 'the consent tool (webtoffee-cookie-consent) is on the page but its script crashed before showing a banner, so a visitor gets no banner and no choice: “x”' } } }) })} />);
    expect(broken).toContain('Your consent tool is broken: no visitor gets a banner');
    expect(broken).toContain('The consent tool (webtoffee-cookie-consent) is on the page but its script crashed');
    expect(broken).not.toContain('No consent banner detected');
    expect(text(<BannerLine data={running({ report: owner({ banner: { state: 'pending', visitsWithBanner: 0, visitsChecked: 0 } }) })} />)).toContain('Looking for a consent banner…');
  });
});

describe('c. the matrix', () => {
  it('tools folded to one row each (cookies behind a toggle); spinners for pending cells; ✕ and ? cells', () => {
    const out = html(<Matrix data={running()} />);
    expect(out).toContain('Before a choice');
    expect(out).toContain('After rejection');
    expect(out.match(/class="rp-cell" data-state="pending"/g)?.length).toBe(4);
    expect(out.match(/class="rp-cell" data-state="mismatch"/g)?.length).toBe(1);
    expect(out).toContain('aria-label="widgets.test · Before a choice: Tell us what this tool is for"');
    expect(out).not.toContain('_fbp');
    expect(out).toContain('class="rp-fold" aria-expanded="false" aria-label="Show the 1 cookie or storage key Meta Pixel sets"');
    expect(out.match(/class="rp-fold"/g)).toHaveLength(1); // widgets.test sets nothing: no toggle
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
  it('a tool answered on this page shows its judged purpose at once, before the next report arrives', () => {
    expect(text(<ReportPageView data={running()} now={NOW} ui={{ answers: { 'class:w': ['analytics'] } }} />)).toContain('widgets.test Analytics');
    expect(text(<ReportPageView data={running()} now={NOW} />)).toContain('widgets.test Unclassified');
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
    expect(out).not.toContain('install.zip');
    expect(out).toContain('&lt;script src=&quot;https://ck.example-host.test/s/shop.example.js&quot; referrerpolicy=&quot;no-referrer&quot;&gt;&lt;/script&gt;');
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
    const answered = done({ report: responsive(), todo: { state: 'ready', tasks: [decision, waiting] } });
    expect(text(<ReportPageView data={answered} now={NOW} actions={{ onVerify: () => {} }} />)).not.toContain('Verify');
    expect(text(<ReportPageView data={answered} now={NOW} ui={{ answers: { 'class:w': ['analytics'] } }} actions={{ onVerify: () => {} }} />)).toContain('Verify');
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
    const widget = { ...owner().matrix.tools[1], classified: true, purpose: 'Analytics', categories: ['analytics'], answer: { categories: ['analytics'], applied: true }, cells: [ok, gap, ok] };
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
    expect(html(<TodoList data={done()} ui={{}} />)).not.toContain('data-testid="updating"');
    expect(html(<TodoList data={done({ updating: true })} ui={{}} />)).toContain('data-testid="updating"');
    expect(text(<TodoList data={done({ updateError: 'report crashed' })} ui={{}} />)).toContain('could not be updated with your latest answer (report crashed)');
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
});

const judgeServed = (r: OwnerReport, answers: Record<string, string[]>): OwnerReport => shownData({ ...done(), report: r }, answers).report!;

describe('facts, not verdicts, and decided is not applied', () => {
  it('the picker offers the law’s four categories, in order', () => {
    const out = html(<TodoList data={done({ todo: { state: 'ready', tasks: [decision], fromThisRun: true } })} ui={{}} actions={{ onClassify: () => {} }} />);
    const ids = [...out.matchAll(/data-purpose="([a-z]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(['necessary', 'functional', 'analytics', 'advertising']);
    expect(PURPOSES.map((p) => p.id)).toEqual(ids);
    for (const label of ['Necessary', 'Functional', 'Analytics', 'Advertising']) expect(out).toContain(`>${label}<`);
    expect(out).toContain('title="The site breaks without it: login, cart, security, payments"');
    expect(out).toContain('title="A feature or preference: chat, video, reviews, saved choices"');
    expect(out).not.toContain('Payments or checkout');
  });
  it('a refused answer says what the owner answered and that complykit treats it as needing consent, from the judged row', () => {
    const data = responsiveData();
    const shownHtml = html(<ReportPageView data={data} now={NOW} ui={{ answers: { 'class:pay': ['necessary'] } }} />);
    expect(shownHtml).toContain(`Answered: <strong>Necessary</strong>. complykit treats it as needing consent: ${TRACKER}.`);
    const out = text(<ReportPageView data={data} now={NOW} ui={{ answers: { 'class:pay': ['necessary'] } }} />);
    expect(out).toContain('Answered');
    // The server's task fields are not read: the same answer from the served report renders the same, with no refused/answered on the task.
    const served = responsiveData({ report: judgeServed(responsive(), { 'class:pay': ['necessary'] }) });
    expect(html(<ReportPageView data={served} now={NOW} />)).toContain(`Answered: <strong>Necessary</strong>. complykit treats it as needing consent: ${TRACKER}.`);
    // A task that claims a refusal the judged row does not have shows none.
    const claim = { ...decision, status: 'verified' as const, refused: 'invented', answered: 'necessary' };
    expect(html(<ReportPageView data={done({ report: responsive(), todo: { state: 'ready', tasks: [claim], fromThisRun: true } })} now={NOW} />)).not.toContain('invented');
  });
  it('an applied answer still reads Decided', () => {
    const decided = { ...decision, status: 'verified' as const };
    expect(text(<TodoList data={done({ todo: { state: 'ready', tasks: [decided], fromThisRun: true } })} ui={{}} />)).toContain('Decided ✓');
  });
});

describe('saving a classification', () => {
  const served = (answers: Record<string, string[]>, over: Partial<JobReportResponse> = {}) => done({ report: responsive({ answers }), ...over });
  it('the overlay is dropped only when the report holds THIS answer and no report is still being made', () => {
    const pending = { 'class:w': ['analytics'] };
    expect(answersAfter(pending, served({ 'class:w': ['analytics'] }, { updating: true }))).toEqual(pending); // still updating
    expect(answersAfter(pending, served({ 'class:w': ['analytics'] }, { updating: false }))).toEqual({});
    expect(answersAfter(pending, served({ 'class:w': ['advertising'] }))).toEqual(pending); // an older answer: a "Change" in flight
    expect(answersAfter(pending, served({}))).toEqual(pending); // a report that does not answer it yet
    expect(answersAfter(pending, done({ report: null }))).toEqual(pending);
    expect(answersAfter({ ...pending, 'class:pay': ['necessary'] }, served({ 'class:w': ['analytics'] }))).toEqual({ 'class:pay': ['necessary'] }); // per tool
  });
  it('answers are compared as sets: same members in any order are the same answer', () => {
    const pending = { 'class:w': ['functional', 'advertising'] };
    expect(answersAfter(pending, served({ 'class:w': ['advertising', 'functional'] }))).toEqual({});
    expect(answersAfter(pending, served({ 'class:w': ['advertising'] }))).toEqual(pending); // a subset is not the answer
    expect(answersAfter(pending, served({ 'class:w': ['functional', 'advertising', 'analytics'] }))).toEqual(pending);
    expect(answersAfter(pending, served({ 'class:w': ['functional'] }))).toEqual(pending);
  });
  it('a failed report read after a successful save is not a classification error', async () => {
    const refresh = vi.fn().mockRejectedValue(new Error('network'));
    expect(await saveClassification(async () => undefined, refresh)).toEqual({ saved: true });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it('a failed save is reported and reads nothing', async () => {
    const refresh = vi.fn();
    const boom = new Error('409');
    expect(await saveClassification(async () => { throw boom; }, refresh)).toEqual({ saved: false, error: boom });
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('the responsive report: judged in the browser before any server round trip', () => {
  const view = (ui: Parameters<typeof ReportPageView>[0]['ui'], over: Partial<JobReportResponse> = {}) => html(<ReportPageView data={responsiveData(over)} now={NOW} ui={ui} actions={{ onClassify: () => {} }} />);

  it('an answer in ui.answers changes the purpose, the cells and the score at once', () => {
    const before = view({});
    const after = view({ answers: { 'class:w': ['advertising'] } });
    expect(text(<ReportPageView data={responsiveData()} now={NOW} />)).toContain('widgets.test Unclassified');
    expect(text(<ReportPageView data={responsiveData()} now={NOW} ui={{ answers: { 'class:w': ['advertising'] } }} />)).toContain('widgets.test Advertising');
    // The cell that waited for a decision now has a verdict: active before a choice is a problem, quiet after rejection is as expected.
    expect(rowCells(before, 'w')).toEqual(['needs-decision', 'needs-decision']);
    expect(rowCells(after, 'w')).toEqual(['mismatch', 'ok']);
    // Its cookie (folded in the page) is judged with the tool.
    const cookie = shownData(responsiveData(), { 'class:w': ['advertising'] }).report!.matrix.tools[1].cookies[0];
    expect(cookie).toMatchObject({ purpose: 'Advertising', classified: true });
    expect(cookie.cells.map((c) => c.state)).toEqual(['mismatch', 'ok']);
    // 1 of 6 checks passed becomes 2 of 6; the problems follow.
    expect(scoreOf(before)).toBe(17);
    expect(scoreOf(after)).toBe(33);
    expect(after).toMatch(/data-testid="problems">2</);
    expect(before).not.toMatch(/data-testid="problems">2</);
    // The decision is made in the to-do list too.
    expect(text(<ReportPageView data={responsiveData()} now={NOW} ui={{ answers: { 'class:w': ['advertising'] } }} />)).toContain('Your answer: Advertising');
  });

  it('a cell flips from needs-decision to ok when the answer allows the tool to run', () => {
    const after = view({ answers: { 'class:w': ['necessary'] } });
    expect(rowCells(after, 'w')).toEqual(['ok', 'ok']);
    const shown = shownData(responsiveData(), { 'class:w': ['necessary'] });
    expect(shown.report!.matrix.tools[1].answer).toEqual({ categories: ['necessary'], applied: true });
    expect(shown.report!.decisions.map((d) => d.classKey)).toEqual(['class:pay']);
    expect(scoreReport(shown.report)).toMatchObject({ decisions: 1 });
    expect(reportSeverity(shown.report)).toBe('problem');
  });

  it('a legacy stored id is labelled by categoryLabel', () => {
    expect(text(<ReportPageView data={responsiveData()} now={NOW} ui={{ answers: { 'class:w': ['payments'] } }} />)).toContain('widgets.test Payments');
    expect(text(<ReportPageView data={responsiveData()} now={NOW} ui={{ answers: { 'class:w': ['chat'] } }} />)).toContain('widgets.test Chat');
  });

  it('a tracker answered "necessary" is refused in the grid and the to-do list, from the judged row', () => {
    const shown = shownData(responsiveData(), { 'class:pay': ['necessary'] }).report!.matrix.tools[2];
    expect(shown).toMatchObject({ classified: true, categories: ['advertising'], purpose: 'Needs consent (behaves like a tracker)', answer: { categories: ['necessary'], applied: false, reason: TRACKER } });
    const out = view({ answers: { 'class:pay': ['necessary'] } });
    expect(out).toContain(`Answered: <strong>Necessary</strong>. complykit treats it as needing consent: ${TRACKER}.`);
    expect(out).toContain('data-refused="true"');
    expect(rowCells(out, 'pay')).toEqual(['mismatch', 'ok']);
  });

  it('the answer in ui.answers wins over the one the server served, and the served report is not mutated', () => {
    const served = responsive({ answers: { 'class:w': ['advertising'] } });
    const data = responsiveData({ report: judgeServed(responsive(), { 'class:w': ['advertising'] }) });
    expect(data.report!.answers).toEqual({ 'class:w': ['advertising'] });
    expect(rowCells(html(<ReportPageView data={data} now={NOW} />), 'w')).toEqual(['mismatch', 'ok']);
    const changed = html(<ReportPageView data={data} now={NOW} ui={{ answers: { 'class:w': ['necessary'] } }} />);
    expect(rowCells(changed, 'w')).toEqual(['ok', 'ok']);
    expect(served.matrix.tools[1].classified).toBe(false);
    expect(data.report!.matrix.tools[1].answer).toEqual({ categories: ['advertising'], applied: true });
  });

  it('the grid never shows an updating state; the notice lives in the to-do section only', () => {
    const out = view({ answers: { 'class:w': ['advertising'] } }, { updating: true });
    const matrix = out.slice(out.indexOf('data-testid="matrix"'), out.indexOf('data-testid="todo"'));
    expect(matrix).not.toMatch(/Updating|data-testid="updating"/);
    expect(out.slice(out.indexOf('data-testid="todo"'))).toContain('Updating the report with your answers…');
    const failed = view({}, { updateError: 'report crashed' });
    expect(failed.slice(0, failed.indexOf('data-testid="todo"'))).not.toContain('could not be updated');
    expect(failed).toContain('could not be updated with your latest answer (report crashed)');
  });

  it('the judged tabs: each law’s live report is judged too', () => {
    const live = responsive();
    const d = running({ job: job({ laws: ['eu', 'ca'] }), report: null, laws: ['eu', 'ca'].map((id) => ({ id: id as LawId, progress: { id: id as LawId, locationId: LAWS.find((l) => l.id === id)!.locationId, region: 'x', local: false, state: 'scanning' as const, visitsDone: 1, visitsTotal: 3 }, report: live })) });
    const shown = shownData(d, { 'class:w': ['advertising'] });
    expect(shown.laws!.every((l) => l.report!.matrix.tools[1].classified)).toBe(true);
    expect(d.laws![0].report!.matrix.tools[1].classified).toBe(false);
  });

  it('a multi-category answer is judged on all its categories, and the Decision shows them', () => {
    const shown = shownData(responsiveData(), { 'class:w': ['functional', 'advertising'] }).report!.matrix.tools[1];
    expect(shown).toMatchObject({ classified: true, categories: ['functional', 'advertising'], purpose: 'Functional · Advertising', answer: { categories: ['functional', 'advertising'], applied: true } });
    // necessary + advertising is not "no consent needed": not refused, judged as given.
    const mixed = shownData(responsiveData(), { 'class:pay': ['necessary', 'advertising'] }).report!.matrix.tools[2];
    expect(mixed.answer).toEqual({ categories: ['necessary', 'advertising'], applied: true });
  });

  it('a tool the knowledge base classified (no answer on the site) reads "complykit knows it", never "Your answer"', () => {
    const metaDecision = task('classify:3', { kind: 'classify', title: 'Decide: what is Meta Pixel?', tools: ['Meta Pixel'], classKey: 'class:meta', verify: { check: 'manual', method: 'manual' }, order: 0, snippet: undefined, steps: [] });
    const out = text(<ReportPageView data={responsiveData({ todo: { state: 'ready', tasks: [metaDecision, install], fromThisRun: true } })} now={NOW} />);
    expect(out).toContain('complykit knows it: Advertising');
    expect(out).not.toContain('Your answer: Advertising');
    expect(out).not.toContain('The scan doesn’t know this tool');
    // An answer the site gave is still "Your answer".
    expect(text(<ReportPageView data={responsiveData({ todo: { state: 'ready', tasks: [metaDecision, install], fromThisRun: true } })} now={NOW} ui={{ answers: { 'class:meta': ['analytics'] } }} />)).toContain('Your answer: Analytics');
  });

  it('a legacy report (no judge fields) says "Saved — the report updates shortly" on the row while an answer is pending, and not otherwise', () => {
    const legacy = responsive();
    for (const t of legacy.matrix.tools) delete (t as { judge?: unknown }).judge;
    const data = responsiveData({ report: legacy });
    const pendingText = text(<ReportPageView data={data} now={NOW} ui={{ answers: { 'class:w': ['advertising'] } }} />);
    expect(pendingText).toContain('widgets.test Saved — the report updates shortly');
    expect(pendingText).not.toContain('paylater.test Saved');
    expect(text(<ReportPageView data={data} now={NOW} />)).not.toContain('Saved — the report updates shortly');
    // A judgeable report judges at once instead.
    expect(text(<ReportPageView data={responsiveData()} now={NOW} ui={{ answers: { 'class:w': ['advertising'] } }} />)).not.toContain('Saved — the report updates shortly');
  });

  it('reports saved before the judge fields existed are shown as served', () => {
    const legacy = responsive();
    delete (legacy.matrix.tools[0] as { judge?: unknown }).judge;
    const data = responsiveData({ report: legacy });
    expect(shownData(data, { 'class:w': ['advertising'] }).report).toBe(data.report);
    expect(() => html(<ReportPageView data={data} now={NOW} ui={{ answers: { 'class:w': ['advertising'] } }} />)).not.toThrow();
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

describe('scan history', () => {
  const history: JobReportResponse['history'] = [
    { jobId: 'j3', at: '2026-10-09T10:00:00Z', url: 'https://www.shop.example/', status: 'done', checks: ['consent'], quick: false, available: true },
    { jobId: 'j2', at: '2026-10-08T10:00:00Z', status: 'failed', checks: ['consent'], quick: true, available: true },
    { jobId: 'j1', at: '2026-10-07T10:00:00Z', url: 'https://shop.example/', status: 'done', checks: ['consent'], quick: false, available: true, current: true },
    { jobId: 'gone1', at: '2026-10-01T10:00:00Z', available: false },
  ];

  it('lists the site’s scans: others link to their report, this one is marked, failed and gone ones are greyed', () => {
    const out = html(<ScanHistory history={history} />);
    expect(out).toContain('4 scans of this site');
    expect(out).toContain('href="#report/j3"');
    expect(out).toContain('href="#report/j2"');
    expect(out).not.toContain('href="#report/j1"');
    expect(out).toContain('aria-current="page"');
    expect(out).not.toContain('href="#report/gone1"');
    expect(out).toMatch(/class="rp-history-item is-muted" data-status="failed"/);
    expect(out).toMatch(/class="rp-history-item is-muted" data-status="gone"/);
    expect(text(<ScanHistory history={history} />)).toContain('no longer on this service');
    expect(text(<ScanHistory history={history} />)).toContain('latest');
    expect(text(<ScanHistory history={history} />)).toContain('· www.shop.example');
    expect(text(<ScanHistory history={history} />)).not.toContain('· shop.example ');
    expect(html(<ScanHistory history={[]} />)).toBe('');
  });

  it('an earlier scan says so, links the latest, and offers no Make-list button', () => {
    const data = done({ history, newerScan: { jobId: 'j3', at: '2026-10-09T10:00:00Z' }, todo: { state: 'none', tasks: [] } });
    const out = html(<ReportPageView data={data} now={NOW} actions={{ onMakeList: () => {} }} />);
    expect(out).toContain('data-testid="earlier-scan"');
    expect(out).toContain('This is an earlier scan.');
    expect(out).toContain('href="#report/j3"');
    expect(out).not.toContain('Make my to-do list');
    expect(text(<TodoList data={data} actions={{ onMakeList: () => {} }} />)).toContain('The list is made from the latest scan');
  });

  it('the latest scan shows no earlier-scan notice', () => {
    expect(html(<ReportPageView data={done({ history })} now={NOW} />)).not.toContain('earlier-scan');
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
        tools: [{ id: 'tool:meta', partyId: 'meta', label: 'Meta Pixel', domain: 'facebook.com', purpose: 'Advertising', categories: ['advertising'], classified: true, recognized: true, classKey: 'class:meta', judge: { base: ['advertising'] }, cells: [bad, ok], cookies: [] }],
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

describe('overview and folds', () => {
  it('score: the share of scored tool checks that passed; gaps and n/a don’t count', () => {
    expect(scoreReport(finalOwner)).toEqual({ score: 50, problems: 1, decisions: 0, passed: 1, scored: 2 });
    expect(scoreReport(owner())).toMatchObject({ problems: 1, decisions: 1, passed: 0, scored: 2, score: 0 });
    expect(scoreReport(null).score).toBeUndefined();
  });
  it('severity: any ✕/⊘ is a problem; ? or a check that couldn’t run is a warning; ok only when clean', () => {
    expect(reportSeverity(finalOwner)).toBe('problem');
    const tools = [{ ...finalOwner.matrix.tools[0], cells: [ok, gap, ok] }];
    expect(reportSeverity({ matrix: { ...finalOwner.matrix, tools } })).toBe('warning');
    const clean = { matrix: { ...finalOwner.matrix, columns: finalOwner.matrix.columns.map((c) => ({ ...c, state: 'done' as const })), tools: [{ ...tools[0], cells: [ok, ok, ok] }] } };
    expect(reportSeverity(clean)).toBe('ok');
  });
  it('the overview shows the score, problems, and the change since the site’s first scan', () => {
    const out = text(<Overview data={done({ firstScan: { jobId: 'old', at: '2026-10-01T10:00:00Z', score: 20 } })} />);
    expect(out).toMatch(/50 Compliance score 1 of 2 checks passed/);
    expect(out).toMatch(/Problems 1 tool with a problem/);
    expect(out).toContain('Since the first scan +30 from 20 on');
    expect(html(<Overview data={done({ firstScan: { jobId: 'old', at: '2026-10-01T10:00:00Z', score: 20 } })} />)).toContain('href="#report/old"');
    expect(text(<Overview data={done({ firstScan: { jobId: 'job1', at: 'x', current: true } })} />)).toContain('This is the site’s first scan');
    expect(text(<Overview data={done({ firstScan: { jobId: 'old', at: 'x', score: 80 } })} />)).toContain('−30');
  });
  it('the overview sits above the law tabs', () => {
    const d = { ...running({ job: job({ laws: ['eu', 'ca'] }) }) };
    const out = html(<ReportPageView data={d} now={NOW} />);
    expect(out.indexOf('data-testid="overview"')).toBeGreaterThan(-1);
    expect(out.indexOf('data-testid="overview"')).toBeLessThan(out.indexOf('role="tablist"'));
  });
  it('a finished law’s dot is its worst finding: red for a problem, amber for a gap, green only when clean', () => {
    const final = owner({
      stage: 'final',
      matrix: {
        columns: [
          { id: 'de:do-nothing', location: 'de', scenario: 'do-nothing', label: 'Before a choice', state: 'done' },
          { id: 'us-ca:gpc', location: 'us-ca', scenario: 'gpc', label: 'Privacy signal (GPC)', state: 'not-checked' },
          { id: 'us-tx:do-nothing', location: 'us-tx', scenario: 'do-nothing', label: 'Before a choice', state: 'done' },
        ],
        tools: [{ id: 'tool:meta', partyId: 'meta', label: 'Meta Pixel', domain: 'facebook.com', purpose: 'Advertising', categories: ['advertising'], classified: true, recognized: true, classKey: 'class:meta', judge: { base: ['advertising'] }, cells: [bad, gap, ok], cookies: [] }],
        counts: { ok: 1, mismatch: 1, needsDecision: 0, pending: 0, notChecked: 1, notApplicable: 0, blocked: 0 },
      },
    });
    const laws = (['eu', 'ca', 'tx'] as const).map((id) => ({ id, progress: { id, locationId: LAWS.find((l) => l.id === id)!.locationId, region: 'x', local: false, state: 'done' as const, visitsDone: 1, visitsTotal: 1 }, report: null }));
    const data = done({ job: job({ status: 'done', laws: ['eu', 'ca', 'tx'], metrics: { ...job().metrics, laws: laws.map((l) => l.progress) } }), report: final, laws });
    const dots = [...html(<LawTabsView data={data} selected="eu" onSelect={() => {}} />).matchAll(/class="law-dot" data-state="(\w+)"(?: data-severity="(\w+)")?/g)].map((m) => m[2]);
    expect(dots).toEqual(['problem', 'warning', 'ok']);
  });
  it('the to-do list folds to a summary by default; the make-my-list prompt stays open', () => {
    const out = html(<TodoList data={done()} />);
    expect(out).toMatch(/<details class="rp-todo-fold" data-testid="todo-fold"><summary/);
    expect(text(<TodoList data={done()} />)).toMatch(/0 of 3 done .*3 tasks left/);
    const none = html(<TodoList data={done({ todo: { state: 'none', tasks: [] } })} />);
    expect(none).not.toContain('rp-todo-fold');
    expect(none).toContain('data-testid="todo-make"');
  });
});

describe('completed tasks', () => {
  it('done tasks leave the list for a folded Completed list at the bottom; open ones stay in order', () => {
    const tasks = [decision, task('a', { status: 'verified' }), task('b'), task('c', { status: 'done-unverified' }), task('d', { status: 'failed' }), task('e', { optional: true, status: 'verified' }), task('f', { optional: true })];
    const data = done({ report: responsive(), todo: { state: 'ready', tasks, fromThisRun: true } });
    const out = html(<ReportPageView data={data} now={NOW} ui={{ answers: { 'class:w': ['analytics'] } }} />);
    const completed = out.slice(out.indexOf('data-testid="todo-completed"'), out.indexOf('data-testid="final-scan"'));
    const open = out.slice(0, out.indexOf('data-testid="todo-completed"'));
    for (const id of ['a', 'c', 'e']) expect(completed).toContain(`Hold the ${id} tag`);
    expect(completed).toContain('widgets.test'); // a decision answered here counts as done
    for (const id of ['b', 'd', 'f']) expect(open).toContain(`Hold the ${id} tag`);
    for (const id of ['a', 'c', 'e']) expect(open).not.toContain(`Hold the ${id} tag`);
    expect(completed).toMatch(/<details><summary>Completed \(4\)<\/summary>/);
    expect(open).toContain('Only if they apply (1)');
    expect(html(<TodoList data={done({ todo: { state: 'ready', tasks: [task('b')], fromThisRun: true } })} />)).not.toContain('todo-completed');
  });
});


describe('Save as PDF', () => {
  it('names the file after the site and the scan day', () => {
    expect(pdfTitle('shop.example', '2026-10-07T11:58:00Z')).toBe('complykit-shop.example-2026-10-07');
    expect(pdfTitle('shop.example', undefined)).toBe('complykit-shop.example');
  });

  it('the report header carries the button; the Home link is hidden in print', () => {
    const out = renderToStaticMarkup(<ReportPageView data={done()} now={NOW} />);
    expect(out).toMatch(/<p class="eyebrow" data-print="hide"><a href="#">← Home<\/a><\/p><button type="button" class="btn btn-sm btn-secondary rp-save-pdf"[^>]*>Save as PDF<\/button>/);
  });
});
