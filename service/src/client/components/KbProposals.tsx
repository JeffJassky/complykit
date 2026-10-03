import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { KB_CATEGORIES, type KbCategory, type KbConfirmRequest, type KbProposal } from '../../shared/api';
import { api } from '../lib/api';
import { formatAbsolute, formatRelative, plural } from '../lib/format';
import { useNow } from '../lib/useNow';
import { Icon } from './Icon';
import type { PushToast } from './KnowledgeBase';

const CATEGORY_HELP = new Map<string, string>(KB_CATEGORIES.map((c) => [c.id, c.help]));

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="kbp-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** The category chips: read-only until "Edit", then every category is a toggle. */
function Categories({ proposal, value, onChange, disabled }: { proposal: KbProposal; value: KbCategory[]; onChange: (v: KbCategory[]) => void; disabled: boolean }) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const edited = !sameSet(value, proposal.entry.categories);
  // Keep the vocabulary's order so chips don't jump around while toggling.
  const toggle = (c: KbCategory) => onChange(value.includes(c) ? value.filter((x) => x !== c) : KB_CATEGORIES.map((k) => k.id).filter((k) => k === c || value.includes(k)));
  return (
    <div className="kbp-cats">
      <div className="kbp-cats-head">
        <span id={`${id}-label`} className="kbp-label">
          Categories
        </span>
        {edited ? <span className="tag tag-edited">edited</span> : null}
        <button type="button" className="link-btn" aria-expanded={editing} aria-controls={`${id}-chips`} disabled={disabled} onClick={() => setEditing((e) => !e)}>
          {editing ? 'Done' : 'Edit'}
        </button>
        {edited ? (
          <button type="button" className="link-btn" disabled={disabled} onClick={() => onChange([...proposal.entry.categories])}>
            Reset
          </button>
        ) : null}
      </div>
      <ul id={`${id}-chips`} className="cat-chips" role={editing ? 'group' : undefined} aria-labelledby={`${id}-label`}>
        {editing
          ? KB_CATEGORIES.map((c) => {
              const on = value.includes(c.id);
              return (
                <li key={c.id}>
                  <button type="button" className={`cat-chip cat-toggle${on ? ' on' : ''}`} aria-pressed={on} title={c.help} disabled={disabled} onClick={() => toggle(c.id)}>
                    {on ? <Icon name="check" size={12} /> : null}
                    {c.id}
                  </button>
                </li>
              );
            })
          : value.map((c) => (
              <li key={c} className="cat-chip on" title={CATEGORY_HELP.get(c)}>
                {c}
              </li>
            ))}
      </ul>
      {!value.length ? <p className="form-note warn">Choose at least one category.</p> : null}
    </div>
  );
}

