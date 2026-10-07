import { RemediationTask, resolveRemediationTaskValue, type RemediationStatus } from '../record/index.js';
import { escapeHtml as esc, safeHref } from './human.js';
import { shortPage } from './consent-compatibility.js';

// "Make these changes" — the guided checklist (plans/remediation-flow.md §6, R3).
// A numbered list of the generated config's tasks, install first: plain title,
// one-line why, numbered steps, the markup to paste (with a copy button) and
// what it looks like now, the pages, a guide link, and a status the owner sets
// ("I've made this change") or a Verify sets (service only). Pure over
// RemediationTask[]; the status overlay and the buttons are REMEDIATION_JS,
// which saves through the report workbench's storage (workspace.ts: the site
// workspace on the service, localStorage offline) under task:change:<id>.
//
// Wording: a Verify pass means the fetched page (or container) carries the
// change — never that the site is compliant; the rescan shows behavior.

/** The checklist the report renders: tasks from the latest generated config. */
export interface RemediationSection {
  tasks: RemediationTask[];
  /** Where they came from: the site workspace's config (service / --workspace) or the run's generated output. */
  source: 'workspace' | 'run';
  /** When the config was generated, and from which run. */
  configAt?: string;
  runId?: string;
}

/** Validate tasks read from JSON (a stored config value, a tasks file); invalid ones are dropped, the order is kept. */
export function parseRemediationTasks(raw: unknown): RemediationTask[] {
  if (!Array.isArray(raw)) return [];
  const out: RemediationTask[] = [];
  for (const t of raw) {
    const r = RemediationTask.safeParse(t);
    if (r.success) out.push(r.data);
  }
  return out.sort((a, b) => a.order - b.order);
}

/** The parts of a site workspace this reads (the service's SiteWorkspace and the CLI's WorkspaceSnapshot qualify). */
export interface RemediationWorkspaceLike {
  entries: Record<string, { value: unknown } | undefined>;
  config?: { value: unknown; at?: string; runId?: string };
}

/** Status from the workspace's task:change:<id> entries over the tasks' own (a cleared entry is to do; a folded item's entry is found through the task's aliases). */
export function withWorkspaceStatus(tasks: RemediationTask[], ws: RemediationWorkspaceLike | undefined): RemediationTask[] {
  if (!ws) return tasks;
  return tasks.map((t) => {
    const v = resolveRemediationTaskValue(t, ws.entries);
    if (!v) return t;
    const { lastVerify: _drop, ...rest } = t;
    return { ...rest, status: v.status, ...(v.lastVerify ? { lastVerify: v.lastVerify } : {}) };
  });
}

/** The checklist from a workspace's latest generated config (`config.value.tasks`); undefined when it has none. */
export function remediationFromWorkspace(ws: RemediationWorkspaceLike | undefined): RemediationSection | undefined {
  const value = ws?.config?.value as { tasks?: unknown } | undefined;
  const tasks = parseRemediationTasks(value?.tasks);
  if (!ws || !tasks.length) return undefined;
  return { tasks: withWorkspaceStatus(tasks, ws), source: 'workspace', ...(ws.config?.at ? { configAt: ws.config.at } : {}), ...(ws.config?.runId ? { runId: ws.config.runId } : {}) };
}

export const REMEDIATION_STATUS_LABEL: Record<RemediationStatus, string> = {
  todo: 'To do',
  'done-unverified': 'Marked done',
  verified: 'Verified ✓',
  failed: 'Failed ✗',
  'cannot-verify': 'Can’t verify automatically',
};
const STATUS_TONE: Record<RemediationStatus, string> = { todo: 'neutral', 'done-unverified': 'amber', verified: 'green', failed: 'red', 'cannot-verify': 'amber' };

