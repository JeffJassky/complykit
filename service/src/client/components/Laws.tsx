import { useId, useState, type ReactNode } from 'react';
import type { JobSummary, OwnerReport } from '../../shared/api';
import { LAWS, type LawId } from '../../shared/laws';
import { lawLabel, lawRows, toggleLaw } from '../lib/laws';

/** "Scan under these laws": one checkbox per law (label, model, law names). */
export function LawPicker({ selected, onChange, disabled }: { selected: readonly LawId[]; onChange: (next: LawId[]) => void; disabled?: boolean }) {
  return (
    <fieldset className="law-picker" disabled={disabled} data-testid="law-picker">
      <legend>Scan under these laws</legend>
      {LAWS.map((l) => (
        <label key={l.id} className="law-option">
          <input type="checkbox" checked={selected.includes(l.id)} onChange={(e) => onChange(toggleLaw(selected, l.id, e.target.checked))} data-law={l.id} />
          <span className="law-text">
            <strong>{l.label}</strong>
            <span className="law-model muted">{l.model}</span>
            <span className="law-names small">{l.laws}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** "I am authorized to scan this site": never remembered. */
export function AuthorizedBox({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="home-option law-authorized">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} data-testid="authorized" /> I am authorized to scan this site
    </label>
  );
}

/** A running job's laws, one row each with its live state. Nothing when the job has no laws. */
export function LawProgress({ job, report }: { job: JobSummary; report?: OwnerReport | null }) {
  const rows = lawRows(job, report);
  if (!rows.length) return null;
  return (
    <ul className="law-progress" aria-label="Progress by law" data-testid="law-progress">
      {rows.map((r) => (
        <li key={r.id} data-state={r.state}>
          <span>{r.label}</span>
          <span className="muted">{r.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** The job's laws and who vouched for the scan, for the report and site pages. */
export function JobLaws({ job }: { job: Pick<JobSummary, 'laws' | 'authorizedAt'> }) {
  if (!job.laws?.length && !job.authorizedAt) return null;
  const when = job.authorizedAt ? new Date(job.authorizedAt) : null;
  const time = when && !Number.isNaN(when.getTime()) ? when.toLocaleString() : job.authorizedAt;
  return (
    <span className="law-summary muted" data-testid="job-laws">
      {job.laws?.length ? <span>Scanned under: {job.laws.map(lawLabel).join(', ')}.</span> : null}
      {job.authorizedAt ? <span> Authorized by submitter at {time}.</span> : null}
    </span>
  );
}

/**
 * A rescan button. When the scan being repeated used laws it asks for the
 * authorization first (not remembered) and passes `authorized: true` along.
 */
export function RescanButton({
  laws,
  busy,
  disabled,
  onRescan,
  className,
  children,
}: {
  laws?: readonly LawId[];
  busy?: boolean;
  disabled?: boolean;
  onRescan?: (extra: { laws?: LawId[]; authorized?: true }) => void;
  className: string;
  children: ReactNode;
}) {
  const id = useId();
  const [authorized, setAuthorized] = useState(false);
  const needs = Boolean(laws?.length);
  return (
    <>
      {needs ? (
        <label className="home-option law-authorized" htmlFor={`${id}-auth`}>
          <input id={`${id}-auth`} type="checkbox" checked={authorized} disabled={busy} onChange={(e) => setAuthorized(e.target.checked)} data-testid="rescan-authorized" /> I am authorized to scan this site
        </label>
      ) : null}
      <button type="button" className={className} disabled={busy || disabled || !onRescan || (needs && !authorized)} onClick={() => onRescan?.(needs ? { laws: [...laws!], authorized: true } : {})}>
        {children}
      </button>
    </>
  );
}