function ProposalCard({ p, reviewer, reviewerInputId, onChanged, pushToast }: { p: KbProposal; reviewer: string; reviewerInputId: string; onChanged: () => void; pushToast: PushToast }) {
  const id = useId();
  const now = useNow(30_000);
  const e = p.entry;
  const [categories, setCategories] = useState<KbCategory[]>(() => [...e.categories]);
  const [details, setDetails] = useState(false);
  const [vendor, setVendor] = useState(e.vendor);
  const [owner, setOwner] = useState(e.owner ?? '');
  const [consentApi, setConsentApi] = useState(e.consentApi ?? '');
  const [note, setNote] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<null | 'confirm' | 'reject'>(null);
  const [error, setError] = useState<string | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const rejectRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (rejecting) reasonRef.current?.focus();
  }, [rejecting]);

  const noReviewer = !reviewer;
  const locked = busy !== null;

  async function confirm() {
    if (noReviewer || locked || !categories.length) return;
    setBusy('confirm');
    setError(null);
    const req: KbConfirmRequest = { by: reviewer };
    if (!sameSet(categories, e.categories)) req.categories = categories;
    if (vendor.trim() && vendor.trim() !== e.vendor) req.vendor = vendor.trim();
    if (owner.trim() && owner.trim() !== (e.owner ?? '')) req.owner = owner.trim();
    if (consentApi.trim() && consentApi.trim() !== (e.consentApi ?? '')) req.consentApi = consentApi.trim();
    if (note.trim()) req.note = note.trim();
    try {
      const entry = await api.kbConfirm(p.id, req);
      pushToast({ tone: 'success', title: `Confirmed ${entry.vendor}`, body: `${entry.categories.join(', ')} — recognized from the next scan on.` });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }

  async function reject(ev: FormEvent) {
    ev.preventDefault();
    if (noReviewer || locked || !reason.trim()) return;
    setBusy('reject');
    setError(null);
    try {
      await api.kbReject(p.id, { by: reviewer, reason: reason.trim() });
      pushToast({ tone: 'neutral', title: `Rejected the proposal for ${p.domain}`, body: 'It is open in the queue again.' });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }

  return (
    <li className="card kbp" aria-labelledby={`${id}-vendor`}>
      <div className="kbp-head">
        <div className="kbp-id">
          <h3 id={`${id}-vendor`} className="kbp-vendor">
            {e.vendor}
          </h3>
          <p className="kbp-meta">
            <span className="mono">{p.domain}</span>
            {e.owner ? <span>{e.owner}</span> : null}
            <span className="mono" title="Entry id">
              {e.id}
            </span>
          </p>
        </div>
        <span className={`conf conf-${p.confidence}`} title="The researcher’s confidence">
          {p.confidence[0].toUpperCase() + p.confidence.slice(1)} confidence
        </span>
      </div>

      {p.firstParty ? <p className="form-note warn kbp-note">Proposed as the site’s own infrastructure (first party), not an outside vendor.</p> : null}

      <Categories proposal={p} value={categories} onChange={setCategories} disabled={locked} />

      <p className="kbp-rationale">{p.rationale}</p>

      {p.disagreements.length ? (
        <div className="kbp-disagree" role="note" aria-label="Observed versus documented">
          <p className="kbp-disagree-title">
            <Icon name="alert" size={14} />
            Observed vs documented
          </p>
          <ul>
            {p.disagreements.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <dl className="kbp-facts">
        <Fact label="Hosts">
          <span className="mono">{e.match.hosts.join(', ')}</span>
          {e.match.path ? <span className="mono muted"> path {e.match.path}</span> : null}
        </Fact>
        {e.sends.length ? <Fact label="Sends">{e.sends.join(', ')}</Fact> : null}
        {e.stores.length ? (
          <Fact label="Stores">
            {e.stores.map((s, i) => (
              <span key={i} className="mono">
                {i ? ', ' : ''}
                {s.name}
                <span className="muted">
                  {' '}
                  ({s.kind}
                  {s.lifetimeDays !== undefined ? `, ${s.lifetimeDays}d` : ''})
                </span>
              </span>
            ))}
          </Fact>
        ) : null}
        {e.consentApi ? <Fact label="Consent API">{e.consentApi}</Fact> : null}
        {e.decoder && e.decoder !== 'none' ? <Fact label="Decoder">{e.decoder}</Fact> : null}
      </dl>

      <div className="kbp-sources">
        <span className="kbp-label">{plural(p.sources.length, 'source')}</span>
        <ol>
          {p.sources.map((s) => (
            <li key={s}>
              <a href={s} target="_blank" rel="noopener noreferrer">
                {s}
                <span className="visually-hidden"> (opens in a new tab)</span>
              </a>
            </li>
          ))}
        </ol>
      </div>

      <p className="kbp-by">
        Proposed by <span className={p.proposedBy.startsWith('agent:') ? 'mono' : undefined}>{p.proposedBy}</span>{' '}
        <time dateTime={p.proposedAt} title={formatAbsolute(p.proposedAt)}>
          {formatRelative(p.proposedAt, now)}
        </time>
        <span className="mono muted"> · {p.id}</span>
      </p>

      <div className="kbp-details">
        <button type="button" className="disclosure" aria-expanded={details} aria-controls={`${id}-details`} onClick={() => setDetails((d) => !d)}>
          <Icon name="chevron" size={14} />
          Correct details before confirming
        </button>
        {details ? (
          <div id={`${id}-details`} className="kbp-fields">
            <label className="kbp-field">
              <span className="field-label">Vendor</span>
              <input className="input" value={vendor} onChange={(ev) => setVendor(ev.target.value)} maxLength={200} disabled={locked} />
            </label>
            <label className="kbp-field">
              <span className="field-label">Owner</span>
              <input className="input" value={owner} onChange={(ev) => setOwner(ev.target.value)} maxLength={200} disabled={locked} />
            </label>
            <label className="kbp-field">
              <span className="field-label">Consent API</span>
              <input className="input" value={consentApi} onChange={(ev) => setConsentApi(ev.target.value)} maxLength={500} placeholder="none — must be held back" disabled={locked} />
            </label>
            <label className="kbp-field kbp-field-wide">
              <span className="field-label">Note</span>
              <input className="input" value={note} onChange={(ev) => setNote(ev.target.value)} maxLength={2000} placeholder="Saved with the entry" disabled={locked} />
            </label>
          </div>
        ) : null}
      </div>

      <div aria-live="polite">
        {error ? (
          <p className="form-note error" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      {rejecting ? (
        <form className="kbp-reject" onSubmit={reject}>
          <label htmlFor={`${id}-reason`} className="field-label">
            Why reject? The next researcher reads this.
          </label>
          <textarea
            ref={reasonRef}
            id={`${id}-reason`}
            className="input kbp-reason"
            rows={2}
            value={reason}
            maxLength={2000}
            onChange={(ev) => setReason(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === 'Escape') {
                setRejecting(false);
                requestAnimationFrame(() => rejectRef.current?.focus());
              }
            }}
            disabled={locked}
            required
          />
          <div className="kbp-actions">
            <button type="submit" className="btn btn-danger btn-sm" disabled={locked || noReviewer || !reason.trim()}>
              {busy === 'reject' ? 'Rejecting…' : 'Reject proposal'}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={locked}
              onClick={() => {
                setRejecting(false);
                requestAnimationFrame(() => rejectRef.current?.focus());
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="kbp-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={locked || noReviewer || !categories.length}
            aria-describedby={noReviewer ? `${id}-need-name` : undefined}
            onClick={() => void confirm()}
          >
            <Icon name="check" size={14} />
            {busy === 'confirm' ? 'Confirming…' : 'Confirm'}
          </button>
          <button
            ref={rejectRef}
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={locked || noReviewer}
            aria-describedby={noReviewer ? `${id}-need-name` : undefined}
            onClick={() => setRejecting(true)}
          >
            Reject…
          </button>
          {noReviewer ? (
            <p id={`${id}-need-name`} className="hint">
              <a
                href={`#${reviewerInputId}`}
                onClick={(ev) => {
                  ev.preventDefault();
                  document.getElementById(reviewerInputId)?.focus();
                }}
              >
                Enter your name
              </a>{' '}
              above to review.
            </p>
          ) : null}
        </div>
      )}
    </li>
  );
}

export function KbProposals({
  proposals,
  reviewer,
  reviewerInputId,
  onChanged,
  pushToast,
}: {
  proposals: KbProposal[];
  reviewer: string;
  reviewerInputId: string;
  onChanged: () => void;
  pushToast: PushToast;
}) {
  const sorted = [...proposals].sort((a, b) => a.proposedAt.localeCompare(b.proposedAt));
  return (
    <section className="section" aria-labelledby="kb-proposals-title">
      <div className="section-head">
        <h2 id="kb-proposals-title" className="section-title">
          Proposals awaiting review
          {proposals.length ? <span className="section-count">{proposals.length}</span> : null}
        </h2>
      </div>
      {sorted.length === 0 ? (
        <div className="empty">
          <p className="empty-title">Nothing to review</p>
          <p className="empty-text">Research an item from the queue below, or import one with complykit kb propose.</p>
        </div>
      ) : (
        <ul className="kbp-list">
          {sorted.map((p) => (
            <ProposalCard key={p.id} p={p} reviewer={reviewer} reviewerInputId={reviewerInputId} onChanged={onChanged} pushToast={pushToast} />
          ))}
        </ul>
      )}
    </section>
  );
}
