import { useEffect, useId, useState } from 'react';
import type { LawId } from '../../shared/laws';
import { orderLaws, scanBlockedReason } from '../lib/laws';
import { AuthorizedBox, JobLaws, LawPicker } from './Laws';
import type { ConsentSettings, ConsentStatsResponse, JobSummary, RemediationStatus, RemediationTask, SiteSummary, SiteWorkspace, WorkspaceRun } from '../../shared/api';
import { formatAbsolute, formatRelative } from '../lib/format';
import { api } from '../lib/api';
import { notifyJobsChanged } from '../lib/useJobs';
import { configDownloads, configStoredOf, generatableRuns, siteRuns, generateErrorText, REPORT_REFRESH_FAILED, summarizeWorkspace } from '../lib/sites';
import { PHASE_LABEL } from '../lib/format';
import { COMPANION_INSTALL_SUMMARY, checklistFromWorkspace, checklistProgress, hostedScriptUrlOf, installSnippet, openDecisions, reportChecklistHref, reportTaskHref, taskStatusLabel, TASK_CHANGE_PREFIX } from '../lib/checklist';
import { COMPANION_LIST_NOTE, categoryIdsOf, consentSettingsOf, detectedBannerOf, settingsDefaultsOf } from '../lib/consentSettings';
import { ConsentSettingsForm } from './ConsentSettingsForm';
import { reportHref, siteHref } from '../lib/useHashView';
import { useNow } from '../lib/useNow';
import { copyText, useReviewer } from '../lib/useKb';
import { useLiveRefresh, useSites, useSiteStats, useSiteWorkspace } from '../lib/useSites';
import { hasActivity, summarizeStats } from '../lib/stats';

function When({ iso, now }: { iso: string | undefined; now: number }) {
  if (!iso) return <span className="muted">—</span>;
  return (
    <time dateTime={iso} title={formatAbsolute(iso)}>
      {formatRelative(iso, now)}
    </time>
  );
}

// --- List ------------------------------------------------------------------

export function SitesListView({ sites, now }: { sites: SiteSummary[]; now: number }) {
  if (!sites.length) {
    return (
      <div className="empty">
        <p className="empty-title">No sites yet</p>
        <p className="empty-text">A site appears here once a team member saves work for it or one of its scans is recorded.</p>
      </div>
    );
  }
  return (
    <ul className="sites-list" aria-label="Sites">
      {sites.map((s) => (
        <li key={s.domain} className="card site-row">
          <a className="site-name" href={siteHref(s.domain)}>
            {s.domain}
          </a>
          <dl className="kb-facts">
            <div className="fact">
              <dt>Runs</dt>
              <dd>{s.runs}</dd>
            </div>
            <div className="fact">
              <dt>Saved answers</dt>
              <dd>{s.entries}</dd>
            </div>
            <div className="fact">
              <dt>Last run</dt>
              <dd>
                <When iso={s.lastRunAt} now={now} />
              </dd>
            </div>
            <div className="fact">
              <dt>Config</dt>
              <dd>{s.configAt ? <When iso={s.configAt} now={now} /> : 'none yet'}</dd>
            </div>
            <div className="fact">
              <dt>Checklist</dt>
              <dd data-testid="site-checklist">
                {s.checklist ? (
                  <>
                    {s.checklist.verified} of {s.checklist.required} done
                    {s.checklist.doneUnverified ? <small className="muted"> · {s.checklist.doneUnverified} marked done</small> : null}
                    {s.checklist.failed ? <small className="muted"> · {s.checklist.failed} failed</small> : null}
                  </>
                ) : (
                  <span className="muted">—</span>
                )}
              </dd>
            </div>
          </dl>
        </li>
      ))}
    </ul>
  );
}

export function SitesList() {
  const id = useId();
  const { data, error, refresh } = useSites();
  useLiveRefresh(refresh); // checklist progress changes elsewhere (the report, the API)
  const now = useNow(30_000);
  return (
    <div className="kb">
      <section className="panel" aria-labelledby={`${id}-title`}>
        <h1 id={`${id}-title`} className="research-title">
          Sites
        </h1>
        <p className="muted">Everything the team has saved for each site: scan history, checklist progress and the latest consent-tool config.</p>
      </section>
      {error ? (
        <div className="banner-error" role="alert">
          Couldn’t load sites: {error}
        </div>
      ) : null}
      {data ? <SitesListView sites={data.sites} now={now} /> : error ? null : <div className="skeleton" aria-busy="true" aria-label="Loading sites"><div className="skeleton-card" /></div>}
    </div>
  );
}

// --- Site page ---------------------------------------------------------------

function metaText(meta: WorkspaceRun['meta']): string {
  if (!meta) return '';
  return Object.entries(meta)
    .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(' · ');
}

