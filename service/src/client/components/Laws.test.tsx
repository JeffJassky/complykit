import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobSummary, LawScanProgress, OwnerReport } from '../../shared/api';
import { DEFAULT_LAWS, LAWS } from '../../shared/laws';
import { LAWS_STORAGE_KEY, lawRows, orderLaws, readStoredLaws, scanBlockedReason, scanRequestOf, writeStoredLaws } from '../lib/laws';
import { HomeView } from './Home';
import { JobLaws, LawProgress, RescanButton } from './Laws';
import { RescanPanel } from './Sites';

const store = (getItem: (k: string) => string | null, setItem: (k: string, v: string) => void = () => {}) => vi.stubGlobal('window', { localStorage: { getItem, setItem } });
afterEach(() => vi.unstubAllGlobals());

const home = () => renderToStaticMarkup(<HomeView rows={[]} now={0} loaded onSubmit={() => {}} />);
const lawBox = (html: string, id: string) => html.match(new RegExp(`<input type="checkbox"[^>]*data-law="${id}"[^>]*/>`))?.[0] ?? '';
const submitBtn = (html: string) => html.match(/<button type="submit"[^>]*>/)?.[0] ?? '';

describe('new-scan form: authorization', () => {
  it('sits directly under the address field, before the scan options', () => {
    const html = home();
    const url = html.indexOf('class="home-url"');
    const box = html.indexOf('data-testid="authorized"');
    const options = html.indexOf('class="home-options"');
    expect(url).toBeGreaterThan(-1);
    expect(box).toBeGreaterThan(url);
    expect(box).toBeLessThan(options);
  });
});

describe('new-scan form: laws', () => {
  it('shows one checkbox per law, all checked by default, with label, model and law names', () => {
    const html = home();
    for (const l of LAWS) {
      expect(lawBox(html, l.id)).toContain('checked=""');
      expect(html).toContain(`<strong>${l.label}</strong>`);
      expect(html).toContain(l.model);
      expect(html).toContain(l.laws);
    }
    expect(html).toContain('Scan under these laws');
  });

  it('restores the remembered selection; ignores unknown ids; junk falls back to every law', () => {
    store((k) => (k === LAWS_STORAGE_KEY ? JSON.stringify(['uk', 'bogus', 'eu']) : null));
    const html = home();
    expect(lawBox(html, 'eu')).toContain('checked=""');
    expect(lawBox(html, 'uk')).toContain('checked=""');
    expect(lawBox(html, 'ca')).not.toContain('checked=""');
    expect(lawBox(html, 'tx')).not.toContain('checked=""');
    store(() => '{not json');
    expect(readStoredLaws()).toEqual([...DEFAULT_LAWS]);
    store(() => JSON.stringify(['nope']));
    expect(readStoredLaws()).toEqual([...DEFAULT_LAWS]);
  });

  it('localStorage throwing does not break rendering or saving', () => {
    store(
      () => {
        throw new Error('blocked');
      },
      () => {
        throw new Error('blocked');
      },
    );
    expect(lawBox(home(), 'eu')).toContain('checked=""');
    expect(() => writeStoredLaws(['eu'])).not.toThrow();
    vi.stubGlobal('window', {});
    expect(readStoredLaws()).toEqual([...DEFAULT_LAWS]);
  });

  it('saves under complykit.laws', () => {
    const set = vi.fn();
    store(() => null, set);
    writeStoredLaws(['uk', 'eu'] as never);
    expect(set).toHaveBeenCalledWith('complykit.laws', JSON.stringify(['uk', 'eu']));
  });

  it('the authorization box starts unchecked and submit is disabled until it is; the hint says why', () => {
    store(() => JSON.stringify(['eu']));
    const html = home();
    expect(html).toContain('I am authorized to scan this site');
    expect(html.match(/<input[^>]*data-testid="authorized"[^>]*>/)?.[0]).not.toContain('checked=""');
    expect(submitBtn(html)).toContain('disabled=""');
    expect(html).toContain('Confirm you are authorized to scan this site.');
  });

  it('blocking reasons: not authorized, no law, no check; accessibility alone needs neither', () => {
    const ok = { consent: true, accessibility: false, laws: ['eu'] as const, authorized: true };
    expect(scanBlockedReason(ok)).toBeNull();
    expect(scanBlockedReason({ ...ok, authorized: false })).toMatch(/authorized/);
    expect(scanBlockedReason({ ...ok, laws: [] })).toMatch(/at least one law/);
    expect(scanBlockedReason({ ...ok, consent: false })).toMatch(/at least one check/);
    expect(scanBlockedReason({ consent: false, accessibility: true, laws: [], authorized: false })).toBeNull();
  });

  it('the payload carries laws in LAWS order and authorized: true', () => {
    const req = scanRequestOf({ url: 'a.test', consent: true, accessibility: false, quick: false, slowRepeat: false, laws: ['tx', 'eu', 'ca'], authorized: true });
    expect(req.laws).toEqual(['eu', 'ca', 'tx']);
    expect(req.authorized).toBe(true);
    expect(orderLaws(['us', 'uk'])).toEqual(['uk', 'us']);
  });

  it('consent off: the law boxes are disabled, and the request omits laws and authorized', () => {
    const req = scanRequestOf({ url: 'a.test', consent: false, accessibility: true, quick: false, slowRepeat: true, laws: ['eu'], authorized: true });
    expect(req).not.toHaveProperty('laws');
    expect(req).not.toHaveProperty('authorized');
    expect(req.slowRepeat).toBe(false);
  });
});

