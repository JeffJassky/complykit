import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { JobReportResponse, OwnerCell, OwnerReport, OwnerToolActivity, OwnerToolRow, RemediationTask } from '../../shared/api';
import { LAWS, type LawId } from '../../shared/laws';
import { api } from '../lib/api';
import { JobLaws, LawProgress, RescanButton } from './Laws';
import { lawRows } from '../lib/laws';
import { tabReport } from '../lib/lawReport';
import { formatClock, jobDuration } from '../lib/format';
import { openDecisions, STATUS_LABEL as TASK_STATUS_LABEL, TASK_CHANGE_PREFIX } from '../lib/checklist';
import { copyText, useReviewer } from '../lib/useKb';
import { createRerenderQueue, useJobReport } from '../lib/useJobReport';
import { reportHref } from '../lib/useHashView';
import { useNow } from '../lib/useNow';

// The report page (plans/simple-report.md): one scan, four parts, in order —
// scan status (only while scanning), consent banner, the matrix, the to-do
// list — and one small "Technical details" link to the full HTML report.
// Nothing else. ReportPageView is pure (render tests); ReportPage wires it.

/** The purposes an owner can pick for a tool the scan does not know (workspace class: entries). */
export const PURPOSES: Array<{ id: string; label: string; help: string }> = [
  { id: 'necessary', label: 'Necessary', help: 'The site needs it to work (cart, login, security)' },
  { id: 'functional', label: 'Functional', help: 'A feature visitors use (chat, video, saved choices)' },
  { id: 'analytics', label: 'Analytics', help: 'Measures visits and behavior' },
  { id: 'advertising', label: 'Advertising', help: 'Ads, retargeting, conversion tracking' },
];
const PURPOSE_LABEL = Object.fromEntries(PURPOSES.map((p) => [p.id, p.label]));

const CELL_ICON: Record<OwnerCell['state'], string> = { pending: '', ok: '✓', mismatch: '✕', 'needs-decision': '?', 'not-checked': '–' };
const CELL_TEXT: Record<OwnerCell['state'], string> = { pending: 'Checking…', ok: 'As expected', mismatch: 'Problem: running when it should be off', 'needs-decision': 'Needs your decision', 'not-checked': 'Not checked' };

export interface ReportActions {
  onCancel?: () => void;
  /** Save what an unclassified tool is for (class:<key>). */
  onClassify?: (classKey: string, purpose: string) => void;
  /** Save the site-wide answer about consent-denied pings (null clears it). */
  onDecide?: (key: string, value: 'allow' | 'hold' | null) => void;
  onVerify?: (task: RemediationTask) => void;
  onMarkDone?: (task: RemediationTask) => void;
  onRescan?: (extra?: { laws?: LawId[]; authorized?: true }) => void;
  /** Make the list when none was made (or making it failed). */
  onMakeList?: () => void;
  onCopy?: (text: string) => Promise<boolean>;
  /** Delete this scan (after the owner confirms). */
  onDelete?: () => void;
}