/** Where a generation stands. `runId` is the workspace run being generated from. */
export interface GenerateState {
  busyRunId?: string;
  error?: string;
  /** Set after a success; `stale` means a newer config was already stored. */
  done?: { runId: string; stale: boolean };
  /** The config and checklist were generated and stored, but the report could not be re-rendered: offer "Update report". */
  reportFailed?: { jobId: string; runId: string; reason: string };
  /** "Update report" is running. */
  updating?: boolean;
}

function GenerateButton({ run, primary, generate, onGenerate }: { run: WorkspaceRun; primary?: boolean; generate: GenerateState; onGenerate: (run: WorkspaceRun) => void }) {
  const busy = generate.busyRunId === run.id;
  return (
    <button
      type="button"
      className={`btn btn-sm ${primary ? 'btn-primary' : 'btn-secondary'}`}
      disabled={!!generate.busyRunId}
      aria-busy={busy}
      onClick={() => onGenerate(run)}
    >
      {busy ? 'Generating…' : 'Generate consent tool config'}
    </button>
  );
}

/** A failed or cancelled run (greyed in the list). */
function runEnded(run: WorkspaceRun, jobs: Record<string, JobSummary> | null): boolean {
  const status = run.jobId ? jobs?.[run.jobId]?.status : undefined;
  return status === 'failed' || status === 'cancelled';
}

function RunReport({ run, jobs }: { run: WorkspaceRun; jobs: Record<string, JobSummary> | null }) {
  if (!run.jobId) return <span className="muted">Ran outside this service</span>;
  const job = jobs?.[run.jobId];
  if (job) {
    return (
      <>
        <a href={reportHref(job.id)}>View report</a>
        {job?.result?.downloadUrl ? (
          <>
            {' · '}
            <a href={job.result.downloadUrl}>Download</a>
          </>
        ) : null}
        {job ? <JobLaws job={job} /> : null}
      </>
    );
  }
  return <span className="muted">{jobs ? 'Report deleted or expired' : 'Report unavailable'}</span>;
}

// --- Checklist (R3) ------------------------------------------------------------

/** Where the checklist's buttons stand: one Verify per site at a time (the service refuses a second). */
export interface ChecklistState {
  /** The task being verified. */
  verifying?: string;
  /** The task whose status is being saved. */
  saving?: string;
  /** Per task: why the last Verify / save could not run. */
  errors?: Record<string, string>;
}

const STATUS_PILL: Record<RemediationStatus, string> = { todo: 'pill-queued', 'done-unverified': 'pill-marked', verified: 'pill-done', failed: 'pill-failed', 'cannot-verify': 'pill-marked' };

/** A decision (kind 'classify'): what an unrecognized tool is for. Made in the report (its classify control); done when the workspace holds a purpose. */
function DecisionItem({ task, tasks, report }: { task: RemediationTask; tasks: RemediationTask[]; report?: string }) {
  const unblocks = tasks.filter((t) => t.waitingOn?.includes(task.id));
  return (
    <li className="checklist-item" data-task-id={task.id} data-task-kind="classify" data-status={task.status}>
      <div className="checklist-head">
        <strong className="checklist-title">{task.title}</strong>
        <span className={`pill ${STATUS_PILL[task.status]}`}>{taskStatusLabel(task)}</span>
      </div>
      <p className="muted">{task.summary}</p>
      {unblocks.length ? (
        <div className="checklist-also" data-testid="unblocks">
          <strong>Unblocks:</strong> {unblocks.map((u) => u.title).join(' · ')}
        </div>
      ) : null}
      <div className="site-downloads">
        {task.status === 'verified' ? (
          <span className="muted">Decided — your team’s classification is saved for this site.</span>
        ) : report ? (
          <a className="btn btn-sm" href={reportTaskHref(report, task.id)}>
            Classify it in the report
          </a>
        ) : (
          <span className="muted">Classify it in the scan’s report (its grid), then press “Update report with my classifications”.</span>
        )}
      </div>
    </li>
  );
}

/** The install line with a Copy button: all a site owner pastes (first in <head>). */
function InstallLine({ hostedScriptUrl, companion }: { hostedScriptUrl: string; companion?: boolean }) {
  const text = installSnippet(hostedScriptUrl);
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <div className="checklist-snippet" data-testid="install-snippet">
      <div className="site-downloads">
        <span>{companion ? 'Paste in <head>' : 'Paste first in <head>'}</span>
        <button type="button" className="btn btn-sm btn-secondary" onClick={() => void copyText(text).then(setCopied)}>
          {copied === true ? 'Copied ✓' : copied === false ? 'Copy failed' : 'Copy'}
        </button>
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}

