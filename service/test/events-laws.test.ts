import { describe, expect, it } from 'vitest';
import type { JobDetail, LawScanProgress } from '../src/shared/api.js';
import { LAWS } from '../src/shared/laws.js';
import { ConsentProgress } from '../src/server/events.js';

// plans/per-law-report-contract.md, PR B1: ConsentProgress keeps one entry per law in
// job.metrics.laws, moved by the collectors' events (by location) and by the runner
// (setLaw) for what events cannot say: a worker starting, a law failing.

const at = '2026-10-08T00:00:00Z';
const newJob = () =>
  ({
    id: 'job1abc',
    progress: { fraction: 0, done: 0, total: 0, phase: 'queued' },
    metrics: { requests: 0, thirdPartyRequests: 0, parties: 0, cookies: 0, scenarios: [] },
  }) as unknown as JobDetail;
const three = LAWS.filter((l) => ['eu', 'ca', 'tx'].includes(l.id));
const law = (job: JobDetail, id: string): LawScanProgress => job.metrics.laws!.find((l) => l.id === id)!;

describe('ConsentProgress: per-law state', () => {
  it('starts with one waiting entry per law, in catalog order', () => {
    const job = newJob();
    new ConsentProgress(job, 0, three);
    expect(job.metrics.laws).toEqual([
      { id: 'eu', locationId: 'de', region: 'fra', local: false, state: 'waiting', visitsDone: 0, visitsTotal: 0 },
      { id: 'ca', locationId: 'us-ca', region: 'lax', local: true, state: 'waiting', visitsDone: 0, visitsTotal: 0 },
      { id: 'tx', locationId: 'us-tx', region: 'dfw', local: false, state: 'waiting', visitsDone: 0, visitsTotal: 0 },
    ]);
  });

  it('follows one location through its events; other laws are untouched', () => {
    const job = newJob();
    const m = new ConsentProgress(job, 0, three);
    expect(m.setLaw('eu', { state: 'starting' })).toBe(true);
    expect(law(job, 'eu').state).toBe('starting');

    m.apply({ at, type: 'start', runId: 'r', url: 'https://x/', locations: ['de'] });
    expect(law(job, 'eu').state).toBe('verifying');

    m.apply({ at, type: 'location', location: 'de', verdict: 'verified', observed: 'DE', scenarios: ['do-nothing', 'reject', 'accept'], runs: 1 });
    expect(law(job, 'eu')).toMatchObject({ state: 'scanning', verdict: 'verified', observed: 'DE', visitsTotal: 3, visitsDone: 0 });

    m.apply({ at, type: 'scenario-start', location: 'de', scenario: 'do-nothing' });
    expect(law(job, 'eu').current).toEqual({ scenario: 'do-nothing' });

    m.apply({ at, type: 'scenario-done', location: 'de', scenario: 'do-nothing', status: 'tested', requests: 3, thirdPartyRequests: 1, parties: 1, cookies: 1, durationMs: 10, banner: 'onetrust' });
    expect(law(job, 'eu')).toMatchObject({ visitsDone: 1, banner: 'onetrust' });
    expect(law(job, 'eu').current).toBeUndefined();

    m.apply({ at, type: 'scenario-start', location: 'de', scenario: 'reject', run: 2 });
    expect(law(job, 'eu').current).toEqual({ scenario: 'reject', run: 2 });

    m.apply({ at, type: 'collected', runId: 'r', runDir: '/x', locations: ['de'] });
    expect(law(job, 'eu').state).toBe('collected');

    expect(law(job, 'ca')).toMatchObject({ state: 'waiting', visitsDone: 0, visitsTotal: 0 });
    expect(law(job, 'tx')).toMatchObject({ state: 'waiting', visitsDone: 0, visitsTotal: 0 });
  });

  it('runs × scenarios make the total', () => {
    const job = newJob();
    const m = new ConsentProgress(job, 0, three);
    m.apply({ at, type: 'location', location: 'us-ca', verdict: 'verified', scenarios: ['a', 'b'], runs: 2 });
    expect(law(job, 'ca').visitsTotal).toBe(4);
  });

  it('a location without scenarios is a failed law, saying its verdict and note', () => {
    const job = newJob();
    const m = new ConsentProgress(job, 0, three);
    m.apply({ at, type: 'location', location: 'us-tx', verdict: 'mismatch', observed: 'US-OK', scenarios: [], note: 'expected TX, exit is in OK' });
    expect(law(job, 'tx')).toMatchObject({ state: 'failed', error: 'mismatch — expected TX, exit is in OK', verdict: 'mismatch' });
    m.apply({ at, type: 'location', location: 'de', verdict: 'unknown', scenarios: [] });
    expect(law(job, 'eu')).toMatchObject({ state: 'failed', error: 'unknown' });
  });

  it('failed is terminal: later events do not revive it; setLaw reports no change when nothing changed', () => {
    const job = newJob();
    const m = new ConsentProgress(job, 0, three);
    m.setLaw('eu', { state: 'failed', error: 'worker in fra failed: boom' });
    m.apply({ at, type: 'location', location: 'de', verdict: 'verified', scenarios: ['a'] });
    m.apply({ at, type: 'scenario-done', location: 'de', scenario: 'a', status: 'tested', requests: 0, thirdPartyRequests: 0, parties: 0, cookies: 0, durationMs: 1 });
    m.apply({ at, type: 'collected', runId: 'r', runDir: '/x', locations: ['de'] });
    expect(law(job, 'eu')).toMatchObject({ state: 'failed', error: 'worker in fra failed: boom' });
    expect(m.setLaw('eu', { state: 'failed', error: 'worker in fra failed: boom' })).toBe(false);
    expect(m.setLaw('eu', { state: 'starting' })).toBe(false);
  });

  it('the merge’s done finishes every collected law; failed and never-collected stay as they are', () => {
    const job = newJob();
    const m = new ConsentProgress(job, 0, three);
    m.apply({ at, type: 'collected', runId: 'r', runDir: '/x', locations: ['de'] });
    m.apply({ at, type: 'collected', runId: 'r', runDir: '/y', locations: ['us-ca'] });
    m.setLaw('tx', { state: 'failed', error: 'x' });
    m.apply({ at, type: 'done', runId: 'm', runDir: '/m', report: '/m/r.html', findings: 0, totals: { violation: 0, 'needs-review': 0, exposure: 0, practice: 0 }, parties: 0, unrecognized: 0 });
    expect(job.metrics.laws!.map((l) => [l.id, l.state])).toEqual([['eu', 'done'], ['ca', 'done'], ['tx', 'failed']]);
  });

  it('events for a location no law covers leave laws alone; the job-wide counters still move', () => {
    const job = newJob();
    const m = new ConsentProgress(job, 0, three);
    m.apply({ at, type: 'location', location: 'local', verdict: 'verified', scenarios: ['a'] });
    expect(job.metrics.laws!.every((l) => l.state === 'waiting')).toBe(true);
    expect(job.progress.total).toBe(1);
  });

  it('a job without laws has no metrics.laws, and setLaw is a no-op', () => {
    const job = newJob();
    const m = new ConsentProgress(job, 0);
    m.apply({ at, type: 'start', runId: 'r', url: 'https://x/', locations: ['local'] });
    expect(job.metrics.laws).toBeUndefined();
    expect(m.setLaw('eu', { state: 'starting' })).toBe(false);
    expect(job.metrics.laws).toBeUndefined();
  });
});
