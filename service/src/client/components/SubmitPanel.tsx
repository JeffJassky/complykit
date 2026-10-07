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
  const [slowRepeat, setSlowRepeat] = useState(false);
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
      // Quick is always one pass: the repeat only applies to a full privacy scan.
      const res = await api.createBatch({ urls: raw, checks: { consent, accessibility: a11y }, quick, slowRepeat: consent && !quick && slowRepeat });
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
        <h2 id={`${id}-title`} className="panel-title">Scan a website</h2>
        <span className="hint">Up to {MAX_URLS_PER_BATCH} sites</span>
      </div>

      <div className="submit-fields"><label htmlFor={`${id}-urls`} className="field-label">
        Website address
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
        placeholder={'example.com\nAdd more websites on separate lines'}
        rows={4}
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
          <p className="preview-empty">Use a domain or full URL. Add several sites on separate lines or separate them with commas.</p>
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

      </div><div className="submit-settings"><fieldset className="options">
        <legend className="field-label">What would you like to check?</legend>
        <label className="option">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span className="option-text">
            <span className="option-title">Visitor privacy</span>
            <span className="option-desc">See how cookies and tracking respond to visitors’ privacy choices.</span>
          </span>
        </label>
        <label className="option">
          <input type="checkbox" checked={a11y} onChange={(e) => setA11y(e.target.checked)} />
          <span className="option-text">
            <span className="option-title">Accessibility</span>
            <span className="option-desc">Find barriers that make your site difficult to use. Checks up to 15 pages.</span>
          </span>
        </label>
      </fieldset><details className="advanced-options"><summary>Scan options</summary><label className="option option-switch">
          <span className="option-text">
            <span className="option-title">Quick mode</span>
            <span className="option-desc">Shorter visits, fewer scenarios</span>
          </span>
          <input type="checkbox" role="switch" className="switch" checked={quick} onChange={(e) => setQuick(e.target.checked)} disabled={!consent} />
        </label>
        <label className="option option-switch">
          <span className="option-text">
            <span className="option-title">Also repeat on a slow connection</span>
            <span className="option-desc">Catches tracking that slips in when the consent banner loads late. Takes about 3x longer. Not with quick mode.</span>
          </span>
          <input type="checkbox" role="switch" className="switch" checked={slowRepeat && consent && !quick} onChange={(e) => setSlowRepeat(e.target.checked)} disabled={!consent || quick} />
        </label>
      </details>

      <div className="submit-row">
        <button type="submit" className="btn btn-primary btn-lg" disabled={disabled} aria-describedby={noChecks ? `${id}-nochecks` : undefined}>
          {busy ? 'Starting scan…' : n <= 1 ? 'Start scan' : `Scan ${plural(n, 'website')}`}
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
            Couldn’t start the scan: {error}
          </p>
        ) : null}
        {result ? (
          <div className="form-note success">
            {plural(result.queued, 'scan')} added. Follow progress below; your report will appear when it’s ready.
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
      </div>
    </form>
  );
}
