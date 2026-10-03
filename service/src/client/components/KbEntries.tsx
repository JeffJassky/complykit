import { useId, useState } from 'react';
import type { KbEntry } from '../../shared/api';
import { formatAbsolute, formatRelative } from '../lib/format';
import { useNow } from '../lib/useNow';
import { Icon } from './Icon';

/** Confirmed local entries — collapsed by default; this is the record, not the work. */
export function KbEntries({ entries, dir }: { entries: KbEntry[]; dir: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const now = useNow(60_000);
  const sorted = [...entries].sort((a, b) => (b.provenance.confirmedAt ?? '').localeCompare(a.provenance.confirmedAt ?? ''));

  return (
    <section className="section" aria-labelledby={`${id}-title`}>
      <div className="section-head">
        <h2 id={`${id}-title`} className="section-title">
          <button type="button" className="section-toggle" aria-expanded={open} aria-controls={`${id}-list`} onClick={() => setOpen((o) => !o)}>
            <Icon name="chevron" size={15} />
            Confirmed entries
          </button>
          <span className="section-count">{entries.length}</span>
        </h2>
        <span className="hint mono" title="Knowledge-base store on the server">
          {dir}
        </span>
      </div>
      {open ? (
        <div id={`${id}-list`}>
          {sorted.length === 0 ? (
            <div className="empty">
              <p className="empty-text">No confirmed entries yet. Confirm a proposal and it is recognized from the next scan on.</p>
            </div>
          ) : (
            <ul className="kbe-list">
              {sorted.map((e) => (
                <li key={e.id} className="kbe">
                  <div className="kbe-head">
                    <h3 className="kbe-vendor">{e.vendor}</h3>
                    <span className="mono muted">{e.id}</span>
                    <ul className="cat-chips">
                      {e.categories.map((c) => (
                        <li key={c} className="cat-chip on">
                          {c}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <p className="kbe-meta">
                    <span className="mono">{e.match.hosts.join(', ')}</span>
                    {e.owner ? <span>{e.owner}</span> : null}
                    {e.provenance.confirmedBy ? (
                      <span>
                        confirmed by {e.provenance.confirmedBy}
                        {e.provenance.confirmedAt ? (
                          <>
                            {' '}
                            <time dateTime={e.provenance.confirmedAt} title={formatAbsolute(e.provenance.confirmedAt)}>
                              {formatRelative(e.provenance.confirmedAt, now)}
                            </time>
                          </>
                        ) : null}
                      </span>
                    ) : null}
                    {e.provenance.sources.length ? (
                      <span>
                        {e.provenance.sources.map((s, i) => (
                          <a key={s} href={s} target="_blank" rel="noopener noreferrer" title={s}>
                            {i ? ' ' : ''}[{i + 1}]<span className="visually-hidden"> {s} (opens in a new tab)</span>
                          </a>
                        ))}
                      </span>
                    ) : null}
                  </p>
                  {e.notes ? <p className="kbe-notes">{e.notes}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}
