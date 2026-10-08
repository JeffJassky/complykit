import { renderScopeHtml, SCOPE_CSS } from './consent-scope.js';
import { renderLocationRulesHtml, LOCATION_RULES_CSS, LOCATION_RULES_JS } from './consent-location-rules.js';
import { buildMatrixWorkspace } from './consent-workbench.js';
import { renderSinceHtml, carriedTasks } from './consent-diff.js';
import { buildBehaviorMatrix, renderBehaviorMatrix, MATRIX_CSS, MATRIX_JS } from './consent-matrix.js';
import { renderCompatibilityHtml, COMPATIBILITY_CSS, CHANGE_LIST_FILE } from './consent-compatibility.js';
import { renderConsentToolProofHtml, PROOF_CSS } from './consent-tool-proof.js';
import { renderRemediationHtml, REMEDIATION_CSS, REMEDIATION_JS } from './consent-remediation.js';
import { renderRerenderPanel, RERENDER_CSS, RERENDER_JS, KEEP_SCROLL_JS, type ReportRenderInfo } from './consent-rerender.js';
import { workspaceId, tone, actionControls, workspacePanel, workspaceScript, WORKSPACE_CSS } from './workspace.js';
import fs from 'node:fs';
import path from 'node:path';
import type { Evidence } from '../record/index.js';
import { KIND_LABEL, SCENARIO_LABEL, type ConsentReportModel, type FindingKind } from './consent-model.js';

// The consent evaluation report as ONE self-contained HTML file (inline CSS +
// a few lines of JS, screenshots as data URIs, no fetches) — it opens from
// disk and attaches to an email. Evidence files (HAR, timeline) are linked by
// run-relative path, so the report works when written into the run directory.
// Vocabulary: findings, evidence, not tested — never a conformance verdict
// (asserted in test/consent-report.test.ts; not at runtime, because site
// content quoted in evidence is outside our control).

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

import { HUMAN_CSS, workBrief, safeHref } from './human.js';
import { VISITOR_ACTION, KIND_HUMAN, KIND_NOTE, details, groupConsentActions, actionTitle, groupObservation, implementationHint, occurrences, toolInventory, storageReviewCards, consentLimitations, type ActionGroup } from './consent-view.js';