/** The element id of a task card (ids carry a colon). */
export const taskAnchor = (id: string): string => `task-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

const attrJson = (v: unknown): string => esc(JSON.stringify(v));

function lastVerifyHtml(t: RemediationTask): string {
  const lv = t.lastVerify;
  if (!lv) return '';
  return `<p><strong>Last check (${esc(lv.at.slice(0, 16).replace('T', ' '))} UTC):</strong> ${esc(lv.message)}</p>${lv.evidence.length ? `<ul class="ck-task-evidence">${lv.evidence.map((e) => `<li><code>${esc(e)}</code></li>`).join('')}</ul>` : ''}`;
}

/** One step; a step with surface variants carries both, the script shows the one for where the report is open (offline until it knows: a file has no service). */
function stepHtml(t: RemediationTask, text: string, i: number): string {
  const v = t.stepVariants?.find((x) => x.step === i);
  if (!v) return esc(text);
  return `<span data-rem-surface="service" hidden>${esc(v.service)}</span><span data-rem-surface="offline">${esc(v.offline)}</span>`;
}

function card(t: RemediationTask, matrixRow: (partyId: string) => number): string {
  const anchor = taskAnchor(t.id);
  const base = { status: t.status, ...(t.lastVerify ? { lastVerify: t.lastVerify } : {}) };
  const pages = t.pages.length
    ? `<p class="ck-task-pages"><strong>${t.pages.length === 1 ? 'Page' : 'Pages'}:</strong> ${t.pages.map((p) => `<a href="${esc(safeHref(p))}">${esc(shortPage(p))}</a>`).join(', ')}</p>`
    : '';
  const row = t.classifyFirst && t.partyIds[0] !== undefined ? matrixRow(t.partyIds[0]) : -1;
  const classify = t.classifyFirst
    ? `<p class="ck-task-classify"><strong>Classify first:</strong> this applies only if ${esc(t.tools.join(', ') || 'the tool')} tracks visitors. ${row >= 0 ? `<button type="button" class="ck-link-button" data-matrix-select="${row}:0">Open ${esc(t.tools[0] ?? 'it')} in the grid</button>` : '<a href="#behavior-matrix">Classify it in the grid</a>'}; skip this task if it does not.</p>`
    : '';
  const manual = t.verify.method === 'manual' ? `<p class="human-muted" data-rem-manual>Can’t be checked automatically: ${esc(t.verify.reason)}. Mark it done when it’s made; the rescan decides.</p>` : '';
  const also = t.alsoFixes?.length ? `<div class="ck-task-also"><strong>This also fixes:</strong>${t.alsoFixes.length === 1 ? ` ${esc(t.alsoFixes[0])}` : `<ul>${t.alsoFixes.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>`}</div>` : '';
  return `<li class="ck-task" id="${esc(anchor)}" data-remediation-id="${esc(t.id)}"${t.aliases?.length ? ` data-rem-aliases="${esc(t.aliases.join(' '))}"` : ''} data-task-kind="${esc(t.kind)}" data-verify-method="${esc(t.verify.method)}" data-status="${esc(t.status)}" data-rem-base="${attrJson(base)}"${t.optional ? ' data-optional="true"' : ''}>
<div class="ck-task-head"><h3>${esc(t.title)}</h3><span class="human-status ck-pill" data-rem-pill data-tone="${STATUS_TONE[t.status]}">${esc(REMEDIATION_STATUS_LABEL[t.status])}</span></div>
<p class="ck-task-why">${esc(t.summary)}</p>
${also}
${classify}
<ol class="ck-task-steps">${t.steps.map((s, i) => `<li>${stepHtml(t, s, i)}</li>`).join('')}</ol>
${t.snippet?.after ? `<div class="ck-snippet"><div class="ck-snippet-bar"><span>${t.kind === 'install' ? 'Paste this first in &lt;head&gt;' : 'Change it to this'}</span><button type="button" data-rem-copy aria-label="Copy the markup for: ${esc(t.title)}">Copy</button><span class="ck-copy-status" data-rem-copy-status role="status"></span></div><pre data-rem-code>${esc(t.snippet.after)}</pre></div>` : ''}
${t.snippet?.before ? `<details class="human-details"><summary>What it looks like now</summary><div><pre>${esc(t.snippet.before)}</pre></div></details>` : ''}
${pages}
${t.guide ? `<p class="ck-task-guide"><a href="${esc(safeHref(t.guide.href))}">Guide: ${esc(t.guide.label)}</a></p>` : ''}
${t.notes.length ? `<details class="human-details"><summary>Notes (${t.notes.length})</summary><div><ul>${t.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div></details>` : ''}
${manual}
<div class="ck-task-actions"><button type="button" data-rem-done aria-pressed="${t.status === 'done-unverified'}">I’ve made this change</button>${t.verify.method !== 'manual' ? '<button type="button" data-rem-verify hidden>Verify</button>' : ''}${t.kind === 'install' ? '<a class="ck-zip" data-rem-zip hidden download>Download install bundle (.zip)</a>' : ''}</div>
<div class="ck-task-result" data-rem-result role="status" aria-live="polite">${lastVerifyHtml(t)}</div>
<details class="human-details ck-task-note"><summary>Note</summary><div><label>Note for your team <textarea data-rem-note rows="2" maxlength="4000" placeholder="Who made the change, when, or why it is skipped"></textarea></label></div></details>
</li>`;
}

/** The last step: the rescan. The button is the service's (POST /api/sites/:domain/rescan); offline, the command. Never a verdict. */
function rescanHtml(): string {
  return `<div class="ck-rem-rescan" data-rem-rescan>