const job = (over: Partial<JobSummary> = {}) => ({ id: 'j', laws: ['eu', 'ca'], ...over }) as JobSummary;
const report = (columns: Array<{ location: string; state: string }>) => ({ matrix: { columns } }) as unknown as OwnerReport;

describe('per-law progress and job detail', () => {
  it('one row per law with live state from the report’s columns; missing data reads as waiting', () => {
    expect(lawRows(job(), null).map((r) => [r.label, r.state])).toEqual([['EU law', 'waiting'], ['California law', 'waiting']]);
    const rows = lawRows(job(), report([{ location: 'de', state: 'done' }, { location: 'de', state: 'running' }, { location: 'us-ca', state: 'done' }, { location: 'us-ca', state: 'not-checked' }]));
    expect(rows.map((r) => [r.state, r.text])).toEqual([['scanning', 'Scanning (1 of 2)'], ['done', 'Done']]);
    expect(lawRows({}, null)).toEqual([]);
    expect(renderToStaticMarkup(<LawProgress job={{ id: 'x' } as JobSummary} />)).toBe('');
    expect(renderToStaticMarkup(<LawProgress job={job()} />)).toContain('EU law');
  });

  it('shows the job’s laws and when the submitter authorized it', () => {
    const html = renderToStaticMarkup(<JobLaws job={{ laws: ['eu', 'tx'], authorizedAt: '2026-10-08T12:00:00Z' }} />);
    expect(html).toContain('Scanned under: EU law, Texas law.');
    expect(html).toContain('Authorized by submitter at');
    expect(renderToStaticMarkup(<JobLaws job={{}} />)).toBe('');
  });
});

