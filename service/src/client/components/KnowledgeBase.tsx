import { useCallback, useId } from 'react';
import type { KbResearchRequest, KbResearchState } from '../../shared/api';
import { api } from '../lib/api';
import { formatAbsolute, formatRelative, plural } from '../lib/format';
import { useKb, useReviewer } from '../lib/useKb';
import { useNow } from '../lib/useNow';
import { Icon } from './Icon';
import { KbEntries } from './KbEntries';
import { KbProposals } from './KbProposals';
import { KbQueue } from './KbQueue';
import type { Toast } from './Toasts';

export type PushToast = (t: Omit<Toast, 'id'>) => void;

/** What the research button says when it can't run, and why. */
export function researchBlocker(available: boolean, research: KbResearchState | undefined): string | null {
  if (!available) return 'Research needs ANTHROPIC_API_KEY on the server. Use “Copy packet” to research by hand.';
  if (research?.running) return `Research is already running (${research.domains.join(', ')}).`;
  return null;
}

function ResearchStatus({ research, now }: { research: KbResearchState; now: number }) {
  if (research.running) {
    return (
      <div className="kb-research kb-research-running">
        <span className="kb-research-dot" aria-hidden="true" />
        <p>
          <strong>Researching {plural(research.domains.length, 'domain')}</strong>
          <span className="muted"> — {research.domains.join(', ')}</span>
          {research.startedAt ? (
            <span className="muted">
              {' '}
              · started{' '}
              <time dateTime={research.startedAt} title={formatAbsolute(research.startedAt)}>
                {formatRelative(research.startedAt, now)}
              </time>
            </span>
          ) : null}
          <span className="muted"> · each domain can take a minute or two; proposals appear below when it finishes.</span>
        </p>
      </div>
    );
  }
  if (!research.finishedAt) return null;
  const results = research.lastResults ?? [];
  const ok = results.filter((r) => r.proposalId);
  const failed = results.filter((r) => r.error);
  const tone = research.lastError || failed.length ? 'warn' : 'ok';
  return (
    <div className={`kb-research kb-research-${tone}`}>
      <Icon name={tone === 'ok' ? 'check' : 'alert'} size={15} />
      <p>
        <strong>Last research</strong>{' '}
        <time dateTime={research.finishedAt} title={formatAbsolute(research.finishedAt)}>
          {formatRelative(research.finishedAt, now)}
        </time>
        {research.model ? <span className="muted"> · {research.model}</span> : null}
        {': '}
        {research.lastError ? (
          <span>failed — {research.lastError}</span>
        ) : (
          <>
            {plural(ok.length, 'new proposal')}
            {failed.length ? (
              <span>
                , {failed.length} failed ({failed.map((f) => `${f.domain}: ${f.error}`).join('; ')})
              </span>
            ) : null}
          </>
        )}
      </p>
    </div>
  );
}

export function KnowledgeBase({ version, pushToast }: { version: number; pushToast: PushToast }) {
  const id = useId();
  const { data, error, refresh } = useKb(version);
  const [reviewer, setReviewer] = useReviewer();
  const now = useNow(30_000);

  const startResearch = useCallback(
    async (req: KbResearchRequest) => {
      try {
        const state = await api.kbResearch(req);
        pushToast({ tone: 'neutral', title: `Researching ${plural(state.domains.length, 'domain')}`, body: state.domains.join(', ') });
      } catch (err) {
        pushToast({ tone: 'error', title: 'Couldn’t start research', body: err instanceof Error ? err.message : String(err) });
      } finally {
        void refresh();
      }
    },
    [pushToast, refresh],
  );

  const open = data?.counts.open ?? 0;
  const proposed = data?.proposals.filter((p) => p.status === 'proposed') ?? [];

  return (
    <div className="kb">
      <div>
        <section className="panel kb-intro" aria-labelledby={`${id}-title`}>
          <div className="kb-intro-text">
            <h1 id={`${id}-title`} className="research-title">
              Make sense of unfamiliar tools
            </h1>
            <p className="muted">
              Some tools need a closer look. Research their provider and purpose, review the sources, then confirm what belongs in your shared tool library. Future scans use confirmed entries.
            </p>
            {data ? (
              <dl className="kb-facts">
                <div className="fact">
                  <dt>Open</dt>
                  <dd>{open}</dd>
                </div>
                <div className="fact">
                  <dt>Awaiting review</dt>
                  <dd>{proposed.length}</dd>
                </div>
                <div className="fact">
                  <dt>Confirmed</dt>
                  <dd>{data.entries.length}</dd>
                </div>
              </dl>
            ) : null}
          </div>
          <div className="kb-reviewer">
            <label htmlFor={`${id}-reviewer`} className="field-label">
              Your name for reviews
            </label>
            <input
              id={`${id}-reviewer`}
              className="input"
              type="text"
              value={reviewer}
              onChange={(e) => setReviewer(e.target.value)}
              placeholder="Your name"
              autoComplete="name"
              maxLength={80}
              aria-describedby={`${id}-reviewer-hint`}
            />
            <p id={`${id}-reviewer-hint`} className="hint">
              Recorded on every confirm and reject. Remembered in this browser.
            </p>
          </div>
        </section>

        <div className="kb-live" aria-live="polite">
          {data ? <ResearchStatus research={data.research} now={now} /> : null}
        </div>
      </div>

      {error ? (
        <div className="banner-error" role="alert">
          Couldn’t load the knowledge base: {error}
        </div>
      ) : null}

      {!data ? (
        error ? null : (
          <div className="skeleton" aria-busy="true" aria-label="Loading the knowledge base">
            <div className="skeleton-card" />
            <div className="skeleton-card" />
          </div>
        )
      ) : (
        <>
          <KbQueue data={data} onResearch={startResearch} onChanged={refresh} pushToast={pushToast} />
          <KbProposals proposals={proposed} reviewer={reviewer.trim()} reviewerInputId={`${id}-reviewer`} onChanged={refresh} pushToast={pushToast} />
          <KbEntries entries={data.entries} dir={data.dir} />
        </>
      )}
    </div>
  );
}