<h3>Last step: rescan the site</h3>
<p>When every change above is made, rescan. A verified change means the page we fetched carries it — not what visitors’ browsers do. The rescan’s report has the final word: its section <strong>“Your complykit consent tool: what it controls”</strong> says, per vendor, <em>controlled</em>, <em>not controlled</em> or <em>not observed</em>, for the pages and locations it visited. Anything not verified or marked done here will show up there.</p>
<div data-rem-rescan-service hidden>
<fieldset class="ck-rescan-options" data-rem-rescan-options><legend>Rescan options</legend>
<p>Location: <strong>this service’s own connection</strong> — the only place it scans from today.</p>
<label><input type="radio" name="ck-rescan-mode" value="full" data-rem-rescan-mode checked> Full — every visitor choice, normal visits (best for the final check)</label>
<label><input type="radio" name="ck-rescan-mode" value="quick" data-rem-rescan-mode> Quick — shorter visits, fewer visitor choices</label>
</fieldset>
<p><button type="button" data-rem-rescan-button>Rescan site</button> <span data-rem-rescan-status role="status"></span></p>
<div class="ck-rescan-follow" data-rem-rescan-follow hidden><progress data-rem-rescan-progress max="100" value="0" aria-label="Rescan progress"></progress><p data-rem-rescan-phase role="status" aria-live="polite"></p></div>
</div>
<p data-rem-rescan-offline class="human-muted">Rescan from the complykit service (the site page or this report opened from it), or run <code>complykit consent --url &lt;your page&gt; --workspace &lt;workspace.json&gt;</code> again.</p>
</div>`;
}

/** The `#remediation` section: the checklist, or the prompt to generate the config. */
export function renderRemediationHtml(section: RemediationSection | undefined, m?: { behaviorMatrix?: { rows: Array<{ kind: string; partyId: string }> } }): string {
  const tasks = section?.tasks ?? [];
  if (!tasks.length) {
    return `<section id="remediation" class="ck-rem" aria-labelledby="remediation-title" data-remediation-empty data-rem-config-at="${esc(section?.configAt ?? '')}">
<h2 id="remediation-title" class="human-section-title">Make these changes</h2>
<div class="ck-rem-stale" data-rem-stale hidden role="status"><p><strong>The checklist was regenerated after this report was rendered.</strong> <span data-rem-stale-at></span></p><p><button type="button" data-rem-refresh>Show the new checklist</button> <span data-rem-refresh-status role="status"></span></p></div>
<p>Generate the consent tool config to get your checklist: the exact changes to make, in order, each with a way to check it.</p>
<p data-rem-generate-offline class="human-muted">Run <code>complykit consent-config &lt;run-dir&gt;</code>, then <code>complykit report --format consent-html</code> again; or open this report from the complykit service and generate it there.</p>
<p data-rem-generate-service hidden><button type="button" data-rem-generate>Generate the consent tool config</button> <span data-rem-generate-status role="status"></span></p>
<div class="ck-rem-stale" data-rem-generate-partial hidden role="alert"><p><strong>Your checklist was generated; the report couldn’t refresh — reload or press Update report.</strong></p><p class="human-muted" data-rem-generate-reason></p><p><button type="button" data-rem-update-report>Update report</button> <span data-rem-update-status role="status"></span></p></div>
</section>`;
  }
  const rows = m?.behaviorMatrix?.rows ?? [];
  const matrixRow = (partyId: string): number => rows.findIndex((r) => r.kind === 'tool' && r.partyId === partyId);
  const required = tasks.filter((t) => !t.optional && !t.classifyFirst);
  const later = tasks.filter((t) => t.optional || t.classifyFirst);
  const verified = required.filter((t) => t.status === 'verified').length;
  const from = section?.configAt ? `Generated ${esc(section.configAt.slice(0, 16).replace('T', ' '))} UTC${section.runId ? ` from run <code>${esc(section.runId)}</code>` : ''}. ` : '';
  return `<section id="remediation" class="ck-rem" aria-labelledby="remediation-title" data-remediation-source="${esc(section?.source ?? 'run')}" data-rem-config-at="${esc(section?.configAt ?? '')}">
<h2 id="remediation-title" class="human-section-title">Make these changes</h2>
<div class="ck-rem-stale" data-rem-stale hidden role="status"><p><strong>The checklist was regenerated after this report was rendered.</strong> <span data-rem-stale-at></span></p><p><button type="button" data-rem-refresh>Show the new checklist</button> <span data-rem-refresh-status role="status"></span></p></div>
<p>Do these in order — the install comes first, everything else relies on it. Each change says what to edit, where, and how to check it.</p>
<div class="ck-rem-progress"><progress data-rem-progress max="${required.length}" value="${verified}" aria-label="Changes verified"></progress><p data-rem-progress-text role="status"><strong>${verified} of ${required.length} verified</strong></p><p class="human-muted" data-rem-progress-more></p></div>
<p class="human-muted" data-rem-offline>Verify needs the complykit service (open this report from it). Here you can mark changes done; that is saved in this browser.</p>
<ol class="ck-rem-list">${required.map((t) => card(t, matrixRow)).join('')}</ol>
${later.length ? `<details class="human-details ck-rem-later"><summary>Only if they apply (${later.length}): chat, embeds, fonts and tools to classify first</summary><div><p class="human-muted">Not counted in the progress above. Each says when it applies.</p><ol class="ck-rem-list">${later.map((t) => card(t, matrixRow)).join('')}</ol></div></details>` : ''}
<p class="human-muted">${from}“Verified” means the page we fetched carries the change. What visitors’ browsers actually do is shown by a rescan — run it once every change is made.</p>
${rescanHtml()}
</section>`;
}

