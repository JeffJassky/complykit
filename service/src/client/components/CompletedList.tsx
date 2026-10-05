import { useEffect, useId, useRef, useState } from 'react';
import type { JobSummary } from '../../shared/api';
import { api } from '../lib/api';
import { formatAbsolute, formatDuration, formatRelative, jobDuration, plural } from '../lib/format';
import { useNow } from '../lib/useNow';
import { StatusPill, TotalsBadges } from './Badges';
import { Icon } from './Icon';

function DeleteButton({ job, onDeleted }: { job: JobSummary; onDeleted: (id: string) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!confirming) return;
    confirmRef.current?.focus();
    const t = setTimeout(() => setConfirming(false), 6000);
    return () => clearTimeout(t);
  }, [confirming]);

  if (!confirming) {
    return (
      <button ref={triggerRef} type="button" className="btn btn-icon btn-ghost" aria-label={`Delete report for ${job.host}`} title="Delete" onClick={() => setConfirming(true)}>
        <Icon name="trash" />
      </button>
    );
  }
  return (
    <span className="confirm" role="group" aria-label={`Confirm delete of ${job.host}`}>
      <button
        ref={confirmRef}
        type="button"
        className="btn btn-danger btn-sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api.remove(job.id);
            onDeleted(job.id);
          } catch {
            setBusy(false);
            setConfirming(false);
          }
        }}
      >
        {busy ? 'Deleting…' : 'Delete'}
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => {
          setConfirming(false);
          requestAnimationFrame(() => triggerRef.current?.focus());
        }}
      >
        Keep
      </button>
    </span>
  );
}

function LogDisclosure({ job }: { job: JobSummary }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || log) return;
    let live = true;
    api
      .job(job.id)
      .then((d) => live && setLog(d.log))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [open, log, job.id]);

  return (
    <div className="log">
      <button type="button" className="disclosure" aria-expanded={open} aria-controls={`${id}-log`} onClick={() => setOpen((o) => !o)}>
        <Icon name="chevron" size={14} />
        {open ? 'Hide log' : 'Show log'}
      </button>
      {open ? (
        <div id={`${id}-log`}>
          {error ? (
            <p className="form-note error">Couldn’t load the log: {error}</p>
          ) : log ? (
            <pre className="log-pre" tabIndex={0} aria-label={`Log for ${job.host}`}>
              {log.length ? log.join('\n') : '(empty log)'}
            </pre>
          ) : (
            <p className="muted small">Loading…</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ReportRow({ job, now, onDeleted }: { job: JobSummary; now: number; onDeleted: (id: string) => void }) {
  const consent = job.result?.consent;
  const a11y = job.result?.accessibility;
  const finished = job.finishedAt ?? job.createdAt;
  const hasActions = !!(consent || a11y || job.result?.downloadUrl);
  const checks = [job.checks.includes('consent') ? 'Privacy' : null, job.checks.includes('accessibility') ? 'Accessibility' : null].filter(Boolean).join(' + ');
  return (
    <li className={`report report-${job.status}`}>
      <div className="report-main">
        <div className="report-id">
          <h3 className="report-host">
            {job.host}
            {job.status !== 'done' ? <StatusPill status={job.status} /> : null}
          </h3>
          <p className="report-meta">
            <time dateTime={finished} title={formatAbsolute(finished)}>
              {formatRelative(finished, now)}
            </time>
            {job.startedAt ? <span>{formatDuration(jobDuration(job, now))}</span> : null}
            <span>
              {checks}
              {job.quick ? ' · quick' : ''}
            </span>
          </p>
        </div>
        {consent ? <TotalsBadges totals={consent.totals} /> : null}
        {!hasActions ? <DeleteButton job={job} onDeleted={onDeleted} /> : null}
      </div>

      {job.status === 'failed' ? (
        <div className="report-error">
          <p className="error-text">
            <Icon name="alert" size={15} />
            <span>{job.error ?? 'The check failed without an error message.'}</span>
          </p>
          <LogDisclosure job={job} />
        </div>
      ) : null}
      {job.status === 'cancelled' ? <p className="muted small">Cancelled before it finished — no report.</p> : null}

      {hasActions ? (
        <div className="report-actions">
          {consent ? (
            <a className="btn btn-primary btn-sm" href={consent.reportUrl} target="_blank" rel="noopener">
              Open privacy report
              <Icon name="external" size={14} />
              <span className="visually-hidden"> for {job.host} (opens in a new tab)</span>
            </a>
          ) : null}
          {a11y ? (
            <a className={`btn ${consent ? 'btn-secondary' : 'btn-primary'} btn-sm`} href={a11y.reportUrl} target="_blank" rel="noopener">
              Open accessibility report
              <Icon name="external" size={14} />
              <span className="visually-hidden"> for {job.host} (opens in a new tab)</span>
            </a>
          ) : null}
          {job.result?.downloadUrl ? (
            <a className="btn btn-ghost btn-sm" href={job.result.downloadUrl} download>
              <Icon name="download" size={14} />
              Download files
              <span className="visually-hidden"> for {job.host}</span>
            </a>
          ) : null}
          <span className="spacer" />
          {consent || a11y?.findings !== undefined ? (
            <span className="report-facts">
              {consent ? <span>{plural(consent.parties, 'outside tool', 'outside tools')}</span> : null}
              {consent?.unrecognized ? <span className="unrec">{consent.unrecognized} to identify</span> : null}
              {a11y?.findings !== undefined ? <span>{plural(a11y.findings, 'accessibility finding')}</span> : null}
            </span>
          ) : null}
          <DeleteButton job={job} onDeleted={onDeleted} />
        </div>
      ) : null}
    </li>
  );
}

export function CompletedList({ jobs, onDeleted }: { jobs: JobSummary[]; onDeleted: (id: string) => void }) {
  const [filter, setFilter] = useState('');
  const now = useNow(30_000);
  const q = filter.trim().toLowerCase();
  const sorted = [...jobs].sort((a, b) => (b.finishedAt ?? b.createdAt).localeCompare(a.finishedAt ?? a.createdAt));
  const shown = q ? sorted.filter((j) => j.host.toLowerCase().includes(q) || j.url.toLowerCase().includes(q)) : sorted;

  return (
    <section className="section" aria-labelledby="reports-title">
      <div className="section-head">
        <h2 id="reports-title" className="section-title">
          Your reports
          {jobs.length ? <span className="section-count">{jobs.length}</span> : null}
        </h2>
        {jobs.length > 3 ? (
          <label className="filter">
            <Icon name="search" size={14} />
            <span className="visually-hidden">Filter reports by site</span>
            <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by site" />
          </label>
        ) : null}
      </div>
      <p className="section-description">Open a report to see what was found, answer research questions, and track your next steps.</p>
      {jobs.length > 0 ? <details className="report-key"><summary>What do these counts mean?</summary><p>Problems are observations flagged for correction. Review and research items need more information. Legal review identifies potential legal exposure, not a proven violation. These are scan findings, not a compliance score.</p></details> : null}
      {jobs.length === 0 ? (
        <div className="empty">
          <p className="empty-title">No reports yet</p>
          <p className="empty-text">Start a scan above. Your report will appear here with clear explanations and a checklist.</p>
        </div>
      ) : shown.length === 0 ? (
        <div className="empty">
          <p className="empty-text">No reports match “{filter}”.</p>
        </div>
      ) : (
        <ul className="report-list">
          {shown.map((j) => (
            <ReportRow key={j.id} job={j} now={now} onDeleted={onDeleted} />
          ))}
        </ul>
      )}
    </section>
  );
}