export interface ReportUiState {
  /** Classifications saved here before the next report arrives: classKey → purpose. */
  saved?: Record<string, string>;
  /** classKey being saved. */
  saving?: string;
  verifying?: string;
  marking?: string;
  rescanning?: boolean;
  makingList?: boolean;
  deleting?: boolean;
  /** The report is being re-rendered with new decisions. */
  rerender?: 'idle' | 'scheduled' | 'running';
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
        <strong>No consent banner detected</strong>
        {b.consentTools?.length ? <span className="muted">— {b.consentTools.join(', ')} {b.consentTools.length === 1 ? 'is' : 'are'} on the site, but no banner appeared.</span> : null}
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

export function Matrix({ data, ui = {}, actions = {} }: { data: JobReportResponse; ui?: ReportUiState; actions?: ReportActions }) {
  const report = data.report;
  const scanning = data.job.status === 'queued' || data.job.status === 'running';
  const [open, setOpen] = useState<{ row: string; col?: number } | null>(null);
  const toggle = (row: string, col?: number) => setOpen((o) => (o && o.row === row && o.col === col ? null : { row, col }));
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
  const gaps = columns.filter((c) => c.state === 'not-checked');
  const unverified = report.scan.location && !report.scan.location.verified;
  const colName = (i: number) => columns[i].label + (columns[i].locationLabel ? ` (${columns[i].locationLabel})` : '');
  const purposeOf = (t: OwnerToolRow) => (ui.saved?.[t.classKey] && !t.classified ? `${PURPOSE_LABEL[ui.saved[t.classKey]] ?? ui.saved[t.classKey]} (saved)` : t.purpose);
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
          <b data-state="needs-decision">?</b> needs your decision
        </span>
        <span>
          <b data-state="not-checked">–</b> not checked
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
                const decide = !t.classified && !ui.saved?.[t.classKey];
                const rows = [
                  { key: t.id, name: t.label, sub: purposeOf(t), cells: t.cells, tool: true, unclassified: !t.classified },
                  ...t.cookies.map((k) => ({ key: k.id, name: k.name, sub: k.kind === 'cookie' ? 'cookie' : `${k.kind} storage`, cells: k.cells, tool: false, unclassified: false })),
                ];
                return (
                  <Fragment key={t.id}>
                    {rows.map((r) => (
                      <Fragment key={r.key}>
                        <tr className={r.tool ? 'rp-tool' : 'rp-cookie'} data-row={r.key}>
                          <th scope="row">
                            <button type="button" className="rp-row-label" aria-expanded={open?.row === r.key && open.col === undefined} onClick={() => toggle(r.key)}>
                              {r.name}
                            </button>
                            <small data-unclassified={r.unclassified && !ui.saved?.[t.classKey] ? 'true' : undefined}>{r.sub}</small>
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
            <li key={g.id}>
              <b>– {g.label}:</b> {g.note}
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

function DecisionTodo({ label, classKey, decided, ui, actions, unblocks, tool }: { label: string; classKey: string; decided?: string; ui: ReportUiState; actions: ReportActions; unblocks?: string[]; tool?: OwnerToolRow }) {
  const [changing, setChanging] = useState(false);
  const saved = ui.saved?.[classKey];
  const done = !!(decided || saved);
  return (
    <li className="rp-todo" data-kind="classify" data-status={done ? 'verified' : 'todo'}>
      <div className="rp-todo-head">
        <strong>What is {label} for?</strong>
        <span className={`pill ${done ? 'pill-done' : 'pill-queued'}`}>{done ? 'Decided ✓' : 'To decide'}</span>
      </div>
      <p className="muted">The scan doesn’t know this tool. Your answer decides whether it needs consent{unblocks?.length ? ` — and ${unblocks.length === 1 ? 'one change below' : `${unblocks.length} changes below`}` : ''}.</p>
      {tool && !(done && !changing) ? <ToolEvidence tool={tool} /> : null}
      {done && !changing ? (
        <p>
          {saved ? <>Saved as <strong>{PURPOSE_LABEL[saved] ?? saved}</strong>. </> : decided && decided !== 'saved' ? <>Your answer: <strong>{decided}</strong>. </> : <>Your answer is saved for this site. </>}
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

const PING_CHOICES = [
  { value: 'allow', label: 'Accept them', help: 'Keeps Google’s modelled conversions; accepts a small, untested legal risk.' },
  { value: 'hold', label: 'Hold them until consent', help: 'No legal exposure from these pings; load Google tags only after the visitor accepts (Consent Mode “basic”).' },
] as const;

/** The one site-wide answer about consent-denied pings; it settles many checks at once. */
export function PingDecision({ decision, ui, actions }: { decision: NonNullable<OwnerReport['pingDecision']>; ui: ReportUiState; actions: ReportActions }) {
  const { key, cells, at } = decision;
  // A value saved on this page shows at once; '' means it was cleared.
  const saved = ui.saved?.[key];
  const choice = saved !== undefined ? (saved === 'allow' || saved === 'hold' ? saved : undefined) : decision.choice;
  const busy = ui.saving === key;
  const answered = PING_CHOICES.find((c) => c.value === choice);
  return (
    <li className="rp-todo" data-kind="decide" data-testid="ping-decision" data-status={choice ? 'verified' : 'todo'}>
      <div className="rp-todo-head">
        <strong>Google’s cookieless pings before consent</strong>
        <span className={`pill ${choice ? 'pill-done' : 'pill-queued'}`}>{choice ? 'Decided ✓' : 'To decide'}</span>
      </div>
      <p className="muted">
        Google tags (Consent Mode “advanced”) send pings without cookies before the visitor chooses, or after they refuse. They still carry the IP address and the page address. Whether that needs consent is unsettled in the EU and UK and under the wiretap laws of California, Florida, Pennsylvania, Maryland and Illinois. Answer once for this site; every scan follows your answer.
        {cells > 0 ? ` This settles ${cells} ${cells === 1 ? 'check' : 'checks'}.` : ''}
      </p>
      {answered ? (
        <p data-testid="ping-answer">
          Your answer: <strong>{answered.label}</strong>
          {at && !saved ? ` (${new Date(at).toLocaleDateString()})` : ''}.
        </p>
      ) : null}
      <fieldset className="rp-picker" disabled={busy || !actions.onDecide}>
        <div className="rp-picker-buttons">
          {PING_CHOICES.map((c) => (
            <button key={c.value} type="button" className={`btn btn-sm ${c.value === choice ? 'btn-primary' : 'btn-secondary'}`} data-value={c.value} aria-pressed={c.value === choice} onClick={() => actions.onDecide?.(key, c.value)}>
              {c.label}
            </button>
          ))}
        </div>
        <ul className="rp-help muted">
          {PING_CHOICES.map((c) => (
            <li key={c.value}>
              <strong>{c.label}:</strong> {c.help}
            </li>
          ))}
        </ul>
        {busy ? <p className="rp-help muted">Saving…</p> : null}
      </fieldset>
      {ui.errors?.[key] ? (
        <p className="rp-error" role="alert">
          {ui.errors[key]}
        </p>
      ) : null}
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
  const waiting = openDecisions(task, tasks).filter((d) => !ui.saved?.[d.classKey ?? '']);
  const verifying = ui.verifying === task.id;
  const steps = task.steps.map((s, i) => task.stepVariants?.find((v) => v.step === i)?.service ?? s);
  return (
    <li className="rp-todo" data-kind={task.kind} data-task-id={task.id} data-status={task.status}>
      <div className="rp-todo-head">
        <strong>{task.title}</strong>
        <span className={`pill ${STATUS_PILL[task.status]}`}>{TASK_STATUS_LABEL[task.status]}</span>
      </div>
      <p className="muted">{task.summary}</p>
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
          {task.snippet?.after ? <SnippetBlock text={task.snippet.after} label={task.kind === 'install' ? 'Paste first in <head>' : 'Change it to'} onCopy={actions.onCopy} /> : null}
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
          {task.kind === 'install' && data.installZipUrl ? (
            <a className="btn btn-sm btn-secondary" href={data.installZipUrl} download>
              Download install bundle (.zip)
            </a>
          ) : null}
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

export function TodoList({ data, ui = {}, actions = {} }: { data: JobReportResponse; ui?: ReportUiState; actions?: ReportActions }) {
  const { todo, report, job } = data;
  const tasks = todo.state === 'ready' ? todo.tasks : [];
  const required = tasks.filter((t) => !t.optional);
  const optional = tasks.filter((t) => t.optional);
  // Before the checklist exists: the decisions the scan has found so far are the first items.
  const liveDecisions = todo.state === 'ready' ? [] : (report?.decisions ?? []);
  const toolFor = (classKey?: string) => (classKey ? report?.matrix.tools.find((x) => x.classKey === classKey) : undefined);
  const isDone = (t: RemediationTask) => finishedTask(t) || (t.kind === 'classify' && !!ui.saved?.[t.classKey ?? '']);
  const doneCount = required.filter(isDone).length;
  const canRescan = todo.state === 'ready' && required.length > 0 && required.every(isDone);
  const scanning = job.status === 'queued' || job.status === 'running';
  // The change to do next shows its steps open; the rest stay folded.
  const nextId = required.find((t) => t.kind !== 'classify' && !finishedTask(t) && !openDecisions(t, tasks).some((d) => !ui.saved?.[d.classKey ?? '']))?.id;
  return (
    <section className="rp-section" aria-labelledby="rp-todo-title" data-testid="todo" data-state={todo.state}>
      <div className="rp-todo-title">
        <h2 id="rp-todo-title" className="rp-h2">
          Your to-do list
        </h2>
        {todo.state === 'ready' ? (
          <span className="muted" data-testid="todo-progress">
            {doneCount} of {required.length} done
          </span>
        ) : null}
      </div>
      {ui.rerender && ui.rerender !== 'idle' ? (
        <p className="muted" role="status" data-testid="updating">
          <span className="rp-spinner rp-spinner-sm" aria-hidden="true" /> Updating the report with your answers…
        </p>
      ) : null}
      {todo.state === 'ready' && todo.fromThisRun === false ? <p className="muted rp-note">This list comes from an earlier scan of this site; your progress on it is kept.</p> : null}
      <ol className="rp-todos">
        {report?.pingDecision ? <PingDecision decision={report.pingDecision} ui={ui} actions={actions} /> : null}
        {liveDecisions.map((d) => (
          <DecisionTodo key={d.classKey} label={d.label} classKey={d.classKey} ui={ui} actions={actions} tool={toolFor(d.classKey)} />
        ))}
        {required.map((t) =>
          t.kind === 'classify' && t.classKey ? (
            <DecisionTodo key={t.id} label={t.tools[0] ?? t.title} classKey={t.classKey} decided={t.status === 'verified' ? (report?.matrix.tools.find((x) => x.classKey === t.classKey && x.classified)?.purpose ?? 'saved') : undefined} ui={ui} actions={actions} unblocks={tasks.filter((x) => x.waitingOn?.includes(t.id)).map((x) => x.title)} tool={toolFor(t.classKey)} />
          ) : (
            <ChangeTodo key={t.id} task={t} tasks={tasks} data={data} ui={ui} actions={actions} current={t.id === nextId} />
          ),
        )}
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
            <button type="button" className="btn btn-sm btn-primary" disabled={ui.makingList || !actions.onMakeList} onClick={actions.onMakeList}>
              {ui.makingList ? 'Making your list…' : todo.error ? 'Try again' : 'Make my to-do list'}
            </button>
            {ui.errors?.list ? <p className="rp-error">{ui.errors.list}</p> : null}
          </li>
        ) : null}
        {optional.length ? (
          <li className="rp-todo rp-todo-optional">
            <details>
              <summary>Only if they apply ({optional.length})</summary>
              <ol className="rp-todos">
                {optional.map((t) => (
                  <ChangeTodo key={t.id} task={t} tasks={tasks} data={data} ui={ui} actions={actions} />
                ))}
              </ol>
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
    </section>
  );
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
            <span className="law-dot" data-state={r.state} aria-hidden="true" />
          </button>
        ))}
      </div>
      <div role="tabpanel" id={panelId} aria-labelledby={row ? tabId(row.id) : undefined} tabIndex={0}>
        {body}
      </div>
    </div>
  );
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

export function ReportPageView({ data, now, ui = {}, actions = {} }: { data: JobReportResponse; now: number; ui?: ReportUiState; actions?: ReportActions }) {
  const { job } = data;
  const consent = job.checks.includes('consent');
  return (
    <div className="rp" data-job-status={job.status}>
      <header className="rp-header">
        <p className="eyebrow">
          <a href="#">← Home</a>
        </p>
        <h1 className="rp-h1">{job.host}</h1>
        <JobLaws job={job} />
      </header>
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

  // New decisions re-render the report, coalesced; no "Update report" button.
  const queue = useMemo(
    () =>
      createRerenderQueue(
        async () => {
          await api.rerender(jobId, by ? { by } : {});
          await refresh();
        },
        { onState: (s) => setUi((u) => ({ ...u, rerender: s })), onError: (e) => err('list', e) },
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [jobId, refresh],
  );
  useEffect(() => () => queue.cancel(), [queue]);
  // A fresh report that classifies the tool replaces the local "saved" marker.
  useEffect(() => {
    if (!data?.report || !ui.saved) return;
    const classified = new Set(data.report.matrix.tools.filter((t) => t.classified).map((t) => t.classKey));
    const decided = new Set(data.todo.tasks.filter((t) => t.kind === 'classify' && t.status === 'verified').map((t) => t.classKey));
    const ping = data.report.pingDecision;
    // The ping answer is replaced once the report carries it (a cleared one is '').
    const left = Object.fromEntries(Object.entries(ui.saved).filter(([k, v]) => !classified.has(k) && !decided.has(k) && !(k === ping?.key && v === (ping.choice ?? ''))));
    if (Object.keys(left).length !== Object.keys(ui.saved).length) setUi((u) => ({ ...u, saved: left }));
  }, [data, ui.saved]);

  const actions: ReportActions = {
    onCopy: copyText,
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
      clear(classKey);
      setUi((u) => ({ ...u, saving: classKey }));
      try {
        await api.patchWorkspace(d.domain, { ...(by ? { by } : {}), entries: { [classKey]: { value: { category: purpose, categoryChosen: true, source: 'report-page' } } } });
        setUi((u) => ({ ...u, saved: { ...u.saved, [classKey]: purpose } }));
        // A finished scan re-renders now; a running one applies it when it finishes (its list is made then).
        if (d.job.status === 'done') queue.request();
      } catch (e) {
        err(classKey, e);
      } finally {
        setUi((u) => ({ ...u, saving: undefined }));
      }
    },
    onDecide: async (key, value) => {
      const d = dataRef.current;
      if (!d) return;
      clear(key);
      setUi((u) => ({ ...u, saving: key }));
      try {
        await api.patchWorkspace(d.domain, { ...(by ? { by } : {}), entries: { [key]: { value } } });
        setUi((u) => ({ ...u, saved: { ...u.saved, [key]: value ?? '' } }));
        if (d.job.status === 'done') queue.request();
      } catch (e) {
        err(key, e);
      } finally {
        setUi((u) => ({ ...u, saving: undefined }));
      }
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
          {error.status === 404 ? 'This scan is no longer here (scans are kept for a limited time).' : `Couldn’t load the report: ${error.message}`}
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
