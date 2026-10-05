import { actionQuestions, questionFields } from './questions.js';
import { createHash } from 'node:crypto';
import { escapeHtml as esc } from './human.js';

export const CATEGORIES = ['necessary', 'functional', 'analytics', 'advertising', 'security', 'chat', 'embed', 'fonts', 'payments', 'consent', 'other'] as const;
export function workspaceId(type: string, identity: unknown): string {
  return `${type}-${createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 32)}`;
}
export function tone(status: string): string { return /problem|violation/i.test(status) ? 'red' : /no finding|no cookie-specific/i.test(status) ? 'neutral' : 'amber'; }

export function actionControls(rule = '', requirement = ''): string {
  return `<div class="work-controls" data-work-controls hidden><label>Task progress <select data-work-status aria-label="Task progress"><option value="open">To do</option><option value="in-progress">In progress</option><option value="done">Done — marked by me</option></select></label><h4>Answer this action’s questions</h4><p>Save research as you go. Blank answers remain open even if you mark the task done.</p>${questionFields(actionQuestions(rule, requirement))}<label>Research sources / links <textarea data-review-answer="sources" data-question-label="Which sources support your answers?" rows="2" maxlength="4000" placeholder="Vendor documentation, configuration, test evidence, or reviewer and date"></textarea></label><p data-review-summary role="status"></p><label>Notes / how you checked it <textarea data-work-note rows="2" maxlength="4000" placeholder="What changed, who checked it, or what is still needed"></textarea></label><p class="work-feedback" data-work-feedback></p></div>`;
}
export function classificationControls(key: string, label: string): string {
  return `<details class="classification-controls" data-work-controls hidden><summary>Research and classify ${esc(label)}</summary><div><p>Describe its actual use on your site. Answers save as you type, including incomplete research. Record verified facts; leave unresolved questions blank. Your control decision does not retest consent behavior or establish legal compliance.</p><p><strong>How to research this:</strong> Ask the person who added it or check your tag manager for its configuration. Read the vendor’s data and cookie documentation, compare it with the scan evidence, then ask your privacy reviewer to confirm the control decision. Record links, reviewer and date below; vendor descriptions alone may not describe your site’s actual use.</p><form data-class-form="${esc(key)}"><label>Purpose category <select name="category"><option value="">Choose a category…</option>${CATEGORIES.map((c) => `<option value="${c}">${esc(c[0].toUpperCase() + c.slice(1))}</option>`).join('')}</select></label><label>What is it used for on this site? <textarea name="purpose" rows="2" maxlength="2000" placeholder="For example: measures visits to our product pages"></textarea></label><label>Who owns or provides it? <input name="owner" maxlength="1000" placeholder="Vendor / organization and internal owner if known"></label><label>What information does it collect, read, store or send? <textarea name="information" rows="2" maxlength="2000" placeholder="List the information and recipients; explicitly say none if verified"></textarea></label><label>Does it need consent or another control? <select name="control"><option value="">Still researching</option><option value="consent">Consent required</option><option value="other">Another control required</option><option value="none">No additional control — reviewed</option></select></label><label>Why, and which control will you use? <textarea name="controlReason" rows="2" maxlength="2000" placeholder="Explain your decision, applicable locations and control, or the verified reason none is needed"></textarea></label><label>Research evidence / source and reviewer <input name="source" maxlength="1000" placeholder="Vendor documentation, site owner, or reviewer"></label><button type="submit">Save research answers</button> <button type="button" data-class-clear>Clear my answer</button></form><p data-class-answer class="work-feedback"></p></div></details>`;
}

export function workspacePanel(): string {
  return `<section id="report-workspace" class="workspace-panel" data-work-controls hidden><h2 class="human-section-title">Your checklist</h2><p>Answer the open classification questions and track fixes here. Your answers and task progress are separate from the original scan evidence.</p><div class="human-stats"><div class="human-stat" data-tone="red"><strong id="work-fix-count">0</strong><span>Still needs fixing</span></div><div class="human-stat" data-tone="amber"><strong id="work-review-count">0</strong><span>Still needs review</span></div><div class="human-stat" data-tone="amber"><strong id="work-class-count">0</strong><span>Tool / storage reviews incomplete</span></div><div class="human-stat" data-tone="green"><strong id="work-done-count">0</strong><span>Tasks marked done</span></div></div><p><strong id="work-question-count">0</strong> action questions still need answers.</p><p><strong id="work-class-done-count">0</strong> tool / storage review(s) complete. Task counts and classification questions are separate and can overlap.</p><label>Show tasks <select id="work-filter"><option value="all">All tasks</option><option value="remaining">Remaining tasks</option><option value="in-progress">In progress</option><option value="done">Marked done</option></select></label><button type="button" id="work-export">Download progress backup</button> <label class="work-import">Restore progress <input id="work-import" type="file" accept="application/json,.json"></label> <button type="button" id="work-reset">Reset this report’s progress</button><p id="work-storage-status" role="status" aria-live="polite"></p><p class="human-muted">Saved locally in this browser for this report. Each scan has its own checklist. Moving the file or using another browser may require restoring a backup. Marking a task done means your team completed it; rerun the scan to verify the website’s behavior.</p></section>`;
}

