import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ConsentSettings, JobReportResponse, ScanHistoryItem, OwnerCell, OwnerColumn, OwnerReport, OwnerToolActivity, OwnerToolRow, RemediationTask } from '../../shared/api';
import { LAWS, type LawId } from '../../shared/laws';
import { reportSeverity, scoreReport, type Severity } from '../../shared/score';
import { api } from '../lib/api';
import { notifyJobsChanged } from '../lib/useJobs';
import { JobLaws, LawProgress, RescanButton } from './Laws';
import { ConsentSettingsForm } from './ConsentSettingsForm';
import { bannerFromCmp, COMPANION_LIST_NOTE } from '../lib/consentSettings';
import { lawRows, type LawRow } from '../lib/laws';
import { tabReport } from '../lib/lawReport';
import { formatAbsolute, formatClock, jobDuration, STATUS_LABEL as JOB_STATUS_LABEL } from '../lib/format';
import { COMPANION_INSTALL_SUMMARY, installSnippet, openDecisions, STATUS_LABEL as TASK_STATUS_LABEL, TASK_CHANGE_PREFIX } from '../lib/checklist';
import { copyText, useReviewer } from '../lib/useKb';
import { useJobReport } from '../lib/useJobReport';
import { reportHref } from '../lib/useHashView';
import { useNow } from '../lib/useNow';
import { answersAfter, categoryLabel, sameCategories, shownData, toolJudgeable } from '../lib/shown';

// The report page (plans/simple-report.md): one scan, four parts, in order —
// scan status (only while scanning), consent banner, the matrix, the to-do
// list — and one small "Technical details" link to the full HTML report.
// Nothing else. ReportPageView is pure (render tests); ReportPage wires it.

/**
 * What an owner can say a tool the scan does not know is for: the law's four categories (plans/report-truth.md D3).
 * Facts, not verdicts: complykit decides what needs consent. Older stored ids (payments, chat, embed, reviews, cdn,
 * captcha, ...) keep working and are labelled by `categoryLabel`.
 */
export const PURPOSES: Array<{ id: string; label: string; help: string }> = [
  { id: 'necessary', label: 'Necessary', help: 'The site breaks without it: login, cart, security, payments' },
  { id: 'functional', label: 'Functional', help: 'A feature or preference: chat, video, reviews, saved choices' },
  { id: 'analytics', label: 'Analytics', help: 'Measures visits and what people do' },
  { id: 'advertising', label: 'Advertising', help: 'Ads, retargeting, marketing, conversion tracking' },
];

const CELL_ICON: Record<OwnerCell['state'], string> = { pending: '', ok: '✓', mismatch: '✕', 'needs-decision': '?', 'not-checked': '–', 'not-applicable': '∅', blocked: '⊘' };
const CELL_TEXT: Record<OwnerCell['state'], string> = {
  pending: 'Checking…',
  ok: 'As expected',
  mismatch: 'Problem: running when it should be off',
  'needs-decision': 'Tell us what this tool is for',
  'not-checked': 'Couldn’t test — the scan could not complete this',
  'not-applicable': 'Not applicable — nothing to test',
  blocked: 'Blocked — a visitor can’t do this either (a problem)',
};
/** Column states that carry a note shown once under the matrix, with the icon its cells use. */
const GAP_ICON: Partial<Record<OwnerColumn['state'], string>> = { 'not-checked': '–', 'not-applicable': '∅', blocked: '⊘' };

export interface ReportActions {
  onCancel?: () => void;
  /** Save what an unclassified tool is for (class:<key>). */
  onClassify?: (classKey: string, purpose: string) => void;
  onVerify?: (task: RemediationTask) => void;
  onMarkDone?: (task: RemediationTask) => void;
  onRescan?: (extra?: { laws?: LawId[]; authorized?: true }) => void;
  /** Make the list when none was made (or making it failed). */
  onMakeList?: () => void;
  onCopy?: (text: string) => Promise<boolean>;
  /** Save the install task's settings (rejects with the reason to show). */
  onSaveSettings?: (settings: ConsentSettings) => Promise<void>;
  /** Delete this scan (after the owner confirms). */
  onDelete?: () => void;
}

export interface ReportUiState {
  /** Answers given on this page that the served report may not hold yet: classKey → category set. The page judges with them at once. */
  answers?: Record<string, string[]>;
  /** classKey being saved. */
  saving?: string;
  verifying?: string;
  marking?: string;
  rescanning?: boolean;
  makingList?: boolean;
  deleting?: boolean;
  /** Per task id / classKey / 'rescan' / 'list': what went wrong. */
  errors?: Record<string, string>;
}

// --- a. Scan status -------------------------------------------------------------

/** Pages visited: the report's; before a multi-law job's merged report exists, the most any one law has visited (laws mostly visit the same pages, so a sum would overcount). */
export function pagesVisited(data: JobReportResponse): number {
  if (data.report) return data.report.scan.pagesVisited;
  return Math.max(0, ...(data.laws ?? []).map((l) => l.report?.scan.pagesVisited ?? 0));
}