describe('rescan authorization', () => {
  it('a job with laws asks for authorization and disables the button until given', () => {
    const html = renderToStaticMarkup(<RescanButton className="btn" laws={['eu']} onRescan={() => {}}>Go</RescanButton>);
    expect(html).toContain('I am authorized to scan this site');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Go</);
    const plain = renderToStaticMarkup(<RescanButton className="btn" onRescan={() => {}}>Go</RescanButton>);
    expect(plain).not.toContain('authorized');
    expect(plain).not.toMatch(/<button[^>]*disabled/);
  });

  it('the checklist rescan starts from the latest job’s laws, with the picker and authorization', () => {
    const html = renderToStaticMarkup(<RescanPanel canRescan remaining={0} defaultLaws={['uk', 'tx']} onRescan={() => {}} />);
    expect(lawBox(html, 'uk')).toContain('checked=""');
    expect(lawBox(html, 'eu')).not.toContain('checked=""');
    expect(html).toContain('I am authorized to scan this site');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Rescan site</);
    expect(renderToStaticMarkup(<RescanPanel canRescan remaining={0} />)).toContain('this service’s own connection');
  });
});

// plans/per-law-report-contract.md, PR C1: the chips read job.metrics.laws when the job has it.
describe('per-law chips from metrics.laws', () => {
  const entry = (id: LawScanProgress['id'], over: Partial<LawScanProgress> = {}): LawScanProgress => {
    const l = LAWS.find((x) => x.id === id)!;
    return { id, locationId: l.locationId, region: l.flyRegion, local: !!l.local, state: 'waiting', visitsDone: 0, visitsTotal: 0, ...over };
  };
  const withLaws = (laws: LawScanProgress[], phase: JobSummary['progress']['phase'] = 'scenarios') =>
    ({ id: 'j', laws: laws.map((l) => l.id), progress: { fraction: 0, done: 0, total: 0, phase }, metrics: { requests: 0, thirdPartyRequests: 0, parties: 0, cookies: 0, scenarios: [], laws } }) as unknown as JobSummary;

  it('one text per state; remote start names the city, local does not', () => {
    const rows = lawRows(
      withLaws([
        entry('eu', { state: 'starting' }),
        entry('uk', { state: 'verifying' }),
        entry('ca', { state: 'starting' }),
        entry('tx', { state: 'scanning', visitsDone: 2, visitsTotal: 5 }),
        entry('us', { state: 'scanning' }),
      ]),
      null,
    );
    expect(rows.map((r) => [r.id, r.state, r.text])).toEqual([
      ['eu', 'starting', 'Starting the worker in Frankfurt'],
      ['uk', 'verifying', 'Checking the location'],
      ['ca', 'starting', 'Starting'],
      ['tx', 'scanning', 'Scanning 2 of 5'],
      ['us', 'scanning', 'Scanning'],
    ]);
    expect(rows.map((r) => r.region)).toEqual(['Frankfurt', 'London', 'Los Angeles', 'Dallas', 'Chicago']);
  });

  it('waiting, collected (then preparing findings while the merge runs), done, failed with its reason', () => {
    const laws = [entry('eu'), entry('uk', { state: 'collected' }), entry('ca', { state: 'done' }), entry('tx', { state: 'failed', error: 'worker in dfw failed: boom' })];
    expect(lawRows(withLaws(laws), null).map((r) => r.text)).toEqual(['Waiting', 'Collected', 'Done', 'Failed']);
    expect(lawRows(withLaws(laws, 'analyzing'), null)[1].text).toBe('Preparing findings');
    expect(lawRows(withLaws(laws), null)[3].error).toBe('worker in dfw failed: boom');
  });

  it('the failed chip carries its reason as a tooltip and its state as data', () => {
    const html = renderToStaticMarkup(<LawProgress job={withLaws([entry('eu', { state: 'failed', error: 'worker in fra failed: x' })])} />);
    expect(html).toMatch(/<li[^>]*data-state="failed"[^>]*title="worker in fra failed: x"|<li[^>]*title="worker in fra failed: x"[^>]*data-state="failed"/);
  });

  it('jobs without metrics.laws keep the column-derived rows', () => {
    const rows = lawRows(job(), report([{ location: 'de', state: 'done' }, { location: 'de', state: 'running' }]));
    expect(rows.map((r) => [r.state, r.text])).toEqual([['scanning', 'Scanning (1 of 2)'], ['waiting', 'Waiting']]);
  });
});