export function workspaceScript(type: string, property: string, runId: string, fingerprints: string[]): string {
  const key = `complykit:report-workspace:v1:${workspaceId('report', [type, property, runId, [...fingerprints].sort()])}`;
  const config = JSON.stringify({ key, categories: CATEGORIES }).replace(/</g, '\\u003c');
  return `<script type="application/json" id="workspace-config">${config}</script><script>${WORKSPACE_JS}</script>`;
}

export const WORKSPACE_CSS = `
:root{--work-red:#a52218;--work-red-bg:#fff0ed;--work-amber:#805100;--work-amber-bg:#fff7db;--work-green:#14663b;--work-green-bg:#ecf9f0;--work-neutral:#526071;--work-neutral-bg:#eef1f5}
@media(prefers-color-scheme:dark){:root{--work-red:#ffa99d;--work-red-bg:#3c201f;--work-amber:#f4ce70;--work-amber-bg:#352c16;--work-green:#8de3ac;--work-green-bg:#183526;--work-neutral:#bec9d9;--work-neutral-bg:#242d39}}
.human-status[data-tone],.work-feedback[data-tone],.classification-badge[data-tone]{color:var(--work-neutral);background:var(--work-neutral-bg);border-color:var(--work-neutral)}
[data-tone=red]{--tone:var(--work-red);--tone-bg:var(--work-red-bg)}[data-tone=amber]{--tone:var(--work-amber);--tone-bg:var(--work-amber-bg)}[data-tone=green]{--tone:var(--work-green);--tone-bg:var(--work-green-bg)}[data-tone=neutral]{--tone:var(--work-neutral);--tone-bg:var(--work-neutral-bg)}
.human-status[data-tone],.classification-badge[data-tone],.work-feedback[data-tone]{color:var(--tone);background:var(--tone-bg);border-color:var(--tone)}
.human-stat[data-tone]{border-top:4px solid var(--tone);background:var(--tone-bg)}.human-stat[data-tone] strong{color:var(--tone)}
.human-card[data-scan-tone]{border-left:5px solid var(--tone)}.human-card[data-work-state=done]{border-left-color:var(--work-green)}.human-card[data-work-state=in-progress]{border-left-color:var(--work-amber)}
.workspace-panel{margin:28px 0;padding:18px;border:1px solid var(--line);border-radius:12px;background:var(--card)}.workspace-panel .human-section-title{margin-top:0!important}
.work-controls{padding:14px;margin:18px 0;border:1px solid var(--line);border-radius:8px;background:var(--bg)}.work-controls label,.classification-controls label{display:block;margin:10px 0;font-weight:600;font-size:14px}.work-controls textarea,.classification-controls textarea,.classification-controls input,.classification-controls select,.work-controls select{display:block;margin-top:5px;width:100%;max-width:650px;box-sizing:border-box;padding:9px;font:14px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:6px}
.classification-controls{padding:12px;border:1px solid var(--line);border-radius:8px;margin-top:12px}.classification-controls summary{cursor:pointer;font-weight:600}.classification-controls button,.workspace-panel button{padding:8px;margin:6px 0;font:14px system-ui,sans-serif;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:6px}.classification-badge,.work-feedback[data-tone]{display:inline-block;padding:5px 9px;border:1px solid;border-radius:6px;font-size:13px}.work-import{display:block;margin-top:12px}.work-import input{max-width:100%}.status-legend{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}.work-controls[hidden],[data-work-controls][hidden]{display:none!important}
@media print{.workspace-panel button,.workspace-panel input,.workspace-panel select,.work-controls,.classification-controls form{display:none!important}}
`;

