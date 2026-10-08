import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JobSummary } from '../shared/api';
import { Header } from './components/Header';
import { Home } from './components/Home';
import { KnowledgeBase } from './components/KnowledgeBase';
import LegalGuidePage from './components/LegalGuide';
import { ReportPage } from './components/ReportPage';
import { SitePage, SitesList } from './components/Sites';
import { Toasts, type Toast } from './components/Toasts';
import { isActive } from './lib/format';
import { reportHref, useHashRoute } from './lib/useHashView';
import { useJobs } from './lib/useJobs';
import { useNow } from './lib/useNow';
import { useSites } from './lib/useSites';

export function App() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextToast = useRef(1);

  const pushToast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = nextToast.current++;
    setToasts((list) => [...list.slice(-3), { ...t, id }]);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);

  const { view, domain: siteDomain, jobId, place } = useHashRoute();
  const viewRef = useRef({ view, jobId });
  viewRef.current = { view, jobId };

  // A scan finishing elsewhere (not the report you are looking at) gets a toast to its report.
  const onTransition = useCallback(
    (prev: JobSummary, next: JobSummary) => {
      if (!isActive(prev) || isActive(next)) return;
      if (viewRef.current.view === 'report' && viewRef.current.jobId === next.id) return;
      if (next.status === 'done') pushToast({ tone: 'success', title: `${next.host} — scan finished`, href: reportHref(next.id), hrefLabel: 'Open report' });
      else if (next.status === 'failed') pushToast({ tone: 'error', title: `${next.host} — scan didn’t finish`, body: next.error });
    },
    [pushToast],
  );

  // Bumped by the stream's `kb` event; the KB view refetches on each bump.
  const [kbVersion, setKbVersion] = useState(0);
  const onKb = useCallback(() => setKbVersion((v) => v + 1), []);

  const { jobs, server, loaded, loadError, connection } = useJobs(onTransition, onKb);
  const sites = useSites();
  const now = useNow(30_000);

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
  }, [view, siteDomain, jobId]);

  const list = useMemo(() => Object.values(jobs), [jobs]);
  const running = list.filter((j) => j.status === 'running').length;
  const queued = list.filter((j) => j.status === 'queued').length;

  // The home list follows finished scans (their to-do progress comes from the sites API).
  const finished = list.filter((j) => !isActive(j)).length;
  const refreshSites = sites.refresh;
  useEffect(() => {
    if (view === 'checks') void refreshSites();
  }, [finished, view, refreshSites]);

  useEffect(() => {
    document.title = running ? `(${running} running) complykit` : queued ? `(${queued} queued) complykit` : 'complykit';
  }, [running, queued]);

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Header view={view === 'report' ? 'checks' : view} server={server} running={running} queued={queued} connection={connection} />
      {view === 'report' && jobId ? (
        <main id="main" ref={mainRef} tabIndex={-1} className="rp-layout" aria-label="Report">
          <ReportPage key={jobId} jobId={jobId} />
        </main>
      ) : view === 'sites' ? (
        <main id="main" ref={mainRef} tabIndex={-1} className="kb-layout" aria-label="Sites">
          {siteDomain ? <SitePage domain={siteDomain} jobs={loaded ? jobs : null} /> : <SitesList />}
        </main>
      ) : view === 'laws' ? (
        <main id="main" ref={mainRef} tabIndex={-1} className="kb-layout" aria-label="Legal guide">
          <LegalGuidePage place={place} />
        </main>
      ) : view === 'kb' ? (
        <main id="main" ref={mainRef} tabIndex={-1} className="kb-layout" aria-label="Knowledge base">
          <KnowledgeBase version={kbVersion} pushToast={pushToast} />
        </main>
      ) : (
        <main id="main" ref={mainRef} tabIndex={-1} className="rp-layout" aria-label="Home">
          {loadError ? (
            <div className="banner-error" role="alert">
              Couldn’t reach the server: {loadError}. Retrying…
            </div>
          ) : null}
          <Home jobs={list} sites={sites.data?.sites ?? []} loaded={loaded} now={now} />
        </main>
      )}
      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
