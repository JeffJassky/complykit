import { useId, useMemo, useState, type FormEvent } from 'react';
import { parseUrlList, type JobSummary, type SiteSummary } from '../../shared/api';
import { api } from '../lib/api';
import { formatRelative } from '../lib/format';
import { reportHref } from '../lib/useHashView';
import { readStoredLaws, scanBlockedReason, scanRequestOf, writeStoredLaws, type ScanRequest } from '../lib/laws';
import type { LawId } from '../../shared/laws';
import { AuthorizedBox, LawPicker } from './Laws';

// The home page (plans/simple-report.md): a URL and a Scan button (checks and
// scan options tucked behind "Options"), then your sites with their latest
// status, each linking to its report page. Starting a scan opens its report.

export interface SiteRow {
  host: string;
  job: JobSummary;
  /** To-do progress from the site's workspace, when its list exists. */
  checklist?: SiteSummary['checklist'];
}

/** One row per site (host): its newest job, with the workspace's to-do progress. Newest first. */
export function siteRows(jobs: JobSummary[], sites: SiteSummary[] = []): SiteRow[] {
  const latest = new Map<string, JobSummary>();
  for (const j of jobs) {
    const prev = latest.get(j.host);
    if (!prev || j.createdAt > prev.createdAt) latest.set(j.host, j);
  }
  return [...latest.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((job) => {
      const site = sites.find((s) => job.host === s.domain || job.host.endsWith('.' + s.domain));
      return { host: job.host, job, ...(site?.checklist ? { checklist: site.checklist } : {}) };
    });
}

/** The latest status of a site, in a few words. */
export function siteStatus(row: SiteRow, now: number): { text: string; tone: 'running' | 'done' | 'failed' | 'queued' } {
  const j = row.job;
  if (j.status === 'queued') return { text: 'Waiting to start', tone: 'queued' };
  if (j.status === 'running') return { text: `Scanning… ${Math.round(Math.max(0, Math.min(1, j.progress.fraction)) * 100)}%`, tone: 'running' };
  if (j.status === 'failed') return { text: 'Scan didn’t finish', tone: 'failed' };
  if (j.status === 'cancelled') return { text: 'Scan cancelled', tone: 'failed' };
  const when = formatRelative(j.finishedAt, now);
  const c = row.checklist;
  if (c && c.required) return { text: c.verified >= c.required ? `All ${c.required} to-dos done · scanned ${when}` : `${c.verified} of ${c.required} to-dos done · scanned ${when}`, tone: 'done' };
  return { text: `Scanned ${when}`, tone: 'done' };
}

export function HomeView({ rows, now, loaded, onSubmit, busy, error }: { rows: SiteRow[]; now: number; loaded: boolean; onSubmit: (req: ScanRequest) => void; busy?: boolean; error?: string | null }) {
  const id = useId();
  const [url, setUrl] = useState('');
  const [consent, setConsent] = useState(true);
  const [a11y, setA11y] = useState(false);
  const [quick, setQuick] = useState(false);
  const [slowRepeat, setSlowRepeat] = useState(false);
  const [laws, setLaws] = useState<LawId[]>(readStoredLaws);
  // Not remembered: unchecked on every load.
  const [authorized, setAuthorized] = useState(false);
  const valid = useMemo(() => parseUrlList(url).urls.length > 0, [url]);
  const blocked = scanBlockedReason({ consent, accessibility: a11y, laws, authorized });
  const changeLaws = (next: LawId[]) => {
    setLaws(next);
    writeStoredLaws(next);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid || busy || blocked) return;
    onSubmit(scanRequestOf({ url, consent, accessibility: a11y, quick, slowRepeat, laws, authorized }));
  };
  return (
    <div className="home">
      <form className="home-form" onSubmit={submit} aria-labelledby={`${id}-title`}>
        <h1 id={`${id}-title`} className="rp-h1">
          Check a website
        </h1>
        <div className="home-row">
          <label htmlFor={`${id}-url`} className="visually-hidden">
            Website address
          </label>
          <input id={`${id}-url`} className="home-url" type="text" inputMode="url" placeholder="example.com" value={url} onChange={(e) => setUrl(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          <button type="submit" className="btn btn-primary btn-lg" disabled={!valid || busy || blocked !== null}>
            {busy ? 'Starting…' : 'Scan'}
          </button>
        </div>
        <details className="home-options">
          <summary>Options</summary>
          <label className="home-option">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> Visitor privacy (cookies and consent)
          </label>
          <label className="home-option">
            <input type="checkbox" checked={a11y} onChange={(e) => setA11y(e.target.checked)} /> Accessibility (up to 15 pages)
          </label>
          <label className="home-option">
            <input type="checkbox" checked={quick} disabled={!consent} onChange={(e) => setQuick(e.target.checked)} /> Quick scan (shorter visits, fewer choices)
          </label>
          <label className="home-option">
            <input type="checkbox" checked={slowRepeat && consent && !quick} disabled={!consent || quick} onChange={(e) => setSlowRepeat(e.target.checked)} /> Also repeat on a slow connection (about 3× longer)
          </label>
          <LawPicker selected={laws} onChange={changeLaws} disabled={!consent} />
        </details>
        {consent ? <AuthorizedBox checked={authorized} onChange={setAuthorized} /> : null}
        {blocked ? (
          <p className="hint" data-testid="scan-blocked">
            {blocked}
          </p>
        ) : null}
        {error ? (
          <p className="rp-error" role="alert">
            Couldn’t start the scan: {error}
          </p>
        ) : null}
      </form>
      <section className="home-sites" aria-labelledby={`${id}-sites`}>
        <h2 id={`${id}-sites`} className="rp-h2">
          Your sites
        </h2>
        {!loaded ? (
          <p className="muted">Loading…</p>
        ) : rows.length ? (
          <ul className="home-list">
            {rows.map((r) => {
              const st = siteStatus(r, now);
              return (
                <li key={r.host}>
                  <a href={reportHref(r.job.id)} className="home-site" data-status={r.job.status}>
                    <strong>{r.host}</strong>
                    <span className={`home-status home-status-${st.tone}`}>
                      {st.tone === 'running' ? <span className="rp-spinner rp-spinner-sm" aria-hidden="true" /> : null}
                      {st.text}
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted">No sites yet. Enter an address above to scan your first one.</p>
        )}
      </section>
    </div>
  );
}

export function Home({ jobs, sites, loaded, now }: { jobs: JobSummary[]; sites: SiteSummary[]; loaded: boolean; now: number }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rows = useMemo(() => siteRows(jobs, sites), [jobs, sites]);
  const onSubmit = async (req: ScanRequest) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.createBatch({ urls: req.url, checks: { consent: req.consent, accessibility: req.accessibility }, quick: req.quick, slowRepeat: req.slowRepeat, ...(req.laws ? { laws: req.laws, authorized: req.authorized } : {}) });
      const first = res.jobs[0];
      if (first) window.location.hash = reportHref(first.id);
      else setError(res.rejected.length ? `not a website address: ${res.rejected.join(', ')}` : 'nothing to scan');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return <HomeView rows={rows} now={now} loaded={loaded} onSubmit={onSubmit} busy={busy} error={error} />;
}
