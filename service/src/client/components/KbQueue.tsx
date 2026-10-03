import { Fragment, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { KbQueueItem, KbQueueStatus, KbResearchRequest, KbResponse } from '../../shared/api';
import { api } from '../lib/api';
import { formatAbsolute, formatRelative, plural } from '../lib/format';
import { copyText } from '../lib/useKb';
import { useNow } from '../lib/useNow';
import { Icon } from './Icon';
import { researchBlocker, type PushToast } from './KnowledgeBase';

const PAGE = 50;
/** Long evidence lists (loaders, samples, sites) show this many, then "+N more". */
const LIST_LIMIT = 12;
const TOP = 5;

const STATUS_LABEL: Record<KbQueueStatus, string> = { open: 'Open', proposed: 'Proposed', resolved: 'Resolved', dismissed: 'Dismissed' };

type Filter = 'open' | 'all';

/** A button that stays focusable (so its reason is reachable) when it can't act. */
function GuardedButton({ blocker, className, onClick, children, label }: { blocker: string | null; className: string; onClick: () => void; children: ReactNode; label?: string }) {
  const id = useId();
  return (
    <>
      <button
        type="button"
        className={className}
        aria-disabled={blocker ? true : undefined}
        aria-label={label}
        aria-describedby={blocker ? id : undefined}
        title={blocker ?? undefined}
        onClick={() => !blocker && onClick()}
      >
        {children}
      </button>
      {blocker ? (
        <span id={id} className="visually-hidden">
          {blocker}
        </span>
      ) : null}
    </>
  );
}

function EvidenceList({ items, mono = true, render }: { items: string[]; mono?: boolean; render?: (s: string) => ReactNode }) {
  const [all, setAll] = useState(false);
  if (!items.length) return <span className="muted">—</span>;
  const shown = all ? items : items.slice(0, LIST_LIMIT);
  return (
    <ul className={`kbq-list${mono ? ' mono' : ''}`}>
      {shown.map((s, i) => (
        <li key={i} title={s}>
          {render ? render(s) : s}
        </li>
      ))}
      {items.length > LIST_LIMIT ? (
        <li>
          <button type="button" className="link-btn" onClick={() => setAll((a) => !a)}>
            {all ? 'Show fewer' : `+${items.length - LIST_LIMIT} more`}
          </button>
        </li>
      ) : null}
    </ul>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="kbq-detail">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function ItemDetail({
  item,
  researchBlock,
  onResearch,
  onChanged,
  pushToast,
}: {
  item: KbQueueItem;
  researchBlock: string | null;
  onResearch: (req: KbResearchRequest) => void;
  onChanged: () => void;
  pushToast: PushToast;
}) {
  const id = useId();
  const now = useNow(60_000);
  const [packet, setPacket] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noteRef = useRef<HTMLInputElement>(null);
  const dismissRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (dismissing) noteRef.current?.focus();
  }, [dismissing]);

  async function copyPacket() {
    setCopying(true);
    setError(null);
    try {
      const text = await api.kbPacket(item.domain);
      if (await copyText(text)) {
        pushToast({ tone: 'success', title: `Packet for ${item.domain} copied`, body: 'Paste it into a research agent; import the result with complykit kb propose.' });
      } else {
        setPacket(text); // clipboard refused: show it to copy by hand
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCopying(false);
    }
  }

  async function dismiss(ev: FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.kbDismiss({ domain: item.domain, ...(note.trim() ? { note: note.trim() } : {}) });
      pushToast({ tone: 'neutral', title: `Dismissed ${item.domain}`, body: 'Dropped from the queue without an entry.' });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const statusBlock = item.status === 'open' ? null : `Only open items can be researched (this one is ${item.status}).`;

  return (
    <div className="kbq-expanded">
      <dl className="kbq-details">
        <Detail label="Reason">{item.reason}</Detail>
        {item.kind === 'drift' && item.entryId ? (
          <Detail label="Drifted from">
            <span className="mono">{item.entryId}</span>
          </Detail>
        ) : null}
        <Detail label="Hosts">
          <EvidenceList items={item.hosts} />
        </Detail>
        <Detail label="Tracker signals">
          <EvidenceList items={item.trackerSignals} />
        </Detail>
        <Detail label="Sends">
          <EvidenceList items={item.sends} />
        </Detail>
        <Detail label="Stores">
          <EvidenceList items={item.stores.map((s) => `${s.name} (${s.kind}${s.lifetimeDays !== null ? `, ${Math.round(s.lifetimeDays)}d` : ''})`)} />
        </Detail>
        <Detail label={`Sites (${item.sites.length})`}>
          <EvidenceList items={item.sites} />
        </Detail>
        <Detail label="Seen during">
          <EvidenceList items={item.phases} />
        </Detail>
        <Detail label="Loaded by">
          <EvidenceList items={[...item.sources.map((s) => `(${s})`), ...item.loadedBy]} />
        </Detail>
        <Detail label="Samples">
          <EvidenceList items={item.samples} />
        </Detail>
        <Detail label="Seen">
          <span>
            {item.runs} run{item.runs === 1 ? '' : 's'}, first{' '}
            <time dateTime={item.firstSeen} title={formatAbsolute(item.firstSeen)}>
              {formatRelative(item.firstSeen, now)}
            </time>
            , last{' '}
            <time dateTime={item.lastSeen} title={formatAbsolute(item.lastSeen)}>
              {formatRelative(item.lastSeen, now)}
            </time>
          </span>
        </Detail>
        {item.proposalId ? (
          <Detail label="Proposal">
            <span className="mono">{item.proposalId}</span>
          </Detail>
        ) : null}
        {item.note ? <Detail label="Note">{item.note}</Detail> : null}
      </dl>

      <div aria-live="polite">
        {error ? (
          <p className="form-note error" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      {packet !== null ? (
        <div className="kbq-packet">
          <label htmlFor={`${id}-packet`} className="field-label">
            The clipboard was blocked — copy the packet from here
          </label>
          <textarea id={`${id}-packet`} className="input kbq-packet-text" readOnly value={packet} rows={8} onFocus={(e) => e.currentTarget.select()} />
        </div>
      ) : null}

      {dismissing ? (
        <form className="kbq-dismiss" onSubmit={dismiss}>
          <label htmlFor={`${id}-note`} className="field-label">
            Why dismiss {item.domain}?
          </label>
          <div className="kbq-dismiss-row">
            <input
              ref={noteRef}
              id={`${id}-note`}
              className="input"
              value={note}
              maxLength={2000}
              placeholder="e.g. the site’s own CDN"
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setDismissing(false);
                  requestAnimationFrame(() => dismissRef.current?.focus());
                }
              }}
              disabled={busy}
            />
            <button type="submit" className="btn btn-danger btn-sm" disabled={busy}>
              {busy ? 'Dismissing…' : 'Dismiss'}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy}
              onClick={() => {
                setDismissing(false);
                requestAnimationFrame(() => dismissRef.current?.focus());
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="kbq-actions">
          <GuardedButton blocker={researchBlock ?? statusBlock} className="btn btn-primary btn-sm" onClick={() => onResearch({ domains: [item.domain] })}>
            <Icon name="spark" size={14} />
            Research
          </GuardedButton>
          <button type="button" className="btn btn-secondary btn-sm" disabled={copying} onClick={() => void copyPacket()}>
            <Icon name="copy" size={14} />
            {copying ? 'Copying…' : 'Copy packet'}
          </button>
          {item.status !== 'dismissed' ? (
            <button ref={dismissRef} type="button" className="btn btn-ghost btn-sm" onClick={() => setDismissing(true)}>
              Dismiss…
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function KbQueue({ data, onResearch, onChanged, pushToast }: { data: KbResponse; onResearch: (req: KbResearchRequest) => void; onChanged: () => void; pushToast: PushToast }) {
  const id = useId();
  const [filter, setFilter] = useState<Filter>('open');
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [expanded, setExpanded] = useState<string | null>(null);

  const researching = useMemo(() => new Set(data.research.running ? data.research.domains : []), [data.research]);
  const blocker = researchBlocker(data.researchAvailable, data.research);
  const openCount = data.counts.open ?? 0;

  const q = search.trim().toLowerCase();
  const rows = useMemo(() => data.queue.filter((x) => (filter === 'all' || x.status === 'open') && (!q || x.domain.includes(q) || x.hosts.some((h) => h.includes(q)))), [data.queue, filter, q]);
  const shown = rows.slice(0, limit);
  // A row key is domain + kind: an unrecognized and a drift item can share a domain.
  const key = (x: KbQueueItem) => `${x.domain}|${x.kind}`;

  return (
    <section className="section" aria-labelledby="kb-queue-title">
      <div className="section-head">
        <h2 id="kb-queue-title" className="section-title">
          Research queue
          <span className="section-count">{openCount} open</span>
        </h2>
        <GuardedButton blocker={blocker ?? (openCount ? null : 'Nothing open to research.')} className="btn btn-secondary btn-sm" onClick={() => onResearch({ top: TOP })}>
          <Icon name="spark" size={14} />
          Research top {TOP}
        </GuardedButton>
      </div>
      {!data.researchAvailable ? (
        <p className="legend">
          Research by API is off on this server (no <code>ANTHROPIC_API_KEY</code>). Expand an item and use <strong>Copy packet</strong> to research it by hand, then import the result with{' '}
          <code>complykit kb propose</code>.
        </p>
      ) : (
        <p className="legend">Most widespread first. Research turns an item into a proposal for review above.</p>
      )}

      <div className="kbq-toolbar">
        <div className="segmented" role="radiogroup" aria-label="Show">
          {(['open', 'all'] as const).map((f) => (
            <label key={f} className={`segment${filter === f ? ' on' : ''}`}>
              <input
                type="radio"
                name={`${id}-filter`}
                value={f}
                checked={filter === f}
                onChange={() => {
                  setFilter(f);
                  setLimit(PAGE);
                }}
              />
              {f === 'open' ? `Open (${openCount})` : `All (${data.queue.length})`}
            </label>
          ))}
        </div>
        <label className="filter">
          <Icon name="search" size={14} />
          <span className="visually-hidden">Filter the queue by domain or host</span>
          <input
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setLimit(PAGE);
            }}
            placeholder="Filter by domain"
          />
        </label>
      </div>

      {data.queue.length === 0 ? (
        <div className="empty">
          <p className="empty-title">The queue is empty</p>
          <p className="empty-text">Run a consent check — parties it can’t recognize are queued here.</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="empty">
          <p className="empty-text">{q ? `Nothing matches “${search}”.` : 'Nothing open — everything is proposed, resolved or dismissed.'}</p>
        </div>
      ) : (
        <div className="kbq-wrap">
          <table className="kbq">
            <thead>
              <tr>
                <th scope="col">Domain</th>
                <th scope="col" className="num">
                  Sites
                </th>
                <th scope="col" className="num kbq-opt">
                  Requests
                </th>
                <th scope="col">
                  <span className="visually-hidden">Behaves like a tracker</span>
                </th>
                <th scope="col" className="kbq-opt">
                  Kind
                </th>
                <th scope="col">Status</th>
                <th scope="col" className="kbq-opt kbq-reason-col">
                  Reason
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((x) => {
                const k = key(x);
                const open = expanded === k;
                const detailId = `${id}-${k}`;
                return (
                  <Fragment key={k}>
                    <tr className={`kbq-row${open ? ' open' : ''}`}>
                      <th scope="row" className="kbq-domain">
                        <button type="button" className="kbq-toggle" aria-expanded={open} aria-controls={detailId} onClick={() => setExpanded(open ? null : k)}>
                          <Icon name="chevron" size={14} />
                          <span className="mono">{x.domain}</span>
                        </button>
                      </th>
                      <td className="num">{x.sites.length}</td>
                      <td className="num kbq-opt">{x.requests.toLocaleString()}</td>
                      <td>
                        {x.behavesLikeTracker ? (
                          <span className="badge badge-tracker" title={x.trackerSignals.join(', ') || 'Behaves like a tracker'}>
                            Tracker
                          </span>
                        ) : null}
                      </td>
                      <td className="kbq-opt">
                        {x.kind === 'drift' ? (
                          <span className="badge badge-drift" title={x.entryId ? `Behaved unlike entry ${x.entryId}` : undefined}>
                            Drift
                          </span>
                        ) : (
                          <span className="muted">Unrecognized</span>
                        )}
                      </td>
                      <td>
                        {researching.has(x.domain) ? (
                          <span className="pill pill-running">
                            <span className="pill-dot" aria-hidden="true" />
                            Researching
                          </span>
                        ) : (
                          <span className={`qstatus qstatus-${x.status}`}>{STATUS_LABEL[x.status]}</span>
                        )}
                      </td>
                      <td className="kbq-opt kbq-reason" title={x.reason}>
                        {x.reason}
                      </td>
                    </tr>
                    {open ? (
                      <tr className="kbq-detail-row">
                        <td colSpan={7} id={detailId}>
                          <ItemDetail item={x} researchBlock={researching.has(x.domain) ? 'Being researched now.' : blocker} onResearch={onResearch} onChanged={onChanged} pushToast={pushToast} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {rows.length > shown.length ? (
            <div className="kbq-more">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLimit((l) => l + PAGE)}>
                Show {Math.min(PAGE, rows.length - shown.length)} more
              </button>
              <span className="hint">
                {shown.length} of {plural(rows.length, 'item')}
              </span>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
