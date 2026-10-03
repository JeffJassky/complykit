import type { JobProgress, JobStatus, JobSummary } from '../../shared/api';

export const SCENARIO_LABEL: Record<string, string> = {
  'do-nothing': 'Do nothing',
  browse: 'Ignore & browse',
  dismiss: 'Dismiss',
  reject: 'Reject',
  accept: 'Accept',
  partial: 'Partial',
  withdraw: 'Withdraw',
  gpc: 'Do-not-sell signal',
  'opt-out-all': 'Opt out every way',
  'opt-out-link': 'Opt-out link',
  'return-visit': 'Return visit',
  markers: 'Markers',
};

export const PHASE_LABEL: Record<JobProgress['phase'], string> = {
  queued: 'Waiting in queue',
  'verifying-location': 'Verifying location',
  scenarios: 'Running scenarios',
  analyzing: 'Analyzing',
  accessibility: 'Accessibility scan',
  finished: 'Finished',
};

export const STATUS_LABEL: Record<JobStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const isActive = (j: JobSummary) => j.status === 'queued' || j.status === 'running';

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(h ? 2 : 1, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
export function formatRelative(iso: string | undefined, now: number): string {
  if (!iso) return '—';
  const diff = (new Date(iso).getTime() - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  return new Date(iso).toLocaleDateString();
}

export function formatAbsolute(iso: string | undefined): string {
  return iso ? new Date(iso).toLocaleString() : '';
}

export function jobDuration(j: JobSummary, now: number): number {
  if (!j.startedAt) return 0;
  const end = j.finishedAt ? new Date(j.finishedAt).getTime() : now;
  return end - new Date(j.startedAt).getTime();
}

export function totalFindings(j: JobSummary): number {
  return (j.result?.consent?.findings ?? 0) + (j.result?.accessibility?.findings ?? 0);
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
