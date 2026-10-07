import { useState, type ReactNode } from 'react';
import type { JobSummary } from '../../shared/api';
import { api } from '../lib/api';
import { PHASE_LABEL, formatClock, jobDuration } from '../lib/format';
import { useNow } from '../lib/useNow';
import { StatusPill } from './Badges';
import { Icon } from './Icon';
import { ScenarioStrip } from './ScenarioStrip';

function CheckTags({ job }: { job: JobSummary }) {
  return (
    <span className="tags">
      {job.checks.includes('consent') ? <span className="tag">Consent</span> : null}
      {job.checks.includes('accessibility') ? <span className="tag">WCAG</span> : null}
      {job.quick ? <span className="tag tag-quick">Quick</span> : null}
      {job.slowRepeat ? (
        <span className="tag tag-slow" title="Every visitor choice is repeated on a slow connection">
          Slow repeat
        </span>
      ) : null}
    </span>
  );
}

function CancelButton({ job, onUpdated }: { job: JobSummary; onUpdated: (j: JobSummary) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      disabled={busy}
      aria-label={`Cancel check of ${job.host}`}
      onClick={async () => {
        setBusy(true);
        try {
          onUpdated(await api.cancel(job.id));
        } catch {
          setBusy(false);
        }
      }}
    >
      <Icon name="stop" size={14} />
      {busy ? 'Cancelling…' : 'Cancel'}
    </button>
  );
}

function Metric({ label, value, sub, hint }: { label: string; value: ReactNode; sub?: ReactNode; hint?: string }) {
  return (
    <div className="metric" title={hint}>
      <dt>{label}</dt>
      <dd>
        {value}
        {sub ? <span className="metric-sub">{sub}</span> : null}
      </dd>
    </div>
  );
}

function RunningCard({ job, now, onUpdated }: { job: JobSummary; now: number; onUpdated: (j: JobSummary) => void }) {
  const { progress: p, metrics: m } = job;
  const pct = Math.round(Math.max(0, Math.min(1, p.fraction)) * 100);
  const a11yUnit = job.checks.includes('accessibility') ? 1 : 0;
  const pending = p.total > 0 && (p.phase === 'scenarios' || p.phase === 'verifying-location') ? Math.max(0, p.total - a11yUnit - m.scenarios.length) : 0;
  const loc = m.location;
  const third = m.requests > 0 ? Math.round((m.thirdPartyRequests / m.requests) * 100) : 0;
  return (
    <li className="card job running">
      <div className="job-head">
        <div className="job-id">
          <h3 className="job-host">{job.host}</h3>
          <a className="job-url" href={job.url} target="_blank" rel="noreferrer noopener">
            {job.url}
          </a>
        </div>
        <div className="job-side">
          <StatusPill status={job.status} />
          <span className="clock mono" title="Elapsed">
            {formatClock(jobDuration(job, now))}
          </span>
        </div>
      </div>

      <div className="progress-wrap">
        <div className="progress-meta">
          <span className="phase">{PHASE_LABEL[p.phase]}</span>
          {p.current ? <span className="current mono">{p.current}</span> : null}
          <span className="pct mono">{pct}%</span>
        </div>
        <div className="progress" role="progressbar" aria-label={`${job.host} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={`${pct}% — ${PHASE_LABEL[p.phase]}`}>
          <div className="progress-fill" style={{ width: `${Math.max(pct, 2)}%` }} />
        </div>
        {p.total > 0 ? (
          <p className="progress-sub">
            {p.done} of {p.total} {p.total === 1 ? 'step' : 'steps'}
          </p>
        ) : null}
      </div>

      <details className="scan-details"><summary>Live scan details</summary><dl className="metrics">
        <Metric label="Requests" value={m.requests.toLocaleString()} />
        <Metric label="Third-party" value={m.thirdPartyRequests.toLocaleString()} sub={m.requests ? `${third}%` : undefined} />
        <Metric label="Parties" value={m.parties} hint="Outside parties seen (max in one scenario)" />
        <Metric label="Cookies" value={m.cookies} hint="Max set in one scenario" />
        <Metric label="Consent banner" value={m.banner ?? <span className="muted">{p.done > 0 ? 'no banner' : '—'}</span>} />
        <Metric
          label="Location"
          value={
            loc ? (
              <span className={`verdict verdict-${loc.verdict === 'verified' ? 'ok' : 'warn'}`}>
                {loc.verdict}
                {loc.observed ? <span className="mono"> · {loc.observed}</span> : null}
              </span>
            ) : (
              <span className="muted">checking…</span>
            )
          }
        />
      </dl>

      <ScenarioStrip scenarios={m.scenarios} planned={m.planned} pending={pending} /></details>

      <div className="job-foot">
        <CheckTags job={job} />
        <CancelButton job={job} onUpdated={onUpdated} />
      </div>
    </li>
  );
}

function QueuedCard({ job, position, onUpdated }: { job: JobSummary; position: number; onUpdated: (j: JobSummary) => void }) {
  return (
    <li className="card job queued">
      <div className="job-head">
        <div className="job-id">
          <h3 className="job-host">{job.host}</h3>
          <span className="job-url-text">{job.url}</span>
        </div>
        <div className="job-side">
          <span className="queue-pos">#{position} in queue</span>
          <StatusPill status={job.status} />
        </div>
      </div>
      <div className="job-foot">
        <CheckTags job={job} />
        <CancelButton job={job} onUpdated={onUpdated} />
      </div>
    </li>
  );
}

export function ActiveJobs({ jobs, onUpdated }: { jobs: JobSummary[]; onUpdated: (j: JobSummary) => void }) {
  const running = jobs.filter((j) => j.status === 'running').sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
  const queued = jobs.filter((j) => j.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const now = useNow(1000, running.length > 0);

  return (
    <section className="section" aria-labelledby="active-title">
      <div className="section-head">
        <h2 id="active-title" className="section-title">
          Scanning now
          {jobs.length ? <span className="section-count">{jobs.length}</span> : null}
        </h2>
      </div>
      {jobs.length === 0 ? (
        <div className="empty">
          <p className="empty-title">Nothing running</p>
          <p className="empty-text">Paste a few sites and run a check — progress shows up here live.</p>
        </div>
      ) : (
        <ul className="job-list">
          {running.map((j) => (
            <RunningCard key={j.id} job={j} now={now} onUpdated={onUpdated} />
          ))}
          {queued.map((j, i) => (
            <QueuedCard key={j.id} job={j} position={i + 1} onUpdated={onUpdated} />
          ))}
        </ul>
      )}
    </section>
  );
}
