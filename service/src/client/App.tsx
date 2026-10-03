import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CreateBatchResponse, JobSummary } from '../shared/api';
import { ActiveJobs } from './components/ActiveJobs';
import { CompletedList } from './components/CompletedList';
import { Header } from './components/Header';
import { KnowledgeBase } from './components/KnowledgeBase';
import { SubmitPanel } from './components/SubmitPanel';
import { Toasts, type Toast } from './components/Toasts';
import { isActive, plural, totalFindings } from './lib/format';
import { useHashView } from './lib/useHashView';
import { useJobs } from './lib/useJobs';

export function App() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextToast = useRef(1);

  const pushToast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = nextToast.current++;
    setToasts((list) => [...list.slice(-3), { ...t, id }]);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);

  const onTransition = useCallback(
    (prev: JobSummary, next: JobSummary) => {
      if (!isActive(prev)) return;
      if (next.status === 'done') {
        const n = totalFindings(next);
        pushToast({
          tone: 'success',
          title: `${next.host} — done, ${plural(n, 'finding')}`,
          href: next.result?.consent?.reportUrl ?? next.result?.accessibility?.reportUrl,
          hrefLabel: 'View report',
        });
      } else if (next.status === 'failed') {
        pushToast({ tone: 'error', title: `${next.host} — failed`, body: next.error });
      } else if (next.status === 'cancelled') {
        pushToast({ tone: 'neutral', title: `${next.host} — cancelled` });
      }
    },
    [pushToast],
  );

  const view = useHashView();
  // Bumped by the stream's `kb` event; the KB view refetches on each bump.
  const [kbVersion, setKbVersion] = useState(0);
  const onKb = useCallback(() => setKbVersion((v) => v + 1), []);

  const { jobs, server, loaded, loadError, connection, upsert, remove } = useJobs(onTransition, onKb);

  // Switching views moves focus to the new content (skip on first render).
  const mainRef = useRef<HTMLElement>(null);
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    mainRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }, [view]);

  const list = useMemo(() => Object.values(jobs), [jobs]);
  const active = useMemo(() => list.filter(isActive), [list]);
  const completed = useMemo(() => list.filter((j) => !isActive(j)), [list]);
  const running = active.filter((j) => j.status === 'running').length;
  const queued = active.length - running;

  useEffect(() => {
    document.title = running ? `(${running} running) complykit` : queued ? `(${queued} queued) complykit` : 'complykit';
  }, [running, queued]);

  const onCreated = useCallback((res: CreateBatchResponse) => res.jobs.forEach(upsert), [upsert]);

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Header view={view} server={server} running={running} queued={queued} connection={connection} />
      {view === 'kb' ? (
        <main id="main" ref={mainRef} tabIndex={-1} className="kb-layout" aria-label="Knowledge base">
          <KnowledgeBase version={kbVersion} pushToast={pushToast} />
        </main>
      ) : (
        <main id="main" ref={mainRef} tabIndex={-1} className="layout">
          <div className="col-side">
            <SubmitPanel onCreated={onCreated} />
          </div>
          <div className="col-main">
            {loadError ? (
              <div className="banner-error" role="alert">
                Couldn’t reach the server: {loadError}. Retrying…
              </div>
            ) : null}
            {!loaded ? (
              <div className="skeleton" aria-busy="true" aria-label="Loading jobs">
                <div className="skeleton-card" />
                <div className="skeleton-card" />
              </div>
            ) : (
              <>
                <ActiveJobs jobs={active} onUpdated={upsert} />
                <CompletedList jobs={completed} onDeleted={remove} />
              </>
            )}
          </div>
        </main>
      )}
      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