export function ScanStatus({ data, now, onCancel }: { data: JobReportResponse; now: number; onCancel?: () => void }) {
  const { job, report } = data;
  if (job.status !== 'queued' && job.status !== 'running') return null;
  const done = report?.scan.visitsDone ?? job.progress.done;
  const total = report?.scan.visitsTotal || job.progress.total;
  const pct = Math.round(Math.max(0, Math.min(1, total ? done / total : job.progress.fraction)) * 100);
  const manyLaws = (job.laws?.length ?? 0) >= 2;
  const current = manyLaws ? undefined : report?.scan.current ?? (job.progress.phase === 'verifying-location' ? 'Checking the test location' : job.progress.phase === 'analyzing' ? 'Preparing your findings' : undefined);
  return (
    <section className="rp-section rp-status" aria-labelledby="rp-status-title" data-testid="scan-status">
      <div className="rp-status-head">
        <h2 id="rp-status-title" className="rp-h2">
          <span className="rp-spinner" aria-hidden="true" />
          {job.status === 'queued' ? 'Waiting to start…' : `Scanning ${job.host}…`}
        </h2>
        {onCancel ? (
          <button type="button" className="btn btn-sm btn-secondary" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
      <div className="rp-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Scan progress">
        <span style={{ width: `${pct}%` }} />
      </div>
      <LawProgress job={job} report={report} />
      <dl className="rp-facts">
        <div>
          <dt>Visits</dt>
          <dd data-testid="visits">{total ? `${done} of ${total}` : '—'}</dd>
        </div>
        <div>
          <dt>Pages</dt>
          <dd data-testid="pages">{pagesVisited(data)}</dd>
        </div>
        <div>
          <dt>Time</dt>
          <dd data-testid="elapsed">{formatClock(jobDuration(job, now))}</dd>
        </div>
        {current ? (
          <div>
            <dt>Now</dt>
            <dd data-testid="current">{current}</dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}

// --- b. Consent banner ----------------------------------------------------------

export function BannerLine({ data }: { data: JobReportResponse }) {
  const b = data.report?.banner;
  const scanning = data.job.status === 'queued' || data.job.status === 'running';
  let body: ReactNode;
  if (!b || b.state === 'pending') {
    body = scanning ? (
      <>
        <span className="rp-spinner" aria-hidden="true" /> Looking for a consent banner…
      </>
    ) : (
      <span className="muted">The scan did not get far enough to look for a consent banner.</span>
    );
  } else if (b.state === 'detected') {
    body = (
      <>
        <span className="rp-dot rp-dot-ok" aria-hidden="true" />
        Consent banner: <strong>{b.provider ?? 'detected (provider not recognized)'}</strong>
      </>
    );
  } else {
    body = (
      <>
        <span className="rp-dot rp-dot-bad" aria-hidden="true" />
        <strong>{b.broken ? 'Your consent tool is broken: no visitor gets a banner' : 'No consent banner detected'}</strong>
        {b.broken ? (
          <span className="muted" data-testid="banner-broken">
            {' '}— {b.broken.reason.replace(/^the /, 'The ')}. Trackers it should hold back run as if there were no consent tool.
          </span>
        ) : b.consentTools?.length ? (
          <span className="muted">— {b.consentTools.join(', ')} {b.consentTools.length === 1 ? 'is' : 'are'} on the site, but no banner appeared.</span>
        ) : null}
      </>
    );
  }
  return (
    <section className="rp-section rp-banner" aria-label="Consent banner" data-testid="banner" data-state={b?.state ?? 'pending'}>
      <p>{body}</p>
    </section>
  );
}

// --- c. The matrix ----------------------------------------------------------------

function CellButton({ cell, label, selected, onSelect }: { cell: OwnerCell; label: string; selected: boolean; onSelect: () => void }) {
  if (cell.state === 'pending') {
    return (
      <span className="rp-cell" data-state="pending" role="img" aria-label={`${label}: checking`}>
        <span className="rp-spinner rp-spinner-sm" aria-hidden="true" />
      </span>
    );
  }
  return (
    <button type="button" className="rp-cell" data-state={cell.state} aria-pressed={selected} aria-label={`${label}: ${CELL_TEXT[cell.state]}`} title={CELL_TEXT[cell.state]} onClick={onSelect}>
      {CELL_ICON[cell.state]}
    </button>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a tool row is: a tool that only makes requests, or one that also stores cookies / storage. */
export function activityLine(a: OwnerToolActivity | undefined): string | undefined {
  if (!a) return undefined;
  const stores = [a.cookies ? plural(a.cookies, 'cookie') : '', a.storage ? plural(a.storage, 'storage key') : ''].filter(Boolean);
  return stores.length ? `sets ${stores.join(' and ')}` : 'requests only, no cookies';
}

const fileOf = (url: string) => {
  try {
    const u = new URL(url);
    return u.pathname.split('/').filter(Boolean).pop() ?? u.hostname;
  } catch {
    return url;
  }
};

/** What the scan saw a tool do — enough to tell what it is at a glance: where it is hosted, what it stored, the addresses it loaded. */
function ToolEvidence({ tool }: { tool: OwnerToolRow }) {
  const a = tool.activity;
  if (!a) return null;
  const stored = a.cookies + a.storage;
  return (
    <div className="rp-evidence" data-testid="tool-evidence">
      {a.hostedOn ? (
        <p>
          Hosted on <strong>{a.hostedOn.provider}</strong>, in storage named “{a.hostedOn.name}”.
          {a.hostedOn.matchesSite ? ' The name matches your site, so it is probably your own.' : ''}
        </p>
      ) : null}
      <p className="muted">
        {plural(a.requests, 'request')} across {plural(a.visits, 'visit')}. {stored ? `Set ${activityLine(a)!.replace(/^sets /, '')}.` : 'Set no cookies or browser storage.'}
        {a.loadedBy.length ? (
          <>
            {' '}Loaded by{' '}
            {a.loadedBy.slice(0, 2).map((u, i) => (
              <Fragment key={u}>
                {i ? ', ' : ''}
                <code title={u}>{fileOf(u)}</code>
              </Fragment>
            ))}
            .
          </>
        ) : null}
      </p>
      {a.samples.length ? (
        <details className="rp-urls">
          <summary>Addresses it loaded ({a.samples.length})</summary>
          <ul>
            {a.samples.map((u) => (
              <li key={u}>
                <code>{u}</code>
              </li>
            ))}
          </ul>
          <p className="muted">Query values are left out; they can carry visitor data.</p>
        </details>
      ) : null}
    </div>
  );
}

function PurposePicker({ classKey, label, busy, error, onClassify, hideLegend }: { classKey: string; label: string; busy?: boolean; error?: string; onClassify?: (classKey: string, purpose: string) => void; hideLegend?: boolean }) {
  const id = useId();
  return (
    <fieldset className="rp-picker" data-testid="purpose-picker" data-class-key={classKey} disabled={busy || !onClassify}>
      <legend id={id} className={hideLegend ? 'visually-hidden' : undefined}>What is {label} for?</legend>
      <div className="rp-picker-options">
        {PURPOSES.map((p) => (
          <button key={p.id} type="button" className="btn btn-sm btn-secondary" title={p.help} data-purpose={p.id} onClick={() => onClassify?.(classKey, p.id)}>
            {p.label}
          </button>
        ))}
      </div>
      <p className="rp-help muted">{busy ? 'Saving…' : 'Not sure? Ask whoever added it to the site. Your answer is saved for this site.'}</p>
      {error ? (
        <p className="rp-error" role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

function CellDetail({ cell, row, column }: { cell: OwnerCell; row: string; column: string }) {
  return (
    <div className="rp-detail" data-testid="cell-detail">
      <p>
        <strong>
          {row} · {column}:
        </strong>{' '}
        {CELL_TEXT[cell.state]}
      </p>
      <dl>
        {cell.expected ? (
          <div>
            <dt>Expected</dt>
            <dd>{cell.expected}</dd>
          </div>
        ) : null}
        {cell.observed ? (
          <div>
            <dt>What we saw</dt>
            <dd>{cell.observed}</dd>
          </div>
        ) : null}
      </dl>
      {cell.reason ? <p className="muted">{cell.reason}</p> : null}
    </div>
  );
}

/** `data` is what the page SHOWS: already judged with the owner's answers (see ReportPageView). */
export function Matrix({ data, ui = {}, actions = {} }: { data: JobReportResponse; ui?: ReportUiState; actions?: ReportActions }) {
  const report = data.report;
  const scanning = data.job.status === 'queued' || data.job.status === 'running';
  const [open, setOpen] = useState<{ row: string; col?: number } | null>(null);
  const toggle = (row: string, col?: number) => setOpen((o) => (o && o.row === row && o.col === col ? null : { row, col }));
  // Tools start folded: their cookies and storage show when the tool is opened.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggleTool = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  if (!report) {
    return (
      <section className="rp-section" aria-labelledby="rp-matrix-title" data-testid="matrix">
        <h2 id="rp-matrix-title" className="rp-h2">
          Tools and cookies
        </h2>
        <p className="muted">{scanning ? 'Tools and cookies appear here as the scan finds them.' : 'Nothing was recorded.'}</p>
      </section>
    );
  }
  const { columns, tools } = report.matrix;
  const gaps = columns.filter((c) => GAP_ICON[c.state] !== undefined);
  const unverified = report.scan.location && !report.scan.location.verified;
  const colName = (i: number) => columns[i].label + (columns[i].locationLabel ? ` (${columns[i].locationLabel})` : '');
  const span = columns.length + 1;
  return (
    <section className="rp-section" aria-labelledby="rp-matrix-title" data-testid="matrix">
      <h2 id="rp-matrix-title" className="rp-h2">
        Tools and cookies
      </h2>
      <p className="rp-legend muted" aria-label="Legend">
        <span>
          <b data-state="ok">✓</b> as expected
        </span>
        <span>
          <b data-state="mismatch">✕</b> problem
        </span>
        <span>
          <b data-state="needs-decision">?</b> tell us what this tool is for
        </span>
        <span>
          <b data-state="blocked">⊘</b> blocked: a visitor can’t do this either (a problem)
        </span>
        <span>
          <b data-state="not-checked">–</b> couldn’t test: the scan could not complete this
        </span>
        <span>
          <b data-state="not-applicable">∅</b> not applicable: nothing to test
        </span>
        {scanning ? (
          <span>
            <span className="rp-spinner rp-spinner-sm" aria-hidden="true" /> checking
          </span>
        ) : null}
      </p>
      {unverified ? (
        <p className="rp-note" role="note">
          We could not confirm where the scan was running from{report.scan.location?.note ? ` (${report.scan.location.note})` : ''}, so nothing was checked.
        </p>
      ) : null}
      {columns.length ? (
        <div className="rp-table-wrap" tabIndex={0} role="region" aria-label="Tools and cookies by visitor action, scrollable">
          <table className="rp-matrix">
            <thead>
              <tr>
                <th scope="col">Tool / cookie it sets</th>
                {columns.map((c) => (
                  <th key={c.id} scope="col" data-state={c.state} title={c.note}>
                    {c.label}
                    {c.locationLabel ? <small>{c.locationLabel}</small> : null}
                    {c.state === 'running' ? <span className="rp-spinner rp-spinner-sm" aria-label="visiting now" /> : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tools.length === 0 ? (
                <tr>
                  <td colSpan={span} className="muted rp-empty">
                    {scanning ? 'Tools and cookies appear here as the scan finds them.' : 'No outside tools or cookies were seen.'}
                  </td>
                </tr>
              ) : null}
              {tools.map((t) => {
                const decide = !t.classified;
                const isOpen = expanded.has(t.id);
                const rows = [
                  { key: t.id, name: t.label, sub: ui.answers?.[t.classKey] && !toolJudgeable(t) ? 'Saved — the report updates shortly' : t.purpose, cells: t.cells, tool: true, unclassified: !t.classified },
                  ...(isOpen ? t.cookies : []).map((k) => ({ key: k.id, name: k.name, sub: k.kind === 'cookie' ? 'cookie' : `${k.kind} storage`, cells: k.cells, tool: false, unclassified: !k.classified })),
                ];
                return (
                  <Fragment key={t.id}>
                    {rows.map((r) => (
                      <Fragment key={r.key}>
                        <tr className={r.tool ? 'rp-tool' : 'rp-cookie'} data-row={r.key}>
                          <th scope="row">
                            {r.tool && t.cookies.length ? (
                              <button type="button" className="rp-fold" aria-expanded={isOpen} aria-label={`${isOpen ? 'Hide' : 'Show'} the ${plural(t.cookies.length, 'cookie or storage key', 'cookies and storage keys')} ${t.label} sets`} onClick={() => toggleTool(t.id)}>
                                <span aria-hidden="true">▸</span>
                              </button>
                            ) : null}
                            <button type="button" className="rp-row-label" aria-expanded={open?.row === r.key && open.col === undefined} onClick={() => toggle(r.key)}>
                              {r.name}
                            </button>
                            <small data-unclassified={r.unclassified ? 'true' : undefined}>{r.sub}</small>
                            {r.tool && activityLine(t.activity) ? (
                              <small className="rp-activity" data-stores={t.activity!.cookies + t.activity!.storage > 0 ? 'true' : 'false'}>
                                {activityLine(t.activity)}
                              </small>
                            ) : null}
                          </th>
                          {r.cells.map((c, i) => (
                            <td key={columns[i]?.id ?? i}>
                              <CellButton cell={c} label={`${r.name} · ${colName(i)}`} selected={open?.row === r.key && open.col === i} onSelect={() => toggle(r.key, i)} />
                            </td>
                          ))}
                        </tr>
                        {open?.row === r.key ? (
                          <tr className="rp-open">
                            <td colSpan={span}>
                              {open.col !== undefined && r.cells[open.col] ? (
                                <CellDetail cell={r.cells[open.col]} row={r.name} column={colName(open.col)} />
                              ) : r.tool && decide ? (
                                <>
                                  <ToolEvidence tool={t} />
                                  <PurposePicker classKey={t.classKey} label={t.label} busy={ui.saving === t.classKey} error={ui.errors?.[t.classKey]} onClassify={actions.onClassify} />
                                </>
                              ) : (
                                <div className="rp-detail">
                                  <p>
                                    <strong>{r.name}</strong> — {r.tool ? `${t.purpose}${t.recognized ? '' : ' (classified by your team)'} · ${t.domain}` : `set by ${t.label}; ${r.sub}`}.
                                  </p>
                                  {r.tool ? <ToolEvidence tool={t} /> : null}
                                  <p className="muted">Select a symbol in the row to see what the scan saw.</p>
                                </div>
                              )}
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : unverified ? null : (
        <p className="muted">{scanning ? 'Planning the visits…' : 'No visits were made.'}</p>
      )}
      {gaps.length ? (
        <ul className="rp-gaps" data-testid="column-gaps">
          {gaps.map((g) => (
            <li key={g.id} data-state={g.state}>
              <b>
                {GAP_ICON[g.state]} {g.label}:
              </b>{' '}
              {g.note}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

// --- d. The to-do list -------------------------------------------------------------

const STATUS_PILL: Record<RemediationTask['status'], string> = { todo: 'pill-queued', 'done-unverified': 'pill-marked', verified: 'pill-done', failed: 'pill-failed', 'cannot-verify': 'pill-marked' };
const finishedTask = (t: RemediationTask) => t.status === 'verified' || t.status === 'done-unverified';

/** Every required item done (verified, decided, or marked done): the final scan opens up. */
export function readyForFinalScan(tasks: RemediationTask[]): boolean {
  const req = tasks.filter((t) => !t.optional);
  return req.length > 0 && req.every(finishedTask);
}

/** Whether a decision is made: the shown tool row says so; a decision for a tool the report does not list follows its own status. */
function decisionDone(d: RemediationTask, report: OwnerReport | null): boolean {
  const tool = d.classKey ? report?.matrix.tools.find((x) => x.classKey === d.classKey) : undefined;
  return tool ? tool.classified : d.status === 'verified';
}

/** A decision. Done, refused and answered all come from `tool`, the shown (judged) row, never from the server's task. */
function DecisionTodo({ label, classKey, taskDone, ui, actions, unblocks, tool }: { label: string; classKey: string; taskDone?: boolean; ui: ReportUiState; actions: ReportActions; unblocks?: string[]; tool?: OwnerToolRow }) {
  const [changing, setChanging] = useState(false);
  const done = tool ? tool.classified : !!taskDone;
  const refused = tool?.answer && !tool.answer.applied ? (tool.answer.reason ?? '') : undefined;
  // Classified with no answer on the site: the knowledge base's own classification, not the owner's.
  const known = !!tool && tool.classified && !tool.answer;
  return (
    <li className="rp-todo" data-kind="classify" data-status={done ? 'verified' : 'todo'} data-refused={refused !== undefined ? 'true' : undefined}>
      <div className="rp-todo-head">
        <strong>What is {label} for?</strong>
        <span className={`pill ${done ? 'pill-done' : 'pill-queued'}`}>{done ? (refused !== undefined ? 'Answered' : 'Decided ✓') : 'To decide'}</span>
      </div>
      <p className="muted">
        {known ? 'complykit already knows this tool; a different answer would change' : 'The scan doesn’t know this tool. Your answer decides'} whether it needs consent
        {unblocks?.length ? ` — and ${unblocks.length === 1 ? 'one change below' : `${unblocks.length} changes below`}` : ''}.
      </p>
      {tool && !(done && !changing) ? <ToolEvidence tool={tool} /> : null}
      {done && !changing ? (
        <p>
          {refused !== undefined ? (
            <>
              Answered: <strong>{categoryLabel(tool?.answer?.categories ?? [])}</strong>. complykit treats it as needing consent: {refused.replace(/\.$/, '')}.{' '}
            </>
          ) : tool?.answer ? (
            <>Your answer: <strong>{categoryLabel(tool.answer.categories)}</strong>. </>
          ) : tool ? (
            <>complykit knows it: <strong>{tool.purpose}</strong>. </>
          ) : (
            <>Your answer is saved for this site. </>
          )}
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setChanging(true)}>
            Change
          </button>
        </p>
      ) : (
        <PurposePicker
          hideLegend
          classKey={classKey}
          label={label}
          busy={ui.saving === classKey}
          error={ui.errors?.[classKey]}
          onClassify={(k, p) => {
            setChanging(false);
            actions.onClassify?.(k, p);
          }}
        />
      )}
    </li>
  );
}

function SnippetBlock({ text, label, onCopy }: { text: string; label: string; onCopy?: (t: string) => Promise<boolean> }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <div className="rp-snippet">
      <div className="rp-snippet-head">
        <span>{label}</span>
        {onCopy ? (
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => void onCopy(text).then(setCopied)}>
            {copied === true ? 'Copied ✓' : copied === false ? 'Copy failed' : 'Copy'}
          </button>
        ) : null}
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}

function ChangeTodo({ task, tasks, data, ui, actions, current }: { task: RemediationTask; tasks: RemediationTask[]; data: JobReportResponse; ui: ReportUiState; actions: ReportActions; current?: boolean }) {
  const waiting = openDecisions(task, tasks).filter((d) => !decisionDone(d, data.report));
  const verifying = ui.verifying === task.id;
  const cs = data.consentSettings;
  const companion = task.kind === 'install' && cs?.settings.mode === 'companion';
  // Add-on mode: the install steps for keeping the site's banner.
  const steps = companion && task.companionSteps?.length ? task.companionSteps : task.steps.map((s, i) => task.stepVariants?.find((v) => v.step === i)?.service ?? s);
  return (
    <li className="rp-todo" data-kind={task.kind} data-task-id={task.id} data-status={task.status}>
      <div className="rp-todo-head">
        <strong>{task.title}</strong>
        <span className={`pill ${STATUS_PILL[task.status]}`}>{TASK_STATUS_LABEL[task.status]}</span>
      </div>
      <p className="muted">{companion ? COMPANION_INSTALL_SUMMARY : task.summary}</p>
      {waiting.length ? (
        <p className="rp-note">Waiting on your answer about {waiting.map((d) => d.tools[0] ?? d.title).join(', ')} (above).</p>
      ) : (
        <details className="rp-howto" open={current || task.status === 'failed'}>
          <summary>How to do it</summary>
          {steps.length ? (
            <ol className="rp-steps">
              {steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          ) : null}
          {task.kind === 'install' && data.hostedScriptUrl ? (
            <SnippetBlock text={installSnippet(data.hostedScriptUrl)} label={companion ? 'Paste in <head>' : 'Paste first in <head>'} onCopy={actions.onCopy} />
          ) : task.snippet?.after ? (
            <SnippetBlock text={task.snippet.after} label={task.kind === 'install' ? (companion ? 'Paste in <head>' : 'Paste first in <head>') : 'Change it to'} onCopy={actions.onCopy} />
          ) : null}
          {task.kind === 'install' && cs && actions.onSaveSettings ? (
            <ConsentSettingsForm key={JSON.stringify(cs.settings)} settings={cs.settings} defaults={cs.defaults ?? {}} detectedBanner={cs.detectedBanner ?? bannerFromCmp(cs.detectedCmp)} categoryIds={cs.categoryIds} onSave={actions.onSaveSettings} />
          ) : null}
          {task.snippet?.before ? (
            <details className="rp-before">
              <summary>What it looks like now</summary>
              <pre>
                <code>{task.snippet.before}</code>
              </pre>
            </details>
          ) : null}
          {task.pages.length ? (
            <p className="muted rp-pages">
              On: {task.pages.slice(0, 3).join(', ')}
              {task.pages.length > 3 ? ` and ${task.pages.length - 3} more` : ''}
            </p>
          ) : null}
          {task.alsoFixes?.length ? <p className="muted">This also fixes: {task.alsoFixes.join(' · ')}</p> : null}
        </details>
      )}
      {waiting.length ? null : (
        <div className="rp-todo-actions">
          {task.verify.method !== 'manual' ? (
            <button type="button" className="btn btn-sm btn-primary" disabled={!!ui.verifying || !actions.onVerify} aria-busy={verifying} onClick={() => actions.onVerify?.(task)}>
              {verifying ? 'Checking your site…' : task.lastVerify ? 'Verify again' : 'Verify'}
            </button>
          ) : null}
          {task.status !== 'verified' ? (
            <button type="button" className="btn btn-sm btn-ghost" aria-pressed={task.status === 'done-unverified'} disabled={ui.marking === task.id || !actions.onMarkDone} onClick={() => actions.onMarkDone?.(task)}>
              {task.status === 'done-unverified' ? 'Undo “done”' : task.verify.method === 'manual' ? 'I’ve done this' : 'Mark done without checking'}
            </button>
          ) : null}
        </div>
      )}
      {verifying ? (
        <p className="muted" role="status">
          Checking the live page… a browser check can take up to a minute.
        </p>
      ) : task.lastVerify ? (
        <p className="rp-last" role="status" data-result={task.lastVerify.result}>
          <strong>Last check:</strong> {task.lastVerify.message}
        </p>
      ) : null}
      {ui.errors?.[task.id] ? (
        <p className="rp-error" role="alert">
          {ui.errors[task.id]}
        </p>
      ) : null}
    </li>
  );
}

/** `data` is what the page SHOWS: already judged with the owner's answers (see ReportPageView). */
export function TodoList({ data, ui = {}, actions = {} }: { data: JobReportResponse; ui?: ReportUiState; actions?: ReportActions }) {
  const { todo, report, job } = data;
  const tasks = todo.state === 'ready' ? todo.tasks : [];
  const required = tasks.filter((t) => !t.optional);
  const optional = tasks.filter((t) => t.optional);
  // Before the checklist exists: the decisions the scan has found so far are the first items.
  const liveDecisions = todo.state === 'ready' ? [] : (report?.decisions ?? []);
  const toolFor = (classKey?: string) => (classKey ? report?.matrix.tools.find((x) => x.classKey === classKey) : undefined);
  const isDone = (t: RemediationTask) => (t.kind === 'classify' && t.classKey ? decisionDone(t, report) : finishedTask(t));
  const doneCount = required.filter(isDone).length;
  const canRescan = todo.state === 'ready' && required.length > 0 && required.every(isDone);
  const scanning = job.status === 'queued' || job.status === 'running';
  // The change to do next shows its steps open; the rest stay folded.
  const nextId = required.find((t) => t.kind !== 'classify' && !finishedTask(t) && !openDecisions(t, tasks).some((d) => !decisionDone(d, report)))?.id;
  // Done items (required or optional) move to a folded "Completed" list at the bottom.
  const optionalOpen = optional.filter((t) => !isDone(t));
  const completed = tasks.filter(isDone);
  const item = (t: RemediationTask) =>
    t.kind === 'classify' && t.classKey ? (
      <DecisionTodo key={t.id} label={t.tools[0] ?? t.title} classKey={t.classKey} taskDone={t.status === 'verified'} ui={ui} actions={actions} unblocks={tasks.filter((x) => x.waitingOn?.includes(t.id)).map((x) => x.title)} tool={toolFor(t.classKey)} />
    ) : (
      <ChangeTodo key={t.id} task={t} tasks={tasks} data={data} ui={ui} actions={actions} current={t.id === nextId} />
    );
  return (
    <section className="rp-section" aria-labelledby="rp-todo-title" data-testid="todo" data-state={todo.state}>
      <h2 id="rp-todo-title" className="rp-h2">
        Your to-do list
      </h2>
      {data.updating ? (
        <p className="muted" role="status" data-testid="updating">
          <span className="rp-spinner rp-spinner-sm" aria-hidden="true" /> Updating the report with your answers…
        </p>
      ) : data.updateError ? (
        <p className="rp-error" role="alert" data-testid="update-error">
          The report could not be updated with your latest answer ({data.updateError}). It updates again on your next answer.
        </p>
      ) : null}
      {todo.state === 'ready' && data.consentSettings?.settings.mode === 'companion' ? (
        <p className="muted rp-note" data-testid="companion-note">
          {COMPANION_LIST_NOTE}
        </p>
      ) : null}
      {todo.state === 'ready' && todo.fromThisRun === false ? <p className="muted rp-note">This list comes from an earlier scan of this site; your progress on it is kept.</p> : null}
      {/* Folded by default to a summary; with no list yet, the make-my-list prompt shows as is. */}
      <TodoFold fold={todo.state !== 'error' && todo.state !== 'none'} summary={<TodoSummary state={todo.state} done={doneCount} required={required.length} optional={optional.length} decisions={liveDecisions.length} scanning={scanning} />}>
      <ol className="rp-todos">
        {liveDecisions.map((d) => (
          <DecisionTodo key={d.classKey} label={d.label} classKey={d.classKey} ui={ui} actions={actions} tool={toolFor(d.classKey)} />
        ))}
        {required.filter((t) => !isDone(t)).map(item)}
        {todo.state === 'waiting' ? (
          <li className="rp-todo rp-todo-placeholder" data-testid="todo-waiting">
            <span className="muted">{scanning ? 'The rest of your list — the changes to make on your site — appears when the scan finishes.' : 'The rest of your list appears when the scan finishes.'}</span>
          </li>
        ) : null}
        {todo.state === 'preparing' ? (
          <li className="rp-todo rp-todo-placeholder" data-testid="todo-preparing">
            <span className="rp-spinner rp-spinner-sm" aria-hidden="true" /> Preparing the changes to make on your site…
          </li>
        ) : null}
        {todo.state === 'error' || (todo.state === 'none' && job.status === 'done' && report) ? (
          <li className="rp-todo rp-todo-placeholder" data-testid="todo-make">
            {todo.error ? <p className="rp-error">Your list couldn’t be made: {todo.error}</p> : <p className="muted">Your list of changes hasn’t been made yet.</p>}
            {data.newerScan ? (
              <p className="muted">
                The list is made from the latest scan. <a href={reportHref(data.newerScan.jobId)}>Open the latest report</a>
              </p>
            ) : (
              <button type="button" className="btn btn-sm btn-primary" disabled={ui.makingList || !actions.onMakeList} onClick={actions.onMakeList}>
                {ui.makingList ? 'Making your list…' : todo.error ? 'Try again' : 'Make my to-do list'}
              </button>
            )}
            {ui.errors?.list ? <p className="rp-error">{ui.errors.list}</p> : null}
          </li>
        ) : null}
        {optionalOpen.length ? (
          <li className="rp-todo rp-todo-optional">
            <details>
              <summary>Only if they apply ({optionalOpen.length})</summary>
              <ol className="rp-todos">
                {optionalOpen.map(item)}
              </ol>
            </details>
          </li>
        ) : null}
        {completed.length ? (
          <li className="rp-todo rp-todo-optional rp-todo-completed" data-testid="todo-completed">
            <details>
              <summary>Completed ({completed.length})</summary>
              <ol className="rp-todos">{completed.map(item)}</ol>
            </details>
          </li>
        ) : null}
        {job.checks.includes('consent') ? (
          <li className="rp-todo rp-todo-final" data-kind="final-scan" data-testid="final-scan">
            <div className="rp-todo-head">
              <strong>Run the final scan</strong>
            </div>
            <p className="muted">{canRescan ? 'Everything above is done. A new scan shows how your site behaves now.' : scanning ? 'After this scan, once everything above is done.' : 'Opens up when everything above is done.'}</p>
            <div className="rp-todo-actions">
              <RescanButton className="btn btn-sm btn-primary" laws={data.job.laws} busy={ui.rescanning} disabled={!canRescan} onRescan={actions.onRescan}>
                {ui.rescanning ? 'Starting…' : 'Run the final scan'}
              </RescanButton>
            </div>
            {ui.errors?.rescan ? (
              <p className="rp-error" role="alert">
                {ui.errors.rescan}
              </p>
            ) : null}
          </li>
        ) : null}
      </ol>
      </TodoFold>
    </section>
  );
}

function TodoFold({ fold, summary, children }: { fold: boolean; summary: ReactNode; children: ReactNode }) {
  if (!fold) return <>{children}</>;
  return (
    <details className="rp-todo-fold" data-testid="todo-fold">
      <summary data-testid="todo-summary">
        {summary}
        <span className="rp-todo-toggle" aria-hidden="true">
          <span className="rp-todo-show">Show tasks ▾</span>
          <span className="rp-todo-hide">Hide tasks ▴</span>
        </span>
      </summary>
      {children}
    </details>
  );
}

/** The to-do list folded: how much is left, big enough to read at a glance. */
function TodoSummary({ state, done, required, optional, decisions, scanning }: { state: JobReportResponse['todo']['state']; done: number; required: number; optional: number; decisions: number; scanning: boolean }) {
  if (state === 'ready') {
    const left = required - done;
    return (
      <span className="rp-todo-sum" data-testid="todo-progress">
        <span className="rp-todo-big">
          {done}
          <span className="rp-todo-of"> of {required} done</span>
        </span>
        <span className="rp-todo-meter" aria-hidden="true">
          <span style={{ width: `${required ? (100 * done) / required : 100}%` }} />
        </span>
        <span className="muted">
          {left === 0 ? 'Nothing left to do.' : `${plural(left, 'task')} left`}
          {optional ? ` · ${optional} only if they apply` : ''}
        </span>
      </span>
    );
  }
  if (state === 'preparing') return <span className="rp-todo-sum muted">Preparing the changes to make on your site…</span>;
  if (state === 'waiting')
    return (
      <span className="rp-todo-sum">
        {decisions ? <span className="rp-todo-big">{plural(decisions, 'tool')} to describe</span> : null}
        <span className="muted">{scanning ? 'The changes to make on your site appear when the scan finishes.' : 'The rest of your list appears when the scan finishes.'}</span>
      </span>
    );
  return null;
}

// --- site not reached ---------------------------------------------------------------

/** One notice in place of the banner line, matrix and to-do list when no visit reached the site. */
export function Unreachable({ data, ui, actions }: { data: JobReportResponse; ui: ReportUiState; actions: ReportActions }) {
  const reason = data.report?.scan.unreachable?.reason;
  return (
    <section className="rp-section rp-alert" role="alert" data-testid="unreachable">
      <p>
        <strong>We couldn’t reach {data.job.host}.</strong> Nothing was checked, so there are no findings and nothing to do yet.
      </p>
      {reason ? <p className="muted">{reason.charAt(0).toUpperCase() + reason.slice(1)}.</p> : null}
      {actions.onRescan ? (
        <RescanButton className="btn btn-sm btn-secondary" laws={data.job.laws} busy={ui.rescanning} onRescan={actions.onRescan}>
          {ui.rescanning ? 'Starting…' : 'Scan again'}
        </RescanButton>
      ) : null}
    </section>
  );
}

// --- scan history -------------------------------------------------------------------

const hostOf = (url: string | undefined): string | undefined => {
  try {
    return url ? new URL(url).hostname : undefined;
  } catch {
    return undefined;
  }
};

/** Date and time, plus the kind when not a full consent scan, plus the host when it isn't this report's. */
function scanLabel(s: Pick<ScanHistoryItem, 'at' | 'quick' | 'checks' | 'url'>, host?: string): string {
  const kind = s.checks && !s.checks.includes('consent') ? 'accessibility' : s.quick ? 'quick' : undefined;
  const other = hostOf(s.url);
  return [formatAbsolute(s.at), kind, other && host && other !== host ? other : undefined].filter(Boolean).join(' · ');
}

/** The site's scans, newest first; this one marked. Failed and cancelled scans are greyed; gone ones aren't links. */
export function ScanHistory({ history }: { history: ScanHistoryItem[] }) {
  const current = history.find((s) => s.current);
  if (!current) return null;
  const host = hostOf(current.url);
  return (
    <details className="rp-history" data-testid="scan-history">
      <summary>
        Scan of {scanLabel(current)} <span className="muted">· {history.length === 1 ? 'the only scan of this site' : `${history.length} scans of this site`}</span>
      </summary>
      <ol className="rp-history-list">
        {history.map((s, i) => {
          const ended = s.status === 'failed' || s.status === 'cancelled';
          const cls = `rp-history-item${ended || !s.available ? ' is-muted' : ''}${s.current ? ' is-current' : ''}`;
          const note = !s.available ? (s.jobId ? 'no longer on this service' : 'ran outside this service') : s.status && s.status !== 'done' ? JOB_STATUS_LABEL[s.status].toLowerCase() : undefined;
          return (
            <li key={s.jobId ?? `${s.at}-${i}`} className={cls} data-status={s.status ?? 'gone'}>
              {s.current ? (
                <strong aria-current="page">{scanLabel(s, host)}</strong>
              ) : s.available && s.jobId ? (
                <a href={reportHref(s.jobId)}>{scanLabel(s, host)}</a>
              ) : (
                <span>{scanLabel(s, host)}</span>
              )}
              {note ? <span className="muted"> · {note}</span> : null}
              {i === 0 && !s.current ? <span className="muted"> · latest</span> : null}
            </li>
          );
        })}
      </ol>
    </details>
  );
}

/** An earlier scan: what it is, and the way to the latest. */
export function EarlierScan({ newer }: { newer: NonNullable<JobReportResponse['newerScan']> }) {
  return (
    <section className="rp-section rp-earlier" data-testid="earlier-scan">
      <p>
        <strong>This is an earlier scan.</strong> A newer scan of this site ran {formatAbsolute(newer.at)}.{' '}
        <a href={reportHref(newer.jobId)}>Open the latest report</a>
      </p>
      <p className="muted">It shows what was observed then. Tool classifications and the to-do list belong to the whole site, so changes you make here apply to every scan.</p>
    </section>
  );
}

// --- overview: compliance score -----------------------------------------------------

/** The whole scan's report: the final one, or while a multi-law job runs, its laws' live reports together. */
function overviewReport(data: JobReportResponse): Pick<OwnerReport, 'matrix'> | null {
  if (data.report) return data.report;
  const live = (data.laws ?? []).map((l) => l.report).filter((r): r is OwnerReport => r !== null);
  if (!live.length) return null;
  return { matrix: { columns: live.flatMap((r) => r.matrix.columns), tools: live.flatMap((r) => r.matrix.tools), counts: live[0].matrix.counts } };
}

/** Above the law tabs: the compliance score, how it moved since the site's first scan, and what's wrong. */
export function Overview({ data }: { data: JobReportResponse }) {
  const report = overviewReport(data);
  const sum = scoreReport(report);
  if (sum.score === undefined) return null;
  const running = data.job.status === 'queued' || data.job.status === 'running';
  const first = data.firstScan;
  const delta = first && !first.current && first.score !== undefined ? sum.score - first.score : undefined;
  const severity = reportSeverity(report) ?? 'ok';
  return (
    <section className="rp-section rp-overview" aria-label="Overview" data-testid="overview">
      <div className="rp-score" data-severity={severity}>
        <span className="rp-score-num" data-testid="score">
          {sum.score}
        </span>
        <span className="rp-score-label">
          Compliance score{running ? ' so far' : ''}
          <small>
            {sum.passed} of {plural(sum.scored, 'check')} passed
          </small>
        </span>
      </div>
      <dl className="rp-stats">
        <div data-severity={sum.problems ? 'problem' : 'ok'}>
          <dt>Problems</dt>
          <dd data-testid="problems">{sum.problems}</dd>
          <small>{sum.problems === 1 ? 'tool with a problem' : 'tools with a problem'}</small>
        </div>
        {sum.decisions ? (
          <div data-severity="warning">
            <dt>To describe</dt>
            <dd>{sum.decisions}</dd>
            <small>{sum.decisions === 1 ? 'tool needs' : 'tools need'} a purpose</small>
          </div>
        ) : null}
        {first ? (
          <div data-testid="score-change" data-trend={delta === undefined ? undefined : delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'}>
            <dt>Since the first scan</dt>
            {first.current ? (
              <>
                <dd>—</dd>
                <small>This is the site’s first scan</small>
              </>
            ) : delta !== undefined ? (
              <>
                <dd>{delta > 0 ? `+${delta}` : delta < 0 ? `−${-delta}` : '±0'}</dd>
                <small>
                  from {first.score} on <a href={reportHref(first.jobId)}>{formatAbsolute(first.at)}</a>
                </small>
              </>
            ) : (
              <>
                <dd>—</dd>
                <small>
                  the <a href={reportHref(first.jobId)}>first scan</a> has no score
                </small>
              </>
            )}
          </div>
        ) : null}
      </dl>
    </section>
  );
}

// --- law tabs (plans/per-law-report-contract.md, C3) ---------------------------------

/** The tabs for a multi-law job: stateless, so render tests can pick the selected law. */
export function LawTabsView({ data, selected, onSelect, ui = {}, actions = {} }: { data: JobReportResponse; selected: LawId; onSelect: (id: LawId) => void; ui?: ReportUiState; actions?: ReportActions }) {
  const base = useId();
  const rows = lawRows(data.job, data.report);
  const tabId = (id: LawId) => `${base}-tab-${id}`;
  const panelId = `${base}-panel`;
  const row = rows.find((r) => r.id === selected) ?? rows[0];
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const i = rows.findIndex((r) => r.id === selected);
    const next = rows[(i + (e.key === 'ArrowRight' ? 1 : rows.length - 1)) % rows.length];
    if (!next) return;
    e.preventDefault();
    onSelect(next.id);
    document.getElementById(tabId(next.id))?.focus();
  };
  let body: ReactNode = null;
  if (row) {
    const report = tabReport(data, row.id);
    if (row.state === 'failed') {
      body = (
        <div className="rp-section rp-alert" role="alert">
          <p>
            <strong>This law could not be scanned.</strong> {row.error ? <span className="muted">{row.error}</span> : null}
          </p>
        </div>
      );
    } else if (!report && (row.state === 'waiting' || row.state === 'starting' || row.state === 'verifying')) {
      body = <p className="muted">{row.text}…</p>;
    } else {
      const lawData: JobReportResponse = { ...data, report };
      body = (
        <>
          <BannerLine data={lawData} />
          <Matrix data={lawData} ui={ui} actions={actions} />
        </>
      );
    }
  }
  return (
    <div className="law-tabs" data-testid="law-tabs">
      <div role="tablist" aria-label="Laws scanned" onKeyDown={onKeyDown}>
        {rows.map((r) => (
          <button key={r.id} type="button" role="tab" id={tabId(r.id)} aria-selected={r.id === row?.id} aria-controls={panelId} tabIndex={r.id === row?.id ? 0 : -1} onClick={() => onSelect(r.id)}>
            {r.label}
            <span className="law-dot" data-state={r.state} data-severity={tabSeverity(r.state, tabReport(data, r.id)) ?? undefined} aria-hidden="true" />
          </button>
        ))}
      </div>
      <div role="tabpanel" id={panelId} aria-labelledby={row ? tabId(row.id) : undefined} tabIndex={0}>
        {body}
      </div>
    </div>
  );
}

/** A finished law's dot: red for any problem, amber for anything short of a clean pass, green only when every check passed. */
function tabSeverity(state: LawRow['state'], report: OwnerReport | null): Severity | null {
  if (state === 'failed') return 'problem';
  if ((state !== 'done' && state !== 'collected') || !report) return null;
  return reportSeverity(report) ?? 'ok';
}

/** Initial tab: the first law scanning, else the first. */
function initialLaw(data: JobReportResponse): LawId {
  const rows = lawRows(data.job, data.report);
  return (rows.find((r) => r.state === 'scanning') ?? rows[0])?.id ?? LAWS[0].id;
}

export function LawTabs({ data, ui, actions }: { data: JobReportResponse; ui?: ReportUiState; actions?: ReportActions }) {
  const [selected, setSelected] = useState<LawId>(() => initialLaw(data));
  return <LawTabsView data={data} selected={selected} onSelect={setSelected} ui={ui} actions={actions} />;
}

// --- the page -----------------------------------------------------------------------

/** The PDF's file name: the browser's "Save as PDF" suggests the document title. */
export function pdfTitle(host: string, at: string | undefined): string {
  return `complykit-${host}${at ? `-${at.slice(0, 10)}` : ''}`;
}

/**
 * Save as PDF: the browser's own print, so the PDF is the page as it stands — every
 * open or closed fold, expanded tool row and selected law tab — with real text and
 * links. The print stylesheet hides the controls (`.btn`, `data-print="hide"`).
 */
function SavePdfButton({ host, at }: { host: string; at?: string }) {
  const onClick = () => {
    const title = document.title;
    const restore = () => {
      document.title = title;
      window.removeEventListener('afterprint', restore);
    };
    window.addEventListener('afterprint', restore);
    document.title = pdfTitle(host, at);
    window.print();
  };
  return (
    <button type="button" className="btn btn-sm btn-secondary rp-save-pdf" onClick={onClick} title="Opens print — choose “Save as PDF”. The PDF shows the page as it is now: open sections stay open, closed ones stay closed.">
      Save as PDF
    </button>
  );
}

export function ReportPageView({ data: served, now, ui = {}, actions = {} }: { data: JobReportResponse; now: number; ui?: ReportUiState; actions?: ReportActions }) {
  // Everything below reads `data`, the report as JUDGED with the owner's answers (the served ones plus those not served
  // back yet), so a click changes the grid, the score and the to-do list at once, before any server round trip.
  const data = useMemo(() => shownData(served, ui.answers), [served, ui.answers]);
  const { job } = data;
  const consent = job.checks.includes('consent');
  return (
    <div className="rp" data-job-status={job.status}>
      <header className="rp-header">
        <div className="rp-topline">
          <p className="eyebrow" data-print="hide">
            <a href="#">← Home</a>
          </p>
          <SavePdfButton host={job.host} at={job.createdAt} />
        </div>
        <h1 className="rp-h1">{job.host}</h1>
        <ScanHistory history={data.history ?? []} />
        <JobLaws job={job} />
      </header>
      {data.newerScan ? <EarlierScan newer={data.newerScan} /> : null}
      <ScanStatus data={data} now={now} onCancel={actions.onCancel} />
      {job.status === 'failed' || job.status === 'cancelled' ? (
        <div className="rp-section rp-alert" role="alert" data-testid="scan-ended">
          <p>
            <strong>{job.status === 'failed' ? 'The scan didn’t finish.' : 'The scan was cancelled.'}</strong> {job.error ? <span className="muted">{job.error.split('\n')[0]}</span> : null}
          </p>
          {actions.onRescan && consent ? (
            <RescanButton className="btn btn-sm btn-secondary" laws={job.laws} busy={ui.rescanning} onRescan={actions.onRescan}>
              Scan again
            </RescanButton>
          ) : null}
        </div>
      ) : null}
      {consent && data.report?.scan.unreachable ? <Unreachable data={data} ui={ui} actions={actions} /> : null}
      {consent && !data.report?.scan.unreachable ? (
        <>
          <Overview data={data} />
          {(job.laws?.length ?? 0) >= 2 ? (
            <LawTabs data={data} ui={ui} actions={actions} />
          ) : (
            <>
              <BannerLine data={data} />
              <Matrix data={data} ui={ui} actions={actions} />
            </>
          )}
          <TodoList data={data} ui={ui} actions={actions} />
        </>
      ) : null}
      <footer className="rp-footer">
        {data.technicalReportUrl ? (
          <a href={data.technicalReportUrl} target="_blank" rel="noopener">
            Technical details
          </a>
        ) : null}
        {data.accessibilityReportUrl ? (
          <a href={data.accessibilityReportUrl} target="_blank" rel="noopener">
            Accessibility report
          </a>
        ) : null}
        {data.jsonReportUrl ? (
          <a href={data.jsonReportUrl} download={`complykit-${data.job.host}.json`}>
            Download JSON
          </a>
        ) : null}
        {data.downloadUrl ? (
          <a href={data.downloadUrl} download>
            Download everything (.zip)
          </a>
        ) : null}
        {actions.onDelete ? (
          <button type="button" className="rp-delete" disabled={ui.deleting} onClick={actions.onDelete}>
            {ui.deleting ? 'Deleting…' : 'Delete this report'}
          </button>
        ) : null}
      </footer>
      {ui.errors?.delete ? (
        <p className="rp-error" role="alert">
          {ui.errors.delete}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Save a classification, then read the report. The server re-renders a finished scan's report itself, and the page
 * polls while it updates. Failing to read afterwards is not a failed classification (the answer is saved): the next
 * poll picks the report up.
 */
export async function saveClassification(save: () => Promise<unknown>, refresh: () => Promise<unknown>): Promise<{ saved: true } | { saved: false; error: unknown }> {
  try {
    await save();
  } catch (error) {
    return { saved: false, error };
  }
  try {
    await refresh();
  } catch {
    /* saved; the next poll reads the report */
  }
  return { saved: true };
}

export function ReportPage({ jobId }: { jobId: string }) {
  const { data, error, refresh } = useJobReport(jobId);
  const [reviewer] = useReviewer();
  const by = reviewer.trim() || undefined;
  const scanning = data?.job.status === 'queued' || data?.job.status === 'running';
  const now = useNow(1000, scanning);
  const [ui, setUi] = useState<ReportUiState>({});
  const err = (key: string, e: unknown) => setUi((u) => ({ ...u, errors: { ...u.errors, [key]: e instanceof Error ? e.message : String(e) } }));
  const clear = (key: string) => setUi((u) => ({ ...u, errors: Object.fromEntries(Object.entries(u.errors ?? {}).filter(([k]) => k !== key)) }));
  const dataRef = useRef(data);
  dataRef.current = data;

  // A fresh report that holds an answer (and is not being re-made) replaces the page's own copy of it.
  useEffect(() => {
    if (!data || !ui.answers) return;
    const left = answersAfter(ui.answers, data);
    if (Object.keys(left).length !== Object.keys(ui.answers).length) setUi((u) => ({ ...u, answers: answersAfter(u.answers ?? {}, data) }));
  }, [data, ui.answers]);

  const actions: ReportActions = {
    onCopy: copyText,
    onSaveSettings: async (settings) => {
      const d = dataRef.current;
      if (!d) return;
      await api.saveConsentSettings(d.domain, settings);
      await refresh();
    },
    onDelete: async () => {
      const d = dataRef.current;
      const host = d?.job.host ?? 'this site';
      if (!window.confirm(`Delete this report for ${host}?\n\nThe scan and its evidence are removed for good. Your decisions and to-do progress for the site are kept.`)) return;
      setUi((u) => ({ ...u, deleting: true }));
      try {
        await api.remove(jobId);
        window.location.hash = '';
      } catch (e) {
        setUi((u) => ({ ...u, deleting: false, errors: { ...u.errors, delete: `Could not delete the report: ${e instanceof Error ? e.message : String(e)}` } }));
      }
    },
    onCancel: async () => {
      try {
        await api.cancel(jobId);
      } finally {
        await refresh();
      }
    },
    onClassify: async (classKey, purpose) => {
      const d = dataRef.current;
      if (!d) return;
      // The page judges with the answer at once (no await before this); the PATCH and the refresh follow.
      setUi((u) => ({ ...u, answers: { ...u.answers, [classKey]: [purpose] }, saving: classKey, errors: Object.fromEntries(Object.entries(u.errors ?? {}).filter(([k]) => k !== classKey)) }));
      const out = await saveClassification(
        () => api.patchWorkspace(d.domain, { ...(by ? { by } : {}), entries: { [classKey]: { value: { category: purpose, categoryChosen: true, source: 'report-page' } } } }),
        refresh,
      );
      // A failed save was never an answer: the page goes back to what the server holds.
      if (!out.saved) setUi((u) => ({ ...u, answers: Object.fromEntries(Object.entries(u.answers ?? {}).filter(([k, v]) => !(k === classKey && sameCategories(v, [purpose])))) }));
      if (!out.saved) err(classKey, out.error);
      setUi((u) => ({ ...u, saving: undefined }));
    },
    onVerify: async (task) => {
      const d = dataRef.current;
      if (!d || ui.verifying) return;
      clear(task.id);
      setUi((u) => ({ ...u, verifying: task.id }));
      try {
        await api.verifyTask(d.domain, task.id);
        await refresh();
      } catch (e) {
        err(task.id, new Error(`Couldn’t run the check: ${e instanceof Error ? e.message : String(e)}`));
      } finally {
        setUi((u) => ({ ...u, verifying: undefined }));
      }
    },
    onMarkDone: async (task) => {
      const d = dataRef.current;
      if (!d) return;
      clear(task.id);
      setUi((u) => ({ ...u, marking: task.id }));
      const value = { status: task.status === 'done-unverified' ? 'todo' : 'done-unverified', ...(task.note ? { note: task.note } : {}), ...(task.lastVerify ? { lastVerify: task.lastVerify } : {}) };
      try {
        await api.patchWorkspace(d.domain, { ...(by ? { by } : {}), entries: { [TASK_CHANGE_PREFIX + task.id]: { value } } });
        await refresh();
      } catch (e) {
        err(task.id, e);
      } finally {
        setUi((u) => ({ ...u, marking: undefined }));
      }
    },
    onRescan: async (extra) => {
      const d = dataRef.current;
      if (!d) return;
      clear('rescan');
      setUi((u) => ({ ...u, rescanning: true }));
      try {
        const res = await api.rescan(d.domain, extra?.laws ? { laws: extra.laws, authorized: extra.authorized } : {});
        notifyJobsChanged();
        window.location.hash = reportHref(res.job.id);
      } catch (e) {
        err('rescan', e);
      } finally {
        setUi((u) => ({ ...u, rescanning: false }));
      }
    },
    onMakeList: async () => {
      clear('list');
      setUi((u) => ({ ...u, makingList: true }));
      try {
        await api.rerender(jobId, { generate: true, ...(by ? { by } : {}) });
        await refresh();
      } catch (e) {
        err('list', e);
      } finally {
        setUi((u) => ({ ...u, makingList: false }));
      }
    },
  };

  if (error && !data) {
    return (
      <div className="rp">
        <p className="eyebrow">
          <a href="#">← Home</a>
        </p>
        <div className="banner-error" role="alert">
          {error.status === 404 ? 'This scan is no longer here (it was deleted).' : `Couldn’t load the report: ${error.message}`}
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="rp skeleton" aria-busy="true" aria-label="Loading the report">
        <div className="skeleton-card" />
        <div className="skeleton-card" />
      </div>
    );
  }
  return <ReportPageView data={data} now={now} ui={ui} actions={actions} />;
}