export const REMEDIATION_CSS = `.ck-rem{margin:24px 0;padding:18px;border:1px solid var(--line);border-radius:12px;background:var(--card)}.ck-rem .human-section-title{margin-top:0!important}
.ck-rem-progress{margin:12px 0}.ck-rem-progress progress{width:100%;height:12px;accent-color:var(--work-green,#14663b)}.ck-rem-progress p{margin:4px 0}
.ck-rem-list{padding-left:0;list-style:none;counter-reset:task;margin:12px 0}.ck-task{counter-increment:task;border:1px solid var(--line);border-left:5px solid var(--work-neutral,#526071);border-radius:8px;padding:12px 14px;margin:12px 0;background:var(--bg)}
.ck-task[data-status=verified]{border-left-color:var(--work-green,#14663b)}.ck-task[data-status=failed]{border-left-color:var(--work-red,#a52218)}.ck-task[data-status=done-unverified],.ck-task[data-status=cannot-verify]{border-left-color:var(--work-amber,#805100)}
.ck-task-head{display:flex;gap:10px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap}.ck-task-head h3{margin:0;font-size:17px}.ck-task-head h3::before{content:counter(task) ". ";color:var(--muted)}
.ck-pill{display:inline-block;padding:2px 8px;border:1px solid;border-radius:999px;font-size:13px;white-space:nowrap}.ck-task-why{margin:6px 0}.ck-task-also{margin:6px 0;padding:6px 10px;border-radius:6px;background:var(--card);font-size:14px}.ck-task-also ul{margin:4px 0 0;padding-left:20px}.ck-task-steps{margin:8px 0;padding-left:22px}
.ck-snippet{margin:8px 0}.ck-snippet-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13px;color:var(--muted)}.ck-snippet pre,.ck-task pre{white-space:pre;overflow-x:auto;max-width:100%;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:8px;font:12px/1.5 var(--mono,ui-monospace,monospace)}
.ck-task-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0 4px}.ck-task-actions button[aria-pressed=true]{border-color:var(--work-amber,#805100)}.ck-task-actions button:disabled{opacity:.6}
.ck-task-result:empty{display:none}.ck-checking::before{content:'';display:inline-block;width:12px;height:12px;margin-right:8px;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:ck-spin 1s linear infinite;vertical-align:-1px}@keyframes ck-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.ck-checking::before{animation:none}}.ck-task-result{font-size:14px}.ck-task-evidence code{overflow-wrap:anywhere}.ck-link-button{padding:2px 6px}.ck-task-note textarea{width:100%;font:inherit;padding:6px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg)}
.ck-rem-stale{margin:10px 0;padding:10px 12px;border:2px solid var(--work-amber,#805100);border-radius:8px;background:var(--work-amber-bg,#fff7db)}.ck-rem-stale[hidden],.ck-rem [hidden]{display:none!important}.ck-rem-stale p{margin:4px 0}.ck-rem-rescan{margin-top:16px;padding-top:12px;border-top:1px solid var(--line)}.ck-rem-rescan h3{margin:0 0 6px;font-size:17px}.ck-rescan-options{border:0;margin:8px 0;padding:0}.ck-rescan-options legend{font-weight:600;padding:0}.ck-rescan-options label{display:block;margin:4px 0}.ck-rescan-follow progress{width:100%;height:10px}
.ck-task :focus-visible,.ck-rem :focus-visible{outline:2px solid var(--accent);outline-offset:2px}.ck-change-task{display:inline-block;margin-top:4px;font-size:13px}
@media print{.ck-task-actions,.ck-task-note,[data-rem-copy],[data-rem-rescan-service],[data-rem-stale]{display:none!important}}`;