function ChecklistItem({ task, tasks, hostedScriptUrl, state, onVerify, onMarkDone, workspace, onSaveSettings }: { task: RemediationTask; tasks: RemediationTask[]; hostedScriptUrl?: string; state: ChecklistState; onVerify: (t: RemediationTask) => void; onMarkDone: (t: RemediationTask) => void; workspace?: SiteWorkspace; onSaveSettings?: (s: ConsentSettings) => Promise<void> }) {
  const busy = state.verifying === task.id;
  const error = state.errors?.[task.id];
  const waiting = openDecisions(task, tasks);
  return (
    <li className="checklist-item" data-task-id={task.id} data-status={task.status} data-blocked={waiting.length ? 'true' : undefined}>
      <div className="checklist-head">
        <strong className="checklist-title">{task.title}</strong>
        <span className={`pill ${STATUS_PILL[task.status]}`}>{taskStatusLabel(task)}</span>
      </div>
      <p className="muted">{task.kind === 'install' && workspace && consentSettingsOf(workspace).mode === 'companion' ? COMPANION_INSTALL_SUMMARY : task.summary}</p>
      {waiting.length ? (
        <p className="checklist-waiting" data-testid="waiting-on">
          <strong>Waiting on:</strong> your decision on what {waiting.map((d) => d.tools[0] ?? d.title).join(', ')} {waiting.length === 1 ? 'is' : 'are'} (above). This change applies only if {waiting.length === 1 ? 'it tracks' : 'they track'} visitors.
        </p>
      ) : null}
      {task.alsoFixes?.length ? (
        <div className="checklist-also" data-testid="also-fixes">
          <strong>This also fixes:</strong>{' '}
          {task.alsoFixes.length === 1 ? (
            task.alsoFixes[0]
          ) : (
            <ul>
              {task.alsoFixes.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      {waiting.length ? null : <div className="site-downloads">
        {task.status !== 'verified' ? (
          <button type="button" className="btn btn-sm btn-secondary" aria-pressed={task.status === 'done-unverified'} disabled={state.saving === task.id} onClick={() => onMarkDone(task)}>
            {task.status === 'done-unverified' ? 'Undo “made this change”' : 'I’ve made this change'}
          </button>
        ) : null}
        {task.verify.method !== 'manual' ? (
          <button type="button" className="btn btn-sm" disabled={!!state.verifying} aria-busy={busy} onClick={() => onVerify(task)}>
            {busy ? 'Checking the live page…' : task.lastVerify ? 'Verify again' : 'Verify'}
          </button>
        ) : (
          <span className="muted">Can’t be checked automatically — mark it done when it’s made.</span>
        )}
      </div>}
      {task.kind === 'install' && workspace && consentSettingsOf(workspace).mode === 'companion' && task.companionSteps?.length ? (
        <ol className="checklist-steps" data-testid="companion-steps">
          {task.companionSteps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      ) : null}
      {task.kind === 'install' && hostedScriptUrl ? <InstallLine hostedScriptUrl={hostedScriptUrl} companion={!!workspace && consentSettingsOf(workspace).mode === 'companion'} /> : null}
      {task.kind === 'install' && workspace && onSaveSettings ? (
        <ConsentSettingsForm
          // The form restarts from what is stored whenever that changes.
          key={JSON.stringify(consentSettingsOf(workspace))}
          settings={consentSettingsOf(workspace)}
          defaults={settingsDefaultsOf(workspace)}
          detectedBanner={detectedBannerOf(workspace)}
          categoryIds={categoryIdsOf(workspace)}
          onSave={onSaveSettings}
        />
      ) : null}
      {busy ? (
        <p className="muted" role="status">
          Checking the live page… a browser check can take up to a minute.
        </p>
      ) : null}
      {error ? (
        <p className="banner-error" role="alert">
          {error}
        </p>
      ) : null}
      {task.lastVerify && !busy ? (
        <div className="checklist-result" role="status">
          <p>
            <strong>Last check:</strong> {task.lastVerify.message}
          </p>
          {task.lastVerify.evidence.length ? (
            <ul className="checklist-evidence">
              {task.lastVerify.evidence.map((e, i) => (
                <li key={i}>
                  <code>{e}</code>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** Where the rescan stands (POST /api/sites/:domain/rescan). */
export interface RescanState {
  busy?: boolean;
  error?: string;
  started?: { jobId: string; url: string; quick: boolean; slowRepeat?: boolean };
}

/** The proof section of a consent report: the rescan's final word. */
export const PROOF_ANCHOR = 'consent-tool-proof';

/** The rescan being followed: live from the jobs stream (the same events the checks page shows). */
function RescanProgress({ started, job }: { started: NonNullable<RescanState['started']>; job?: JobSummary }) {
  if (!job || job.status === 'queued' || job.status === 'running') {
    const pct = job ? Math.round(Math.max(0, Math.min(1, job.progress.fraction)) * 100) : 0;
    return (
      <div className="checklist-rescan-follow" role="status" data-testid="rescan-progress">
        <p className="muted">
          Rescanning {started.url} ({started.quick ? 'quick' : started.slowRepeat ? 'full, with a slow-connection repeat' : 'full'})… {job ? `${PHASE_LABEL[job.progress.phase]}${job.progress.current ? ` — ${job.progress.current}` : ''}` : 'starting'}
        </p>
        <progress className="checklist-progress" max={100} value={pct} aria-label="Rescan progress" />
      </div>
    );
  }
  const report = job.result?.consent?.reportUrl;
  if (job.status === 'done' && report) {
    return (
      <p role="status" data-testid="rescan-done">
        Rescan finished. <a href={`${report}#${PROOF_ANCHOR}`}>Open the new report at “Your complykit consent tool: what it controls”</a> — it says, per vendor, controlled, not controlled or not observed.
      </p>
    );
  }
  return (
    <div className="banner-error" role="alert" data-testid="rescan-ended">
      The rescan {job.status === 'cancelled' ? 'was cancelled' : 'did not finish'}{job.error ? `: ${job.error}` : ''}. Nothing on the checklist changed; you can start it again.
    </div>
  );
}

/** The checklist's last step. A button, never a verdict: the rescan's report is the behavior proof. */
export function RescanPanel({
  rescan = {},
  onRescan,
  canRescan,
  remaining,
  defaultQuick = false,
  defaultSlowRepeat = false,
  defaultLaws,
  job,
}: {
  rescan?: RescanState;
  onRescan?: (opts: { quick: boolean; slowRepeat: boolean; laws?: LawId[]; authorized?: true }) => void;
  canRescan: boolean;
  remaining: number;
  /** The site's latest scan was quick: preselect it. */
  defaultQuick?: boolean;
  /** The site's latest scan repeated on a slow connection: preselect it. */
  defaultSlowRepeat?: boolean;
  /** The laws the site's latest scan ran under (none: a single scan from the service's own location). */
  defaultLaws?: readonly LawId[];
  /** The started rescan's job, live (undefined until the stream has it). */
  job?: JobSummary;
}) {
  const id = useId();
  const [quick, setQuick] = useState(defaultQuick);
  const [slowRepeat, setSlowRepeat] = useState(defaultSlowRepeat);
  const [laws, setLaws] = useState<LawId[]>(() => orderLaws(defaultLaws ?? []));
  const [authorized, setAuthorized] = useState(false);
  const withLaws = Boolean(defaultLaws?.length);
  const blocked = withLaws ? scanBlockedReason({ consent: true, accessibility: false, laws, authorized }) : null;
  const running = Boolean(rescan.started) && (!job || job.status === 'queued' || job.status === 'running');
  return (
    <div className="checklist-rescan" data-testid="rescan">
      <h3 className="section-subtitle">Last step: rescan the site</h3>
      <p className="hint">
        When every change is made, rescan. “Verified” means the page we fetched carries the change, not what visitors’ browsers do: the rescan’s report has the final word — its section <strong>“Your complykit consent tool: what it controls”</strong> says, per vendor,
        controlled, not controlled or not observed, for the pages and locations it visited.
        {remaining ? ` ${remaining} required ${remaining === 1 ? 'item is' : 'items are'} not done yet; ${remaining === 1 ? 'it' : 'they'} will show up there.` : ''}
      </p>
      {canRescan ? (
        <>
          <fieldset className="checklist-rescan-options" disabled={rescan.busy || running}>
            <legend className="visually-hidden">Rescan options</legend>
            {withLaws ? (
              <LawPicker selected={laws} onChange={setLaws} />
            ) : (
              <p className="muted" data-testid="rescan-location">
                Location: <strong>this service’s own connection</strong> — the only place it scans from today.
              </p>
            )}
            <label className="option">
              <input type="radio" name={`${id}-mode`} checked={!quick} onChange={() => setQuick(false)} /> <span>Full — every visitor choice, normal visits (best for the final check)</span>
            </label>
            <label className="option option-nested">
              <input type="checkbox" checked={!quick && slowRepeat} disabled={quick} onChange={(e) => setSlowRepeat(e.target.checked)} data-testid="rescan-slow-repeat" />{' '}
              <span>Also repeat on a slow connection — catches tracking that slips in when the banner loads late; takes about 3x longer</span>
            </label>
            <label className="option">
              <input type="radio" name={`${id}-mode`} checked={quick} onChange={() => setQuick(true)} /> <span>Quick — shorter visits, fewer visitor choices</span>
            </label>
          </fieldset>
          {withLaws ? <AuthorizedBox checked={authorized} onChange={setAuthorized} disabled={rescan.busy || running} /> : null}
          {blocked ? <p className="hint">{blocked}</p> : null}
          <p>
            <button type="button" className="btn btn-sm" disabled={rescan.busy || running || blocked !== null} onClick={() => onRescan?.({ quick, slowRepeat: !quick && slowRepeat, ...(withLaws ? { laws: orderLaws(laws), authorized: true as const } : {}) })}>
              {rescan.busy ? 'Starting…' : rescan.started && !running ? 'Rescan again' : 'Rescan site'}
            </button>
          </p>
        </>
      ) : (
        <p className="hint">Rescanning needs an earlier scan of this site: start one from the checks page.</p>
      )}
      {rescan.started ? <RescanProgress started={rescan.started} job={job} /> : null}
      {rescan.error ? (
        <div className="banner-error" role="alert">
          Couldn’t start the rescan: {rescan.error}
        </div>
      ) : null}
    </div>
  );
}

/** The site's latest consent scan on the service (the rescan's default options). */
export function latestSiteJob(workspace: SiteWorkspace, jobs: Record<string, JobSummary> | null): JobSummary | undefined {
  if (!jobs) return undefined;
  const runs = [...workspace.runs].sort((a, b) => b.at.localeCompare(a.at));
  for (const r of runs) {
    const j = r.jobId ? jobs[r.jobId] : undefined;
    if (j?.checks?.includes('consent')) return j;
  }
  return undefined;
}

export function ChecklistPanel({
  workspace,
  jobs,
  state = {},
  onVerify = () => {},
  onMarkDone = () => {},
  rescan,
  onRescan,
  onSaveSettings,
}: {
  workspace: SiteWorkspace;
  jobs: Record<string, JobSummary> | null;
  onSaveSettings?: (s: ConsentSettings) => Promise<void>;
  state?: ChecklistState;
  onVerify?: (t: RemediationTask) => void;
  onMarkDone?: (t: RemediationTask) => void;
  rescan?: RescanState;
  onRescan?: (opts: { quick: boolean; slowRepeat: boolean; laws?: LawId[]; authorized?: true }) => void;
}) {
  const tasks = checklistFromWorkspace(workspace);
  const report = reportChecklistHref(workspace, jobs);
  const p = checklistProgress(tasks);
  // One list: the decisions (what an unrecognized tool is for) first, then the changes; optional (chat, embeds, fonts) folded at the end.
  const required = tasks.filter((t) => !t.optional);
  const later = tasks.filter((t) => t.optional);
  const item = (t: RemediationTask) =>
    t.kind === 'classify' ? <DecisionItem key={t.id} task={t} tasks={tasks} report={report} /> : <ChecklistItem key={t.id} task={t} tasks={tasks} hostedScriptUrl={hostedScriptUrlOf(workspace)} state={state} onVerify={onVerify} onMarkDone={onMarkDone} workspace={workspace} onSaveSettings={onSaveSettings} />;
  return (
    <section className="panel" aria-labelledby="site-checklist">
      <h2 id="site-checklist" className="section-title">
        To-do list
      </h2>
      {tasks.length ? (
        <>
          <progress className="checklist-progress" max={Math.max(p.required, 1)} value={p.verified} aria-label="To-do items done" />
          <p data-testid="checklist-progress">
            <strong>
              {p.verified} of {p.required} done
            </strong>
            {p.doneUnverified ? ` · ${p.doneUnverified} more marked done, not verified yet` : ''}
            {p.failed ? ` · ${p.failed} failed` : ''}
          </p>
          {consentSettingsOf(workspace).mode === 'companion' ? (
            <p className="hint" data-testid="companion-note">
              {COMPANION_LIST_NOTE}
            </p>
          ) : null}
          {report ? (
            <p>
              <a href={report}>Open the to-do list in the report</a> for the steps, the markup to paste and the classify controls.
            </p>
          ) : null}
          <ol className="checklist">{required.map(item)}</ol>
          {later.length ? (
            <details className="checklist-later">
              <summary>Only if they apply ({later.length}): chat, embeds and fonts</summary>
              <ol className="checklist">{later.map(item)}</ol>
            </details>
          ) : null}
          <RescanPanel
            rescan={rescan}
            onRescan={onRescan}
            canRescan={workspace.runs.some((r) => r.url) || Object.values(jobs ?? {}).some((j) => j.checks?.includes('consent'))}
            remaining={p.required - p.verified - p.doneUnverified}
            defaultQuick={latestSiteJob(workspace, jobs)?.quick ?? false}
            defaultSlowRepeat={latestSiteJob(workspace, jobs)?.slowRepeat ?? false}
            defaultLaws={latestSiteJob(workspace, jobs)?.laws}
            job={rescan?.started ? jobs?.[rescan.started.jobId] : undefined}
          />
        </>
      ) : (
        <p className="muted">Generate the consent tool config to get your checklist.</p>
      )}
    </section>
  );
}

/** Banner analytics per config version: counters from visitors' browsers, never individuals. */
export function BannerStatsPanel({ stats, error }: { stats?: ConsentStatsResponse | null; error?: string | null }) {
  const versions = (stats?.configs ?? []).map((c) => ({ config: c, summary: summarizeStats(c) })).filter((v) => hasActivity(v.summary));
  return (
    <section className="panel" aria-labelledby="site-banner-stats" data-testid="banner-stats">
      <h2 id="site-banner-stats" className="section-title">
        Banner stats
      </h2>
      {error ? (
        <p className="muted" role="alert">
          Couldn’t load banner stats: {error}
        </p>
      ) : !stats ? (
        <p className="muted">Loading…</p>
      ) : !versions.length ? (
        <p className="muted" data-testid="banner-stats-empty">
          No visitor data yet: counts appear once visitors load a page that carries the hosted script.
        </p>
      ) : (
        <>
          <p className="muted">
            Last 30 days ({stats.from} to {stats.to}, UTC), per config version, newest first. Counts only: no visitor is identified.
          </p>
          {versions.map(({ config, summary: s }) => (
            <div key={config.hash} className="banner-stats-version" data-testid="banner-stats-version" data-hash={config.hash}>
              <h3 className="section-subtitle">
                Config <span className="mono">{config.hash.slice(0, 12)}</span>
                {config.firstServed ? <span className="muted"> · first served {config.firstServed.slice(0, 10)}</span> : null}
              </h3>
              <dl className="kb-facts">
                <div className="fact">
                  <dt>Page loads</dt>
                  <dd data-testid="stats-loads">{s.loads}</dd>
                </div>
                <div className="fact">
                  <dt>Banner shown</dt>
                  <dd data-testid="stats-shown">{s.shown}</dd>
                </div>
                <div className="fact">
                  <dt>Decisions</dt>
                  <dd data-testid="stats-decisions">
                    {s.decisions ? `${s.percent.accept}% accept · ${s.percent.reject}% reject · ${s.percent.custom}% custom (of ${s.decisions})` : <span className="muted">none yet</span>}
                  </dd>
                </div>
                <div className="fact">
                  <dt>Most common time to decide</dt>
                  <dd data-testid="stats-ttd">{s.commonTtd ?? <span className="muted">no timed decisions</span>}</dd>
                </div>
                <div className="fact">
                  <dt>Top regions</dt>
                  <dd data-testid="stats-regions">{s.regions.length ? s.regions.map((r) => `${r.label} (${r.loads})`).join(', ') : <span className="muted">none</span>}</dd>
                </div>
              </dl>
            </div>
          ))}
        </>
      )}
    </section>
  );
}

export function SitePageView({
  workspace,
  jobs,
  now,
  generate = {},
  onGenerate = () => {},
  onUpdateReport = () => {},
  checklist = {},
  onVerify,
  onMarkDone,
  rescan,
  onRescan,
  onSaveSettings,
  stats,
  statsError,
}: {
  /** Banner stats (undefined = the panel isn't wired, e.g. a static render). */
  stats?: ConsentStatsResponse | null;
  statsError?: string | null;
  workspace: SiteWorkspace;
  jobs: Record<string, JobSummary> | null;
  now: number;
  onSaveSettings?: (s: ConsentSettings) => Promise<void>;
  generate?: GenerateState;
  onGenerate?: (run: WorkspaceRun) => void;
  /** Retry the report re-render after a generate whose report step failed. */
  onUpdateReport?: () => void;
  checklist?: ChecklistState;
  onVerify?: (t: RemediationTask) => void;
  onMarkDone?: (t: RemediationTask) => void;
  rescan?: RescanState;
  onRescan?: (opts: { quick: boolean; slowRepeat: boolean; laws?: LawId[]; authorized?: true }) => void;
}) {
  const { openTasks, doneTasks, classifications } = summarizeWorkspace(workspace);
  const runs = siteRuns(workspace, jobs);
  const tasks = checklistFromWorkspace(workspace);
  const progress = checklistProgress(tasks);
  const downloads = configDownloads(workspace);
  const generatable = generatableRuns(runs, jobs);
  const latest = generatable[0];
  const latestJob = latestSiteJob(workspace, jobs);
  const download = (d: (typeof downloads)[number]) => {
    const url = URL.createObjectURL(new Blob([d.body], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = d.filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="kb site-page">
      <section className="panel" aria-labelledby="site-title">
        <p className="eyebrow">
          <a href="#sites">← All sites</a>
        </p>
        <h1 id="site-title" className="research-title">
          {workspace.domain}
        </h1>
        {latestJob ? (
          <p>
            <a className="btn btn-sm btn-primary" href={reportHref(latestJob.id)} data-testid="latest-report">
              Open the latest report
            </a>
          </p>
        ) : null}
        <dl className="kb-facts">
          <div className="fact">
            <dt>Checklist</dt>
            <dd data-testid="header-checklist">
              {tasks.length ? (
                <strong>
                  {progress.verified} of {progress.required} done
                </strong>
              ) : (
                <span className="muted">not generated yet</span>
              )}
            </dd>
          </div>
          <div className="fact">
            <dt>Classifications</dt>
            <dd data-testid="classifications">{classifications}</dd>
          </div>
          <div className="fact">
            <dt>Runs</dt>
            <dd>{runs.length}</dd>
          </div>
          <div className="fact" title="The report workbench’s own research notes (its “Saved progress” panel), not the to-do list above.">
            <dt>Report notes</dt>
            <dd data-testid="report-notes">
              {openTasks} open / {doneTasks} done
            </dd>
          </div>
        </dl>
      </section>

      <ChecklistPanel workspace={workspace} jobs={jobs} state={checklist} onVerify={onVerify} onMarkDone={onMarkDone} rescan={rescan} onRescan={onRescan} onSaveSettings={onSaveSettings} />

      <section className="panel" aria-labelledby="site-config">
        <h2 id="site-config" className="section-title">
          Consent tool config
        </h2>
        {workspace.config && downloads.length ? (
          <>
            <p className="muted">
              Generated <When iso={workspace.config.at} now={now} />
              {workspace.config.by ? ` by ${workspace.config.by}` : ''}
              {workspace.config.runId ? ` from run ${workspace.config.runId}` : ''}.
            </p>
            <p className="site-downloads">
              {downloads.map((d) => (
                <button key={d.filename} type="button" className="btn btn-sm" onClick={() => download(d)}>
                  Download {d.label.toLowerCase()}
                </button>
              ))}
            </p>
          </>
        ) : (
          <p className="muted">none yet</p>
        )}
        {latest ? (
          <p className="site-downloads">
            <GenerateButton run={latest} primary generate={generate} onGenerate={onGenerate} />
          </p>
        ) : (
          <p className="hint">Generating needs a finished consent scan of this site that is still on the service.</p>
        )}
        {generate.busyRunId ? (
          <p className="muted" role="status">
            Generating from run {generate.busyRunId}…
          </p>
        ) : null}
        {generate.error ? (
          <div className="banner-error" role="alert">
            {generate.error}
          </div>
        ) : null}
        {generate.reportFailed ? (
          <div className="banner-error" role="alert" data-testid="report-refresh-failed">
            <p>{REPORT_REFRESH_FAILED}</p>
            <p className="muted">Why: {generate.reportFailed.reason}</p>
            <p>
              <button type="button" className="btn btn-sm" disabled={generate.updating} aria-busy={generate.updating} onClick={onUpdateReport}>
                {generate.updating ? 'Updating the report…' : 'Update report'}
              </button>
            </p>
          </div>
        ) : null}
        {generate.done ? (
          <p className="muted" role="status">
            {generate.done.stale ? 'A newer config was already saved for this site, so this one was not stored.' : `Generated from run ${generate.done.runId}. The downloads above are the new config.`}
          </p>
        ) : null}
      </section>

      {stats !== undefined || statsError ? <BannerStatsPanel stats={stats} error={statsError} /> : null}

      <section className="panel" aria-labelledby="site-runs">
        <h2 id="site-runs" className="section-title">
          Runs
        </h2>
        {runs.length ? (
          <ol className="site-runs">
            {runs.map((r) => (
              <li key={r.id} className={`site-run${runEnded(r, jobs) ? ' is-muted' : ''}`} data-status={(r.jobId && jobs?.[r.jobId]?.status) || undefined}>
                <strong>
                  <When iso={r.at} now={now} />
                </strong>
                {r.url ? <span className="mono"> {r.url}</span> : null}
                <div>
                  <RunReport run={r} jobs={jobs} />
                  {generatable.includes(r) ? (
                    <>
                      {' · '}
                      <GenerateButton run={r} generate={generate} onGenerate={onGenerate} />
                    </>
                  ) : null}
                </div>
                {metaText(r.meta) ? <small className="muted">{metaText(r.meta)}</small> : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">No runs recorded yet.</p>
        )}
      </section>
    </div>
  );
}

export function SitePage({ domain, jobs }: { domain: string; jobs: Record<string, JobSummary> | null }) {
  const { data, error, refresh } = useSiteWorkspace(domain);
  const { data: stats, error: statsError } = useSiteStats(domain);
  // The checklist changes elsewhere too (a Verify in the report, the API, another tab):
  // re-read on focus / visibility and every 30 s while visible.
  useLiveRefresh(refresh);
  const now = useNow(30_000);
  const [reviewer] = useReviewer();
  const [generate, setGenerate] = useState<GenerateState>({});
  const onGenerate = async (run: WorkspaceRun) => {
    if (!run.jobId || generate.busyRunId) return;
    setGenerate({ busyRunId: run.id });
    try {
      // Generate AND re-render that run's report (rerender with generate: true), so the
      // config, the checklist here and the report's checklist agree in one step.
      const res = await api.rerender(run.jobId, { generate: true, ...(reviewer.trim() ? { by: reviewer.trim() } : {}) });
      await refresh(); // the new config, snippet and change list appear as downloads
      setGenerate({ done: { runId: res.runId, stale: res.config.stale === true } });
    } catch (err) {
      if (configStoredOf(err)) {
        // The config and the checklist are stored; only the report re-render failed.
        await refresh().catch(() => undefined);
        setGenerate({ reportFailed: { jobId: run.jobId, runId: run.id, reason: err instanceof Error ? err.message : String(err) } });
      } else setGenerate({ error: generateErrorText(err) });
    }
  };
  const onUpdateReport = async () => {
    const failed = generate.reportFailed;
    if (!failed || generate.updating) return;
    setGenerate({ ...generate, updating: true });
    try {
      const res = await api.rerender(failed.jobId, reviewer.trim() ? { by: reviewer.trim() } : {});
      setGenerate({ done: { runId: res.runId, stale: false } });
    } catch (err) {
      setGenerate({ reportFailed: { ...failed, reason: err instanceof Error ? err.message : String(err) } });
    }
  };
  const [rescan, setRescan] = useState<RescanState>({});
  const onRescan = async (opts: { quick: boolean; slowRepeat: boolean; laws?: LawId[]; authorized?: true }) => {
    if (rescan.busy) return;
    setRescan({ busy: true });
    try {
      const res = await api.rescan(domain, { quick: opts.quick, slowRepeat: opts.slowRepeat, ...(opts.laws ? { laws: opts.laws, authorized: opts.authorized } : {}) });
      notifyJobsChanged();
      setRescan({ started: { jobId: res.job.id, url: res.job.url, quick: res.job.quick, slowRepeat: res.job.slowRepeat } });
    } catch (err) {
      setRescan({ error: err instanceof Error ? err.message : String(err) });
    }
  };
  // A finished rescan records a run (and may carry statuses): re-read the site.
  const rescanStatus = rescan.started ? jobs?.[rescan.started.jobId]?.status : undefined;
  useEffect(() => {
    if (rescanStatus && rescanStatus !== 'queued' && rescanStatus !== 'running') void refresh();
  }, [rescanStatus, refresh]);
  const [checklist, setChecklist] = useState<ChecklistState>({});
  const failed = (id: string, message: string) => setChecklist((c) => ({ ...c, errors: { ...c.errors, [id]: message } }));
  const clear = (id: string) => setChecklist((c) => ({ ...c, errors: Object.fromEntries(Object.entries(c.errors ?? {}).filter(([k]) => k !== id)) }));
  const onVerify = async (task: RemediationTask) => {
    if (checklist.verifying) return;
    clear(task.id);
    setChecklist((c) => ({ ...c, verifying: task.id }));
    try {
      await api.verifyTask(domain, task.id);
      await refresh();
    } catch (err) {
      failed(task.id, `Could not run the check: ${err instanceof Error ? err.message : String(err)}. Nothing was changed.`);
    } finally {
      setChecklist((c) => ({ ...c, verifying: undefined }));
    }
  };
  const onMarkDone = async (task: RemediationTask) => {
    clear(task.id);
    setChecklist((c) => ({ ...c, saving: task.id }));
    const value = { status: task.status === 'done-unverified' ? 'todo' : 'done-unverified', ...(task.note ? { note: task.note } : {}), ...(task.lastVerify ? { lastVerify: task.lastVerify } : {}) };
    try {
      await api.patchWorkspace(domain, { ...(reviewer.trim() ? { by: reviewer.trim() } : {}), entries: { [TASK_CHANGE_PREFIX + task.id]: { value } } });
      await refresh();
    } catch (err) {
      failed(task.id, `Could not save: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setChecklist((c) => ({ ...c, saving: undefined }));
    }
  };
  const onSaveSettings = async (settings: ConsentSettings) => {
    await api.saveConsentSettings(domain, settings);
    await refresh();
  };
  return (
    <>
      {error ? (
        <div className="banner-error" role="alert">
          Couldn’t load {domain}: {error}
        </div>
      ) : null}
      {data ? <SitePageView workspace={data} jobs={jobs} now={now} generate={generate} onGenerate={onGenerate} onUpdateReport={onUpdateReport} checklist={checklist} onVerify={onVerify} onMarkDone={onMarkDone} rescan={rescan} onRescan={onRescan} onSaveSettings={onSaveSettings} stats={stats} statsError={statsError} /> : error ? null : <div className="skeleton" aria-busy="true" aria-label="Loading site"><div className="skeleton-card" /></div>}
    </>
  );
}
