import { useId, useMemo, useState, type FormEvent, type KeyboardEvent } from 'react';
import { parseUrlList, MAX_URLS_PER_BATCH, type CreateBatchResponse } from '../../shared/api';
import { api } from '../lib/api';
import { plural } from '../lib/format';

const PREVIEW_LIMIT = 30;

function hostOf(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname;
    return u.hostname.replace(/^www\./, '') + path;
  } catch {
    return url;
  }
}

interface Props {
  onCreated: (res: CreateBatchResponse) => void;
}

export function SubmitPanel({ onCreated }: Props) {
  const id = useId();
  const [raw, setRaw] = useState('');
  const [consent, setConsent] = useState(true);
  const [a11y, setA11y] = useState(false);
  const [quick, setQuick] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ queued: number; rejected: string[] } | null>(null);

  const parsed = useMemo(() => parseUrlList(raw), [raw]);
  const n = parsed.urls.length;
  const noChecks = !consent && !a11y;
  const disabled = busy || n === 0 || noChecks;

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (disabled) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.createBatch({ urls: raw, checks: { consent, accessibility: a11y }, quick });
      setRaw('');
      setResult({ queued: res.jobs.length, rejected: res.rejected });
      onCreated(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <form className="panel submit" onSubmit={submit} aria-labelledby={`${id}-title`}>
      <div className="panel-head">
        <h2 id={`${id}-title`} className="panel-title">New check</h2>
        <span className="hint">Up to {MAX_URLS_PER_BATCH} sites</span>
      </div>

      <label htmlFor={`${id}-urls`} className="field-label">
        Paste websites — one per line, or comma-separated
      </label>
      <textarea
        id={`${id}-urls`}
        className="urls"
        value={raw}
        onChange={(e) => {
          setRaw(e.target.value);
          if (result) setResult(null);
        }}
        onKeyDown={onKeyDown}
        placeholder={'storyfolder.com\nhttps://www.example.org/pricing\nacme.co, northwind.io'}
        rows={7}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-describedby={`${id}-preview`}
      />

      <div id={`${id}-preview`} className="preview" aria-live="polite">
        {n > 0 ? (
          <>
            <p className="preview-count">
              <strong>{plural(n, 'site')}</strong> will be checked
            </p>
            <ul className="chips" aria-label="Sites to check">
              {parsed.urls.slice(0, PREVIEW_LIMIT).map((u) => (
                <li key={u} className="chip" title={u}>
                  {hostOf(u)}
                </li>
              ))}
              {n > PREVIEW_LIMIT ? <li className="chip chip-more">+{n - PREVIEW_LIMIT} more</li> : null}
            </ul>
          </>
        ) : raw.trim() ? null : (
          <p className="preview-empty">Scheme optional — https:// is assumed. Duplicates are ignored.</p>
        )}
        {parsed.rejected.length > 0 ? (
          <p className="rejected">
            <span className="rejected-label">Skipped {plural(parsed.rejected.length, 'entry', 'entries')}:</span>{' '}
            {parsed.rejected.map((r, i) => (
              <code key={i}>{r}</code>
            ))}
          </p>
        ) : null}
      </div>

      <fieldset className="options">
        <legend className="field-label">Checks</legend>
        <label className="option">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span className="option-text">
            <span className="option-title">Consent &amp; tracking</span>
            <span className="option-desc">Before consent, after reject, under GPC, across locations</span>
          </span>
        </label>
        <label className="option">
          <input type="checkbox" checked={a11y} onChange={(e) => setA11y(e.target.checked)} />
          <span className="option-text">
            <span className="option-title">Accessibility (WCAG)</span>
            <span className="option-desc">Slower — crawls up to 15 pages</span>
          </span>
        </label>
        <label className="option option-switch">
          <span className="option-text">
            <span className="option-title">Quick mode</span>
            <span className="option-desc">Shorter visits, fewer scenarios</span>
          </span>
          <input type="checkbox" role="switch" className="switch" checked={quick} onChange={(e) => setQuick(e.target.checked)} disabled={!consent} />
        </label>
      </fieldset>

      <div className="submit-row">
        <button type="submit" className="btn btn-primary btn-lg" disabled={disabled} aria-describedby={noChecks ? `${id}-nochecks` : undefined}>
          {busy ? 'Queuing…' : n === 0 ? 'Run checks' : `Run ${plural(n, 'check')}`}
        </button>
        <kbd className="kbd" aria-hidden="true">
          ⌘ ↵
        </kbd>
      </div>
      {noChecks ? (
        <p id={`${id}-nochecks`} className="form-note warn">
          Choose at least one check.
        </p>
      ) : null}

      <div aria-live="polite">
        {error ? (
          <p className="form-note error" role="alert">
            Couldn’t queue: {error}
          </p>
        ) : null}
        {result ? (
          <div className="form-note success">
            Queued {plural(result.queued, 'check')}.
            {result.rejected.length > 0 ? (
              <p className="rejected">
                <span className="rejected-label">The server skipped:</span>{' '}
                {result.rejected.map((r, i) => (
                  <code key={i}>{r}</code>
                ))}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </form>
  );
}