// The overlay: status from the workbench storage (window.ComplyKitWorkspace),
// Mark done / Verify / copy / note, progress, and links from the change list.
// Re-runs on every workbench update and when the section is replaced.
export const REMEDIATION_JS = String.raw`(function(){
var LABEL={todo:'To do','done-unverified':'Marked done',verified:'Verified ✓',failed:'Failed ✗','cannot-verify':'Can’t verify automatically'};
var TONE={todo:'neutral','done-unverified':'amber',verified:'green',failed:'red','cannot-verify':'amber'};
var RESULT={pass:'verified',fail:'failed','cannot-verify':'cannot-verify'};
// The service block sits after this script (just before the workbench config): read it on first use.
var service=null,looked=false;
function findService(){if(looked)return service;var sc=document.getElementById('ck-service');if(!sc&&document.readyState==='loading')return null;looked=true;try{if(sc){service=JSON.parse(sc.textContent);if(!service||typeof service.domain!=='string'||typeof service.workspace!=='string')service=null;}}catch(e){service=null;}return service;}
var busy={};
function ws(){return window.ComplyKitWorkspace;}
function base(el){try{return JSON.parse(el.dataset.remBase||'{}');}catch(e){return {};}}
function value(el){var w=ws(),v=w&&w.remediation?w.remediation(el.dataset.remediationId):undefined;return v||base(el);}
function siteApi(){return service.workspace.replace(/\/workspace$/,'');}
function setValue(el,v,remote){var w=ws();if(w&&w.setRemediation)w.setRemediation(el.dataset.remediationId,v,remote);else{el.dataset.remBase=JSON.stringify(v);render();}}
function resultInto(box,lv,error){
  box.textContent='';
  if(error){var pe=document.createElement('p');pe.textContent=error;box.appendChild(pe);return;}
  if(!lv)return;
  var p=document.createElement('p'),b=document.createElement('strong');b.textContent='Last check ('+String(lv.at||'').slice(0,16).replace('T',' ')+' UTC): ';p.appendChild(b);p.appendChild(document.createTextNode(lv.message||''));box.appendChild(p);
  if(lv.evidence&&lv.evidence.length){var ul=document.createElement('ul');ul.className='ck-task-evidence';lv.evidence.forEach(function(x){var li=document.createElement('li'),c=document.createElement('code');c.textContent=x;li.appendChild(c);ul.appendChild(li);});box.appendChild(ul);}
}
function render(){
  findService();
  var sec=document.getElementById('remediation');if(!sec)return;
  var gen=sec.querySelector('[data-rem-generate-service]'),genOff=sec.querySelector('[data-rem-generate-offline]');if(gen){gen.hidden=!service||!service.jobId;if(genOff)genOff.hidden=!!(service&&service.jobId);}
  var off=sec.querySelector('[data-rem-offline]');if(off)off.hidden=!!service;
  var rs=sec.querySelector('[data-rem-rescan-service]'),ro=sec.querySelector('[data-rem-rescan-offline]');if(rs)rs.hidden=!service;if(ro)ro.hidden=!!service;if(service)presetMode();
  var stale=sec.querySelector('[data-rem-stale]');if(stale){var cur=sec.dataset.remConfigAt||'';stale.hidden=!(service&&service.jobId&&liveConfigAt!==null&&liveConfigAt!==cur);var sa=stale.querySelector('[data-rem-stale-at]');if(sa&&!stale.hidden)sa.textContent=('The site’s config is from '+liveConfigAt.slice(0,16).replace('T',' ')+' UTC')+(cur?'; this report shows the one from '+cur.slice(0,16).replace('T',' ')+' UTC.':'; this report shows none.');}
  var req=0,ver=0,done=0,failed=0,cannot=0,anyBusy=Object.keys(busy).some(function(k){return busy[k];});
  sec.querySelectorAll('[data-remediation-id]').forEach(function(el){
    var v=value(el),s=LABEL[v.status]?v.status:'todo',id=el.dataset.remediationId;
    el.dataset.status=s;
    var pill=el.querySelector('[data-rem-pill]');pill.textContent=LABEL[s];pill.dataset.tone=TONE[s];
    var d=el.querySelector('[data-rem-done]');if(d){d.hidden=s==='verified';d.setAttribute('aria-pressed',s==='done-unverified'?'true':'false');d.textContent=s==='done-unverified'?'Undo “made this change”':'I’ve made this change';}
    var vb=el.querySelector('[data-rem-verify]');if(vb){vb.hidden=!service;vb.disabled=anyBusy;vb.setAttribute('aria-busy',busy[id]?'true':'false');vb.textContent=busy[id]?'Checking the live page…':s==='verified'||s==='failed'||s==='cannot-verify'?'Verify again':'Verify';}
    var zip=el.querySelector('[data-rem-zip]');if(zip){zip.hidden=!service;if(service)zip.href=siteApi()+'/install.zip';}
    el.querySelectorAll('[data-rem-surface]').forEach(function(x){x.hidden=(x.dataset.remSurface==='service')!==!!service;});
    var box=el.querySelector('[data-rem-result]');if(box&&!busy[id]&&!box.dataset.error)resultInto(box,v.lastVerify);
    var note=el.querySelector('[data-rem-note]');if(note&&document.activeElement!==note)note.value=v.note||'';
    if(el.dataset.optional!=='true'&&!el.closest('.ck-rem-later')){req++;if(s==='verified')ver++;else if(s==='done-unverified')done++;else if(s==='failed')failed++;else if(s==='cannot-verify')cannot++;}
  });
  var bar=sec.querySelector('[data-rem-progress]');if(bar){bar.max=Math.max(req,1);bar.value=ver;}
  var t=sec.querySelector('[data-rem-progress-text]');if(t){t.textContent='';var st=document.createElement('strong');st.textContent=ver+' of '+req+' verified';t.appendChild(st);}
  var more=sec.querySelector('[data-rem-progress-more]');if(more){var parts=[];if(done)parts.push(done+' marked done, not verified yet');if(failed)parts.push(failed+' failed');if(cannot)parts.push(cannot+' can’t be verified automatically');more.textContent=parts.join(' · ');}
  // Each change-list item points at its task.
  // A folded item (a behavior mismatch, a vendor call) points at the task that fixes it (data-rem-aliases).
  document.querySelectorAll('#compatibility [data-change-id]').forEach(function(item){var id=item.dataset.changeId,q=window.CSS&&CSS.escape?CSS.escape(id):id,card=sec.querySelector('[data-remediation-id="'+q+'"]')||sec.querySelector('[data-rem-aliases~="'+q+'"]');if(!card||item.querySelector('.ck-change-task'))return;var a=document.createElement('a');a.className='ck-change-task';a.href='#'+card.id;a.textContent=card.dataset.remediationId===id?'In your checklist →':'Fixed by a task in your checklist →';item.appendChild(a);});
}
function verify(el){
  var id=el.dataset.remediationId,box=el.querySelector('[data-rem-result]');if(!service||Object.keys(busy).some(function(k){return busy[k];}))return;
  busy[id]=true;delete box.dataset.error;box.textContent='';var sp=document.createElement('p');sp.className='ck-checking';sp.textContent='Checking the live page… a browser check can take up to a minute.';box.appendChild(sp);render();
  fetch(siteApi()+'/remediation/'+encodeURIComponent(id)+'/verify',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json'},body:'{}'})
  .then(function(r){return r.json().catch(function(){return {};}).then(function(b){if(!r.ok)throw Error(b&&b.error||'HTTP '+r.status);return b;});})
  .then(function(b){
    var t=b&&b.task||b||{},lv=t.lastVerify||(b&&b.outcome?Object.assign({at:new Date().toISOString()},b.outcome):null),st=t.status||(lv?RESULT[lv.result]:null);
    if(!st||!LABEL[st])throw Error('the service sent no result');
    var cur=value(el),next={status:st};if(cur.note)next.note=cur.note;if(lv)next.lastVerify={at:lv.at||new Date().toISOString(),result:lv.result,message:lv.message||'',evidence:lv.evidence||[]};
    busy[id]=false;setValue(el,next,true);
  },function(err){busy[id]=false;box.dataset.error='1';resultInto(box,null,'Could not run the check: '+(err.message||'the service did not answer')+'. Nothing was changed.');})
  .then(function(){busy[id]=false;render();var vb=el.querySelector('[data-rem-verify]');if(vb&&document.activeElement===document.body)vb.focus();});
}
function copy(btn){
  var wrap=btn.closest('.ck-snippet'),text=wrap.querySelector('[data-rem-code]').textContent,status=wrap.querySelector('[data-rem-copy-status]');
  function ok(){status.textContent='Copied';setTimeout(function(){status.textContent='';},2500);}
  function fallback(){var ta=document.createElement('textarea');ta.value=text;ta.setAttribute('readonly','');ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();var done=false;try{done=document.execCommand('copy');}catch(e){}ta.remove();if(done)ok();else status.textContent='Select the text and copy it';}
  if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(text).then(ok,fallback);else fallback();
}
// Generate (and "show the new checklist") re-render this report from the saved
// run with the site's current workspace, then reload with the checklist where it
// was on screen — the same path as "Update report with my classifications" (R2), so
// the config, the change list and the checklist on the page always agree.
var liveConfigAt=null;
function pending(){var w=ws();return new Promise(function(resolve,reject){var t=0;(function poll(){if(!w||!w.pendingCount||!w.pendingCount())return resolve();if((t+=200)>15000)return reject(Error('your latest changes are not saved to the shared workspace yet'));setTimeout(poll,200);})();});}
function rerender(gen,btn,status,working){
  btn.disabled=true;status.textContent=working;
  pending().then(function(){
    return fetch('/api/jobs/'+encodeURIComponent(service.jobId)+'/rerender',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json'},body:JSON.stringify(gen?{generate:true}:{})});
  }).then(function(r){return r.json().catch(function(){return {};}).then(function(b){if(!r.ok||!b.ok){var e=Error(b&&b.error||'HTTP '+r.status);e.configStored=!!(b&&b.configStored);throw e;}return b;});})
  .then(function(b){
    if(gen)window.dispatchEvent(new CustomEvent('complykit-config-generated',{detail:b}));
    // The reload lands on the checklist, where the button was (KEEP_SCROLL_JS).
    if(window.ComplyKitScroll)window.ComplyKitScroll.save(b.at,'remediation');
    location.reload();
  },function(err){
    btn.disabled=false;
    // The config (and so the checklist) was stored; only the report re-render failed: say exactly that, offer the retry.
    var part=gen&&err.configStored?document.querySelector('[data-rem-generate-partial]'):null;
    if(part){status.textContent='';part.hidden=false;var why=part.querySelector('[data-rem-generate-reason]');if(why)why.textContent='Why: '+(err.message||'unknown error');return;}
    status.textContent=(gen?'Could not generate: ':'Could not update the report: ')+(err.message||'unknown error');
  });
}
function generate(btn){rerender(true,btn,document.querySelector('[data-rem-generate-status]'),'Generating the config and your checklist…');}
// Rescan: the options the service offers (the location is fixed: the service's own connection;
// full or quick, preselected from this report's job), then follow the new job inline through
// the same job events the checks page uses (/api/stream), and link straight to the new report's
// proof section when it is done.
var PHASE={queued:'Waiting in queue','verifying-location':'Checking the test location',scenarios:'Testing visitor choices',analyzing:'Preparing your findings',accessibility:'Accessibility scan',finished:'Finished'};
var modeSet=false;
function presetMode(){
  if(modeSet||!service||!service.jobId)return;modeSet=true;
  fetch('/api/jobs/'+encodeURIComponent(service.jobId),{credentials:'same-origin',cache:'no-store'}).then(function(r){return r.ok?r.json():null;}).then(function(j){if(!j)return;var q=document.querySelector('[data-rem-rescan-mode][value="'+(j.quick?'quick':'full')+'"]');if(q)q.checked=true;},function(){});
}
function follow(job){
  var box=document.querySelector('[data-rem-rescan-follow]'),bar=document.querySelector('[data-rem-rescan-progress]'),ph=document.querySelector('[data-rem-rescan-phase]'),btn=document.querySelector('[data-rem-rescan-button]'),opts=document.querySelector('[data-rem-rescan-options]');
  if(!box)return;box.hidden=false;var done=false,es=null,timer=null;
  function show(j){
    if(done||!j||j.id!==job.id)return;
    var p=j.progress||{},pct=Math.round(Math.max(0,Math.min(1,p.fraction||0))*100);bar.value=pct;
    if(j.status==='queued'||j.status==='running'){ph.textContent='Rescanning ('+(j.quick?'quick':'full')+')… '+(PHASE[p.phase]||'starting')+(p.current?' — '+p.current:'')+' · '+pct+'%';return;}
    done=true;if(es)es.close();if(timer)clearInterval(timer);var w=ws();if(w&&w.refresh)w.refresh();btn.disabled=false;btn.textContent='Rescan again';if(opts)opts.disabled=false;ph.textContent='';
    var url=j.result&&j.result.consent&&j.result.consent.reportUrl;
    if(j.status==='done'&&url){bar.value=100;ph.appendChild(document.createTextNode('Rescan finished. '));var a=document.createElement('a');a.href=url+'#consent-tool-proof';a.textContent='Open the new report at “Your complykit consent tool: what it controls”';a.setAttribute('data-rem-rescan-report','');ph.appendChild(a);ph.appendChild(document.createTextNode(' — it says, per vendor, controlled, not controlled or not observed.'));}
    else ph.textContent='The rescan '+(j.status==='cancelled'?'was cancelled':'did not finish')+(j.error?': '+j.error:'')+'. Nothing on the checklist changed; you can start it again.';
  }
  function poll(){fetch('/api/jobs/'+encodeURIComponent(job.id),{credentials:'same-origin',cache:'no-store'}).then(function(r){return r.ok?r.json():null;}).then(show,function(){});}
  show(job);
  if(window.EventSource){try{es=new EventSource('/api/stream');es.addEventListener('job',function(ev){try{show(JSON.parse(ev.data));}catch(e){}});es.onerror=function(){if(!timer)timer=setInterval(poll,5000);};}catch(e){es=null;}}
  // The stream sends changes, not the current state: read it once now, and poll if there is no stream.
  poll();if(!es)timer=setInterval(poll,3000);
}
function rescan(btn){
  var status=document.querySelector('[data-rem-rescan-status]'),q=document.querySelector('[data-rem-rescan-mode][value="quick"]'),quick=!!(q&&q.checked),opts=document.querySelector('[data-rem-rescan-options]');
  btn.disabled=true;if(opts)opts.disabled=true;status.textContent='Starting the rescan…';
  fetch(siteApi()+'/rescan',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json'},body:JSON.stringify({quick:quick})})
  .then(function(r){return r.json().catch(function(){return {};}).then(function(b){if(!r.ok)throw Error(b&&b.error||'HTTP '+r.status);return b;});})
  .then(function(b){status.textContent='Rescan started ('+(b.job&&b.job.quick?'quick':'full')+').';follow(b.job);},function(err){btn.disabled=false;if(opts)opts.disabled=false;status.textContent='Could not start the rescan: '+(err.message||'unknown error');});
}
document.addEventListener('click',function(e){
  var el=e.target.closest&&e.target.closest('[data-remediation-id]');
  if(e.target.closest&&e.target.closest('[data-rem-generate]')&&findService()){generate(e.target.closest('[data-rem-generate]'));return;}
  if(e.target.closest&&e.target.closest('[data-rem-refresh]')&&findService()&&service.jobId){rerender(false,e.target.closest('[data-rem-refresh]'),document.querySelector('[data-rem-refresh-status]'),'Re-rendering the report from the saved scan…');return;}
  if(e.target.closest&&e.target.closest('[data-rem-rescan-button]')&&findService()){rescan(e.target.closest('[data-rem-rescan-button]'));return;}
  if(e.target.closest&&e.target.closest('[data-rem-update-report]')&&findService()&&service.jobId){rerender(false,e.target.closest('[data-rem-update-report]'),document.querySelector('[data-rem-update-status]'),'Re-rendering the report from the saved scan…');return;}
  if(!el)return;
  if(e.target.closest('[data-rem-copy]'))copy(e.target.closest('[data-rem-copy]'));
  else if(e.target.closest('[data-rem-verify]'))verify(el);
  else if(e.target.closest('[data-rem-done]')){delete el.querySelector('[data-rem-result]').dataset.error;var cur=value(el),next={status:cur.status==='done-unverified'?'todo':'done-unverified'};if(cur.note)next.note=cur.note;if(cur.lastVerify)next.lastVerify=cur.lastVerify;setValue(el,next,false);}
});
document.addEventListener('input',function(e){if(!e.target.matches||!e.target.matches('[data-rem-note]'))return;var el=e.target.closest('[data-remediation-id]'),cur=value(el),next={status:LABEL[cur.status]?cur.status:'todo'};if(e.target.value)next.note=e.target.value;if(cur.lastVerify)next.lastVerify=cur.lastVerify;setValue(el,next,false);});
window.addEventListener('complykit-workflow-changed',render);
// The workbench announces the site's current config (service): a newer one than this report shows → offer the reload.
// Only a config that carries a checklist counts (an older config without tasks would offer a reload that changes nothing).
window.addEventListener('complykit-workspace-config',function(e){var c=e.detail,t=c&&c.value&&c.value.tasks;liveConfigAt=Array.isArray(t)&&t.length&&typeof c.at==='string'?c.at:null;render();});
// The section can be swapped for a re-rendered one (R2): re-render when it is.
var sec=document.getElementById('remediation');if(sec&&sec.parentNode&&window.MutationObserver)new MutationObserver(function(){if(document.getElementById('remediation'))render();}).observe(sec.parentNode,{childList:true});
window.ComplyKitRemediation={render:render};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',render);
render();
})();`;