const WORKSPACE_JS = String.raw`(function(){
  var config=JSON.parse(document.getElementById('workspace-config').textContent);
  var actions=Array.from(document.querySelectorAll('[data-action-key]'));
  var entries=Array.from(document.querySelectorAll('[data-class-key]'));
  var actionKeys=new Set(actions.map(function(el){return el.dataset.actionKey;}));
  var classKeys=new Set(entries.map(function(el){return el.dataset.classKey;}));
  var state={version:1,reportKey:config.key,actions:{},classifications:{}};
  var storageMessage='Your progress will be saved in this browser.';
  function validRecord(raw){
    if(!raw||raw.version!==1||raw.reportKey!==config.key||!raw.actions||typeof raw.actions!=='object'||!raw.classifications||typeof raw.classifications!=='object')throw Error('This backup is not for this report or has an invalid format.');
    var clean={version:1,reportKey:config.key,actions:{},classifications:{}};
    Object.keys(raw.actions).forEach(function(key){var a=raw.actions[key];if(actionKeys.has(key)&&a&&['open','in-progress','done'].includes(a.status)&&typeof a.note==='string'&&a.note.length<=4000){var answers={};Object.keys(a.answers||{}).forEach(function(id){if(/^[a-z]+$/.test(id)&&typeof a.answers[id]==='string'&&a.answers[id].length<=4000)answers[id]=a.answers[id];});clean.actions[key]={status:a.status,note:a.note,answers:answers};}});
    Object.keys(raw.classifications).forEach(function(key){var c=raw.classifications[key];if(!classKeys.has(key)||!c||typeof c!=='object')return;var out={};['category','purpose','owner','information','control','controlReason','source'].forEach(function(id){if(typeof c[id]==='string'&&c[id].length<=2000)out[id]=c[id];else out[id]='';});if(out.category&&!config.categories.includes(out.category))out.category='';if(!['','consent','other','none'].includes(out.control))out.control='';clean.classifications[key]=out;});
    return clean;
  }
  try{var stored=localStorage.getItem(config.key);if(stored){state=validRecord(JSON.parse(stored));storageMessage='Restored your saved progress for this report.';}}
  catch(e){storageMessage='Saved progress could not be loaded. You can still use this checklist and restore a backup.';}
  function save(){try{localStorage.setItem(config.key,JSON.stringify(state));storageMessage='Saved in this browser for this report.';}catch(e){storageMessage='This browser cannot save progress here. Changes remain in this session; download a backup before leaving.';}}
  function task(key){return state.actions[key]||{status:'open',note:'',answers:{}};}
  function shouldShow(key){var filter=document.getElementById('work-filter').value;var status=task(key).status;return filter==='all'||(filter==='remaining'&&status!=='done')||filter===status;}
  window.ComplyKitWorkspace={shouldShow:shouldShow};
  function update(){
    var questions=0,fixing=0,review=0,done=0,unanswered=new Set(),answered=new Set();
    actions.forEach(function(el){var a=task(el.dataset.actionKey);el.dataset.workState=a.status;
      el.querySelector('[data-work-status]').value=a.status;
      var missing=[];el.querySelectorAll('[data-review-answer]').forEach(function(field){var value=(a.answers||{})[field.dataset.reviewAnswer]||'';if(document.activeElement!==field)field.value=value;if(!value.trim()){missing.push(field.dataset.questionLabel);questions++;}});
      el.querySelector('[data-review-summary]').textContent=missing.length?missing.length+' unanswered: '+missing.join(' · '):'All action questions answered by you. Check the evidence before closing the task.';
      var note=el.querySelector('[data-work-note]');if(document.activeElement!==note)note.value=a.note;
      var feedback=el.querySelector('[data-work-feedback]');feedback.textContent=a.status==='done'?'Marked done by you — the original scan finding still needs a recheck.':a.status==='in-progress'?'In progress — still counted as unfinished.':'To do';feedback.dataset.tone=a.status==='done'?'green':a.status==='in-progress'?'amber':el.dataset.scanTone;
      if(a.status==='done')done++;else if(el.dataset.scanTone==='red')fixing++;else review++;
      el.hidden=!shouldShow(el.dataset.actionKey);
    });
    entries.forEach(function(el){var key=el.dataset.classKey;var c=state.classifications[key];var needed=el.dataset.classRequired==='true';var form=el.querySelector('[data-class-form]');
      var fields=['category','purpose','owner','information','control','controlReason','source'];var missing=fields.filter(function(id){return !c||!c[id]||!c[id].trim();});var complete=!!c&&!missing.length;
      if(complete)answered.add(key);else if(needed||c)unanswered.add(key);
      if(c)fields.forEach(function(id){if(document.activeElement!==form.elements[id])form.elements[id].value=c[id]||'';});
      el.dataset.classResolved=complete?'true':'false';
      var badge=el.querySelector('[data-class-badge]');if(badge){badge.textContent=complete?'Reviewed by you: '+c.category:c?'Research in progress — '+missing.length+' answers needed':needed?'Research needed':'Recorded category — verify actual use';badge.dataset.tone=complete?'green':needed||c?'amber':'neutral';}
      var names={category:'purpose category',purpose:'actual purpose',owner:'owner',information:'information used',control:'consent / control decision',controlReason:'decision reason',source:'research evidence / reviewer'};
      var answer=el.querySelector('[data-class-answer]');answer.textContent=complete?'All review questions answered by you; the original observations remain unchanged.':'Still to answer: '+missing.map(function(id){return names[id];}).join(', ');answer.dataset.tone=complete?'green':'amber';
      if(el.hasAttribute('data-tool-state')){var vals=el.dataset.originalToolState.split(' ').filter(function(v){return v!=='classify';});if((needed||c)&&!complete)vals.push('classify');el.dataset.toolState=vals.join(' ');}
      if(el.hasAttribute('data-cookie-state')){var vals=el.dataset.originalCookieState.split(' ').filter(function(v){return v!=='classify';});if((needed||c)&&!complete)vals.push('classify');el.dataset.cookieState=vals.join(' ');}
    });
    document.getElementById('work-question-count').textContent=questions;
    document.getElementById('work-fix-count').textContent=fixing;
    document.getElementById('work-review-count').textContent=review;
    document.getElementById('work-class-count').textContent=unanswered.size;
    document.getElementById('work-done-count').textContent=done;
    document.getElementById('work-class-done-count').textContent=answered.size;
    document.getElementById('work-storage-status').textContent=storageMessage;
    window.dispatchEvent(new CustomEvent('complykit-workflow-changed'));
  }
  document.querySelectorAll('[data-work-controls]').forEach(function(el){el.hidden=false;});
  document.addEventListener('change',function(e){if(e.target.matches('[data-work-status]')){var el=e.target.closest('[data-action-key]');var a=task(el.dataset.actionKey);state.actions[el.dataset.actionKey]={status:e.target.value,note:a.note,answers:a.answers||{}};save();update();}});
  document.addEventListener('input',function(e){if(e.target.matches('[data-work-note]')){var el=e.target.closest('[data-action-key]');var a=task(el.dataset.actionKey);state.actions[el.dataset.actionKey]={status:a.status,note:e.target.value,answers:a.answers||{}};save();document.getElementById('work-storage-status').textContent=storageMessage;}});
  function capture(form){var c={};['category','purpose','owner','information','control','controlReason','source'].forEach(function(id){c[id]=form.elements[id].value;});state.classifications[form.dataset.classForm]=c;save();update();}
  document.addEventListener('input',function(e){if(e.target.matches('[data-review-answer]')){var el=e.target.closest('[data-action-key]');var a=task(el.dataset.actionKey);var answers=Object.assign({},a.answers||{});answers[e.target.dataset.reviewAnswer]=e.target.value;state.actions[el.dataset.actionKey]={status:a.status,note:a.note,answers:answers};save();update();}var form=e.target.closest('[data-class-form]');if(form)capture(form);});
  document.addEventListener('change',function(e){var form=e.target.closest('[data-class-form]');if(form)capture(form);});
  document.addEventListener('submit',function(e){if(e.target.matches('[data-class-form]')){e.preventDefault();capture(e.target);}});
  document.addEventListener('click',function(e){if(e.target.matches('[data-class-clear]')){var form=e.target.closest('form');delete state.classifications[form.dataset.classForm];entries.filter(function(el){return el.dataset.classKey===form.dataset.classForm;}).forEach(function(el){el.querySelector('form').reset();});save();update();}});
  document.getElementById('work-filter').addEventListener('change',update);
  document.getElementById('work-export').addEventListener('click',function(){var url=URL.createObjectURL(new Blob([JSON.stringify(state,null,2)],{type:'application/json'}));var a=document.createElement('a');a.href=url;a.download='complykit-report-progress.json';a.click();setTimeout(function(){URL.revokeObjectURL(url);},1000);});
  document.getElementById('work-import').addEventListener('change',async function(e){var file=e.target.files[0];if(!file)return;try{if(file.size>2000000)throw Error('The backup is too large.');var incoming=validRecord(JSON.parse(await file.text()));state=incoming;entries.forEach(function(el){el.querySelector('form').reset();});save();update();}catch(err){document.getElementById('work-storage-status').textContent=err.message||'Could not restore this backup.';}e.target.value='';});
  document.getElementById('work-reset').addEventListener('click',function(){if(!window.confirm('Reset only this report’s answers, notes and task progress?'))return;state={version:1,reportKey:config.key,actions:{},classifications:{}};entries.forEach(function(el){el.querySelector('form').reset();});save();update();});
  window.addEventListener('storage',function(e){if(e.key!==config.key)return;try{state=e.newValue?validRecord(JSON.parse(e.newValue)):{version:1,reportKey:config.key,actions:{},classifications:{}};entries.forEach(function(el){el.querySelector('form').reset();});update();}catch(err){document.getElementById('work-storage-status').textContent='Another tab saved unreadable progress. Your current checklist has been kept.';}});
  update();
})();`;
