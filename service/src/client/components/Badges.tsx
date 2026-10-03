import type { JobResult, JobStatus } from '../../shared/api';
import { STATUS_LABEL } from '../lib/format';

type Totals = NonNullable<JobResult['consent']>['totals'];

export const KINDS: Array<{ key: keyof Totals; label: string; cls: string; help: string }> = [
  { key: 'violation', label: 'Violation', cls: 'violation', help: 'Conduct a rule prohibits' },
  { key: 'needs-review', label: 'Needs review', cls: 'review', help: 'Depends on facts the scan can’t see' },
  { key: 'exposure', label: 'Exposure', cls: 'exposure', help: 'Litigation theory for counsel, not a violation' },
  { key: 'practice', label: 'Needs research', cls: 'research', help: 'Unrecognized party or practice to look into' },
];

export function TotalsBadges({ totals }: { totals: Totals }) {
  return (
    <ul className="totals" aria-label="Findings by kind">
      {KINDS.map((k) => {
        const n = totals[k.key] ?? 0;
        return (
          <li key={k.key} className={`count count-${k.cls}${n === 0 ? ' count-zero' : ''}`} title={k.help}>
            <span className="count-n">{n}</span>
            <span className="count-label">{k.label}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function StatusPill({ status }: { status: JobStatus }) {
  return (
    <span className={`pill pill-${status}`}>
      <span className="pill-dot" aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  );
}
