import type { JobsResponse } from '../../shared/api';
import type { View } from '../lib/useHashView';
import type { Connection } from '../lib/useJobs';
import { Icon, type IconName } from './Icon';

const CONNECTION_LABEL: Record<Connection, string> = {
  connecting: 'Connecting…',
  live: 'Live',
  reconnecting: 'Reconnecting…',
  polling: 'Polling every 5s',
  offline: 'Offline',
};

const VIEWS: Array<{ id: View; href: string; label: string; icon: IconName }> = [
  { id: 'checks', href: '#', label: 'Checks', icon: 'shield' },
  { id: 'kb', href: '#kb', label: 'Knowledge base', icon: 'book' },
];

interface Props {
  view: View;
  server: JobsResponse['server'] | null;
  running: number;
  queued: number;
  connection: Connection;
}

export function Header({ view, server, running, queued, connection }: Props) {
  return (
    <header className="header">
      <div className="header-inner">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32" width="28" height="28">
              <rect width="32" height="32" rx="8" fill="currentColor" />
              <circle cx="16" cy="16" r="8" stroke="var(--on-accent)" strokeWidth="2.5" fill="none" />
              <circle cx="16" cy="16" r="2.5" fill="var(--on-accent)" />
            </svg>
          </span>
          <div>
            <h1 className="brand-name">complykit</h1>
            <p className="brand-tag">Checks what a website sends to trackers before consent, after a reject and under Global Privacy Control.</p>
          </div>
        </div>
        <nav className="views" aria-label="Sections">
          {VIEWS.map((v) => (
            <a key={v.id} className="view-link" href={v.href} aria-current={view === v.id ? 'page' : undefined}>
              <Icon name={v.icon} size={15} />
              {v.label}
            </a>
          ))}
        </nav>
        <dl className="server-facts" aria-label="Server status">
          <div className="fact">
            <dt>Running</dt>
            <dd>
              {running}
              {server ? <span className="fact-sub"> / {server.concurrency}</span> : null}
            </dd>
          </div>
          <div className="fact">
            <dt>Queued</dt>
            <dd>{queued}</dd>
          </div>
          {server?.region ? (
            <div className="fact">
              <dt>Region</dt>
              <dd className="mono">{server.region}</dd>
            </div>
          ) : null}
          <div className={`conn conn-${connection}`} title={server ? `Server ${server.version}` : undefined}>
            <span className="conn-dot" aria-hidden="true" />
            <span>{CONNECTION_LABEL[connection]}</span>
          </div>
        </dl>
      </div>
      {server ? (
        <p className="retention">
          Reports are kept {server.retentionDays} {server.retentionDays === 1 ? 'day' : 'days'}, then deleted. Download anything you need to keep.
        </p>
      ) : null}
    </header>
  );
}