function inlineImage(runDir: string | undefined, rel: string): string | null {
  if (!runDir) return null;
  try {
    const buf = fs.readFileSync(path.join(runDir, rel));
    if (buf.length > 600_000) return null;
    const type = /\.jpe?g$/i.test(rel) ? 'image/jpeg' : 'image/png';
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

function cell(c: ConsentReportModel['grid'][string][keyof ConsentReportModel['grid'][string]] | undefined): string {
  if (!c) return '<td class="na">—</td>';
  if (c.status === 'not-run') return '<td class="na" title="not in this location’s scenario set">·</td>';
  if (c.status === 'not-tested') return `<td class="nt" title="${esc(c.reason)}">not tested</td>`;
  if (c.status === 'not-applicable') return `<td class="na" title="${esc(c.reason)}">no banner</td>`;
  const parts: string[] = [];
  const add = (k: FindingKind, cls: string): void => {
    if (c.counts[k]) parts.push(`<span class="pill ${cls}" title="${esc(KIND_LABEL[k])}">${c.counts[k]}</span>`);
  };
  add('violation', 'v');
  add('needs-review', 'r');
  add('exposure', 'x');
  add('practice', 'p');
  const meta = [c.banner, c.choice].filter(Boolean).join(' · ');
  return `<td class="t"${meta ? ` title="${esc(meta)}"` : ''}>${parts.join('') || '<span class="none">no finding observed</span>'}</td>`;
}

function evidenceBlock(ev: Evidence[], runDir: string | undefined): string {
  const out: string[] = [];
  const shots = ev.filter((e): e is Extract<Evidence, { kind: 'screenshot' }> => e.kind === 'screenshot');
  for (const s of shots) {
    const uri = inlineImage(runDir, s.path);
    out.push(uri ? `<figure><img src="${uri}" alt="${esc(s.pageState)}"><figcaption>${esc(s.pageState)}</figcaption></figure>` : `<p class="mono">screenshot: ${esc(s.path)}</p>`);
  }
  const reqs = ev.filter((e): e is Extract<Evidence, { kind: 'network-request' }> => e.kind === 'network-request');
  if (reqs.length) {
    out.push(
      `<details><summary>Requests (${reqs.length} shown)</summary>${reqs
        .map((r) => `<div class="req"><code>${esc(r.url)}</code>${r.initiatorChain.length ? `<div class="chain">caused by ${r.initiatorChain.map((u) => `<code>${esc(u)}</code>`).join(' ← ')}</div>` : ''}</div>`)
        .join('')}</details>`,
    );
  }
  const logs = ev.filter((e): e is Extract<Evidence, { kind: 'interaction-log' }> => e.kind === 'interaction-log');
  const files = new Set<string>();
  for (const l of logs) {
    const head = l.steps[0] as { evidence?: { har?: string; timeline?: string } } | undefined;
    if (head?.evidence?.har) files.add(head.evidence.har);
    if (head?.evidence?.timeline) files.add(head.evidence.timeline);
  }
  if (files.size) out.push(`<p class="files">Evidence: ${[...files].map((f) => `<a href="${esc(safeHref(f))}">${esc(f.split('/').slice(-3).join('/'))}</a>`).join(' · ')}</p>`);
  return out.join('');
}

function actionCard(g: ActionGroup, m: ConsentReportModel, runDir: string | undefined): string {
  const os = occurrences(g);
  const contexts = [...new Set(os.map((o) => `${m.locations.find((l) => l.id === o.location)?.label ?? o.location}: ${VISITOR_ACTION[o.scenario] ?? o.scenario}`))];
  for (const f of g.findings) {
    const d = details(f);
    if (d.location) contexts.push(`${m.locations.find((l) => l.id === d.location)?.label ?? d.location}${d.scenario ? `: ${VISITOR_ACTION[d.scenario] ?? d.scenario}` : ''}`);
  }
  const hint = implementationHint(g);
  const notes = [...new Set(g.findings.flatMap((f) => details(f).notes ?? []))];
  const raw = [...new Map(g.findings.map((f) => [JSON.stringify(f), f])).values()];
  return `<article class="human-card" id="${g.id}" data-matrix-managed data-action-kind="${g.kind}" data-action-key="${workspaceId('action', [g.kind, g.findings.map((f) => [f.fingerprint, f.ruleId, f.scope, details(f).pattern, details(f).source, details(f).fix]).sort()])}" data-scan-tone="${g.kind === 'violation' ? 'red' : 'amber'}" data-tone="${g.kind === 'violation' ? 'red' : 'amber'}">
<span class="human-status" data-tone="${tone(KIND_HUMAN[g.kind])}">${esc(KIND_HUMAN[g.kind])}</span>
<h3>${esc(actionTitle(g))}</h3>
<p><strong>What happened:</strong> ${esc(groupObservation(g))}</p>
${os.some((o) => o.markers.length) ? '<p class="human-muted">Some data-sharing observations used sample values supplied by the scanner to test the flow. They do not establish that real customer data was shared.</p>' : ''}
<p class="human-muted">${esc(KIND_NOTE[g.kind])}</p>
${contexts.length ? `<p><strong>Where / when:</strong> ${[...new Set(contexts)].map(esc).join('; ')}.</p>` : ''}
${workBrief(g.profile)}
${g.party && m.inventory.some((p) => p.label === g.party) ? `<p><a class="human-link" href="#tool-${m.inventory.findIndex((p) => p.label === g.party) + 1}">Research ${esc(g.party)}: owner, purpose, information used and consent / controls</a>. Its tool review and individual storage reviews are saved separately from this action.</p>` : ''}
${actionControls(g.findings[0].ruleId, g.findings[0].requirementId, true)}
${hint ? `<p class="human-callout"><strong>Where to start:</strong> ${esc(hint)}</p>` : ''}
${notes.length ? `<details class="human-details"><summary>Important context (${notes.length})</summary><div><ul>${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div></details>` : ''}
<details class="human-details"><summary>Technical evidence and legal references (${g.findings.length} finding${g.findings.length === 1 ? '' : 's'})</summary><div>
<p>This action groups repeated observations of the same behavior and tool. Each original finding and its location-specific legal reference is retained below.</p>
${raw.map((f) => `<section><h4>${esc(f.requirementTitle)}</h4><p>${f.sourceUrl ? `<a href="${esc(safeHref(f.sourceUrl))}">${esc(f.citation)}</a>` : esc(f.citation)} · ${esc(f.scope)} · <code>${esc(f.ruleId)}</code> · ${esc(f.severity)}</p><p>${esc(f.message)}</p>${details(f).fix ? `<p><strong>Implementation detail:</strong> ${esc(details(f).fix)}</p>` : ''}${evidenceBlock(f.evidence, runDir)}<details class="human-details"><summary>Original finding record</summary><div><pre>${esc(JSON.stringify(f, null, 2))}</pre></div></details></section>`).join('')}
</div></details></article>`;
}

export interface ConsentHtmlOptions {
  /** The run directory: screenshots are inlined from here; links are relative to it. */
  runDir?: string;
  /** Link to the downloadable change list, relative to the report (default: change-list.md, which the CLI writes beside it); false = no link. */
  changeList?: string | false;
  /** Which classifications this rendering applied (R2): the page offers an update when the workspace's differ. */
  render?: ReportRenderInfo;
}

export function renderConsentHtml(m: ConsentReportModel, opts: ConsentHtmlOptions = {}): string {
  const groups = groupConsentActions(m);
  const head = `<tr><th>Location</th>${m.scenarios.map((s) => `<th>${esc(VISITOR_ACTION[s] ?? SCENARIO_LABEL[s])}</th>`).join('')}</tr>`;
  const body = m.locations.map((l) => `<tr><th>${esc(l.label)}<br><span class="human-muted">${esc(l.verdict)} · ${esc(l.observed)}</span></th>${m.scenarios.map((s) => cell(m.grid[l.id]?.[s])).join('')}</tr>`).join('');
  const tested = m.locations.flatMap((l) => Object.entries(m.grid[l.id] ?? {}).filter(([, c]) => c?.status === 'tested').map(([scenario, c]) => ({ location: l, scenario, cell: c! })));
  const failedChoices = tested.filter(({ cell: c }) => c.choice?.includes('(failed)'));
  const nt = consentLimitations(m);
  const evidence = m.evidenceIndex.map((e) => `<tr data-evidence-location="${esc(e.location)}" data-evidence-scenario="${esc(e.scenario)}"><td>${esc(m.locations.find((l) => l.id === e.location)?.label ?? e.location)}</td><td>${esc(VISITOR_ACTION[e.scenario] ?? e.scenario)}</td><td>${e.har ? `<a href="${esc(safeHref(e.har))}">Network log (HAR)</a>` : 'Not available'}</td><td>${e.timeline ? `<a href="${esc(safeHref(e.timeline))}">Browser timeline</a>` : 'Not available'}</td><td>${e.screenshots.map((s) => `<a href="${esc(safeHref(s))}">Screenshot</a>`).join('<br>') || 'None'}</td></tr>`).join('');
  const matrix = buildBehaviorMatrix(m);
  const workbench = buildMatrixWorkspace(m, matrix, groups);
  const library = `${workbench.tasksHtml}${groups.map(g => actionCard(g, m, opts.runDir)).join('')}${storageReviewCards(m, groups)}${toolInventory(m, groups)}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Website privacy report — ${esc(m.site.host)}</title><style>
:root{--bg:#f6f7f9;--fg:#1b1e24;--card:#fff;--line:#dde1e7;--muted:#5f6875;--dim:#5f6875;--accent:#2456d6;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--v:#b42318;--r:#b54708;--x:#6941c6;--p:#175cd3}
@media(prefers-color-scheme:dark){:root{--bg:#131519;--fg:#e7e9ec;--card:#1b1e24;--line:#2b3038;--muted:#a5aebb;--dim:#a5aebb;--accent:#82aaff;--v:#f97066;--r:#fdb022;--x:#b692f6;--p:#84adff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:1080px;margin:0 auto;padding:30px 22px 70px}h1{font-size:34px;line-height:1.2;letter-spacing:-.02em;margin:8px 0}h4{font-size:16px}code,.mono{font:12px/1.6 var(--mono)}a{color:var(--accent)}.dim{color:var(--dim)}.eyebrow{font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}select,button{font:inherit;padding:7px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg)}[hidden]{display:none!important}.pill{display:inline-block;padding:2px 6px;margin:2px;border:1px solid var(--line);border-radius:4px;font-size:12px}.pill.v{color:var(--v)}.pill.r{color:var(--r)}.pill.x{color:var(--x)}.pill.p{color:var(--p)}.grid{min-width:1200px}.grid td{min-width:120px}figure img{max-width:100%;max-height:420px;object-fit:contain}figure{margin:14px 0}.req code{overflow-wrap:anywhere}section{margin:20px 0}.na,.nt{color:var(--muted)}
${HUMAN_CSS}
${WORKSPACE_CSS}
${MATRIX_CSS}
${COMPATIBILITY_CSS}
${PROOF_CSS}
${REMEDIATION_CSS}
${RERENDER_CSS}
${SCOPE_CSS}
${LOCATION_RULES_CSS}
</style></head><body><main>
<header id="overview"><div class="eyebrow">ComplyKit · Website privacy report</div><h1>${esc(m.site.host)}</h1><p class="human-muted">${esc(m.site.url)} · Scanned ${esc(m.startedAt.slice(0, 16).replace('T', ' '))} UTC</p>
<p class="human-intro">See how cookies and tracking tools behaved, decide what needs attention, and keep track of your work.</p>
<nav class="human-nav" aria-label="Report sections"><a href="#remediation">Your to-do list</a><a href="#behavior-matrix">Cookie &amp; tool checks</a><a href="#compatibility">Consent tool compatibility</a>${m.consentToolProof?.detected ? '<a href="#consent-tool-proof">Your consent tool</a>' : ''}<a href="#report-workspace">Saved progress</a><a href="#coverage">Scan coverage</a></nav></header>
${renderScopeHtml(m)}
${renderRemediationHtml(m.remediation, m)}
${renderSinceHtml(m.since, carriedTasks(m.siteWorkspace?.doneTasks, library))}
${renderRerenderPanel(opts.render, m.runId)}
${renderLocationRulesHtml(m)}
${renderBehaviorMatrix(matrix, workbench)}
${renderCompatibilityHtml(m.compatibility, { changeListHref: opts.changeList === false ? undefined : (opts.changeList ?? CHANGE_LIST_FILE) })}
${renderConsentToolProofHtml(m.consentToolProof)}
<details class="human-details" id="rule-actions"><summary>Rule findings and other review actions (${groups.length})</summary><div><p>These are the original rule findings, grouped into actions. Some are legal or research questions rather than behavior mismatches. Select an action to open it in the workspace.</p><ul>${groups.map(g => `<li><button type="button" data-select-action="${g.id}">${esc(actionTitle(g))}</button> <span class="human-muted">${esc(KIND_HUMAN[g.kind])}</span></li>`).join('') || '<li>No rule findings were recorded. The grid above still shows any behavior mismatches or missing checks.</li>'}</ul></div></details>
<details class="human-details" id="checklist-panel"><summary>Saved progress, backups and research notes</summary><div>${workspacePanel('Saved progress')}</div></details>
<div id="matrix-detail-library" hidden>${library}</div>
<noscript><p>Enable JavaScript to select grid results and save progress. All research and action details are shown below when scripting is disabled.</p><style>#matrix-detail-library[hidden]{display:block!important}</style></noscript>
<details class="human-details" id="coverage-panel"><summary>Scan coverage, limitations and evidence</summary><div>
<section id="coverage"><h2 class="human-section-title">What we checked and what is missing</h2><p>This report covers the recorded locations, pages and visitor actions only. A result from one location may not describe how your site behaves elsewhere.</p>
<ul>${m.locations.map((l) => `<li><strong>${esc(l.label)}:</strong> ${l.verdict === 'verified' ? `location verified (${esc(l.observed)})` : `location could not be verified as requested (${esc(l.observed)}); do not use it as evidence for the intended location`}.${l.note ? ` ${esc(l.note)}` : ''}</li>`).join('')}</ul>
<h3>Not tested</h3>${nt ? `<ul>${nt}</ul>` : '<p>No additional limitations were recorded. This does not establish complete coverage of the site.</p>'}
${failedChoices.length ? `<h3>Choices that did not succeed</h3><ul>${failedChoices.map(({ location, scenario }) => `<li>${esc(location.label)}: ${esc(VISITOR_ACTION[scenario] ?? scenario)}. Retest with a working control or manual interaction.</li>`).join('')}</ul>` : ''}
<details class="human-details"><summary>Detailed test matrix and original finding counts</summary><div><p>Counts are original findings, not grouped actions. The same finding may occur in several cells. Exposure items are for legal review, not violations.</p><div class="human-table-wrap"><table class="human-table grid"><thead>${head}</thead><tbody>${body}</tbody></table></div></div></details>
<details class="human-details"><summary>Scan metadata and evidence files</summary><div><p>Run <code>${esc(m.runId)}</code> · package ${esc(m.versions.package)} · knowledge base ${esc(m.versions.kb)} · registry ${esc(m.versions.registry)}${m.versions.autoconsent ? ` · autoconsent ${esc(m.versions.autoconsent)}` : ''}.</p><p>${m.redacted ? 'Cookie values, authentication headers and request bodies were redacted.' : 'Raw evidence can contain cookies, tokens and visitor information. Handle it carefully.'} Evidence links require the accompanying run files.</p><div class="human-table-wrap"><table class="human-table"><thead><tr><th>Location</th><th>Visitor action</th><th>Network evidence</th><th>Timeline</th><th>Screenshots</th></tr></thead><tbody>${evidence}</tbody></table></div></div></details></section></div></details>
<footer class="human-callout"><strong>About this report</strong><p>This is an automated review of observed website behavior, not legal advice or a legal conclusion. It does not assert conformance or guarantee that every issue was found. Requirements can depend on location, your organization and how a tool is used. Classifications may need confirmation, and some checks require a person. Review the evidence with your team and seek qualified advice for legal decisions.</p></footer>
</main><script>${KEEP_SCROLL_JS}</script><script>${MATRIX_JS}</script><script>${LOCATION_RULES_JS}</script><script>${REMEDIATION_JS}</script>
${workspaceScript('consent', m.property + ':' + m.site.url, m.runId, m.findings.map((f) => f.fingerprint))}<script>${RERENDER_JS}</script></body></html>`;
}
